import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { sha256File, type SimulationResult } from '../../core';
import type { NexysVhdlService } from '../services/nexys-service';
import { formatSimTime } from '../services/workflow-state';
import { parseVcd } from './vcd-parser';
import { sanitizeRadixState } from './wave-render';
import { renderWaveHtml, toWaveData, type WaveIdentity } from './waveform-html';

type Message = { type: 'ready' } | { type: 'state'; [k: string]: unknown } | { type: 'radix'; state: unknown };

/** Workspace-state key of the remembered Display As choices. */
export const RADIX_STATE_KEY = 'nexysvhdl.waveform.radix';

/**
 * Waveform viewer webview. Always shows the VCD of the latest Simulate
 * result (path from SimulationResult.vcd); reloads automatically after
 * every new simulation and refuses a file whose hash no longer matches
 * the simulation that produced it.
 */
export class WaveformPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private shownRun = -1;
    private readonly sub: { dispose(): void };
    /** Last state reported by the webview script (used by integration tests). */
    lastWebviewState: Record<string, unknown> | undefined;
    /** Identity of the waveform last sent to the webview. */
    shown: WaveIdentity | undefined;

    constructor(
        private readonly service: NexysVhdlService,
        private readonly extensionUri: vscode.Uri,
        /** Remembers Display As choices for this workspace (absent in tests). */
        private readonly memory?: vscode.Memento,
    ) {
        this.sub = service.onDidChange((k) => {
            if (this.panel && k === 'results' && this.service.simulationRun !== this.shownRun) void this.load();
            if (this.panel && k === 'workflow' && this.service.busy === 'simulate' && this.shown) {
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
            if (m.type === 'ready') void this.load();
            else if (m.type === 'state') this.lastWebviewState = m;
            else if (m.type === 'radix') void this.memory?.update(RADIX_STATE_KEY, sanitizeRadixState(m.state));
        });
        const nonce = randomBytes(16).toString('base64');
        const rendererUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(scripts, 'wave-render.js')).toString();
        this.panel.webview.html = renderWaveHtml({ nonce, cspSource: this.panel.webview.cspSource, rendererUri });
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
        if (!sim) return this.empty('No simulation has run yet. Run Simulate to produce a waveform.');
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
        try {
            data = toWaveData(parseVcd(text));
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
        const warning = sim.status === 'succeeded' && sim.passed ? undefined : 'This simulation failed; the waveform shows what happened up to the failure.';
        void this.panel.webview.postMessage({ type: 'load', data, identity, radix: sanitizeRadixState(this.memory?.get(RADIX_STATE_KEY)), ...(warning ? { warning } : {}) });
    }

    dispose(): void {
        this.sub.dispose();
        this.panel?.dispose();
    }
}
