import type { VcdModel, VcdScope } from './vcd-parser';
import { pruneEmptyScopes } from './vcd-parser';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** JSON-safe form of a parsed VCD for the webview. */
export interface WaveData {
    readonly timescaleFs: number;
    readonly endTime: number;
    readonly signals: ReadonlyArray<{ readonly path: string; readonly name: string; readonly width: number; readonly code: string; readonly scope: string; readonly varType: string }>;
    /** `raw` (VHDL metavalues kept apart, see VcdTrace.raw) is present only for traces that have any. */
    readonly traces: Readonly<Record<string, { readonly times: readonly number[]; readonly values: readonly string[]; readonly raw?: readonly string[] }>>;
    readonly tree: WaveTreeNode;
    /** Signal indices shown initially. */
    readonly initial: readonly number[];
}

export interface WaveTreeNode {
    readonly name: string;
    readonly signals: readonly number[];
    readonly scopes: readonly WaveTreeNode[];
}

/** Identity of the waveform shown, so a stale file is never mistaken for the latest run. */
export interface WaveIdentity {
    readonly testbench: string;
    readonly file: string;
    readonly run: number;
    readonly finishedAt: string;
    readonly sha256?: string;
    readonly stoppedAt?: string;
}

const MAX_INITIAL = 40;

/**
 * Converts a parsed VCD to webview data. Shows every signal of a small dump
 * (at most 40), otherwise the testbench scope and its direct children (up to 40).
 */
export function toWaveData(model: VcdModel): WaveData {
    const index = new Map(model.signals.map((s, i) => [s, i]));
    const toNode = (s: VcdScope): WaveTreeNode => ({ name: s.name, signals: s.signals.map((x) => index.get(x)!), scopes: s.scopes.map(toNode) });
    const tree = toNode(pruneEmptyScopes(model.root));
    const initial: number[] = [];
    const maxDepth = model.signals.length <= MAX_INITIAL ? Number.POSITIVE_INFINITY : 2; // teaching-sized dumps: show everything
    const add = (n: WaveTreeNode, depth: number) => {
        if (depth > maxDepth) return;
        for (const i of n.signals) if (initial.length < MAX_INITIAL) initial.push(i);
        for (const c of n.scopes) add(c, depth + 1);
    };
    for (const top of tree.scopes) add(top, 1);
    const traces: Record<string, { times: number[]; values: string[]; raw?: string[] }> = {};
    for (const [code, t] of model.traces) {
        const raw = model.raw.get(code);
        traces[code] = raw ? { times: t.times, values: t.values, raw: [...raw] } : { times: t.times, values: t.values };
    }
    return {
        timescaleFs: model.timescaleFs,
        endTime: model.endTime,
        signals: model.signals.map((s) => ({ path: s.path, name: s.name + (s.width > 1 && s.msb !== undefined ? `[${s.msb}:${s.lsb}]` : ''), width: s.width, code: s.code, scope: s.scope.join('.'), varType: s.varType })),
        traces,
        tree,
        initial,
    };
}

/** Page code used only by automated validation (WaveformPanel.testHooks): not in the page unless a test enables it. */
const TEST_COMMANDS_JS = `else if (m.action === 'showSignals' && data) { visible = (m.paths || []).map((p) => data.signals.findIndex((x) => x.path === p)).filter((i) => i >= 0); saveSignals(); tree(); draw(); }`;

export interface WavePageInput {
    readonly nonce: string;
    /** Webview CSP source (asWebviewUri origin); empty for a standalone preview. */
    readonly cspSource: string;
    /** URI of the compiled wave-render.js. */
    readonly rendererUri: string;
    /** Validation only: include the test-only commands. */
    readonly testHooks?: boolean;
}

/** The waveform viewer page. Data arrives later by postMessage ({type:'load'}). */
export function renderWaveHtml(input: WavePageInput): string {
    const { nonce, cspSource, rendererUri } = input;
    const testHooks = input.testHooks === true;
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}' ${cspSource};`;
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Waveform</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 12px; color: var(--vscode-foreground, #222); background: var(--vscode-editor-background, #fff); margin: 0; height: 100vh; display: flex; flex-direction: column; }
  header { display: flex; gap: 8px; align-items: center; padding: 6px 10px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border, #ccc); }
  header h1 { font-size: 13px; margin: 0 8px 0 0; }
  #simbar { display: flex; gap: 8px; align-items: center; padding: 6px 10px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border, #ccc); background: var(--vscode-editorWidget-background, transparent); }
  #simbar button { padding: 3px 12px; font-weight: 600; }
  #run { background: var(--vscode-button-background, #0a6); color: var(--vscode-button-foreground, #fff); }
  #stop { background: var(--vscode-button-secondaryBackground, #ddd); }
  #simbar button:disabled { opacity: 0.45; cursor: default; }
  #simbar input[type=text] { width: 64px; background: var(--vscode-input-background, #fff); color: var(--vscode-input-foreground, #222); border: 1px solid var(--vscode-input-border, #aaa); padding: 2px 4px; font: inherit; text-align: right; }
  #simbar input.invalid { border-color: var(--vscode-inputValidation-errorBorder, #d02020); }
  #simstatus { color: var(--vscode-descriptionForeground, #666); }
  #simhint { color: var(--vscode-descriptionForeground, #666); font-size: 11px; }
  button, select { background: var(--vscode-button-secondaryBackground, #ddd); color: var(--vscode-button-secondaryForeground, #222); border: none; padding: 2px 8px; cursor: pointer; font: inherit; }
  .ident { color: var(--vscode-descriptionForeground, #666); }
  .banner { padding: 6px 10px; background: var(--vscode-inputValidation-warningBackground, #fff4ce); border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, #c90); }
  main { flex: 1; display: flex; min-height: 0; }
  #tree { width: var(--tree-w, 210px); flex: none; overflow: auto; border-right: 1px solid var(--vscode-panel-border, #ccc); padding: 4px 6px; }
  #tree details { margin-left: 8px; } #tree summary { cursor: pointer; font-weight: 600; }
  #tree label { display: block; margin-left: 14px; white-space: nowrap; cursor: pointer; }
  #wave { flex: 1; display: flex; min-width: 0; overflow-y: auto; }
  @media (max-width: 700px) { #tree, #split-tree { display: none; } #names { width: 220px !important; } }
  .splitter { flex: none; width: 5px; cursor: col-resize; background: transparent; border-left: 1px solid var(--vscode-panel-border, #ccc); touch-action: none; }
  .splitter:hover, .splitter.active, .splitter:focus { background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder, #0a84ff)); outline: none; }
  body.resizing { cursor: col-resize; user-select: none; }
  #names { width: var(--names-w, 380px); flex: none; border-right: 1px solid var(--vscode-panel-border, #ccc); }
  .axis-spacer { height: 26px; border-bottom: 1px solid var(--vscode-panel-border, #ccc); display: flex; align-items: center; padding: 0 6px; color: var(--vscode-descriptionForeground, #666); }
  .row { height: 24px; display: flex; align-items: center; justify-content: space-between; padding: 0 6px; border-bottom: 1px solid var(--vscode-editorWidget-background, #eee); white-space: nowrap; overflow: hidden; }
  .row .nm { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .row select.rx { flex: none; margin-left: 6px; padding: 0 2px; font-size: 11px; max-width: 124px; } .row .val { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-charts-orange, #c25e00); margin-left: 6px; }
  #cvwrap { flex: 1; min-width: 0; position: relative; }
  canvas { display: block; cursor: crosshair; }
</style></head>
<body>
<header>
  <h1>Waveform</h1>
  <button id="fit" title="Show the whole simulation">Fit</button>
  <button id="zin" title="Zoom in around the cursor">+</button>
  <button id="zout" title="Zoom out">−</button>
  <button id="left" title="Pan left">◀</button>
  <button id="right" title="Pan right">▶</button>
  <label title="How buses are shown unless a signal has its own Display As choice">Buses <select id="radix"><option value="hex">Hex</option><option value="bin">Binary</option><option value="udec">Unsigned Decimal</option><option value="sdec">Signed Decimal</option></select></label>
  <span>Cursor: <b id="ctime">—</b></span>
  <span class="ident" id="ident"></span>
</header>
<div id="simbar" role="toolbar" aria-label="Simulation">
  <button id="run" title="Run the testbench from time 0 for the chosen duration">&#9654; Run</button>
  <button id="stop" title="Stop the running simulation" disabled>&#9632; Stop</button>
  <label title="How long the testbench runs, from time 0. Leave empty to let the testbench decide (it ends with std.env.stop).">Run for: <input id="dur" type="text" inputmode="numeric" placeholder="until it ends" aria-label="Simulation duration"> <select id="durunit" aria-label="Time unit"><option>fs</option><option>ps</option><option>ns</option><option selected>us</option><option>ms</option><option>sec</option></select></label>
  <span id="simstatus" role="status"></span>
  <span id="simhint">Each run starts the testbench again at time 0. The testbench itself provides all clocks and stimulus.</span>
</div>
<div id="banner" class="banner" hidden></div>
<main>
  <aside id="tree"></aside>
  <div id="split-tree" class="splitter" role="separator" aria-orientation="vertical" tabindex="0" title="Drag to resize the signal list (double-click to reset)"></div>
  <section id="wave">
    <div id="names"><div class="axis-spacer">Signal / value at cursor</div><div id="rows"></div></div>
    <div id="split-names" class="splitter" role="separator" aria-orientation="vertical" tabindex="0" title="Drag to resize the names column (double-click to reset)"></div>
    <div id="cvwrap"><canvas id="cv"></canvas></div>
  </section>
</main>
<script nonce="${nonce}">var exports = {};</script>
<script nonce="${nonce}" src="${esc(rendererUri)}"></script>
<script nonce="${nonce}">
(function () {
  const W = exports;
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };
  const AXIS = 26, ROW = 24;
  let data = null, visible = [], t0 = 0, t1 = 1, cursor = 0;
  // Display As: the Buses default plus per-signal choices (keyed by signal path), remembered per workspace by the extension.
  let rstate = { buses: 'hex', signals: {} };
  // Pane widths (px), draggable; clamped to sensible limits and remembered per workspace by the extension.
  let layout = Object.assign({}, W.DEFAULT_LAYOUT);
  const mainEl = document.querySelector('main'), treeEl = document.getElementById('tree'), namesEl = document.getElementById('names');
  function applyLayout() {
    const mainW = mainEl.clientWidth || window.innerWidth;
    layout = { treeWidth: W.clampPaneWidth(layout.treeWidth, W.TREE_LIMITS, mainW, 420, W.DEFAULT_LAYOUT.treeWidth), namesWidth: layout.namesWidth };
    const waveW = Math.max(0, mainW - (treeEl.offsetParent === null ? 0 : layout.treeWidth + 5));
    layout = { treeWidth: layout.treeWidth, namesWidth: W.clampPaneWidth(layout.namesWidth, W.NAMES_LIMITS, waveW, 240, W.DEFAULT_LAYOUT.namesWidth) };
    document.body.style.setProperty('--tree-w', layout.treeWidth + 'px');
    document.body.style.setProperty('--names-w', layout.namesWidth + 'px');
  }
  function simReport() { return { running: sim.running, runDisabled: runBtn.disabled, stopDisabled: stopBtn.disabled, typed: durIn.value + durUnit.value, status: simStatus.textContent }; }
  function saveLayout() { vscode.postMessage({ type: 'layout', layout: layout }); }
  let frame = 0;
  function relayout() { applyLayout(); if (!frame) frame = requestAnimationFrame(function () { frame = 0; if (data) draw(); }); }
  function splitter(id, key, limits) {
    const el = document.getElementById(id);
    el.addEventListener('mousedown', function (e) {
      e.preventDefault();
      const startX = e.clientX, start = layout[key];
      el.classList.add('active'); document.body.classList.add('resizing');
      const move = function (ev) { layout = Object.assign({}, layout); layout[key] = start + (ev.clientX - startX); relayout(); };
      const up = function () { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); el.classList.remove('active'); document.body.classList.remove('resizing'); saveLayout(); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    el.addEventListener('dblclick', function () { layout = Object.assign({}, layout); layout[key] = W.DEFAULT_LAYOUT[key]; relayout(); saveLayout(); });
    el.addEventListener('keydown', function (e) {
      const step = e.shiftKey ? 48 : 16;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); layout = Object.assign({}, layout); layout[key] += e.key === 'ArrowLeft' ? -step : step; relayout(); saveLayout(); }
    });
  }
  splitter('split-tree', 'treeWidth');
  splitter('split-names', 'namesWidth');
  const RX_LABEL = { bin: 'Binary', hex: 'Hex', udec: 'Unsigned Decimal', sdec: 'Signed Decimal' };
  const cv = document.getElementById('cv'), wrap = document.getElementById('cvwrap');
  const ctx = cv.getContext('2d');
  const css = (name, fallback) => getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  const fmtT = (t) => data ? W.formatTime(t, data.timescaleFs) : String(t);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  const radixOf = (s) => W.effectiveRadix(rstate, s.path, s.varType);
  function fmt(s, value, raw) { return W.formatValue(value, s.width, radixOf(s), raw ? { raw: raw } : {}); }
  function valueOf(i, t) {
    const s = data.signals[i], tr = data.traces[s.code], k = W.indexAt(tr.times, t);
    return fmt(s, k < 0 ? undefined : tr.values[k], k < 0 || !tr.raw ? undefined : tr.raw[k]);
  }
  let testbench = '';
  function saveSignals() { if (data && testbench) vscode.postMessage({ type: 'signals', testbench: testbench, paths: visible.map((i) => data.signals[i].path) }); }
  function saveRadix() { vscode.postMessage({ type: 'radix', state: rstate }); }

  function report() {
    if (!data) return vscode.postMessage({ type: 'state', loaded: false, sim: simReport() });
    const values = {}, radixes = {};
    for (const i of visible) { values[data.signals[i].path] = valueOf(i, cursor); radixes[data.signals[i].path] = radixOf(data.signals[i]); }
    vscode.postMessage({ type: 'state', loaded: true, sim: simReport(), layout: layout, treeWidthPx: Math.round(treeEl.getBoundingClientRect().width), canvasWidthPx: Math.round(wrap.clientWidth), t0, t1, cursor, radix: rstate.buses, visible: visible.map((i) => data.signals[i].path), values, radixes });
  }

  function rows() {
    document.getElementById('rows').innerHTML = visible.map((i) => {
      const s = data.signals[i];
      // Buses and integers can be shown in any radix: one-bit signals have nothing to choose.
      const choose = s.width > 1 || s.varType === 'integer';
      const own = rstate.signals[s.path] || '';
      const sel = choose ? '<select class="rx" data-i="' + i + '" title="Display As"><option value=""' + (own ? '' : ' selected') + '>Auto</option>' +
        Object.keys(RX_LABEL).map((r) => '<option value="' + r + '"' + (own === r ? ' selected' : '') + '>' + RX_LABEL[r] + '</option>').join('') + '</select>' : '';
      return '<div class="row" title="' + esc(s.path) + '"><span class="nm">' + esc(s.name) + '</span>' + sel + '<span class="val">' + esc(valueOf(i, cursor)) + '</span></div>';
    }).join('');
    document.getElementById('ctime').textContent = fmtT(cursor);
  }

  function draw() {
    if (!data) return;
    const w = Math.max(100, wrap.clientWidth), h = AXIS + visible.length * ROW + 4;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fg = css('--vscode-foreground', '#222'), grid = css('--vscode-editorWidget-background', '#eee');
    const hi = css('--vscode-charts-green', '#2e8b57'), bus = css('--vscode-charts-blue', '#1a6fd1');
    const bad = css('--vscode-charts-red', '#d02020'), zc = css('--vscode-charts-yellow', '#b8a000');
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px ' + css('--vscode-editor-font-family', 'monospace');
    const x = (t) => (t - t0) / (t1 - t0) * w;
    // Time axis and grid.
    ctx.fillStyle = fg; ctx.strokeStyle = grid; ctx.lineWidth = 1;
    for (const t of W.niceTicks(t0, t1, w)) {
      const xx = Math.round(x(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(xx, AXIS - 6); ctx.lineTo(xx, h); ctx.stroke();
      ctx.fillText(fmtT(t), xx + 3, 14);
    }
    visible.forEach((i, r) => {
      const s = data.signals[i], tr = data.traces[s.code];
      const top = AXIS + r * ROW + 4, bot = top + ROW - 8, mid = (top + bot) / 2;
      const segs = W.traceSegments(tr.times, tr.values, t0, t1, w, 2, tr.raw);
      for (const g of segs) {
        if (g.dense) { ctx.fillStyle = s.width > 1 ? bus : hi; ctx.globalAlpha = 0.35; ctx.fillRect(g.x0, top, g.x1 - g.x0, bot - top); ctx.globalAlpha = 1; continue; }
        const v = g.value;
        if (s.width <= 1) {
          if (v === '1' || v === '0') {
            ctx.strokeStyle = hi; ctx.lineWidth = 1.5;
            const y = v === '1' ? top : bot;
            ctx.beginPath(); ctx.moveTo(g.x0, y); ctx.lineTo(g.x1, y); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(g.x0, top); ctx.lineTo(g.x0, bot); ctx.globalAlpha = 0.6; ctx.stroke(); ctx.globalAlpha = 1;
          } else if (v === 'z') {
            ctx.strokeStyle = zc; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(g.x0, mid); ctx.lineTo(g.x1, mid); ctx.stroke();
          } else {
            ctx.fillStyle = bad; ctx.globalAlpha = 0.3; ctx.fillRect(g.x0, top, g.x1 - g.x0, bot - top); ctx.globalAlpha = 1;
          }
        } else {
          const unknown = /[xz]/.test(v);
          ctx.strokeStyle = unknown ? bad : bus; ctx.lineWidth = 1.3;
          const e = Math.min(4, (g.x1 - g.x0) / 2);
          ctx.beginPath();
          ctx.moveTo(g.x0, mid); ctx.lineTo(g.x0 + e, top); ctx.lineTo(g.x1 - e, top); ctx.lineTo(g.x1, mid);
          ctx.lineTo(g.x1 - e, bot); ctx.lineTo(g.x0 + e, bot); ctx.closePath(); ctx.stroke();
          const label = fmt(s, v, g.raw);
          if (ctx.measureText(label).width < g.x1 - g.x0 - 10) { ctx.fillStyle = fg; ctx.fillText(label, Math.max(g.x0, 0) + 6, mid + 4); }
        }
      }
    });
    // Cursor.
    const cx = Math.round(x(cursor)) + 0.5;
    ctx.strokeStyle = css('--vscode-editorCursor-foreground', '#f80'); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
    rows();
    report();
  }

  function setView(a, b) { const v = W.clampView(a, b, data.endTime); t0 = v[0]; t1 = v[1]; draw(); }
  function fit() { if (data) setView(0, Math.max(1, data.endTime)); }
  function zoom(f, at) { if (!data) return; const c = at === undefined ? cursor : at; const span = (t1 - t0) / f; const k = (c - t0) / (t1 - t0); setView(c - span * k, c - span * k + span); }
  function pan(frac) { if (data) setView(t0 + (t1 - t0) * frac, t1 + (t1 - t0) * frac); }
  function setCursor(t) { if (!data) return; cursor = Math.max(0, Math.min(data.endTime, t)); draw(); }

  function tree() {
    const node = (n, depth) => {
      let html = '';
      for (const i of n.signals) html += '<label><input type="checkbox" data-sig="' + i + '"' + (visible.includes(i) ? ' checked' : '') + '> ' + esc(data.signals[i].name) + '</label>';
      for (const c of n.scopes) html += '<details' + (depth < 2 ? ' open' : '') + '><summary>' + esc(c.name) + '</summary>' + node(c, depth + 1) + '</details>';
      return html;
    };
    document.getElementById('tree').innerHTML = node(data.tree, 0);
  }

  document.getElementById('tree').addEventListener('change', (e) => {
    const i = Number(e.target.dataset.sig);
    if (Number.isNaN(i)) return;
    if (e.target.checked) { if (!visible.includes(i)) visible.push(i); } else visible = visible.filter((v) => v !== i);
    saveSignals();
    draw();
  });
  document.getElementById('fit').onclick = fit;
  document.getElementById('zin').onclick = () => zoom(2);
  document.getElementById('zout').onclick = () => zoom(0.5);
  document.getElementById('left').onclick = () => pan(-0.25);
  document.getElementById('right').onclick = () => pan(0.25);
  document.getElementById('radix').onchange = (e) => { rstate = { buses: e.target.value, signals: rstate.signals }; saveRadix(); draw(); };
  function setSignalRadix(i, r) {
    const signals = Object.assign({}, rstate.signals), path = data.signals[i].path;
    if (r) signals[path] = r; else delete signals[path];
    rstate = { buses: rstate.buses, signals: signals }; saveRadix(); draw();
  }
  document.getElementById('rows').addEventListener('change', (e) => {
    if (e.target.classList && e.target.classList.contains('rx')) setSignalRadix(Number(e.target.dataset.i), e.target.value);
  });
  const timeAt = (clientX) => { const r = cv.getBoundingClientRect(); return t0 + (clientX - r.left) / r.width * (t1 - t0); };
  let drag;
  cv.addEventListener('mousedown', (e) => { drag = { x: e.clientX, t0, t1, moved: false }; });
  window.addEventListener('mousemove', (e) => {
    if (!drag || !data) return;
    const dt = (e.clientX - drag.x) / cv.getBoundingClientRect().width * (drag.t1 - drag.t0);
    if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
    if (drag.moved) setView(drag.t0 - dt, drag.t1 - dt);
  });
  window.addEventListener('mouseup', (e) => { if (drag && !drag.moved && data) setCursor(timeAt(e.clientX)); drag = undefined; });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); if (e.shiftKey) pan(e.deltaY > 0 ? 0.1 : -0.1); else zoom(e.deltaY < 0 ? 1.25 : 0.8, timeAt(e.clientX)); }, { passive: false });
  window.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') pan(-0.1); else if (e.key === 'ArrowRight') pan(0.1); else if (e.key === '+') zoom(2); else if (e.key === '-') zoom(0.5); });
  window.addEventListener('resize', relayout);

  // ---- simulation toolbar: Run / Stop / Run for. The extension owns the simulation; this only asks it and shows its state.
  let sim = { running: false, other: '', duration: '', status: '' };
  let durDirty = false;
  const runBtn = document.getElementById('run'), stopBtn = document.getElementById('stop'), durIn = document.getElementById('dur'), durUnit = document.getElementById('durunit'), simStatus = document.getElementById('simstatus');
  const typedDuration = () => W.joinDuration(durIn.value, durUnit.value);
  function renderSim() {
    if (!durDirty) { const d = W.splitDuration(sim.duration); durIn.value = d.number; durUnit.value = d.unit; }
    const valid = typedDuration() !== undefined;
    durIn.classList.toggle('invalid', !valid);
    durIn.disabled = durUnit.disabled = sim.running;
    runBtn.disabled = sim.running || !!sim.other || !valid;
    stopBtn.disabled = !sim.running;
    runBtn.title = sim.running ? 'A simulation is running' : sim.other ? sim.other + ' is running' : !valid ? 'Enter a whole number above zero, or leave the duration empty' : 'Run the testbench from time 0 for the chosen duration';
    simStatus.textContent = sim.status || '';
  }
  function doRun() { if (runBtn.disabled) return; const d = typedDuration(); durDirty = false; vscode.postMessage({ type: 'run', duration: d }); }
  runBtn.onclick = doRun;
  stopBtn.onclick = () => { if (!stopBtn.disabled) vscode.postMessage({ type: 'stop' }); };
  durIn.addEventListener('input', () => { durDirty = true; renderSim(); report(); });
  durUnit.addEventListener('change', () => { durDirty = true; renderSim(); report(); });
  durIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRun(); });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m) return;
    const banner = document.getElementById('banner');
    if (m.type === 'load') {
      const keep = data ? visible.map((i) => data.signals[i].path) : [];
      data = m.data; cursor = 0;
      const again = keep.map((p) => data.signals.findIndex((x) => x.path === p)).filter((i) => i >= 0);
      // A rerun keeps the signals the student chose; after a restart, the ones remembered with the project.
      const saved = (m.signals || []).map((p) => data.signals.findIndex((x) => x.path === p)).filter((i) => i >= 0);
      visible = again.length > 0 ? again : saved.length > 0 ? saved : data.initial.slice();
      testbench = m.identity.testbench;
      if (m.layout) { layout = W.sanitizeLayout(m.layout); applyLayout(); }
      if (m.radix) { rstate = W.sanitizeRadixState(m.radix); document.getElementById('radix').value = rstate.buses; }
      banner.hidden = !m.warning; banner.textContent = m.warning || '';
      const id = m.identity;
      document.getElementById('ident').textContent = id.testbench + ' · run ' + id.run + ' · ' + id.finishedAt + (id.stoppedAt ? ' · stopped at ' + id.stoppedAt : '') + ' · ' + id.file + (id.sha256 ? ' (' + id.sha256.slice(0, 8) + ')' : '');
      tree(); fit();
    } else if (m.type === 'empty') {
      data = null; banner.hidden = false; banner.textContent = m.message;
      document.getElementById('rows').innerHTML = ''; document.getElementById('tree').innerHTML = ''; document.getElementById('ident').textContent = '';
      ctx.clearRect(0, 0, cv.width, cv.height); report();
    } else if (m.type === 'simState') {
      sim = { running: !!m.running, other: m.other || '', duration: m.duration || '', status: m.status || '' };
      renderSim(); report();
    } else if (m.type === 'banner') {
      banner.hidden = false; banner.textContent = m.message;
    } else if (m.type === 'command') {
      if (m.action === 'fit') fit(); else if (m.action === 'zoomIn') zoom(2); else if (m.action === 'zoomOut') zoom(0.5);
      else if (m.action === 'pan') pan(m.fraction || 0.25); else if (m.action === 'cursor') setCursor(m.time);
      else if (m.action === 'radix') { rstate = { buses: m.radix, signals: rstate.signals }; document.getElementById('radix').value = m.radix; saveRadix(); draw(); }
      else if (m.action === 'clickRun') doRun();
      else if (m.action === 'clickStop') { if (!stopBtn.disabled) vscode.postMessage({ type: 'stop' }); }
      else if (m.action === 'setDuration') { durIn.value = m.number || ''; durUnit.value = m.unit || 'us'; durDirty = true; renderSim(); report(); }
      else if (m.action === 'paneWidth') { layout = Object.assign({}, layout); layout[m.pane === 'names' ? 'namesWidth' : 'treeWidth'] = m.width; relayout(); saveLayout(); }
${testHooks ? TEST_COMMANDS_JS : ""}
      else if (m.action === 'signalRadix' && data) {
        const i = data.signals.findIndex((x) => x.path === m.path);
        if (i >= 0) setSignalRadix(i, m.radix || '');
      }
    }
  });
  applyLayout();
  renderSim();
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body></html>`;
}
