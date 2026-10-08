import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { StateStore } from '../services/project-state';
import type { NexysVhdlService } from '../services/nexys-service';
import { AppearanceStore, commonScript, pageCss, type SchematicAppearance, schematicCsp, toolbarHtml } from './schematic-chrome';
import { SchematicExporter } from './schematic-export';
import { buildSchematic, type SchematicModel } from './schematic-model';
import { renderSchematicSvg } from './schematic-svg';
import { sanitizeViewState, type SchematicViewState, type ZoomMode } from './schematic-view';

type Message =
    | { type: 'open'; file: string; line: number; col: number }
    | { type: 'drill'; id: string }
    | { type: 'view'; mode: ZoomMode; scale: number; x: number; y: number; notesOpen: boolean; metrics?: Record<string, number> }
    | { type: 'appearance'; value: SchematicAppearance }
    | { type: 'export'; format: 'svg' | 'png' }
    | { type: 'png'; id: string; width?: number; height?: number; data?: string; error?: string }
    | { type: 'maximize' };

/** Project-state key of the remembered zoom, scroll positions and notes state. */
export const SCHEMATIC_STATE_KEY = 'nexysvhdl.schematic.view';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The Design Schematic webview: a component-level block diagram of one hierarchy level, re-rendered
 * whenever the design index changes (on save). Blocks open their instantiation; ⤵ goes one level
 * down; the breadcrumb goes back up.
 *
 * It opens as an ordinary editor tab in the active editor group, in Fit All (never below a readable
 * scale: a bigger design scrolls). The student pans and zooms (100%, Fit Width, Fit All, +, −, Reset),
 * switches the background between Dark and Light, and exports the complete drawing as SVG or PNG. The
 * choices, with the scroll position of every hierarchy level, are remembered with the project and
 * survive the automatic re-render after a save.
 */
export class SchematicPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private nodeId: string | undefined;
    private readonly sub: { dispose(): void };
    private readonly appearanceSub: { dispose(): void };
    private shown: { svg: string; entity: string } | undefined;
    /** Validation only: adds the test-only page code (metrics, synthetic scroll/click). Off in every normal session. */
    testHooks = false;
    /** The zoom and scroll state the page last reported (also what is stored with the project). */
    viewState: SchematicViewState;
    /** Last state message from the page (integration tests). */
    lastView: { mode: ZoomMode; scale: number; x: number; y: number; node: string | undefined; metrics: Record<string, number> } | undefined;
    readonly exporter: SchematicExporter;

    constructor(
        private readonly service: NexysVhdlService,
        private readonly extensionUri?: vscode.Uri,
        private readonly memory?: StateStore,
        /** The Dark/Light choice, shared with the RTL Schematic. */
        readonly appearance: AppearanceStore = new AppearanceStore(memory),
    ) {
        this.viewState = sanitizeViewState(memory?.get(SCHEMATIC_STATE_KEY));
        this.sub = service.onDidChange((k) => {
            if ((k === 'project' || k === 'workflow') && this.panel) this.render();
        });
        this.appearanceSub = this.appearance.onDidChange((a) => void this.panel?.webview.postMessage({ type: 'command', action: 'appearance', value: a }));
        this.exporter = new SchematicExporter({
            kind: 'design',
            webview: () => this.panel?.webview,
            projectRoot: () => this.service.projectRoot,
            current: () => this.shown,
            appearance: () => this.appearance.get(),
        });
    }

    get visible(): boolean {
        return this.panel !== undefined;
    }

    /** Shows the schematic of hierarchy node `id` (default: the top entity). */
    show(id?: string): void {
        this.nodeId = id;
        this.viewState = sanitizeViewState(this.memory?.get(SCHEMATIC_STATE_KEY) ?? this.viewState);
        if (!this.panel) {
            const scripts = this.extensionUri ? [vscode.Uri.joinPath(this.extensionUri, 'dist', 'extension', 'schematic')] : [];
            // The active editor group: a normal tab, never a new column or split.
            this.panel = vscode.window.createWebviewPanel('nexysvhdl.schematic', 'Design Schematic', vscode.ViewColumn.Active, {
                enableScripts: true,
                localResourceRoots: scripts,
                retainContextWhenHidden: false,
            });
            this.panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
            this.panel.onDidDispose(() => {
                this.panel = undefined;
                this.shown = undefined;
            });
            this.panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m));
            // A hidden tab has no page; when it is shown again VS Code rebuilds the page from the last HTML, which would carry an old zoom
            // and an old Dark/Light choice. Build the HTML afresh from the current state instead.
            let wasVisible = true;
            this.panel.onDidChangeViewState((e) => {
                const visible = e.webviewPanel.visible;
                if (visible && !wasVisible) this.render(); // only on hidden -> shown, never on a mere focus change
                wasVisible = visible;
            });
        } else {
            this.panel.reveal(undefined, false);
        }
        this.render();
    }

    /** Sends a view command to the page: { action: '100' | 'width' | 'all' | 'zoomIn' | 'zoomOut' | 'reset' } (and, with testHooks, 'scroll' and 'click'). */
    postCommand(command: Record<string, unknown>): void {
        void this.panel?.webview.postMessage({ type: 'command', ...command });
    }

    private onMessage(m: Message): void {
        const root = this.service.projectRoot;
        if (m.type === 'open' && root && m.file) {
            // The source opens beside the schematic only when the student asks for it, so the schematic keeps the full width otherwise.
            void vscode.commands.executeCommand('nexysvhdl.openLocation', root, m.file, m.line, m.col, { beside: true });
        } else if (m.type === 'drill') {
            this.nodeId = m.id;
            this.render();
        } else if (m.type === 'maximize') {
            void vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
        } else if (m.type === 'appearance') {
            this.appearance.set(m.value === 'light' ? 'light' : 'dark');
        } else if (m.type === 'export') {
            void this.exporter.request(m.format === 'png' ? 'png' : 'svg');
        } else if (m.type === 'png') {
            void this.exporter.png(m);
        } else if (m.type === 'view') {
            const next = sanitizeViewState({
                view: { mode: m.mode, scale: m.scale },
                pans: { ...this.viewState.pans, ...(this.nodeId ? { [this.nodeId]: { x: m.x, y: m.y } } : {}) },
                notesOpen: m.notesOpen,
            });
            this.viewState = next;
            this.lastView = { mode: next.view.mode, scale: next.view.scale, x: Math.round(m.x), y: Math.round(m.y), node: this.nodeId, metrics: m.metrics ?? {} };
            void this.memory?.update(SCHEMATIC_STATE_KEY, next);
        }
    }

    private model(): { model?: SchematicModel; problem?: string } {
        const snap = this.service.snapshot;
        if (!snap?.project) return { problem: 'No NexysVHDL project is open.' };
        const root = snap.hierarchy.root;
        if (!root) return { problem: `The top entity "${snap.project.config.top}" was not found in src/.` };
        const model = buildSchematic(snap.index, root, this.nodeId) ?? buildSchematic(snap.index, root);
        if (model && model.hierarchyId !== this.nodeId) this.nodeId = model.hierarchyId;
        return model ? { model } : { problem: 'This entity cannot be shown.' };
    }

    private render(): void {
        if (!this.panel) return;
        const { model, problem } = this.model();
        if (model) this.panel.title = `Schematic: ${model.entityName}`;
        const checkState = this.service.workflow.check.state;
        const banner =
            checkState === 'passed'
                ? ''
                : checkState === 'failed'
                  ? 'Check found errors: the schematic follows the source text and may be incomplete until they are fixed.'
                  : 'Not checked yet: the schematic follows the source text. Run Check to confirm the design is valid VHDL.';
        this.panel.webview.html = this.html(model, problem, banner, this.panel.webview);
    }

    private html(model: SchematicModel | undefined, problem: string | undefined, banner: string, webview: vscode.Webview): string {
        const nonce = randomBytes(16).toString('base64');
        const viewUri = this.extensionUri ? webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'extension', 'schematic', 'schematic-view.js')).toString() : '';
        const crumbs = model
            ? model.path.map((p, i) => (i === model.path.length - 1 ? `<span class="here">${esc(p.label)}</span>` : `<a href="#" data-hid="${esc(p.id)}">${esc(p.label)}</a>`)).join(' › ')
            : '';
        const svg = model ? renderSchematicSvg(model) : undefined;
        this.shown = model && svg ? { svg, entity: model.entityName } : undefined;
        const body = svg ?? `<p class="problem">${esc(problem ?? '')}</p>`;
        const notes = model ? model.notes.map((n) => `<li>${esc(n)}</li>`).join('') : '';
        const pan = (this.nodeId && this.viewState.pans[this.nodeId]) || { x: 0, y: 0 };
        const init = JSON.stringify({ mode: this.viewState.view.mode, scale: this.viewState.view.scale, x: pan.x, y: pan.y, notesOpen: this.viewState.notesOpen, appearance: this.appearance.get() }).replace(/</g, '\\u003c');
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${schematicCsp(nonce, webview.cspSource)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  html, body { height: 100%; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 8px 12px; box-sizing: border-box; display: flex; flex-direction: column; }
  header { display: flex; gap: 6px 12px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
  header h1 { font-size: 13px; font-weight: 600; margin: 0; }
  nav { font-size: 13px; }
  nav a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  nav .here { font-weight: 600; }
  .banner { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); padding: 4px 8px; margin: 4px 0 8px; font-size: 12px; }
  details.notes { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 6px 0 0; }
  details.notes summary { cursor: pointer; }
  details.notes ul { margin: 4px 0 0; padding-left: 18px; }
  .problem { color: var(--vscode-errorForeground); }
${pageCss('design')}
</style></head>
<body>
<header>
  <h1>Design Schematic</h1>
  <nav>${crumbs}</nav>
  ${toolbarHtml()}
</header>
${banner ? `<div class="banner">${esc(banner)}</div>` : ''}
<div id="canvas" class="dark" tabindex="0" aria-label="Design schematic. Drag to pan, scroll wheel to zoom.">${body}</div>
<details class="notes" id="notes"><summary>About this view</summary><ul>${notes}<li>Component-level view from the VHDL source (entities, instances and port maps). It is not a synthesized gate-level netlist.</li></ul></details>
<script nonce="${nonce}">var exports = {};</script>
${viewUri ? `<script nonce="${nonce}" src="${esc(viewUri)}"></script>` : ''}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const INIT = ${init};
${commonScript(this.testHooks)}
  document.addEventListener('click', (e) => {
    if (drag && drag.moved) return;
    const drill = e.target.closest('[data-hid].drill, nav a[data-hid]');
    if (drill) { e.preventDefault(); vscode.postMessage({ type: 'drill', id: drill.dataset.hid }); return; }
    const target = e.target.closest('.block, .frame');
    if (target && target.dataset.file) vscode.postMessage({ type: 'open', file: target.dataset.file, line: Number(target.dataset.line), col: Number(target.dataset.col) });
  });
  document.addEventListener('keydown', (e) => {
    const b = document.activeElement && document.activeElement.closest && document.activeElement.closest('.block');
    if (b && e.key === 'Enter') vscode.postMessage({ type: 'open', file: b.dataset.file, line: Number(b.dataset.line), col: Number(b.dataset.col) });
  });
</script>
</body></html>`;
    }

    dispose(): void {
        this.sub.dispose();
        this.appearanceSub.dispose();
        this.panel?.dispose();
    }
}
