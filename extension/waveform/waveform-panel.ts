import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { sha256File, type SimulationResult } from '../../core';
import type { NexysVhdlService } from '../services/nexys-service';
import { formatSimTime } from '../services/workflow-state';
import { parsePartialVcd } from './vcd-parser';
import type { StateStore } from '../services/project-state';
import { sanitizeLayout, sanitizeRadixState, sanitizeSignalChoices } from './wave-render';
import { renderWaveHtml, toWaveData, type WaveIdentity } from './waveform-html';

type Message = { type: 'ready' } | { type: 'run'; duration: string | undefined } | { type: 'stop' } | { type: 'state'; [k: string]: unknown } | { type: 'radix'; state: unknown } | { type: 'layout'; layout: unknown } | { type: 'signals'; testbench: string; paths: unknown };

/** Workspace-state key of the remembered Display As choices. */
export const RADIX_STATE_KEY = 'nexysvhdl.waveform.radix';
/** Workspace-state key of the remembered pane widths. */
export const LAYOUT_STATE_KEY = 'nexysvhdl.waveform.layout';
/** Project-state key of the remembered signal choices (per testbench). */
export const SIGNALS_STATE_KEY = 'nexysvhdl.waveform.signals';

/**
 * The simulation workspace: ONE waveform viewer panel per window, with the simulation
 * toolbar (Run, Stop, Run for). It always shows the VCD of the latest simulation result
 * (path from SimulationResult.vcd), reloads automatically after every run (keeping the
 * student's signals, radix choices and pane widths), and refuses a file whose hash no
 * longer matches the simulation that produced it. A run stopped by the student leaves a
 * partial waveform, shown with a note.
 */
export class WaveformPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private shownRun = -1;
    private readonly sub: { dispose(): void };
    /** Last state reported by the webview script (used by integration tests). */
    lastWebviewState: Record<string, unknown> | undefined;
    /** Validation only: adds the test-only page commands. Off in every normal session. */
    testHooks = false;
    /** Identity of the waveform last sent to the webview. */
    shown: WaveIdentity | undefined;

    constructor(
        private readonly service: NexysVhdlService,
        private readonly extensionUri: vscode.Uri,
        /** Remembers the viewer's choices (signals, Display As, pane widths) with the project (absent in tests). */
        private readonly memory?: StateStore,
    ) {
        this.sub = service.onDidChange((k) => {
            if (!this.panel) return;
            if (k === 'results' && this.service.simulationRun !== this.shownRun) void this.load();
            if (k === 'workflow' || k === 'busy' || k === 'project' || k === 'results') this.postSimState();
            if (k === 'workflow' && this.service.busy === 'simulate' && this.shown) {
                void this.panel.webview.postMessage({ type: 'banner', message: `Simulating… this waveform (run ${this.shown.run}) will be replaced when the new simulation finishes.` });
            }
        });
    }

    get visible(): boolean {
        return this.panel !== undefined;
    }

    show(): void {
        if (this.panel) {
            this.panel.reveal(undefined, true);
            void this.load();
            return;
        }
        const scripts = vscode.Uri.joinPath(this.extensionUri, 'dist', 'extension', 'waveform');
        this.panel = vscode.window.createWebviewPanel('nexysvhdl.waveform', 'Waveform', vscode.ViewColumn.Two, { enableScripts: true, localResourceRoots: [scripts] });
        this.panel.iconPath = new vscode.ThemeIcon('pulse');
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.shownRun = -1;
            this.shown = undefined;
        });
        this.panel.webview.onDidReceiveMessage((m: Message) => {
            if (m.type === 'ready') {
                void this.load();
                this.postSimState();
            } else if (m.type === 'run') void vscode.commands.executeCommand('nexysvhdl.runSimulation', { duration: m.duration ?? null });
            else if (m.type === 'stop') void vscode.commands.executeCommand('nexysvhdl.stopSimulation');
            else if (m.type === 'state') this.lastWebviewState = m;
            else if (m.type === 'radix') void this.memory?.update(RADIX_STATE_KEY, sanitizeRadixState(m.state));
            else if (m.type === 'layout') void this.memory?.update(LAYOUT_STATE_KEY, sanitizeLayout(m.layout));
            else if (m.type === 'signals' && typeof m.testbench === 'string' && Array.isArray(m.paths)) {
                const all = { ...sanitizeSignalChoices(this.memory?.get(SIGNALS_STATE_KEY)), ...sanitizeSignalChoices({ [m.testbench]: m.paths }) };
                void this.memory?.update(SIGNALS_STATE_KEY, all);
            }
        });
        const nonce = randomBytes(16).toString('base64');
        const rendererUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(scripts, 'wave-render.js')).toString();
        this.panel.webview.html = renderWaveHtml({ nonce, cspSource: this.panel.webview.cspSource, rendererUri, testHooks: this.testHooks });
    }

    /** What the toolbar shows: whether a simulation runs, what else is busy, the project's duration, a status line. */
    private postSimState(): void {
        if (!this.panel) return;
        const s = this.service;
        const running = s.simulating;
        const busy = s.busyAction;
        const other = busy && busy !== 'simulate' ? { check: 'Check', build: 'Build', program: 'Programming', rtl: 'RTL schematic generation', simulate: 'Simulation' }[busy] : '';
        const duration = s.project?.config.simulation?.stopTime ?? '';
        const last = s.lastSimulation;
        let status = '';
        if (running) status = `Simulating from 0 to ${duration ? formatSimTime(duration) : 'the end of the testbench'}…`;
        else if (last?.cancelled) status = 'Simulation stopped by user';
        else if (last && last.status === 'succeeded' && last.passed) status = `Last run passed${last.stoppedAt ? ` · stopped at ${formatSimTime(last.stoppedAt)}` : ''}`;
        else if (last) status = 'Last run failed: see the message above or Problems';
        void this.panel.webview.postMessage({ type: 'simState', running, other, duration, status });
    }

    /** Sends a command to the webview (fit, zoomIn, zoomOut, pan, cursor, radix). */
    postCommand(command: Record<string, unknown>): void {
        void this.panel?.webview.postMessage({ type: 'command', ...command });
    }

    private empty(message: string): void {
        this.shown = undefined;
        void this.panel?.webview.postMessage({ type: 'empty', message });
    }

    private async load(): Promise<void> {
        if (!this.panel) return;
        const run = this.service.simulationRun;
        this.shownRun = run;
        const sim: SimulationResult | undefined = this.service.lastSimulation;
        if (!sim) return this.empty('No simulation has run yet. Press ▶ Run to simulate the testbench and see its waveform here.');
        if (!sim.vcd) return this.empty(`The latest simulation (run ${run}) produced no waveform${sim.status === 'succeeded' ? '' : ' because it did not run'}.`);
        let text: string;
        try {
            if (sim.vcd.sha256 && (await sha256File(sim.vcd.path)) !== sim.vcd.sha256) {
                return this.empty('The waveform file was changed after the latest simulation. Run Simulate again.');
            }
            text = await readFile(sim.vcd.path, 'utf8');
        } catch {
            return this.empty('The waveform file of the latest simulation is missing. Run Simulate again.');
        }
        let data;
        let partial = false;
        try {
            const parsed = parsePartialVcd(text);
            partial = parsed.partial || sim.cancelled === true;
            data = toWaveData(parsed.model);
        } catch (err) {
            return this.empty(`The waveform could not be read: ${(err as Error).message}`);
        }
        if (this.service.simulationRun !== run) return; // a newer simulation finished meanwhile
        const root = this.service.projectRoot;
        const identity: WaveIdentity = {
            testbench: sim.testbench,
            file: root ? relative(root, sim.vcd.path).split(sep).join('/') : sim.vcd.path,
            run,
            finishedAt: (this.service.lastSimulationAt ?? new Date()).toLocaleTimeString(),
            ...(sim.vcd.sha256 ? { sha256: sim.vcd.sha256 } : {}),
            ...(sim.stoppedAt ? { stoppedAt: formatSimTime(sim.stoppedAt) } : {}),
        };
        this.shown = identity;
        this.panel.title = `Waveform: ${sim.testbench}`;
        this.postSimState();
        const warning = sim.cancelled
            ? 'Simulation stopped by user. This waveform is partial: it shows what was recorded before you pressed Stop.'
            : sim.status === 'succeeded' && sim.passed
              ? undefined
              : partial
                ? 'This waveform is incomplete.'
                : 'This simulation failed; the waveform shows what happened up to the failure.';
        void this.panel.webview.postMessage({ type: 'load', data, identity, radix: sanitizeRadixState(this.memory?.get(RADIX_STATE_KEY)), layout: sanitizeLayout(this.memory?.get(LAYOUT_STATE_KEY)), signals: sanitizeSignalChoices(this.memory?.get(SIGNALS_STATE_KEY))[sim.testbench] ?? [], ...(warning ? { warning } : {}) });
    }

    dispose(): void {
        this.sub.dispose();
        this.panel?.dispose();
    }
}
