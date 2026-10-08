import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { StateStore } from '../services/project-state';
import type { NexysVhdlService } from '../services/nexys-service';
import { buildSchematic, type SchematicModel } from './schematic-model';
import { renderSchematicSvg } from './schematic-svg';
import { sanitizeViewState, type SchematicViewState, type ZoomMode } from './schematic-view';

type Message =
    | { type: 'open'; file: string; line: number; col: number }
    | { type: 'drill'; id: string }
    | { type: 'view'; mode: ZoomMode; scale: number; x: number; y: number; notesOpen: boolean; metrics?: Record<string, number> }
    | { type: 'maximize' };

/** Project-state key of the remembered zoom, scroll positions and notes state. */
export const SCHEMATIC_STATE_KEY = 'nexysvhdl.schematic.view';

/**
 * Page code that exists ONLY for automated validation (see SchematicPanel.testHooks): what the student sees in screen pixels, and
 * synthetic scroll/click commands. It is not part of the page unless a test turns the flag on, so a student installation never
 * carries it.
 */
const TEST_METRICS_JS = `  // What the student actually sees, in screen pixels: used by validation to prove the text stays readable.
  function metrics() {
    const px = (sel) => { const el = svg && svg.querySelector(sel); return el ? Math.round(parseFloat(getComputedStyle(el).fontSize) * scale * 10) / 10 : 0; };
    const box = (sel) => { const el = svg && svg.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().width) : 0; };
    return { blockLabelPx: px('.block-label'), pinLabelPx: px('.pin-label'), netLabelPx: px('.net-label'), blockWidthPx: box('.block > rect'), blocks: svg ? svg.querySelectorAll('.block').length : 0,
      svgW: BASE.w, svgH: BASE.h, canvasW: canvas.clientWidth, canvasH: canvas.clientHeight, scrollW: canvas.scrollWidth, scrollH: canvas.scrollHeight };
  }`;
const TEST_COMMANDS_JS = `    else if (m.action === 'scroll') { canvas.scrollLeft = m.x || 0; canvas.scrollTop = m.y || 0; report(); }
    else if (m.action === 'click') { const el = document.querySelector(m.selector); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The Design Schematic webview: a component-level block diagram of one hierarchy level, re-rendered
 * whenever the design index changes (on save). Blocks open their instantiation; ⤵ goes one level
 * down; the breadcrumb goes back up.
 *
 * It opens as an ordinary editor tab in the active editor group and at 100%: readable first. The
 * student pans and zooms (100%, Fit Width, Fit All, +, −, Reset) and the choice, with the scroll
 * position of every hierarchy level, is remembered with the project and survives the automatic
 * re-render after a save.
 */
export class SchematicPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private nodeId: string | undefined;
    private readonly sub: { dispose(): void };
    /** Validation only: adds the test-only page code (metrics, synthetic scroll/click). Off in every normal session. */
    testHooks = false;
    /** The zoom and scroll state the page last reported (also what is stored with the project). */
    viewState: SchematicViewState;
    /** Last state message from the page (integration tests). */
    lastView: { mode: ZoomMode; scale: number; x: number; y: number; node: string | undefined; metrics: Record<string, number> } | undefined;

    constructor(
        private readonly service: NexysVhdlService,
        private readonly extensionUri?: vscode.Uri,
        private readonly memory?: StateStore,
    ) {
        this.viewState = sanitizeViewState(memory?.get(SCHEMATIC_STATE_KEY));
        this.sub = service.onDidChange((k) => {
            if ((k === 'project' || k === 'workflow') && this.panel) this.render();
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
            // The active editor group: a normal tab, not a narrow column beside the code.
            this.panel = vscode.window.createWebviewPanel('nexysvhdl.schematic', 'Design Schematic', vscode.ViewColumn.Active, {
                enableScripts: true,
                localResourceRoots: scripts,
                retainContextWhenHidden: false,
            });
            this.panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
            this.panel.onDidDispose(() => (this.panel = undefined));
            this.panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m));
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
        const testHooks = this.testHooks;
        const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}' ${webview.cspSource};`;
        const crumbs = model
            ? model.path.map((p, i) => (i === model.path.length - 1 ? `<span class="here">${esc(p.label)}</span>` : `<a href="#" data-hid="${esc(p.id)}">${esc(p.label)}</a>`)).join(' › ')
            : '';
        const body = model ? renderSchematicSvg(model) : `<p class="problem">${esc(problem ?? '')}</p>`;
        const notes = model ? model.notes.map((n) => `<li>${esc(n)}</li>`).join('') : '';
        const pan = (this.nodeId && this.viewState.pans[this.nodeId]) || { x: 0, y: 0 };
        const init = JSON.stringify({ mode: this.viewState.view.mode, scale: this.viewState.view.scale, x: pan.x, y: pan.y, notesOpen: this.viewState.notesOpen }).replace(/</g, '\\u003c');
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  html, body { height: 100%; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 8px 12px; box-sizing: border-box; display: flex; flex-direction: column; }
  header { display: flex; gap: 6px 12px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
  header h1 { font-size: 13px; font-weight: 600; margin: 0; }
  nav { font-size: 13px; }
  nav a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  nav .here { font-weight: 600; }
  .tools { display: inline-flex; gap: 4px; align-items: center; margin-left: auto; flex-wrap: wrap; }
  .tools button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 9px; cursor: pointer; font: inherit; font-size: 12px; }
  .tools button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .tools button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .tools .zoom { min-width: 3.4em; text-align: center; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .tools .gap { width: 8px; }
  .banner { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); padding: 4px 8px; margin: 4px 0 8px; font-size: 12px; }
  #canvas { overflow: auto; border: 1px solid var(--vscode-panel-border); flex: 1 1 auto; min-height: 240px; cursor: grab; position: relative; }
  #canvas.dragging { cursor: grabbing; user-select: none; }
  #canvas svg { display: block; margin: 0 auto; }
  .schematic text { font-family: var(--vscode-editor-font-family); font-size: 13px; fill: var(--vscode-foreground); }
  .frame rect { fill: none; stroke: var(--vscode-descriptionForeground); stroke-width: 1.5; stroke-dasharray: 6 3; }
  .frame-title { font-weight: 600; font-size: 14px !important; }
  .terminal polygon { fill: var(--vscode-editor-background); stroke: var(--vscode-foreground); }
  .block rect { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-focusBorder); stroke-width: 1.5; cursor: pointer; }
  .block rect.replica { fill: none; stroke-dasharray: 3 2; }
  .block:hover rect, .block:focus rect { stroke-width: 2.5; }
  .block.status-unresolved rect, .block.status-external rect { stroke: var(--vscode-editorWarning-foreground); stroke-dasharray: 5 3; }
  .block-label { font-weight: 600; font-size: 14px !important; }
  .block-entity { fill: var(--vscode-descriptionForeground) !important; }
  .drill { cursor: pointer; fill: var(--vscode-textLink-foreground) !important; font-size: 17px !important; }
  .pin { stroke: var(--vscode-foreground); }
  .pin-label, .pin-detail, .expr-label { font-size: 12px !important; }
  .expr-label { fill: var(--vscode-descriptionForeground) !important; font-style: italic; }
  .wire { fill: none; stroke: var(--vscode-charts-blue); stroke-width: 1.75; }
  .net-port .wire { stroke: var(--vscode-charts-green); }
  .wire.stub { stroke-dasharray: 3 2; }
  .wire.conflict { stroke: var(--vscode-charts-red); stroke-dasharray: 4 2; }
  .net-label { font-size: 12px !important; fill: var(--vscode-charts-blue) !important; }
  .net-port .net-label { fill: var(--vscode-charts-green) !important; }
  details.notes { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 6px 0 0; }
  details.notes summary { cursor: pointer; }
  details.notes ul { margin: 4px 0 0; padding-left: 18px; }
  .problem { color: var(--vscode-errorForeground); }
</style></head>
<body>
<header>
  <h1>Design Schematic</h1>
  <nav>${crumbs}</nav>
  <span class="tools" role="toolbar" aria-label="Schematic view">
    <button id="b100" title="Actual size: text is always readable">100%</button>
    <button id="bwidth" title="Scale so the whole width fits the window">Fit Width</button>
    <button id="ball" title="Scale so the whole schematic fits the window (may be small for big designs)">Fit All</button>
    <span class="gap"></span>
    <button id="zout" title="Zoom out">−</button><span class="zoom" id="zoomlabel">100%</span><button id="zin" title="Zoom in">+</button>
    <span class="gap"></span>
    <button id="reset" title="Back to 100% at the top left">Reset</button>
    <button id="maximize" title="Give the schematic the whole editor area (click again to restore)">Maximize</button>
  </span>
</header>
${banner ? `<div class="banner">${esc(banner)}</div>` : ''}
<div id="canvas" tabindex="0" aria-label="Design schematic. Drag to pan, scroll wheel to zoom.">${body}</div>
<details class="notes" id="notes"><summary>About this view</summary><ul>${notes}<li>Component-level view from the VHDL source (entities, instances and port maps). It is not a synthesized gate-level netlist.</li></ul></details>
<script nonce="${nonce}">var exports = {};</script>
${viewUri ? `<script nonce="${nonce}" src="${esc(viewUri)}"></script>` : ''}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const INIT = ${init};
  const V = exports;
  const canvas = document.getElementById('canvas');
  const svg = canvas.querySelector('svg');
  const label = document.getElementById('zoomlabel');
  const notes = document.getElementById('notes');
  const buttons = { '100': document.getElementById('b100'), width: document.getElementById('bwidth'), all: document.getElementById('ball') };
  notes.open = INIT.notesOpen;
  let mode = INIT.mode, scale = INIT.scale;
  const BASE = svg ? { w: svg.viewBox.baseVal.width, h: svg.viewBox.baseVal.height } : { w: 0, h: 0 };
  const viewport = () => ({ w: Math.max(1, canvas.clientWidth - 2), h: Math.max(1, canvas.clientHeight - 2) });
  let timer = 0;
${testHooks ? TEST_METRICS_JS : "  const metrics = () => ({});"}
  function report() {
    clearTimeout(timer);
    timer = setTimeout(() => vscode.postMessage({ type: 'view', mode: mode, scale: scale, x: canvas.scrollLeft, y: canvas.scrollTop, notesOpen: notes.open, metrics: metrics() }), 200);
  }
  function paint() {
    if (!svg) return;
    svg.setAttribute('width', String(Math.round(BASE.w * scale)));
    svg.setAttribute('height', String(Math.round(BASE.h * scale)));
    label.textContent = Math.round(scale * 100) + '%';
    for (const k of Object.keys(buttons)) buttons[k].classList.toggle('on', mode === k);
  }
  // Re-scales keeping the schematic point under (ax, ay) fixed, so zooming feels anchored.
  function setScale(next, ax, ay) {
    const old = scale;
    scale = V.clampScale(next);
    paint();
    if (ax !== undefined && old > 0) {
      canvas.scrollLeft = (canvas.scrollLeft + ax) * (scale / old) - ax;
      canvas.scrollTop = (canvas.scrollTop + ay) * (scale / old) - ay;
    }
    report();
  }
  function setMode(m, toOrigin) {
    mode = m;
    if (!svg) return;
    if (!canvas.clientWidth || !canvas.clientHeight) { setTimeout(() => setMode(m, toOrigin), 150); return; }
    scale = V.computeScale(m, BASE, viewport(), scale);
    paint();
    if (toOrigin) { canvas.scrollLeft = 0; canvas.scrollTop = 0; }
    report();
  }
  const zoomBy = (f, ax, ay) => { mode = 'custom'; setScale(scale * f, ax, ay); };
  const centre = () => [canvas.clientWidth / 2, canvas.clientHeight / 2];
  document.getElementById('b100').onclick = () => setMode('100', true);
  document.getElementById('bwidth').onclick = () => setMode('width', true);
  document.getElementById('ball').onclick = () => setMode('all', true);
  document.getElementById('reset').onclick = () => setMode('100', true);
  document.getElementById('zin').onclick = () => { const c = centre(); zoomBy(1.2, c[0], c[1]); };
  document.getElementById('zout').onclick = () => { const c = centre(); zoomBy(1 / 1.2, c[0], c[1]); };
  document.getElementById('maximize').onclick = () => vscode.postMessage({ type: 'maximize' });
  notes.addEventListener('toggle', report);
  canvas.addEventListener('scroll', report);
  canvas.addEventListener('wheel', (e) => {
    if (e.shiftKey) { e.preventDefault(); canvas.scrollLeft += e.deltaY; return; }
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  let drag;
  canvas.addEventListener('mousedown', (e) => { if (e.button === 0) { drag = { x: e.clientX, y: e.clientY, l: canvas.scrollLeft, t: canvas.scrollTop, moved: false }; } });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; canvas.classList.add('dragging'); }
    if (drag.moved) { canvas.scrollLeft = drag.l - dx; canvas.scrollTop = drag.t - dy; }
  });
  window.addEventListener('mouseup', () => { canvas.classList.remove('dragging'); setTimeout(() => (drag = undefined), 0); });
  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.closest && e.target.closest('.block')) return;
    if (e.key === '+' || e.key === '=') { const c = centre(); zoomBy(1.2, c[0], c[1]); } else if (e.key === '-') { const c = centre(); zoomBy(1 / 1.2, c[0], c[1]); } else if (e.key === '0') setMode('100', true);
  });
  let resizing = 0;
  new ResizeObserver(() => {
    if (mode !== 'width' && mode !== 'all') return;
    cancelAnimationFrame(resizing);
    resizing = requestAnimationFrame(() => setMode(mode, false));
  }).observe(canvas);
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
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || m.type !== 'command') return;
    if (m.action === '100' || m.action === 'width' || m.action === 'all') setMode(m.action, true);
    else if (m.action === 'reset') setMode('100', true);
    else if (m.action === 'zoomIn') { const c = centre(); zoomBy(1.2, c[0], c[1]); }
    else if (m.action === 'zoomOut') { const c = centre(); zoomBy(1 / 1.2, c[0], c[1]); }
${testHooks ? TEST_COMMANDS_JS : ""}
  });
  // Open: the remembered zoom (100% the first time), at the remembered scroll position of this level.
  (function start() {
    if (!svg) return;
    if (!canvas.clientWidth || !canvas.clientHeight) { setTimeout(start, 100); return; }
    if (mode === 'custom') { scale = V.clampScale(scale); paint(); } else { scale = V.computeScale(mode, BASE, viewport(), scale); paint(); }
    canvas.scrollLeft = INIT.x; canvas.scrollTop = INIT.y;
    report();
  })();
</script>
</body></html>`;
    }

    dispose(): void {
        this.sub.dispose();
        this.panel?.dispose();
    }
}
