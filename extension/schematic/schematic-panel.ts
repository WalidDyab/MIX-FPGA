import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { NexysVhdlService } from '../services/nexys-service';
import { buildSchematic, type SchematicModel } from './schematic-model';
import { renderSchematicSvg } from './schematic-svg';

type Message = { type: 'open'; file: string; line: number; col: number } | { type: 'drill'; id: string };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The Design Schematic webview: a component-level block diagram of one
 * hierarchy level, re-rendered whenever the design index changes (on save).
 * Blocks open their instantiation; ⤵ goes one level down; the breadcrumb
 * goes back up.
 */
export class SchematicPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private nodeId: string | undefined;
    private readonly sub: { dispose(): void };

    constructor(private readonly service: NexysVhdlService) {
        this.sub = service.onDidChange((k) => {
            if ((k === 'project' || k === 'workflow') && this.panel) this.render();
        });
    }

    /** Shows the schematic of hierarchy node `id` (default: the top entity). */
    show(id?: string): void {
        this.nodeId = id;
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel('nexysvhdl.schematic', 'Design Schematic', vscode.ViewColumn.Two, {
                enableScripts: true,
                localResourceRoots: [],
                retainContextWhenHidden: false,
            });
            this.panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
            this.panel.onDidDispose(() => (this.panel = undefined));
            this.panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m));
        } else {
            this.panel.reveal(undefined, true);
        }
        this.render();
    }

    private onMessage(m: Message): void {
        const root = this.service.projectRoot;
        if (m.type === 'open' && root && m.file) {
            void vscode.commands.executeCommand('nexysvhdl.openLocation', root, m.file, m.line, m.col);
        } else if (m.type === 'drill') {
            this.nodeId = m.id;
            this.render();
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
        this.panel.webview.html = this.html(model, problem, banner);
    }

    private html(model: SchematicModel | undefined, problem: string | undefined, banner: string): string {
        const nonce = randomBytes(16).toString('base64');
        const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
        const crumbs = model
            ? model.path.map((p, i) => (i === model.path.length - 1 ? `<span class="here">${esc(p.label)}</span>` : `<a href="#" data-hid="${esc(p.id)}">${esc(p.label)}</a>`)).join(' › ')
            : '';
        const body = model ? renderSchematicSvg(model) : `<p class="problem">${esc(problem ?? '')}</p>`;
        const notes = model ? model.notes.map((n) => `<li>${esc(n)}</li>`).join('') : '';
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 8px 12px; }
  header { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 6px; }
  header h1 { font-size: 13px; font-weight: 600; margin: 0; }
  nav a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  nav .here { font-weight: 600; }
  .tools button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 8px; cursor: pointer; }
  .banner { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); padding: 4px 8px; margin: 4px 0 8px; font-size: 12px; }
  #canvas { overflow: hidden; border: 1px solid var(--vscode-panel-border); height: calc(100vh - 150px); min-height: 240px; cursor: grab; }
  #canvas svg { transform-origin: 0 0; }
  .schematic text { font-family: var(--vscode-editor-font-family); font-size: 12px; fill: var(--vscode-foreground); }
  .frame rect { fill: none; stroke: var(--vscode-descriptionForeground); stroke-width: 1.5; stroke-dasharray: 6 3; }
  .frame-title { font-weight: 600; }
  .terminal polygon { fill: var(--vscode-editor-background); stroke: var(--vscode-foreground); }
  .block rect { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-focusBorder); stroke-width: 1.5; cursor: pointer; }
  .block rect.replica { fill: none; stroke-dasharray: 3 2; }
  .block:hover rect, .block:focus rect { stroke-width: 2.5; }
  .block.status-unresolved rect, .block.status-external rect { stroke: var(--vscode-editorWarning-foreground); stroke-dasharray: 5 3; }
  .block-label { font-weight: 600; }
  .block-entity { fill: var(--vscode-descriptionForeground) !important; }
  .drill { cursor: pointer; fill: var(--vscode-textLink-foreground) !important; font-size: 14px !important; }
  .pin { stroke: var(--vscode-foreground); }
  .pin-label, .pin-detail, .expr-label { font-size: 11px !important; }
  .expr-label { fill: var(--vscode-descriptionForeground) !important; font-style: italic; }
  .wire { fill: none; stroke: var(--vscode-charts-blue); stroke-width: 1.5; }
  .net-port .wire { stroke: var(--vscode-charts-green); }
  .wire.stub { stroke-dasharray: 3 2; }
  .wire.conflict { stroke: var(--vscode-charts-red); stroke-dasharray: 4 2; }
  .net-label { font-size: 11px !important; fill: var(--vscode-charts-blue) !important; }
  .net-port .net-label { fill: var(--vscode-charts-green) !important; }
  ul.notes { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 6px 0 0; padding-left: 18px; }
  .problem { color: var(--vscode-errorForeground); }
</style></head>
<body>
<header>
  <h1>Design Schematic</h1>
  <nav>${crumbs}</nav>
  <span class="tools"><button id="fit">Fit</button> <button id="zin">+</button> <button id="zout">−</button></span>
</header>
${banner ? `<div class="banner">${esc(banner)}</div>` : ''}
<div id="canvas">${body}</div>
<ul class="notes">${notes}<li>Component-level view from the VHDL source (entities, instances and port maps). It is not a synthesized gate-level netlist.</li></ul>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('canvas');
  const svg = canvas.querySelector('svg');
  let scale = 1, tx = 0, ty = 0;
  const apply = () => { if (svg) svg.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; };
  const fit = () => {
    if (!svg) return;
    if (!canvas.clientWidth || !canvas.clientHeight) { setTimeout(fit, 150); return; }
    const w = svg.width.baseVal.value, h = svg.height.baseVal.value;
    scale = Math.max(0.05, Math.min(canvas.clientWidth / w, canvas.clientHeight / h, 1.5));
    tx = (canvas.clientWidth - w * scale) / 2; ty = 8; apply();
  };
  document.getElementById('fit').onclick = fit;
  document.getElementById('zin').onclick = () => { scale *= 1.2; apply(); };
  document.getElementById('zout').onclick = () => { scale /= 1.2; apply(); };
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); scale *= e.deltaY < 0 ? 1.1 : 1 / 1.1; apply(); }, { passive: false });
  let drag;
  canvas.addEventListener('mousedown', (e) => { drag = { x: e.clientX - tx, y: e.clientY - ty, moved: false }; });
  window.addEventListener('mousemove', (e) => { if (drag) { tx = e.clientX - drag.x; ty = e.clientY - drag.y; drag.moved = true; apply(); } });
  window.addEventListener('mouseup', () => { setTimeout(() => (drag = undefined), 0); });
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
  fit();
</script>
</body></html>`;
    }

    dispose(): void {
        this.sub.dispose();
        this.panel?.dispose();
    }
}
