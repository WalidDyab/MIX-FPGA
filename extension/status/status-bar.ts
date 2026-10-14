import * as vscode from 'vscode';
import type { NexysVhdlService } from '../services/nexys-service';
import { BUILD_STAGES } from '../services/workflow-state';

const STAGE_LABEL = { synthesis: 'Synthesis', implementation: 'Implementation', bitstream: 'Bitstream' } as const;

/**
 * Three restrained status bar items: overall state, board, and the last
 * build result (only after a build).
 */
export class StatusBar implements vscode.Disposable {
    private readonly main = vscode.window.createStatusBarItem('nexysvhdl.status', vscode.StatusBarAlignment.Left, 50);
    private readonly board = vscode.window.createStatusBarItem('nexysvhdl.board', vscode.StatusBarAlignment.Left, 49);
    private readonly build = vscode.window.createStatusBarItem('nexysvhdl.build', vscode.StatusBarAlignment.Left, 48);
    private readonly sub: { dispose(): void };

    constructor(private readonly service: NexysVhdlService) {
        this.main.name = 'MIX-FPGA';
        this.board.name = 'MIX-FPGA Board';
        this.build.name = 'MIX-FPGA Build';
        this.main.command = 'workbench.view.extension.nexysvhdl';
        this.board.command = 'nexysvhdl.detectBoards';
        this.build.command = 'nexysvhdl.results.focus';
        this.sub = service.onDidChange(() => this.update());
        this.update();
    }

    update(): void {
        const s = this.service;
        const snap = s.snapshot;
        if (!snap) {
            this.main.hide();
            this.board.hide();
            this.build.hide();
            return;
        }
        const w = s.workflow;
        let text: string;
        let tooltip: string;
        let background: vscode.ThemeColor | undefined;
        if (w.running) {
            const stage = w.running === 'build' ? BUILD_STAGES.find((id) => w.stages[id].state === 'running') : undefined;
            text = `$(sync~spin) MIX-FPGA: ${w[w.running].summary ?? 'Working…'}${stage ? ` ${STAGE_LABEL[stage]}` : ''}`;
            tooltip = 'Click to show the MIX-FPGA sidebar';
        } else if (!snap.project) {
            text = '$(error) MIX-FPGA: Project error';
            tooltip = snap.loadDiagnostics.map((d) => d.message).join('\n');
            background = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (s.environment?.level === 'setup-required') {
            text = '$(warning) MIX-FPGA: Setup required';
            tooltip = s.environment.problems.join('\n');
            background = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            text = '$(circuit-board) MIX-FPGA: Ready';
            tooltip = `${snap.project.config.name} — ${snap.boardName ?? snap.project.config.board}`;
        }
        this.main.text = text;
        this.main.tooltip = tooltip;
        this.main.backgroundColor = background;
        this.main.show();

        if (snap.project) {
            const hw = s.hardware;
            const short = (snap.boardName ?? 'Board').replace(/^Digilent /, '').replace(/-\d+T$/, '');
            const connected = hw.status === 'one' || hw.status === 'many';
            this.board.text = hw.status === 'detecting' ? `$(sync~spin) ${short}` : `${short} ${connected ? '●' : '○'}`;
            this.board.tooltip = connected ? `${hw.boards.length} board(s) connected — click to detect again` : 'No board detected — click to detect';
            this.board.show();
        } else this.board.hide();

        const b = w.build;
        if (b.state === 'passed' || b.state === 'failed') {
            this.build.text = b.state === 'passed' ? 'Build $(check)' : 'Build $(x)';
            this.build.tooltip = b.summary ?? '';
            this.build.show();
        } else this.build.hide();
    }

    dispose(): void {
        this.sub.dispose();
        this.main.dispose();
        this.board.dispose();
        this.build.dispose();
    }
}
