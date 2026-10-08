import { commonScript, pageCss, schematicCsp, toolbarHtml } from '../schematic/schematic-chrome';
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
    /** Webview CSP source and the URI of the compiled schematic-view.js (absent in a standalone preview). */
    readonly cspSource?: string;
    readonly viewUri?: string;
    /** Remembered zoom mode and scroll position, and the Dark/Light choice. */
    readonly init?: { readonly mode: string; readonly scale: number; readonly x: number; readonly y: number; readonly appearance: string };
    /** Validation only: include the test-only page code. */
    readonly testHooks?: boolean;
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
    const csp = schematicCsp(nonce, input.cspSource ?? '');
    const init = JSON.stringify({ mode: 'all', scale: 1, x: 0, y: 0, notesOpen: false, appearance: 'dark', ...(input.init ?? {}) }).replace(/</g, '\\u003c');
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
  html, body { height: 100%; }
  body { font-family: var(--vscode-font-family, system-ui, sans-serif); color: var(--vscode-foreground, #222); background: var(--vscode-editor-background, #fff); margin: 0; padding: 8px 12px; box-sizing: border-box; display: flex; flex-direction: column; }
  header { display: flex; gap: 6px 12px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
  header h1 { font-size: 13px; font-weight: 600; margin: 0; }
  nav a, a { color: var(--vscode-textLink-foreground, #06c); text-decoration: none; cursor: pointer; }
  nav .here { font-weight: 600; }
  .summary { color: var(--vscode-descriptionForeground, #666); font-size: 12px; }
  .regen { background: var(--vscode-button-secondaryBackground, #ddd); color: var(--vscode-button-secondaryForeground, #222); border: none; padding: 3px 9px; cursor: pointer; font: inherit; font-size: 12px; }
  .banner { padding: 4px 8px; margin: 4px 0 8px; font-size: 12px; border: 1px solid; }
  .banner.warn { background: var(--vscode-inputValidation-warningBackground, #fff4ce); border-color: var(--vscode-inputValidation-warningBorder, #c90); }
  .banner.info { background: var(--vscode-inputValidation-infoBackground, #e5f1fb); border-color: var(--vscode-inputValidation-infoBorder, #39f); }
  .layout { display: flex; gap: 8px; flex: 1 1 auto; min-height: 0; }
  #canvas { min-width: 240px; }
  aside { flex: 0 1 260px; min-width: 150px; font-size: 12px; overflow: auto; }
  /* Narrow editor columns: details and legend go under the drawing so the canvas keeps its width. */
  @media (max-width: 640px) { .layout { flex-direction: column; } #canvas { min-width: 0; height: 60vh; } aside { flex: none; height: auto; } }
  aside h2 { font-size: 12px; margin: 4px 0; }
  aside dl { margin: 0; } aside dt { font-weight: 600; margin-top: 4px; } aside dd { margin: 0 0 0 8px; word-break: break-all; }
  .legend td { padding: 1px 4px; vertical-align: top; }
${pageCss('rtl')}
</style></head>
<body>
<header>
  <h1>RTL Schematic</h1>
  <nav>${crumbs}</nav>
  ${toolbarHtml()}
  <button id="regen2" class="regen">Regenerate</button>
  <span class="summary">${esc(summary)}${state.generatedAt ? ` · generated ${esc(state.generatedAt.toLocaleTimeString())}` : ''}</span>
</header>
${banner}
<div class="layout">
<div id="canvas" class="dark">${body}</div>
<aside>
  <h2>Details</h2>
  <div id="details">Click a block for details.</div>
  <h2>Legend</h2>
  <table class="legend">${LEGEND.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>
  <p class="summary">Inferred hardware from synthesis of your VHDL (GHDL + Yosys RTL, before mapping to FPGA primitives). Not placed or routed.</p>
</aside>
</div>
<script nonce="${nonce}">var exports = {};</script>
${input.viewUri ? `<script nonce="${nonce}" src="${esc(input.viewUri)}"></script>` : ''}
<script nonce="${nonce}">
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };
  const DETAILS = ${JSON.stringify(details).replace(/</g, '\\u003c')};
  const INIT = ${init};
${commonScript(input.testHooks === true)}
  // The RTL page also reports a compact state (used by validation and kept from earlier phases).
  let selected = null;
  const reportState = () => vscode.postMessage({ type: 'state', scale, tx: -canvas.scrollLeft, ty: -canvas.scrollTop, mode, selected, cw: canvas.clientWidth, ch: canvas.clientHeight, nodes: svg ? svg.querySelectorAll('.node').length : 0, edges: svg ? svg.querySelectorAll('.wire').length : 0 });
  const baseReport = report;
  report = function () { baseReport(); reportState(); };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const select = (id) => {
    selected = id;
    svg && svg.querySelectorAll('.node').forEach((n) => n.classList.toggle('selected', n.dataset.id === id));
    const d = DETAILS[id];
    const box = document.getElementById('details');
    if (!d) { box.textContent = 'Click a block for details.'; return reportState(); }
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
    reportState();
  };
  for (const id of ['regen', 'regen2']) { const b = document.getElementById(id); if (b) b.onclick = (e) => { e.preventDefault(); vscode.postMessage({ type: 'regenerate' }); }; }
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
    if (m.action === 'fit') setMode('all', true);
    else if (m.action === 'pan') { canvas.scrollLeft -= m.dx || 0; canvas.scrollTop -= m.dy || 0; reportState(); }
    else if (m.action === 'select') select(m.id);
  });
  canvas.addEventListener('scroll', reportState);
  reportState();
</script>
</body></html>`;
}
