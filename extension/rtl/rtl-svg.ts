import type { RtlEdge, RtlModuleView, RtlNode } from './rtl-model';

/**
 * Lays out and renders one RTL module view as SVG. Pure, so layout and
 * shapes are unit-testable. Inputs on the left, outputs on the right,
 * logic in data-flow columns; edges that go backwards (register feedback)
 * are drawn dashed. Colours come from CSS classes (VS Code theme).
 */

const COL_GAP = 110;
const ROW_GAP = 26;
const PIN = 18;
const MARGIN = 30;

interface Placed {
    readonly node: RtlNode;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly column: number;
}

export interface RtlLayout {
    readonly width: number;
    readonly height: number;
    readonly placed: ReadonlyMap<string, Placed>;
}

function size(n: RtlNode): { w: number; h: number } {
    const ins = n.pins.filter((p) => p.dir === 'in').length;
    const outs = n.pins.filter((p) => p.dir === 'out').length;
    const pinsH = Math.max(ins, outs, 1) * PIN;
    const text = (s: string | undefined) => (s ? s.length * 7.2 : 0);
    switch (n.kind) {
        case 'input':
        case 'output':
            return { w: Math.max(70, text(n.label) + 34), h: 26 };
        case 'arith':
        case 'compare':
        case 'shift':
            return { w: 46, h: Math.max(46, pinsH + 10) };
        case 'mux':
            return { w: 56, h: Math.max(64, pinsH + 24) };
        case 'logic':
        case 'reduce':
        case 'buffer':
            return { w: 64, h: Math.max(40, pinsH + 12) };
        case 'const':
            return { w: Math.max(40, text(n.label) + 14), h: 22 };
        case 'concat':
            return { w: 16, h: Math.max(40, pinsH + 10) };
        case 'register':
        case 'latch':
            return { w: Math.max(110, text(n.sublabel) + 20), h: Math.max(64, pinsH + 40) };
        default:
            return { w: Math.max(120, text(n.label) + 30, text(n.sublabel) + 30, text(n.rawType) + 30), h: Math.max(54, pinsH + 40) };
    }
}

/** Strongly connected components (Tarjan), as a node -> component index map. */
function components(ids: readonly string[], succ: ReadonlyMap<string, ReadonlySet<string>>): Map<string, number> {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const comp = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    let next = 0;
    let count = 0;
    const strong = (v: string) => {
        index.set(v, next);
        low.set(v, next++);
        stack.push(v);
        onStack.add(v);
        for (const w of succ.get(v) ?? []) {
            if (!index.has(w)) {
                strong(w);
                low.set(v, Math.min(low.get(v)!, low.get(w)!));
            } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
        if (low.get(v) === index.get(v)) {
            for (;;) {
                const w = stack.pop()!;
                onStack.delete(w);
                comp.set(w, count);
                if (w === v) break;
            }
            count++;
        }
    };
    for (const id of ids) if (!index.has(id)) strong(id);
    return comp;
}

/**
 * Column per node: inputs at 0, outputs last, logic by longest path.
 * Loops are broken where hardware breaks them: at register outputs inside
 * a feedback loop (so a counter reads adder -> mux -> register, with the
 * register output drawn as feedback); any other loop at a DFS back edge.
 */
export function rtlColumns(view: RtlModuleView): Map<string, number> {
    const kind = new Map(view.nodes.map((n) => [n.id, n.kind]));
    const all = new Map<string, Set<string>>(view.nodes.map((n) => [n.id, new Set()]));
    for (const e of view.edges) if (e.from.node !== e.to.node) all.get(e.from.node)?.add(e.to.node);
    const comp = components(view.nodes.map((n) => n.id), all);
    const succ = new Map<string, Set<string>>(view.nodes.map((n) => [n.id, new Set()]));
    for (const [from, tos] of all) {
        const reg = kind.get(from) === 'register' || kind.get(from) === 'latch';
        for (const to of tos) if (!(reg && comp.get(from) === comp.get(to))) succ.get(from)!.add(to);
    }
    const state = new Map<string, number>(); // 1 visiting, 2 done
    const order: string[] = [];
    const dag = new Map<string, string[]>(view.nodes.map((n) => [n.id, []]));
    const visit = (id: string) => {
        state.set(id, 1);
        for (const t of succ.get(id) ?? []) {
            if (state.get(t) === 1) continue; // feedback edge
            dag.get(id)!.push(t);
            if (!state.has(t)) visit(t);
        }
        state.set(id, 2);
        order.push(id);
    };
    // Start from inputs so feedback is detected relative to the data flow.
    for (const n of view.nodes) if (n.kind === 'input' && !state.has(n.id)) visit(n.id);
    for (const n of view.nodes) if (!state.has(n.id)) visit(n.id);
    const col = new Map<string, number>(view.nodes.map((n) => [n.id, n.kind === 'input' ? 0 : 1]));
    for (const id of order.reverse()) for (const t of dag.get(id)!) if (kind.get(t) !== 'input') col.set(t, Math.max(col.get(t)!, col.get(id)! + 1));
    // Constants sit just left of what they feed.
    for (const n of view.nodes) {
        if (n.kind !== 'const') continue;
        const targets = [...(succ.get(n.id) ?? [])].map((t) => col.get(t)!);
        if (targets.length) col.set(n.id, Math.max(1, Math.min(...targets) - 1));
    }
    const last = Math.max(1, ...view.nodes.filter((n) => n.kind !== 'output').map((n) => col.get(n.id)!)) + 1;
    for (const n of view.nodes) if (n.kind === 'output') col.set(n.id, last);
    return col;
}

export function layoutRtl(view: RtlModuleView): RtlLayout {
    const col = rtlColumns(view);
    const columns = new Map<number, RtlNode[]>();
    for (const n of view.nodes) columns.set(col.get(n.id)!, [...(columns.get(col.get(n.id)!) ?? []), n]);
    const keys = [...columns.keys()].sort((a, b) => a - b);
    const preds = new Map<string, string[]>(view.nodes.map((n) => [n.id, []]));
    for (const e of view.edges) preds.get(e.to.node)?.push(e.from.node);

    const placed = new Map<string, Placed>();
    let x = MARGIN;
    let height = 0;
    for (const c of keys) {
        let list = columns.get(c)!;
        // Barycenter ordering: follow the vertical position of the drivers.
        const bary = (n: RtlNode) => {
            const ys = preds.get(n.id)!.map((p) => placed.get(p)).filter((p): p is Placed => !!p).map((p) => p.y + p.h / 2);
            return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.POSITIVE_INFINITY;
        };
        if (c > 0) list = [...list].sort((a, b) => bary(a) - bary(b));
        const sizes = list.map(size);
        const w = Math.max(...sizes.map((s) => s.w));
        let y = MARGIN + 20;
        list.forEach((n, i) => {
            const s = sizes[i]!;
            const target = bary(n);
            if (Number.isFinite(target)) y = Math.max(y, target - s.h / 2);
            placed.set(n.id, { node: n, x: x + (w - s.w) / 2, y, w: s.w, h: s.h, column: c });
            y += s.h + ROW_GAP;
        });
        height = Math.max(height, y);
        x += w + COL_GAP;
    }
    return { width: x - COL_GAP + MARGIN, height: height + MARGIN + 30, placed }; // room for feedback wires below
}

/** Pin anchor on a placed node (inputs left, outputs right, in pin order). */
export function pinPoint(p: Placed, pin: string): { x: number; y: number } {
    const n = p.node;
    const pinDef = n.pins.find((q) => q.name === pin);
    if (n.kind === 'input') return { x: p.x + p.w, y: p.y + p.h / 2 };
    if (n.kind === 'output') return { x: p.x, y: p.y + p.h / 2 };
    const side = n.pins.filter((q) => q.dir === (pinDef?.dir ?? 'in'));
    const i = Math.max(0, side.findIndex((q) => q.name === pin));
    const top = n.kind === 'register' || n.kind === 'latch' || n.kind === 'instance' || n.kind === 'generic' ? 36 : 0;
    const span = p.h - top;
    const yy = p.y + top + (span * (i + 1)) / (side.length + 1);
    return { x: pinDef?.dir === 'out' ? p.x + p.w : p.x, y: yy };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function shape(p: Placed): string {
    const { x, y, w, h, node: n } = p;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const text = (t: string, tx: number, ty: number, cls: string, anchor = 'middle') => `<text class="${cls}" x="${tx}" y="${ty}" text-anchor="${anchor}">${esc(t)}</text>`;
    switch (n.kind) {
        case 'input':
            return `<polygon class="shape port" points="${x},${y} ${x + w - 12},${y} ${x + w},${cy} ${x + w - 12},${y + h} ${x},${y + h}"/>${text(n.label + (n.sublabel ?? ''), x + (w - 12) / 2, cy + 4, 'label')}`;
        case 'output':
            return `<polygon class="shape port" points="${x},${cy} ${x + 12},${y} ${x + w},${y} ${x + w},${y + h} ${x + 12},${y + h}"/>${text(n.label + (n.sublabel ?? ''), x + 12 + (w - 12) / 2, cy + 4, 'label')}`;
        case 'arith':
        case 'compare':
        case 'shift':
            return `<ellipse class="shape op" cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}"/>${text(n.label, cx, cy + 6, 'symbol')}${n.sublabel ? text(n.sublabel, cx, y + h + 13, 'sub') : ''}`;
        case 'mux':
            return `<polygon class="shape mux" points="${x},${y} ${x + w},${y + 12} ${x + w},${y + h - 12} ${x},${y + h}"/>${text('MUX', cx, cy + 4, 'label small')}${n.sublabel ? text(n.sublabel, cx, y + h + 13, 'sub') : ''}`;
        case 'logic':
        case 'reduce':
        case 'buffer':
            return `<rect class="shape gate" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2.6}"/>${text(n.label, cx, cy + 4, 'label')}${n.kind === 'reduce' ? text('reduce', cx, y + h + 13, 'sub') : n.sublabel ? text(n.sublabel, cx, y + h + 13, 'sub') : ''}`;
        case 'const':
            return `<rect class="shape const" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>${text(n.label, cx, cy + 4, 'const-label')}`;
        case 'concat':
            return `<rect class="shape concat" x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/>`;
        case 'register':
        case 'latch': {
            const clk = n.pins.find((q) => q.name === 'CLK' || q.name === 'EN');
            const tri = clk && n.kind === 'register' ? (() => {
                const pt = pinPoint(p, clk.name);
                return `<polyline class="clock-mark" points="${pt.x},${pt.y - 6} ${pt.x + 9},${pt.y} ${pt.x},${pt.y + 6}"/>`;
            })() : '';
            return `<rect class="shape reg${n.kind === 'latch' ? ' latch' : ''}" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>${text(n.label, cx, y + 16, 'label')}${n.sublabel ? text(n.sublabel, cx, y + 30, 'sub') : ''}${tri}`;
        }
        case 'instance':
            return `<rect class="shape inst" x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/><rect class="shape inst-inner" x="${x + 3}" y="${y + 3}" width="${w - 6}" height="${h - 6}" rx="3"/>${text(n.label, cx, y + 17, 'label')}${n.sublabel ? text(n.sublabel, cx, y + 31, 'sub') : ''}${n.module ? `<text class="drill" data-module="${esc(n.module)}" x="${x + w - 16}" y="${y + 17}">⤵</text>` : ''}`;
        default:
            return `<rect class="shape generic" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>${text(n.label, cx, y + 17, 'label')}${text('generic cell', cx, y + 31, 'sub')}`;
    }
}

function pinsMarkup(p: Placed): string {
    const n = p.node;
    if (n.kind === 'input' || n.kind === 'output' || n.kind === 'const') return '';
    const out: string[] = [];
    const showLabels = !['arith', 'compare', 'shift', 'logic', 'reduce', 'buffer', 'concat'].includes(n.kind);
    for (const pin of n.pins) {
        const pt = pinPoint(p, pin.name);
        const left = pin.dir === 'in';
        out.push(`<line class="pin" x1="${pt.x}" y1="${pt.y}" x2="${pt.x + (left ? -5 : 5)}" y2="${pt.y}"/>`);
        if ((showLabels || n.kind === 'concat') && pin.label) {
            const lx = n.kind === 'concat' ? pt.x - 3 : pt.x + (left ? (n.kind === 'register' && (pin.name === 'CLK') ? 12 : 4) : -4);
            out.push(`<text class="pin-label" x="${lx}" y="${pt.y - 3}" text-anchor="${n.kind === 'concat' || !left ? 'end' : 'start'}">${esc(pin.label)}</text>`);
        }
    }
    return out.join('');
}

function edgeMarkup(e: RtlEdge, layout: RtlLayout): string {
    const a = layout.placed.get(e.from.node);
    const b = layout.placed.get(e.to.node);
    if (!a || !b) return '';
    const p1 = pinPoint(a, e.from.pin);
    const p2 = pinPoint(b, e.to.pin);
    const back = b.column <= a.column;
    let d: string;
    if (back) {
        // Feedback: out of the driver to the right, under both blocks, into the sink from the left.
        const below = Math.max(a.y + a.h, b.y + b.h) + 18;
        const r = 14;
        d = `M ${p1.x} ${p1.y} H ${p1.x + r} Q ${p1.x + 2 * r} ${p1.y}, ${p1.x + 2 * r} ${p1.y + r} V ${below - r} Q ${p1.x + 2 * r} ${below}, ${p1.x + r} ${below} H ${p2.x - r} Q ${p2.x - 2 * r} ${below}, ${p2.x - 2 * r} ${below - r} V ${p2.y + r} Q ${p2.x - 2 * r} ${p2.y}, ${p2.x - r} ${p2.y} H ${p2.x}`;
    } else {
        const dx = Math.max(30, (p2.x - p1.x) / 2);
        d = `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
    }
    const cls = `wire${e.width > 1 ? ' bus' : ''}${back ? ' feedback' : ''}`;
    const name = `${e.label ?? ''}${e.slice ?? ''}`;
    const tip = `${name || 'net'} (${e.width} bit${e.width === 1 ? '' : 's'})`;
    const parts = [`<path class="${cls}" d="${d}"><title>${esc(tip)}</title></path>`];
    if (name) parts.push(`<text class="net-label" x="${p2.x - 8}" y="${p2.y - 4}" text-anchor="end">${esc(name)}</text>`);
    if (e.width > 1) parts.push(`<text class="width-label" x="${p1.x + 6}" y="${p1.y + 12}">${e.width}</text>`);
    return parts.join('');
}

export function renderRtlSvg(view: RtlModuleView): string {
    const layout = layoutRtl(view);
    const out = [`<svg xmlns="http://www.w3.org/2000/svg" class="rtl" viewBox="0 0 ${Math.ceil(layout.width)} ${Math.ceil(layout.height)}" width="${Math.ceil(layout.width)}" height="${Math.ceil(layout.height)}">`];
    out.push('<g class="edges">', ...view.edges.map((e) => edgeMarkup(e, layout)), '</g>');
    for (const p of layout.placed.values()) {
        const n = p.node;
        out.push(`<g class="node kind-${n.kind}" data-id="${esc(n.id)}" tabindex="0"><title>${esc(`${n.label}${n.sublabel ? ` — ${n.sublabel}` : ''}: ${n.description}${n.rawType ? ` [${n.rawType}]` : ''}`)}</title>${shape(p)}${pinsMarkup(p)}</g>`);
    }
    out.push('</svg>');
    return out.join('\n');
}
