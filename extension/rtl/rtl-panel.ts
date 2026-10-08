import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { AppearanceStore, type SchematicAppearance } from '../schematic/schematic-chrome';
import { SchematicExporter } from '../schematic/schematic-export';
import { sanitizeViewState, type SchematicViewState, type ZoomMode } from '../schematic/schematic-view';
import { NexysError, type NexysVhdlService } from '../services/nexys-service';
import type { StateStore } from '../services/project-state';
import { renderRtlHtml, type RtlPageState } from './rtl-html';
import { renderRtlSvg } from './rtl-svg';

type Message =
    | { type: 'open'; file: string; line: number; col: number }
    | { type: 'drill'; module: string }
    | { type: 'regenerate' }
    | { type: 'state'; [k: string]: unknown }
    | { type: 'view'; mode: ZoomMode; scale: number; x: number; y: number; notesOpen: boolean; metrics?: Record<string, number> }
    | { type: 'appearance'; value: SchematicAppearance }
    | { type: 'export'; format: 'svg' | 'png' }
    | { type: 'png'; id: string; width?: number; height?: number; data?: string; error?: string }
    | { type: 'maximize' };

/** Project-state key of the RTL Schematic's remembered zoom and scroll positions. */
export const RTL_STATE_KEY = 'nexysvhdl.rtl.view';

/**
 * RTL Schematic webview: the hardware the VHDL infers, from the shared
 * core's RTL analysis. Generated lazily when opened; marked out of date
 * (never silently stale) when the design changes. Opens in the active editor group in Fit All,
 * shares the Dark/Light choice and the toolbar with the Design Schematic, and exports SVG/PNG.
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
    /** Validation only: adds the test-only page code. Off in every normal session. */
    testHooks = false;
    /** The zoom and scroll state the page last reported (also what is stored with the project). */
    viewState: SchematicViewState;
    lastView: { mode: ZoomMode; scale: number; x: number; y: number; module: string | undefined; metrics: Record<string, number> } | undefined;
    readonly exporter: SchematicExporter;
    private shown: { svg: string; entity: string } | undefined;
    private readonly appearanceSub: { dispose(): void };

    constructor(
        private readonly service: NexysVhdlService,
        private readonly extensionUri?: vscode.Uri,
        private readonly memory?: StateStore,
        /** The Dark/Light choice, shared with the Design Schematic. */
        readonly appearance: AppearanceStore = new AppearanceStore(memory),
    ) {
        this.viewState = sanitizeViewState(memory?.get(RTL_STATE_KEY));
        this.sub = service.onDidChange((k) => {
            if (this.panel && (k === 'rtl' || k === 'project')) this.render();
        });
        this.appearanceSub = this.appearance.onDidChange((a) => void this.panel?.webview.postMessage({ type: 'command', action: 'appearance', value: a }));
        this.exporter = new SchematicExporter({
            kind: 'rtl',
            webview: () => this.panel?.webview,
            projectRoot: () => this.service.projectRoot,
            current: () => this.shown,
            appearance: () => this.appearance.get(),
        });
    }

    /** Opens the panel and generates the RTL schematic if there is none for the current design. */
    async show(): Promise<void> {
        if (!this.panel) {
            this.viewState = sanitizeViewState(this.memory?.get(RTL_STATE_KEY) ?? this.viewState);
            const scripts = this.extensionUri ? [vscode.Uri.joinPath(this.extensionUri, 'dist', 'extension', 'schematic')] : [];
            // The active editor group: a normal tab, never a new column or split.
            this.panel = vscode.window.createWebviewPanel('nexysvhdl.rtlSchematic', 'RTL Schematic', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: scripts });
            this.panel.iconPath = new vscode.ThemeIcon('circuit-board');
            this.panel.onDidDispose(() => {
                this.panel = undefined;
                this.shownKey = '';
                this.shown = undefined;
            });
            this.panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m));
            // Shown again after being hidden: rebuild the page from the current zoom and Dark/Light choice (see SchematicPanel).
            let wasVisible = true;
            this.panel.onDidChangeViewState((e) => {
                const visible = e.webviewPanel.visible;
                if (visible && !wasVisible) {
                    this.shownKey = '';
                    this.render();
                }
                wasVisible = visible;
            });
        } else this.panel.reveal(undefined, false);
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
        else if (m.type === 'open' && root) void vscode.commands.executeCommand('nexysvhdl.openLocation', root, m.file, m.line, m.col, { beside: true });
        else if (m.type === 'maximize') void vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
        else if (m.type === 'appearance') this.appearance.set(m.value === 'light' ? 'light' : 'dark');
        else if (m.type === 'export') void this.exporter.request(m.format === 'png' ? 'png' : 'svg');
        else if (m.type === 'png') void this.exporter.png(m);
        else if (m.type === 'view') {
            const module = this.currentModule ?? this.topModule();
            const next = sanitizeViewState({ view: { mode: m.mode, scale: m.scale }, pans: { ...this.viewState.pans, ...(module ? { [module]: { x: m.x, y: m.y } } : {}) }, notesOpen: false });
            this.viewState = next;
            this.lastView = { mode: next.view.mode, scale: next.view.scale, x: Math.round(m.x), y: Math.round(m.y), module, metrics: m.metrics ?? {} };
            void this.memory?.update(RTL_STATE_KEY, next);
        }
        else if (m.type === 'drill') {
            const at = this.path.indexOf(m.module);
            const rtl = this.service.rtl;
            if (rtl.status === 'ready' && m.module === rtl.model.top) this.path = [];
            else if (at >= 0) this.path = this.path.slice(0, at + 1);
            else this.path.push(m.module);
            this.render();
        } else if (m.type === 'regenerate') void this.generate().catch((err: Error) => vscode.window.showWarningMessage(err.message));
    }

    private topModule(): string | undefined {
        const rtl = this.service.rtl;
        return rtl.status === 'ready' ? rtl.model.top : undefined;
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
        const module0 = this.currentModule ?? this.topModule() ?? '';
        if (problem || rtl.status !== 'ready') {
            let state: RtlPageState;
            if (problem) state = { kind: 'message', message: problem };
            else if (rtl.status === 'running') state = { kind: 'running' };
            else if (rtl.status === 'failed' || rtl.status === 'unavailable') state = { kind: 'message', message: rtl.status === 'unavailable' ? `The RTL analysis tools are not set up on this computer (${rtl.message})` : rtl.message };
            else state = { kind: 'message', message: 'Run Check, then open the RTL schematic.' };
            this.shown = undefined;
            this.setHtml(JSON.stringify(state), () => renderRtlHtml({ nonce, state, ...this.pageExtras(module0) }));
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
        this.shown = { svg: renderRtlSvg(view), entity: view.displayName };
        this.setHtml(JSON.stringify(['ready', rtl.generatedAt.getTime(), module, stale]), () => renderRtlHtml({ nonce, state: { kind: 'ready', stale, generatedAt: rtl.generatedAt }, view, path, ...this.pageExtras(module) }));
    }

    /** Webview-dependent page inputs: script URI, CSP source, the remembered view of this module and the Dark/Light choice. */
    private pageExtras(module: string): { cspSource?: string; viewUri?: string; init: { mode: string; scale: number; x: number; y: number; appearance: string }; testHooks: boolean } {
        const webview = this.panel!.webview;
        const pan = this.viewState.pans[module] ?? { x: 0, y: 0 };
        return {
            cspSource: webview.cspSource,
            ...(this.extensionUri ? { viewUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'extension', 'schematic', 'schematic-view.js')).toString() } : {}),
            init: { mode: this.viewState.view.mode, scale: this.viewState.view.scale, x: pan.x, y: pan.y, appearance: this.appearance.get() },
            testHooks: this.testHooks,
        };
    }

    dispose(): void {
        this.sub.dispose();
        this.appearanceSub.dispose();
        this.panel?.dispose();
    }
}
