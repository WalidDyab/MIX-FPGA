import type { VcdModel, VcdScope } from './vcd-parser';
import { pruneEmptyScopes } from './vcd-parser';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** JSON-safe form of a parsed VCD for the webview. */
export interface WaveData {
    readonly timescaleFs: number;
    readonly endTime: number;
    readonly signals: ReadonlyArray<{ readonly path: string; readonly name: string; readonly width: number; readonly code: string; readonly scope: string }>;
    readonly traces: Readonly<Record<string, { readonly times: readonly number[]; readonly values: readonly string[] }>>;
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
    const traces: Record<string, { times: number[]; values: string[] }> = {};
    for (const [code, t] of model.traces) traces[code] = { times: t.times, values: t.values };
    return {
        timescaleFs: model.timescaleFs,
        endTime: model.endTime,
        signals: model.signals.map((s) => ({ path: s.path, name: s.name + (s.width > 1 && s.msb !== undefined ? `[${s.msb}:${s.lsb}]` : ''), width: s.width, code: s.code, scope: s.scope.join('.') })),
        traces,
        tree,
        initial,
    };
}

export interface WavePageInput {
    readonly nonce: string;
    /** Webview CSP source (asWebviewUri origin); empty for a standalone preview. */
    readonly cspSource: string;
    /** URI of the compiled wave-render.js. */
    readonly rendererUri: string;
}

/** The waveform viewer page. Data arrives later by postMessage ({type:'load'}). */
export function renderWaveHtml(input: WavePageInput): string {
    const { nonce, cspSource, rendererUri } = input;
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
  button, select { background: var(--vscode-button-secondaryBackground, #ddd); color: var(--vscode-button-secondaryForeground, #222); border: none; padding: 2px 8px; cursor: pointer; font: inherit; }
  .ident { color: var(--vscode-descriptionForeground, #666); }
  .banner { padding: 6px 10px; background: var(--vscode-inputValidation-warningBackground, #fff4ce); border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, #c90); }
  main { flex: 1; display: flex; min-height: 0; }
  #tree { width: 210px; overflow: auto; border-right: 1px solid var(--vscode-panel-border, #ccc); padding: 4px 6px; }
  #tree details { margin-left: 8px; } #tree summary { cursor: pointer; font-weight: 600; }
  #tree label { display: block; margin-left: 14px; white-space: nowrap; cursor: pointer; }
  #wave { flex: 1; display: flex; min-width: 0; overflow-y: auto; }
  @media (max-width: 700px) { #tree { display: none; } #names { width: 150px !important; } }
  #names { width: 220px; flex: none; border-right: 1px solid var(--vscode-panel-border, #ccc); }
  .axis-spacer { height: 26px; border-bottom: 1px solid var(--vscode-panel-border, #ccc); display: flex; align-items: center; padding: 0 6px; color: var(--vscode-descriptionForeground, #666); }
  .row { height: 24px; display: flex; align-items: center; justify-content: space-between; padding: 0 6px; border-bottom: 1px solid var(--vscode-editorWidget-background, #eee); white-space: nowrap; overflow: hidden; }
  .row .nm { overflow: hidden; text-overflow: ellipsis; } .row .val { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-charts-orange, #c25e00); margin-left: 6px; }
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
  <label>Buses <select id="radix"><option value="hex">hex</option><option value="bin">binary</option></select></label>
  <span>Cursor: <b id="ctime">—</b></span>
  <span class="ident" id="ident"></span>
</header>
<div id="banner" class="banner" hidden></div>
<main>
  <aside id="tree"></aside>
  <section id="wave">
    <div id="names"><div class="axis-spacer">Signal / value at cursor</div><div id="rows"></div></div>
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
  let data = null, visible = [], t0 = 0, t1 = 1, cursor = 0, radix = 'hex';
  const cv = document.getElementById('cv'), wrap = document.getElementById('cvwrap');
  const ctx = cv.getContext('2d');
  const css = (name, fallback) => getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  const fmtT = (t) => data ? W.formatTime(t, data.timescaleFs) : String(t);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function valueOf(i, t) { const s = data.signals[i], tr = data.traces[s.code]; return W.formatValue(W.valueAt(tr.times, tr.values, t), s.width, radix); }

  function report() {
    if (!data) return vscode.postMessage({ type: 'state', loaded: false });
    const values = {};
    for (const i of visible) values[data.signals[i].path] = valueOf(i, cursor);
    vscode.postMessage({ type: 'state', loaded: true, t0, t1, cursor, radix, visible: visible.map((i) => data.signals[i].path), values });
  }

  function rows() {
    document.getElementById('rows').innerHTML = visible.map((i) => {
      const s = data.signals[i];
      return '<div class="row" title="' + esc(s.path) + '"><span class="nm">' + esc(s.name) + '</span><span class="val">' + esc(valueOf(i, cursor)) + '</span></div>';
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
      const segs = W.traceSegments(tr.times, tr.values, t0, t1, w);
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
          const label = W.formatValue(v, s.width, radix);
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
    draw();
  });
  document.getElementById('fit').onclick = fit;
  document.getElementById('zin').onclick = () => zoom(2);
  document.getElementById('zout').onclick = () => zoom(0.5);
  document.getElementById('left').onclick = () => pan(-0.25);
  document.getElementById('right').onclick = () => pan(0.25);
  document.getElementById('radix').onchange = (e) => { radix = e.target.value; draw(); };
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
  window.addEventListener('resize', draw);

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m) return;
    const banner = document.getElementById('banner');
    if (m.type === 'load') {
      data = m.data; visible = data.initial.slice(); cursor = 0;
      banner.hidden = !m.warning; banner.textContent = m.warning || '';
      const id = m.identity;
      document.getElementById('ident').textContent = id.testbench + ' · run ' + id.run + ' · ' + id.finishedAt + (id.stoppedAt ? ' · stopped at ' + id.stoppedAt : '') + ' · ' + id.file + (id.sha256 ? ' (' + id.sha256.slice(0, 8) + ')' : '');
      tree(); fit();
    } else if (m.type === 'empty') {
      data = null; banner.hidden = false; banner.textContent = m.message;
      document.getElementById('rows').innerHTML = ''; document.getElementById('tree').innerHTML = ''; document.getElementById('ident').textContent = '';
      ctx.clearRect(0, 0, cv.width, cv.height); report();
    } else if (m.type === 'banner') {
      banner.hidden = false; banner.textContent = m.message;
    } else if (m.type === 'command') {
      if (m.action === 'fit') fit(); else if (m.action === 'zoomIn') zoom(2); else if (m.action === 'zoomOut') zoom(0.5);
      else if (m.action === 'pan') pan(m.fraction || 0.25); else if (m.action === 'cursor') setCursor(m.time);
      else if (m.action === 'radix') { radix = m.radix; document.getElementById('radix').value = radix; draw(); }
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body></html>`;
}
