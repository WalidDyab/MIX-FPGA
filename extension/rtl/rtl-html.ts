import type { RtlModuleView, RtlNode } from './rtl-model';
import { renderRtlSvg } from './rtl-svg';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface RtlPageState {
    readonly kind: 'ready' | 'running' | 'message';
    readonly message?: string;
    /** The design changed since this schematic was generated. */
    readonly stale?: boolean;
    readonly generatedAt?: Date;
}

export interface RtlPageInput {
    readonly nonce: string;
    readonly state: RtlPageState;
    readonly view?: RtlModuleView;
    /** Breadcrumb of module names from the top (display names). */
    readonly path?: readonly { readonly module: string; readonly label: string }[];
}

/** Details shown when a block is clicked: everything the netlist says, nothing invented. */
export function nodeDetails(n: RtlNode): Record<string, unknown> {
    return {
        title: `${n.label}${n.sublabel ? ` — ${n.sublabel}` : ''}`,
        description: n.description,
        ...(n.rawType ? { rawType: n.rawType } : {}),
        name: n.name,
        width: n.width,
        pins: n.pins.map((p) => `${p.dir === 'in' ? '→' : '←'} ${p.label || p.name} (${p.name}, ${p.width} bit${p.width === 1 ? '' : 's'})`),
        ...(n.parameters && Object.keys(n.parameters).length ? { parameters: n.parameters } : {}),
        ...(n.source ? { source: n.source } : {}),
        ...(n.module ? { module: n.module } : {}),
    };
}

const LEGEND: Array<[string, string]> = [
    ['Register', 'flip-flops: store a value on the clock edge (▷ = clock input)'],
    ['MUX', 'multiplexer: picks input 0 or 1 with sel'],
    ['+ − = <', 'arithmetic and comparison'],
    ['AND OR XOR NOT', 'logic gates (reduce = all bits combined)'],
    ['{ }', 'concatenation of signals into one bus'],
    ['8\'hFF', 'constant'],
    ['dashed wire', 'feedback (an output fed back, e.g. a counter)'],
];

/** The RTL schematic webview page. Scripts run only with the nonce (strict CSP). */
export function renderRtlHtml(input: RtlPageInput): string {
    const { nonce, state, view } = input;
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
    const details = view ? Object.fromEntries(view.nodes.map((n) => [n.id, nodeDetails(n)])) : {};
    const crumbs = (input.path ?? [])
        .map((p, i, all) => (i === all.length - 1 ? `<span class="here">${esc(p.label)}</span>` : `<a href="#" data-module="${esc(p.module)}">${esc(p.label)}</a>`))
        .join(' › ');
    const summary = view ? Object.entries(view.summary).map(([k, v]) => `${v} ${k}`).join(' · ') : '';
    let banner = '';
    if (state.kind === 'running') banner = '<div class="banner info">Generating RTL schematic…</div>';
    else if (state.kind === 'message') banner = `<div class="banner warn">${esc(state.message ?? '')}</div>`;
    else if (state.stale) banner = '<div class="banner warn">The VHDL changed since this RTL schematic was generated. <a href="#" id="regen">Regenerate</a></div>';
    const body = view && state.kind === 'ready' ? renderRtlSvg(view) : '';
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RTL Schematic</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family, system-ui, sans-serif); color: var(--vscode-foreground, #222); background: var(--vscode-editor-background, #fff); margin: 0; padding: 8px 12px; }
  header { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 6px; }
  header h1 { font-size: 13px; font-weight: 600; margin: 0; }
  nav a, a { color: var(--vscode-textLink-foreground, #06c); text-decoration: none; cursor: pointer; }
  nav .here { font-weight: 600; }
  .summary { color: var(--vscode-descriptionForeground, #666); font-size: 12px; }
  .tools button { background: var(--vscode-button-secondaryBackground, #ddd); color: var(--vscode-button-secondaryForeground, #222); border: none; padding: 2px 8px; cursor: pointer; }
  .banner { padding: 4px 8px; margin: 4px 0 8px; font-size: 12px; border: 1px solid; }
  .banner.warn { background: var(--vscode-inputValidation-warningBackground, #fff4ce); border-color: var(--vscode-inputValidation-warningBorder, #c90); }
  .banner.info { background: var(--vscode-inputValidation-infoBackground, #e5f1fb); border-color: var(--vscode-inputValidation-infoBorder, #39f); }
  .layout { display: flex; gap: 8px; }
  #canvas { flex: 1 1 auto; min-width: 240px; overflow: hidden; border: 1px solid var(--vscode-panel-border, #ccc); height: calc(100vh - 120px); min-height: 260px; cursor: grab; position: relative; }
  #canvas svg { transform-origin: 0 0; position: absolute; left: 0; top: 0; }
  aside { flex: 0 1 260px; min-width: 150px; font-size: 12px; overflow: auto; height: calc(100vh - 120px); }
  /* Narrow editor columns: details and legend go under the drawing so the canvas keeps its width. */
  @media (max-width: 640px) { .layout { flex-direction: column; } #canvas { min-width: 0; height: 60vh; } aside { flex: none; height: auto; } }
  aside h2 { font-size: 12px; margin: 4px 0; }
  aside dl { margin: 0; } aside dt { font-weight: 600; margin-top: 4px; } aside dd { margin: 0 0 0 8px; word-break: break-all; }
  .legend td { padding: 1px 4px; vertical-align: top; }
  .rtl text { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; fill: var(--vscode-foreground, #222); }
  .rtl .sub, .rtl .pin-label, .rtl .width-label { font-size: 10px; fill: var(--vscode-descriptionForeground, #666); }
  .rtl .symbol { font-size: 18px; font-weight: 600; }
  .rtl .small { font-size: 11px; }
  .rtl .net-label { font-size: 10px; fill: var(--vscode-charts-blue, #1a6fd1); }
  .rtl .const-label { font-size: 11px; fill: var(--vscode-charts-orange, #c25e00); }
  .rtl .shape { fill: var(--vscode-editorWidget-background, #f6f6f6); stroke: var(--vscode-foreground, #333); stroke-width: 1.3; }
  .rtl .port { fill: var(--vscode-editor-background, #fff); stroke: var(--vscode-charts-green, #2e8b57); stroke-width: 1.6; }
  .rtl .reg { stroke: var(--vscode-charts-purple, #8a3ffc); stroke-width: 2; }
  .rtl .latch { stroke: var(--vscode-charts-red, #d02020); stroke-dasharray: 4 2; }
  .rtl .const { fill: none; stroke: var(--vscode-charts-orange, #c25e00); stroke-dasharray: 2 2; }
  .rtl .concat { fill: var(--vscode-foreground, #333); }
  .rtl .inst-inner { fill: none; }
  .rtl .generic { stroke-dasharray: 5 3; stroke: var(--vscode-editorWarning-foreground, #b80); }
  .rtl .clock-mark { fill: none; stroke: var(--vscode-foreground, #333); }
  .rtl .pin { stroke: var(--vscode-foreground, #333); }
  .rtl .wire { fill: none; stroke: var(--vscode-charts-blue, #1a6fd1); stroke-width: 1.3; }
  .rtl .wire.bus { stroke-width: 2.6; }
  .rtl .wire.feedback { stroke-dasharray: 6 3; }
  .rtl .node { cursor: pointer; }
  .rtl .node.selected .shape { stroke: var(--vscode-focusBorder, #f80); stroke-width: 3; }
  .rtl .drill { cursor: pointer; fill: var(--vscode-textLink-foreground, #06c); font-size: 14px; }
</style></head>
<body>
<header>
  <h1>RTL Schematic</h1>
  <nav>${crumbs}</nav>
  <span class="tools"><button id="fit">Fit</button> <button id="zin">+</button> <button id="zout">−</button> <button id="regen2">Regenerate</button></span>
  <span class="summary">${esc(summary)}${state.generatedAt ? ` · generated ${esc(state.generatedAt.toLocaleTimeString())}` : ''}</span>
</header>
${banner}
<div class="layout">
<div id="canvas">${body}</div>
<aside>
  <h2>Details</h2>
  <div id="details">Click a block for details.</div>
  <h2>Legend</h2>
  <table class="legend">${LEGEND.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>
  <p class="summary">Inferred hardware from synthesis of your VHDL (GHDL + Yosys RTL, before mapping to FPGA primitives). Not placed or routed.</p>
</aside>
</div>
<script nonce="${nonce}">
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };
  const DETAILS = ${JSON.stringify(details).replace(/</g, '\\u003c')};
  const canvas = document.getElementById('canvas');
  const svg = canvas.querySelector('svg');
  let scale = 1, tx = 0, ty = 0, selected = null;
  const report = () => vscode.postMessage({ type: 'state', scale, tx, ty, selected, cw: canvas.clientWidth, ch: canvas.clientHeight, nodes: svg ? svg.querySelectorAll('.node').length : 0, edges: svg ? svg.querySelectorAll('.wire').length : 0 });
  const apply = () => { if (svg) svg.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; report(); };
  const fit = () => {
    if (!svg) return report();
    // The panel may not be laid out yet: never fit to a zero-sized canvas (scale 0 would break zooming).
    if (!canvas.clientWidth || !canvas.clientHeight) { report(); setTimeout(fit, 150); return; }
    const w = svg.width.baseVal.value, h = svg.height.baseVal.value;
    scale = Math.max(0.05, Math.min(canvas.clientWidth / w, canvas.clientHeight / h, 1.6));
    tx = Math.max(0, (canvas.clientWidth - w * scale) / 2); ty = 4; apply();
  };
  const zoom = (f) => { if (!(scale > 0)) return fit(); const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2; tx = cx - (cx - tx) * f; ty = cy - (cy - ty) * f; scale *= f; apply(); };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const select = (id) => {
    selected = id;
    svg && svg.querySelectorAll('.node').forEach((n) => n.classList.toggle('selected', n.dataset.id === id));
    const d = DETAILS[id];
    const box = document.getElementById('details');
    if (!d) { box.textContent = 'Click a block for details.'; return report(); }
    let html = '<dl><dt>' + esc(d.title) + '</dt><dd>' + esc(d.description) + '</dd>';
    if (d.rawType) html += '<dt>Netlist cell</dt><dd>' + esc(d.rawType) + ' (' + esc(d.name) + ')</dd>';
    html += '<dt>Width</dt><dd>' + esc(d.width) + '</dd><dt>Pins</dt>' + d.pins.map((p) => '<dd>' + esc(p) + '</dd>').join('');
    if (d.parameters) html += '<dt>Parameters</dt>' + Object.entries(d.parameters).map(([k, v]) => '<dd>' + esc(k) + ' = ' + esc(v) + '</dd>').join('');
    if (d.source) html += '<dt>VHDL source</dt><dd><a href="#" id="src">' + esc(d.source.file + ':' + d.source.line) + '</a></dd>';
    else html += '<dt>VHDL source</dt><dd>not known exactly for this element</dd>';
    if (d.module) html += '<dd><a href="#" id="into">Show inside ⤵</a></dd>';
    box.innerHTML = html + '</dl>';
    const src = document.getElementById('src');
    if (src) src.onclick = (e) => { e.preventDefault(); vscode.postMessage({ type: 'open', file: d.source.file, line: d.source.line, col: d.source.col }); };
    const into = document.getElementById('into');
    if (into) into.onclick = (e) => { e.preventDefault(); vscode.postMessage({ type: 'drill', module: d.module }); };
    report();
  };
  document.getElementById('fit').onclick = fit;
  document.getElementById('zin').onclick = () => zoom(1.2);
  document.getElementById('zout').onclick = () => zoom(1 / 1.2);
  for (const id of ['regen', 'regen2']) { const b = document.getElementById(id); if (b) b.onclick = (e) => { e.preventDefault(); vscode.postMessage({ type: 'regenerate' }); }; }
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1); }, { passive: false });
  let drag;
  canvas.addEventListener('mousedown', (e) => { drag = { x: e.clientX - tx, y: e.clientY - ty, moved: false }; });
  window.addEventListener('mousemove', (e) => { if (drag) { tx = e.clientX - drag.x; ty = e.clientY - drag.y; drag.moved = true; apply(); } });
  window.addEventListener('mouseup', () => setTimeout(() => (drag = undefined), 0));
  document.addEventListener('click', (e) => {
    if (drag && drag.moved) return;
    const crumb = e.target.closest('nav a[data-module]');
    if (crumb) { e.preventDefault(); vscode.postMessage({ type: 'drill', module: crumb.dataset.module }); return; }
    const drill = e.target.closest('.drill');
    if (drill) { vscode.postMessage({ type: 'drill', module: drill.dataset.module }); return; }
    const node = e.target.closest('.node');
    if (node) select(node.dataset.id);
  });
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || m.type !== 'command') return;
    if (m.action === 'fit') fit();
    else if (m.action === 'zoomIn') zoom(1.2);
    else if (m.action === 'zoomOut') zoom(1 / 1.2);
    else if (m.action === 'pan') { tx += m.dx || 0; ty += m.dy || 0; apply(); }
    else if (m.action === 'select') select(m.id);
  });
  window.addEventListener('resize', fit);
  if (typeof ResizeObserver === 'function') { let first = true; new ResizeObserver(() => { if (first) { first = false; fit(); } }).observe(canvas); }
  fit();
</script>
</body></html>`;
}
