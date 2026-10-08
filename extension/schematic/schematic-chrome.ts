import type { StateStore } from '../services/project-state';

/**
 * What the Design Schematic and the RTL Schematic share: the Dark/Light palette, the diagram styles, the toolbar, the zoom/pan/
 * appearance/export page script, and standalone SVG for export. Free of the VS Code API so it is unit-tested.
 */

export type SchematicAppearance = 'dark' | 'light';
export type DiagramKind = 'design' | 'rtl';

/** Project-state key of the Dark/Light choice, shared by both schematics. */
export const APPEARANCE_STATE_KEY = 'nexysvhdl.schematic.appearance';

export function sanitizeAppearance(value: unknown): SchematicAppearance {
    return value === 'light' ? 'light' : 'dark';
}

/** The remembered Dark/Light choice: one preference for both schematics, kept with the project. */
export class AppearanceStore {
    private listeners = new Set<(a: SchematicAppearance) => void>();
    private current: SchematicAppearance | undefined;

    constructor(private readonly state?: StateStore) {}

    get(): SchematicAppearance {
        return sanitizeAppearance(this.state?.get(APPEARANCE_STATE_KEY) ?? this.current);
    }

    set(value: SchematicAppearance): void {
        if (value === this.get()) return;
        this.current = value;
        void this.state?.update(APPEARANCE_STATE_KEY, value);
        for (const l of [...this.listeners]) l(value);
    }

    onDidChange(l: (a: SchematicAppearance) => void): { dispose(): void } {
        this.listeners.add(l);
        return { dispose: () => this.listeners.delete(l) };
    }
}

/** Colour tokens of a schematic. Both palettes keep every element (blocks, labels, pins, wires, hover, selection) legible. */
export const PALETTES: Record<SchematicAppearance, Record<string, string>> = {
    dark: {
        bg: '#141a24', fg: '#dbe3ef', muted: '#93a0b4', link: '#58a6ff', fill: '#202a38', stroke: '#58a6ff', blue: '#5aa9ff', green: '#4cd68a',
        red: '#ff6b6b', orange: '#ffa657', purple: '#c297ff', warn: '#e6b84a', focus: '#ffa657', border: '#34425a',
    },
    light: {
        bg: '#ffffff', fg: '#1f2328', muted: '#57606a', link: '#0969da', fill: '#eef3f9', stroke: '#0969da', blue: '#0b62c4', green: '#1a7f37',
        red: '#c62828', orange: '#b54708', purple: '#7a3fd0', warn: '#8a5a00', focus: '#b54708', border: '#b8c4d4',
    },
};

const FONT_PAGE = 'var(--vscode-editor-font-family, monospace)';
const FONT_EXPORT = "'Cascadia Mono', Consolas, 'DejaVu Sans Mono', 'Courier New', monospace";

/** Colour reference: a CSS variable in the page, a concrete colour in an exported file. */
type Tone = (token: string) => string;
const inPage: Tone = (t) => `var(--sch-${t})`;
const concrete = (a: SchematicAppearance): Tone => (t) => PALETTES[a][t] ?? '#888';

/** Styles of one diagram kind. Same rules in the page and in an exported file; only the colour source differs. */
export function diagramCss(kind: DiagramKind, c: Tone, font: string): string {
    if (kind === 'design') {
        return `
  .schematic text { font-family: ${font}; font-size: 13px; fill: ${c('fg')}; }
  .frame rect { fill: none; stroke: ${c('muted')}; stroke-width: 1.5; stroke-dasharray: 6 3; }
  .frame-title { font-weight: 600; font-size: 14px !important; }
  .terminal polygon { fill: ${c('bg')}; stroke: ${c('fg')}; }
  .block rect { fill: ${c('fill')}; stroke: ${c('stroke')}; stroke-width: 1.5; cursor: pointer; }
  .block rect.replica { fill: none; stroke-dasharray: 3 2; }
  .block:hover rect, .block:focus rect { stroke-width: 2.5; stroke: ${c('focus')}; }
  .block.status-unresolved rect, .block.status-external rect { stroke: ${c('warn')}; stroke-dasharray: 5 3; }
  .block-label { font-weight: 600; font-size: 14px !important; }
  .block-entity { fill: ${c('muted')} !important; }
  .drill { cursor: pointer; fill: ${c('link')} !important; font-size: 17px !important; }
  .pin { stroke: ${c('fg')}; }
  .pin-label, .pin-detail, .expr-label { font-size: 12px !important; }
  .expr-label { fill: ${c('muted')} !important; font-style: italic; }
  .wire { fill: none; stroke: ${c('blue')}; stroke-width: 1.75; }
  .net-port .wire { stroke: ${c('green')}; }
  .wire.stub { stroke-dasharray: 3 2; }
  .wire.conflict { stroke: ${c('red')}; stroke-dasharray: 4 2; }
  .net-label { font-size: 12px !important; fill: ${c('blue')} !important; }
  .net-port .net-label { fill: ${c('green')} !important; }`;
    }
    return `
  .rtl text { font-family: ${font}; font-size: 12px; fill: ${c('fg')}; }
  .rtl .sub, .rtl .pin-label, .rtl .width-label { font-size: 10px; fill: ${c('muted')}; }
  .rtl .symbol { font-size: 18px; font-weight: 600; }
  .rtl .small { font-size: 11px; }
  .rtl .net-label { font-size: 10px; fill: ${c('blue')}; }
  .rtl .const-label { font-size: 11px; fill: ${c('orange')}; }
  .rtl .shape { fill: ${c('fill')}; stroke: ${c('fg')}; stroke-width: 1.3; }
  .rtl .port { fill: ${c('bg')}; stroke: ${c('green')}; stroke-width: 1.6; }
  .rtl .reg { stroke: ${c('purple')}; stroke-width: 2; }
  .rtl .latch { stroke: ${c('red')}; stroke-dasharray: 4 2; }
  .rtl .const { fill: none; stroke: ${c('orange')}; stroke-dasharray: 2 2; }
  .rtl .concat { fill: ${c('fg')}; }
  .rtl .inst-inner { fill: none; }
  .rtl .generic { stroke-dasharray: 5 3; stroke: ${c('warn')}; }
  .rtl .clock-mark { fill: none; stroke: ${c('fg')}; }
  .rtl .pin { stroke: ${c('fg')}; }
  .rtl .wire { fill: none; stroke: ${c('blue')}; stroke-width: 1.3; }
  .rtl .wire.bus { stroke-width: 2.6; }
  .rtl .wire.feedback { stroke-dasharray: 6 3; }
  .rtl .node { cursor: pointer; }
  .rtl .node.selected .shape { stroke: ${c('focus')}; stroke-width: 3; }
  .rtl .node:hover .shape { stroke: ${c('focus')}; }
  .rtl .drill { cursor: pointer; fill: ${c('link')}; font-size: 14px; }`;
}

/** CSS of the page: both palettes as variables on the canvas, the diagram styles, the toolbar and the canvas. */
export function pageCss(kind: DiagramKind): string {
    const vars = (a: SchematicAppearance) =>
        Object.entries(PALETTES[a])
            .map(([k, v]) => `--sch-${k}: ${v};`)
            .join(' ');
    return `
  #canvas.dark { ${vars('dark')} }
  #canvas.light { ${vars('light')} }
  #canvas { background: var(--sch-bg); color: var(--sch-fg); }
  .tools { display: inline-flex; gap: 4px; align-items: center; margin-left: auto; flex-wrap: wrap; }
  .tools button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 9px; cursor: pointer; font: inherit; font-size: 12px; }
  .tools button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .tools button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .tools .zoom { min-width: 3.4em; text-align: center; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .tools .gap { width: 8px; }
  #canvas { overflow: auto; border: 1px solid var(--vscode-panel-border); flex: 1 1 auto; min-height: 240px; cursor: grab; position: relative; }
  #canvas.dragging { cursor: grabbing; user-select: none; }
  #canvas svg { display: block; margin: 0 auto; }
  ${diagramCss(kind, inPage, FONT_PAGE)}`;
}

/** The toolbar both schematics share. */
export function toolbarHtml(): string {
    return `<span class="tools" role="toolbar" aria-label="Schematic view">
    <button id="b100" title="Actual size: text is always readable">100%</button>
    <button id="bwidth" title="Scale so the whole width fits the window">Fit Width</button>
    <button id="ball" title="Scale so the whole schematic fits the window (never below a readable size: bigger designs scroll)">Fit All</button>
    <span class="gap"></span>
    <button id="zout" title="Zoom out">−</button><span class="zoom" id="zoomlabel">100%</span><button id="zin" title="Zoom in">+</button>
    <span class="gap"></span>
    <button id="reset" title="Back to Fit All at the top left">Reset</button>
    <button id="bmode" title="Switch the schematic background between Dark and Light">Dark</button>
    <button id="bsvg" title="Save the whole schematic as an SVG file (vector)">Export SVG…</button>
    <button id="bpng" title="Save the whole schematic as a PNG picture">Export PNG…</button>
    <button id="maximize" title="Give the schematic the whole editor area (click again to restore)">Maximize</button>
  </span>`;
}

/**
 * Page code that exists ONLY for automated validation (a panel's testHooks flag): what the student sees in screen pixels, and
 * synthetic scroll/click commands. It is not part of the page unless a test turns the flag on.
 */
export const TEST_METRICS_JS = `  function metrics() {
    const px = (sel) => { const el = svg && svg.querySelector(sel); return el ? Math.round(parseFloat(getComputedStyle(el).fontSize) * scale * 10) / 10 : 0; };
    const box = (sel) => { const el = svg && svg.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().width) : 0; };
    return { blockLabelPx: px('.block-label') || px('.rtl .label'), pinLabelPx: px('.pin-label'), netLabelPx: px('.net-label'), blockWidthPx: box('.block > rect') || box('.rtl .shape'), blocks: svg ? svg.querySelectorAll('.block, .rtl .node').length : 0,
      svgW: BASE.w, svgH: BASE.h, canvasW: canvas.clientWidth, canvasH: canvas.clientHeight, scrollW: canvas.scrollWidth, scrollH: canvas.scrollHeight, appearance: canvas.classList.contains('light') ? 'light' : 'dark' };
  }`;
export const TEST_COMMANDS_JS = `    else if (m.action === 'scroll') { canvas.scrollLeft = m.x || 0; canvas.scrollTop = m.y || 0; report(); }
    else if (m.action === 'click') { const el = document.querySelector(m.selector); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }`;

/** Zoom, pan, Dark/Light, export and Maximize for a page that has #canvas, the toolbar and (optionally) #notes. Needs `vscode` and `INIT`. */
export function commonScript(testHooks: boolean): string {
    return `
  const V = exports;
  const canvas = document.getElementById('canvas');
  const svg = canvas.querySelector('svg');
  const label = document.getElementById('zoomlabel');
  const notes = document.getElementById('notes');
  const buttons = { '100': document.getElementById('b100'), width: document.getElementById('bwidth'), all: document.getElementById('ball') };
  if (notes) notes.open = INIT.notesOpen;
  let mode = INIT.mode, scale = INIT.scale;
  const BASE = svg ? { w: svg.viewBox.baseVal.width, h: svg.viewBox.baseVal.height } : { w: 0, h: 0 };
  const viewport = () => ({ w: Math.max(1, canvas.clientWidth - 2), h: Math.max(1, canvas.clientHeight - 2) });
  let timer = 0;
  const bmode = document.getElementById('bmode');
  function applyAppearance(a) {
    canvas.classList.toggle('light', a === 'light');
    canvas.classList.toggle('dark', a !== 'light');
    bmode.textContent = a === 'light' ? 'Light' : 'Dark';
    bmode.title = 'Background: ' + (a === 'light' ? 'Light' : 'Dark') + '. Click to switch to ' + (a === 'light' ? 'Dark' : 'Light') + '.';
  }
  applyAppearance(INIT.appearance);
${testHooks ? TEST_METRICS_JS : '  const metrics = () => ({});'}
  function report() {
    clearTimeout(timer);
    timer = setTimeout(() => vscode.postMessage({ type: 'view', mode: mode, scale: scale, x: canvas.scrollLeft, y: canvas.scrollTop, notesOpen: notes ? notes.open : false, metrics: metrics() }), 200);
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
  document.getElementById('reset').onclick = () => setMode('all', true);
  document.getElementById('zin').onclick = () => { const c = centre(); zoomBy(1.2, c[0], c[1]); };
  document.getElementById('zout').onclick = () => { const c = centre(); zoomBy(1 / 1.2, c[0], c[1]); };
  document.getElementById('maximize').onclick = () => vscode.postMessage({ type: 'maximize' });
  bmode.onclick = () => { const next = canvas.classList.contains('light') ? 'dark' : 'light'; applyAppearance(next); vscode.postMessage({ type: 'appearance', value: next }); report(); };
  document.getElementById('bsvg').onclick = () => vscode.postMessage({ type: 'export', format: 'svg' });
  document.getElementById('bpng').onclick = () => vscode.postMessage({ type: 'export', format: 'png' });
  if (notes) notes.addEventListener('toggle', report);
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
    if (e.target && e.target.closest && e.target.closest('.block, .node')) return;
    if (e.key === '+' || e.key === '=') { const c = centre(); zoomBy(1.2, c[0], c[1]); } else if (e.key === '-') { const c = centre(); zoomBy(1 / 1.2, c[0], c[1]); } else if (e.key === '0') setMode('100', true);
  });
  let resizing = 0;
  new ResizeObserver(() => {
    if (mode !== 'width' && mode !== 'all') return;
    cancelAnimationFrame(resizing);
    resizing = requestAnimationFrame(() => setMode(mode, false));
  }).observe(canvas);
  // PNG export: the extension sends the complete standalone SVG; it is drawn here at a high resolution and handed back.
  function rasterize(job) {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = job.width; c.height = job.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, job.width, job.height);
      vscode.postMessage({ type: 'png', id: job.id, width: job.width, height: job.height, data: c.toDataURL('image/png').split(',')[1] });
    };
    img.onerror = () => vscode.postMessage({ type: 'png', id: job.id, error: 'The picture could not be rendered.' });
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(job.svg);
  }
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.type === 'rasterize') return rasterize(m);
    if (m.type !== 'command') return;
    if (m.action === '100' || m.action === 'width' || m.action === 'all') setMode(m.action, true);
    else if (m.action === 'reset') setMode('all', true);
    else if (m.action === 'appearance') applyAppearance(m.value);
    else if (m.action === 'zoomIn') { const c = centre(); zoomBy(1.2, c[0], c[1]); }
    else if (m.action === 'zoomOut') { const c = centre(); zoomBy(1 / 1.2, c[0], c[1]); }
${testHooks ? TEST_COMMANDS_JS : ''}
  });
  // Open: the remembered zoom (Fit All the first time), at the remembered scroll position of this level.
  (function start() {
    if (!svg) return;
    if (!canvas.clientWidth || !canvas.clientHeight) { setTimeout(start, 100); return; }
    if (mode === 'custom') { scale = V.clampScale(scale); paint(); } else { scale = V.computeScale(mode, BASE, viewport(), scale); paint(); }
    canvas.scrollLeft = INIT.x; canvas.scrollTop = INIT.y;
    report();
  })();`;
}

/** Content-Security-Policy of a schematic page. `img-src data:` is for PNG export only (an SVG data URL drawn into a canvas). */
export function schematicCsp(nonce: string, cspSource: string): string {
    return `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}' ${cspSource}; img-src data:;`;
}

/**
 * A complete, self-contained SVG for export: the same drawing with its styles resolved to the chosen palette and a background,
 * so it looks right in any viewer and is not clipped (the full content bounds are the viewBox). Pure.
 */
export function standaloneSvg(svgMarkup: string, kind: DiagramKind, appearance: SchematicAppearance): string {
    const open = /<svg\b[^>]*>/.exec(svgMarkup);
    if (!open) return svgMarkup;
    const style = `<style>${diagramCss(kind, concrete(appearance), FONT_EXPORT)}\n  .rtl .node, .block { cursor: default; }</style>`;
    const bg = `<rect x="0" y="0" width="100%" height="100%" fill="${PALETTES[appearance].bg}"/>`;
    return `<?xml version="1.0" encoding="UTF-8"?>\n` + svgMarkup.slice(0, open.index + open[0].length) + style + bg + svgMarkup.slice(open.index + open[0].length);
}

/** Pixel size of the PNG for a drawing of `width` × `height`: 3× where it fits (labels and wires stay readable), at most 8192 px on the long side. */
export function pngSize(width: number, height: number): { width: number; height: number; factor: number } {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const factor = Math.min(3, 8192 / Math.max(w, h));
    return { width: Math.round(w * factor), height: Math.round(h * factor), factor };
}

/** Default file name: `<entity>-design.svg` / `<entity>-rtl.png`, lower case and file-system safe. */
export function exportFileName(entity: string, kind: DiagramKind, format: 'svg' | 'png'): string {
    // eslint-disable-next-line no-control-regex
    const safe = entity.toLowerCase().replace(/[<>:"/\\|?*\u0000-\u001f\s]+/g, '_').replace(/^_+|_+$/g, '') || 'schematic';
    return `${safe}-${kind}.${format}`;
}

/** The drawing's own size from its viewBox (the full content bounds, not the visible part). */
export function svgSize(svg: string): { width: number; height: number } | undefined {
    const m = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined;
}
