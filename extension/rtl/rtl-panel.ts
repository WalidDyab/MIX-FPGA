import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { NexysError, type NexysVhdlService } from '../services/nexys-service';
import { renderRtlHtml, type RtlPageState } from './rtl-html';

type Message = { type: 'open'; file: string; line: number; col: number } | { type: 'drill'; module: string } | { type: 'regenerate' } | { type: 'state'; [k: string]: unknown };

/**
 * RTL Schematic webview: the hardware the VHDL infers, from the shared
 * core's RTL analysis. Generated lazily when opened; marked out of date
 * (never silently stale) when the design changes.
 */
export class RtlPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    /** Module path from the top (drill-down). */
    private path: string[] = [];
    private readonly sub: { dispose(): void };
    /** What the page currently shows; the HTML is replaced only when this changes (a reload drops pending messages). */
    private shownKey = '';
    /** Last state reported by the webview script (used by integration tests). */
    lastWebviewState: Record<string, unknown> | undefined;
    /** Recent webview states (diagnostics for integration tests). */
    readonly stateLog: Record<string, unknown>[] = [];

    constructor(private readonly service: NexysVhdlService) {
        this.sub = service.onDidChange((k) => {
            if (this.panel && (k === 'rtl' || k === 'project')) this.render();
        });
    }

    /** Opens the panel and generates the RTL schematic if there is none for the current design. */
    async show(): Promise<void> {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel('nexysvhdl.rtlSchematic', 'RTL Schematic', vscode.ViewColumn.Two, { enableScripts: true, localResourceRoots: [] });
            this.panel.iconPath = new vscode.ThemeIcon('circuit-board');
            this.panel.onDidDispose(() => {
                this.panel = undefined;
                this.shownKey = '';
            });
            this.panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m));
        } else this.panel.reveal(undefined, true);
        this.render();
        const rtl = this.service.rtl;
        if (rtl.status !== 'ready' || this.service.rtlStale) await this.generate();
    }

    /** Sends a command to the webview script (fit, zoomIn, zoomOut, pan, select). */
    postCommand(command: Record<string, unknown>): void {
        void this.panel?.webview.postMessage({ type: 'command', ...command });
    }

    get visible(): boolean {
        return this.panel !== undefined;
    }

    get currentModule(): string | undefined {
        return this.path[this.path.length - 1];
    }

    private async generate(): Promise<void> {
        this.path = [];
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'NexysVHDL: Generating RTL schematic' }, () => this.service.generateRtl());
        } catch (err) {
            if (!(err instanceof NexysError)) throw err;
            this.render(err.message);
            throw err;
        }
    }

    private onMessage(m: Message): void {
        const root = this.service.projectRoot;
        if (m.type === 'state') {
            this.lastWebviewState = m;
            this.stateLog.push(m);
            if (this.stateLog.length > 30) this.stateLog.shift();
        }
        else if (m.type === 'open' && root) void vscode.commands.executeCommand('nexysvhdl.openLocation', root, m.file, m.line, m.col);
        else if (m.type === 'drill') {
            const at = this.path.indexOf(m.module);
            const rtl = this.service.rtl;
            if (rtl.status === 'ready' && m.module === rtl.model.top) this.path = [];
            else if (at >= 0) this.path = this.path.slice(0, at + 1);
            else this.path.push(m.module);
            this.render();
        } else if (m.type === 'regenerate') void this.generate().catch((err: Error) => vscode.window.showWarningMessage(err.message));
    }

    private setHtml(key: string, html: () => string): void {
        if (!this.panel || key === this.shownKey) return;
        this.shownKey = key;
        this.panel.webview.html = html();
    }

    private render(problem?: string): void {
        if (!this.panel) return;
        const nonce = randomBytes(16).toString('base64');
        const rtl = this.service.rtl;
        if (problem || rtl.status !== 'ready') {
            let state: RtlPageState;
            if (problem) state = { kind: 'message', message: problem };
            else if (rtl.status === 'running') state = { kind: 'running' };
            else if (rtl.status === 'failed' || rtl.status === 'unavailable') state = { kind: 'message', message: rtl.status === 'unavailable' ? `The RTL analysis tools are not set up on this computer (${rtl.message})` : rtl.message };
            else state = { kind: 'message', message: 'Run Check, then open the RTL schematic.' };
            this.setHtml(JSON.stringify(state), () => renderRtlHtml({ nonce, state }));
            return;
        }
        const model = rtl.model;
        const module = this.currentModule && model.modules.has(this.currentModule) ? this.currentModule : model.top;
        if (module === model.top) this.path = [];
        const view = model.modules.get(module)!;
        const chain = [model.top, ...this.path];
        const path = chain.map((m) => ({ module: m, label: model.modules.get(m)?.displayName ?? m }));
        this.panel.title = `RTL: ${view.displayName}`;
        const stale = this.service.rtlStale;
        this.setHtml(JSON.stringify(['ready', rtl.generatedAt.getTime(), module, stale]), () => renderRtlHtml({ nonce, state: { kind: 'ready', stale, generatedAt: rtl.generatedAt }, view, path }));
    }

    dispose(): void {
        this.sub.dispose();
        this.panel?.dispose();
    }
}
