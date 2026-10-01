import type { Endpoint, SchematicBlock, SchematicMode, SchematicModel } from './schematic-model';

/**
 * Lays out and renders a SchematicModel as SVG. Pure (string in, string
 * out), so layout is unit-testable without a webview.
 *
 * Layout: the level's entity is the frame; its input ports sit on the left
 * edge and outputs on the right. Blocks are placed in columns by data
 * flow (a block driven by another block's output goes to its right) and
 * wires are drawn as curves from driver to sinks. Colours come from CSS
 * classes so the webview can follow the VS Code theme.
 */

const PIN = 18;
const HEAD = 40;
const COL_GAP = 120;
const ROW_GAP = 36;
const FRAME_PAD = 110;
const CHAR = 7.2;

export interface Point {
    readonly x: number;
    readonly y: number;
}

export interface LaidOutBlock {
    readonly block: SchematicBlock;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly column: number;
    /** Pin anchor points by lower-case port name. */
    readonly pins: ReadonlyMap<string, Point & { side: 'left' | 'right' }>;
}

export interface Layout {
    readonly width: number;
    readonly height: number;
    readonly frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly blocks: readonly LaidOutBlock[];
    readonly terminals: ReadonlyMap<string, Point & { side: 'left' | 'right' }>;
}

const isLeft = (m: SchematicMode) => m === 'in' || m === 'unknown' || m === 'linkage';
const drives = (e: Endpoint) => (e.block === undefined ? isLeft(e.mode) : e.mode === 'out' || e.mode === 'buffer');
const sinks = (e: Endpoint) => (e.block === undefined ? e.mode === 'out' || e.mode === 'buffer' : e.mode === 'in');

function textWidth(s: string): number {
    return s.length * CHAR;
}

/** Column per block: longest driver->sink path, with back edges (feedback) ignored. */
export function assignColumns(model: SchematicModel): Map<string, number> {
    const ids = model.blocks.map((b) => b.id);
    const edges = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
    for (const net of model.nets) {
        const from = net.endpoints.filter((e) => e.block !== undefined && drives(e)).map((e) => e.block!);
        const to = net.endpoints.filter((e) => e.block !== undefined && sinks(e)).map((e) => e.block!);
        for (const f of from) for (const t of to) if (f !== t) edges.get(f)!.add(t);
    }
    // Depth-first ordering that drops edges closing a cycle.
    const state = new Map<string, 'visiting' | 'done'>();
    const order: string[] = [];
    const dag = new Map<string, string[]>(ids.map((id) => [id, []]));
    const visit = (id: string) => {
        state.set(id, 'visiting');
        for (const t of edges.get(id)!) {
            if (state.get(t) === 'visiting') continue; // feedback
            dag.get(id)!.push(t);
            if (!state.has(t)) visit(t);
        }
        state.set(id, 'done');
        order.push(id);
    };
    for (const id of ids) if (!state.has(id)) visit(id);
    const column = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const id of order.reverse()) for (const t of dag.get(id)!) column.set(t, Math.max(column.get(t)!, column.get(id)! + 1));
    return column;
}

export function layoutSchematic(model: SchematicModel): Layout {
    const columns = assignColumns(model);
    const byColumn = new Map<number, SchematicBlock[]>();
    for (const b of model.blocks) {
        const c = columns.get(b.id)!;
        byColumn.set(c, [...(byColumn.get(c) ?? []), b]);
    }
    const leftPorts = model.ports.filter((p) => isLeft(p.mode) || p.mode === 'inout');
    const rightPorts = model.ports.filter((p) => !isLeft(p.mode) && p.mode !== 'inout');
    const portLabel = Math.max(60, ...model.ports.map((p) => textWidth(p.name) + 24));

    const sized = model.blocks.map((b) => {
        const left = b.ports.filter((p) => isLeft(p.mode) || p.mode === 'inout');
        const right = b.ports.filter((p) => !isLeft(p.mode) && p.mode !== 'inout');
        const inner = Math.max(...left.map((p) => textWidth(p.name)), 0) + Math.max(...right.map((p) => textWidth(p.name)), 0) + 40;
        const width = Math.max(150, inner, textWidth(b.label) + 40, textWidth(b.entityName) + 40);
        const height = HEAD + Math.max(left.length, right.length, 1) * PIN + 10;
        return { b, left, right, width, height };
    });
    const colCount = byColumn.size === 0 ? 0 : Math.max(...byColumn.keys()) + 1;
    const colWidth: number[] = Array.from({ length: colCount }, (_, c) => Math.max(0, ...sized.filter((s) => columns.get(s.b.id) === c).map((s) => s.width)));

    const frameX = portLabel + 20;
    const frameY = 30;
    let x = frameX + FRAME_PAD;
    const colX = colWidth.map((w) => {
        const at = x;
        x += w + COL_GAP;
        return at;
    });
    const innerWidth = colCount === 0 ? 200 : x - COL_GAP - frameX + FRAME_PAD;

    const blocks: LaidOutBlock[] = [];
    let maxBottom = frameY + 60;
    for (let c = 0; c < colCount; c++) {
        let y = frameY + 50;
        for (const s of sized.filter((z) => columns.get(z.b.id) === c)) {
            const bx = colX[c]! + (colWidth[c]! - s.width) / 2;
            const pins = new Map<string, Point & { side: 'left' | 'right' }>();
            s.left.forEach((p, i) => pins.set(p.name.toLowerCase(), { x: bx, y: y + HEAD + i * PIN + PIN / 2, side: 'left' }));
            s.right.forEach((p, i) => pins.set(p.name.toLowerCase(), { x: bx + s.width, y: y + HEAD + i * PIN + PIN / 2, side: 'right' }));
            blocks.push({ block: s.b, x: bx, y, width: s.width, height: s.height, column: c, pins });
            y += s.height + ROW_GAP;
            maxBottom = Math.max(maxBottom, y);
        }
    }
    const portsHeight = Math.max(leftPorts.length, rightPorts.length) * 34 + 60;
    const frameHeight = Math.max(maxBottom - frameY + 10, portsHeight, 140);
    const frame = { x: frameX, y: frameY, width: innerWidth, height: frameHeight };

    const terminals = new Map<string, Point & { side: 'left' | 'right' }>();
    const place = (list: typeof model.ports, side: 'left' | 'right') => {
        const step = frameHeight / (list.length + 1);
        list.forEach((p, i) => terminals.set(p.name.toLowerCase(), { x: side === 'left' ? frame.x : frame.x + frame.width, y: frame.y + step * (i + 1), side }));
    };
    place(leftPorts, 'left');
    place(rightPorts, 'right');
    return { width: frame.x + frame.width + portLabel + 20, height: frame.y + frame.height + 30, frame, blocks, terminals };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function curve(a: Point, b: Point, aSide: 'left' | 'right', bSide: 'left' | 'right'): string {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    const c1 = aSide === 'right' ? a.x + dx : a.x - dx;
    const c2 = bSide === 'left' ? b.x - dx : b.x + dx;
    return `M ${a.x} ${a.y} C ${c1} ${a.y}, ${c2} ${b.y}, ${b.x} ${b.y}`;
}

/** Inside-the-frame anchor of an entity port: wires start at the frame edge facing inwards. */
function anchorOf(layout: Layout, e: Endpoint): (Point & { side: 'left' | 'right' }) | undefined {
    if (e.block === undefined) {
        const t = layout.terminals.get(e.port.toLowerCase());
        return t ? { ...t, side: t.side === 'left' ? 'right' : 'left' } : undefined;
    }
    return layout.blocks.find((b) => b.block.id === e.block)?.pins.get(e.port.toLowerCase());
}

export function renderSchematicSvg(model: SchematicModel): string {
    const layout = layoutSchematic(model);
    const out: string[] = [];
    const { frame } = layout;
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" class="schematic" viewBox="0 0 ${Math.ceil(layout.width)} ${Math.ceil(layout.height)}" width="${Math.ceil(layout.width)}" height="${Math.ceil(layout.height)}">`);

    // Frame = the entity of this level.
    const loc = model.entityLocation;
    out.push(`<g class="frame" data-file="${esc(loc?.file ?? '')}" data-line="${loc?.line ?? 1}" data-col="${loc?.col ?? 1}">`);
    out.push(`<rect x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}" rx="6"/>`);
    out.push(`<text class="frame-title" x="${frame.x + 10}" y="${frame.y - 10}">${esc(model.entityName)}${model.architectureName ? ` (${esc(model.architectureName)})` : ''}</text>`);
    out.push('</g>');

    // Entity ports.
    for (const p of model.ports) {
        const t = layout.terminals.get(p.name.toLowerCase());
        if (!t) continue;
        const left = t.side === 'left';
        const arrow = left ? `${t.x - 14},${t.y - 6} ${t.x - 4},${t.y - 6} ${t.x},${t.y} ${t.x - 4},${t.y + 6} ${t.x - 14},${t.y + 6}` : `${t.x},${t.y - 6} ${t.x + 10},${t.y - 6} ${t.x + 14},${t.y} ${t.x + 10},${t.y + 6} ${t.x},${t.y + 6}`;
        out.push(`<g class="terminal mode-${p.mode}"><title>${esc(`${p.name} : ${p.mode} ${p.type ?? ''}`)}</title><polygon points="${arrow}"/>`);
        out.push(`<text class="terminal-label" x="${left ? t.x - 18 : t.x + 18}" y="${t.y + 4}" text-anchor="${left ? 'end' : 'start'}">${esc(p.name)}</text></g>`);
    }

    // Wires.
    for (const net of model.nets) {
        const ends = net.endpoints.map((e) => ({ e, at: anchorOf(layout, e) })).filter((x): x is { e: Endpoint; at: Point & { side: 'left' | 'right' } } => x.at !== undefined);
        const drivers = ends.filter((x) => drives(x.e));
        const anchor = drivers[0] ?? (ends.length > 1 ? ends.find((x) => !sinks(x.e)) : undefined);
        out.push(`<g class="net net-${net.kind}"><title>${esc(net.name)}</title>`);
        if (anchor && ends.length > 1) {
            for (const other of ends) {
                if (other === anchor) continue;
                const cls = drives(other.e) ? 'wire conflict' : 'wire';
                out.push(`<path class="${cls}" d="${curve(anchor.at, other.at, anchor.at.side, other.at.side)}"/>`);
                if (other.e.detail) out.push(`<text class="pin-detail" x="${other.at.x + (other.at.side === 'left' ? -6 : 6)}" y="${other.at.y - 4}" text-anchor="${other.at.side === 'left' ? 'end' : 'start'}">${esc(other.e.detail)}</text>`);
            }
            const lx = anchor.at.x + (anchor.at.side === 'right' ? 8 : -8);
            out.push(`<text class="net-label" x="${lx}" y="${anchor.at.y - 5}" text-anchor="${anchor.at.side === 'right' ? 'start' : 'end'}">${esc(anchor.e.detail ?? net.name)}</text>`);
        } else {
            // Driven or used only by logic in this architecture: a labelled stub at each pin.
            for (const x of ends) {
                if (x.e.block === undefined) continue;
                const dir = x.at.side === 'left' ? -1 : 1;
                out.push(`<path class="wire stub" d="M ${x.at.x} ${x.at.y} h ${dir * 24}"/>`);
                out.push(`<text class="net-label" x="${x.at.x + dir * 28}" y="${x.at.y + 4}" text-anchor="${dir < 0 ? 'end' : 'start'}">${esc(x.e.detail ?? net.name)}</text>`);
            }
        }
        out.push('</g>');
    }

    // Pins connected to literals/expressions.
    for (const s of model.stubs) {
        const at = layout.blocks.find((b) => b.block.id === s.block)?.pins.get(s.port.toLowerCase());
        if (!at) continue;
        const dir = at.side === 'left' ? -1 : 1;
        out.push(`<g class="stub-expr"><path class="wire stub" d="M ${at.x} ${at.y} h ${dir * 16}"/><text class="expr-label" x="${at.x + dir * 20}" y="${at.y + 4}" text-anchor="${dir < 0 ? 'end' : 'start'}">${esc(s.text)}</text></g>`);
    }

    // Blocks.
    for (const lb of layout.blocks) {
        const b = lb.block;
        const l = b.location;
        out.push(
            `<g class="block status-${b.status}" data-file="${esc(l?.file ?? '')}" data-line="${l?.line ?? 1}" data-col="${l?.col ?? 1}" data-hid="${esc(b.hierarchyId)}" data-children="${b.childCount}" tabindex="0">`,
        );
        out.push(`<title>${esc(`${b.label} : ${b.entityName}${b.note ? ` — ${b.note}` : ''}\nClick to open the instantiation${b.childCount ? '; use ⤵ to look inside' : ''}`)}</title>`);
        out.push(`<rect x="${lb.x}" y="${lb.y}" width="${lb.width}" height="${lb.height}" rx="5"/>`);
        if (b.generate.length > 0) out.push(`<rect class="replica" x="${lb.x + 4}" y="${lb.y + 4}" width="${lb.width}" height="${lb.height}" rx="5"/>`);
        out.push(`<text class="block-label" x="${lb.x + lb.width / 2}" y="${lb.y + 16}" text-anchor="middle">${esc(b.label)}</text>`);
        out.push(`<text class="block-entity" x="${lb.x + lb.width / 2}" y="${lb.y + 31}" text-anchor="middle">${esc(b.entityName)}${b.status === 'ok' ? '' : ' ?'}</text>`);
        if (b.childCount > 0) out.push(`<text class="drill" data-hid="${esc(b.hierarchyId)}" x="${lb.x + lb.width - 16}" y="${lb.y + 16}">⤵</text>`);
        for (const p of b.ports) {
            const pin = lb.pins.get(p.name.toLowerCase());
            if (!pin) continue;
            const left = pin.side === 'left';
            out.push(`<line class="pin" x1="${pin.x}" y1="${pin.y}" x2="${pin.x + (left ? 6 : -6)}" y2="${pin.y}"/>`);
            out.push(`<text class="pin-label" x="${pin.x + (left ? 9 : -9)}" y="${pin.y + 4}" text-anchor="${left ? 'start' : 'end'}">${esc(p.name)}</text>`);
        }
        out.push('</g>');
    }
    out.push('</svg>');
    return out.join('\n');
}
