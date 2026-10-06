import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * RTL schematic model built from the Yosys JSON netlist produced by the
 * shared core's RTL analysis (GHDL synthesis -> Yosys `proc`, no technology
 * mapping). Pure: JSON text in, model out.
 *
 * Bits are grouped into word-level connections; slices, concatenations and
 * constants become explicit nodes or labels. Every Yosys cell becomes a
 * node: known generic cells get student-facing labels, anything else is
 * shown as a generic block with its raw type (never guessed).
 */

// ------------------------------------------------------------- Yosys JSON

export type YosysBit = number | '0' | '1' | 'x' | 'z';

export interface YosysCell {
    readonly hide_name?: number;
    readonly type: string;
    readonly parameters?: Readonly<Record<string, string | number>>;
    readonly attributes?: Readonly<Record<string, string | number>>;
    readonly port_directions?: Readonly<Record<string, 'input' | 'output' | 'inout'>>;
    readonly connections: Readonly<Record<string, readonly YosysBit[]>>;
}

export interface YosysModule {
    readonly attributes?: Readonly<Record<string, string | number>>;
    readonly ports?: Readonly<Record<string, { readonly direction: 'input' | 'output' | 'inout'; readonly bits: readonly YosysBit[] }>>;
    readonly cells?: Readonly<Record<string, YosysCell>>;
    readonly netnames?: Readonly<Record<string, { readonly hide_name?: number; readonly bits: readonly YosysBit[] }>>;
}

export interface YosysNetlist {
    readonly modules: Readonly<Record<string, YosysModule>>;
}

export function parseYosysJson(text: string): YosysNetlist {
    const data = JSON.parse(text) as Partial<YosysNetlist>;
    if (typeof data !== 'object' || data === null || typeof data.modules !== 'object' || data.modules === null) {
        throw new Error('not a Yosys JSON netlist (no "modules")');
    }
    return data as YosysNetlist;
}

/** Yosys writes parameters as binary strings (or numbers); decode to a number when it is one. */
export function paramValue(v: string | number | undefined): number | string | undefined {
    if (typeof v === 'number' || v === undefined) return v;
    if (/^[01]+$/.test(v)) return v.length <= 52 ? parseInt(v, 2) : v;
    return v.trim();
}

// ------------------------------------------------------------- cell catalogue

export type RtlKind = 'register' | 'latch' | 'mux' | 'arith' | 'compare' | 'logic' | 'reduce' | 'shift' | 'buffer' | 'instance' | 'generic';

interface CellInfo {
    readonly kind: RtlKind;
    readonly label: string;
    readonly description: string;
}

const REGISTER_DESC: Record<string, string> = {
    $dff: 'D flip-flops (register)',
    $dffe: 'register with enable',
    $adff: 'register with asynchronous reset',
    $adffe: 'register with asynchronous reset and enable',
    $sdff: 'register with synchronous reset',
    $sdffe: 'register with synchronous reset and enable',
    $sdffce: 'register with synchronous reset (gated by enable) and enable',
    $aldff: 'register with asynchronous load',
    $aldffe: 'register with asynchronous load and enable',
    $dffsr: 'register with asynchronous set/reset',
    $dffsre: 'register with asynchronous set/reset and enable',
    $ff: 'register on the global clock',
};

const CELLS: Record<string, CellInfo> = {
    $mux: { kind: 'mux', label: 'MUX', description: '2-to-1 multiplexer: Y = sel ? 1 : 0' },
    $pmux: { kind: 'mux', label: 'MUX', description: 'parallel multiplexer (one-hot select)' },
    $bmux: { kind: 'mux', label: 'MUX', description: 'multiplexer with binary select' },
    $demux: { kind: 'mux', label: 'DEMUX', description: 'demultiplexer' },
    $add: { kind: 'arith', label: '+', description: 'adder' },
    $sub: { kind: 'arith', label: '−', description: 'subtractor' },
    $mul: { kind: 'arith', label: '×', description: 'multiplier' },
    $div: { kind: 'arith', label: '÷', description: 'divider' },
    $mod: { kind: 'arith', label: 'mod', description: 'modulo' },
    $neg: { kind: 'arith', label: '−x', description: 'negation' },
    $pow: { kind: 'arith', label: '**', description: 'power' },
    $eq: { kind: 'compare', label: '=', description: 'equality comparator' },
    $ne: { kind: 'compare', label: '≠', description: 'inequality comparator' },
    $eqx: { kind: 'compare', label: '=', description: 'exact equality comparator' },
    $nex: { kind: 'compare', label: '≠', description: 'exact inequality comparator' },
    $lt: { kind: 'compare', label: '<', description: 'less-than comparator' },
    $le: { kind: 'compare', label: '≤', description: 'less-or-equal comparator' },
    $gt: { kind: 'compare', label: '>', description: 'greater-than comparator' },
    $ge: { kind: 'compare', label: '≥', description: 'greater-or-equal comparator' },
    $and: { kind: 'logic', label: 'AND', description: 'bitwise AND' },
    $or: { kind: 'logic', label: 'OR', description: 'bitwise OR' },
    $xor: { kind: 'logic', label: 'XOR', description: 'bitwise XOR' },
    $xnor: { kind: 'logic', label: 'XNOR', description: 'bitwise XNOR' },
    $not: { kind: 'logic', label: 'NOT', description: 'bitwise NOT (inverter)' },
    $logic_not: { kind: 'logic', label: 'NOT', description: 'logical NOT' },
    $logic_and: { kind: 'logic', label: 'AND', description: 'logical AND' },
    $logic_or: { kind: 'logic', label: 'OR', description: 'logical OR' },
    $reduce_and: { kind: 'reduce', label: 'AND', description: 'AND of all bits' },
    $reduce_or: { kind: 'reduce', label: 'OR', description: 'OR of all bits' },
    $reduce_xor: { kind: 'reduce', label: 'XOR', description: 'XOR of all bits (parity)' },
    $reduce_xnor: { kind: 'reduce', label: 'XNOR', description: 'XNOR of all bits' },
    $reduce_bool: { kind: 'reduce', label: '≠ 0', description: 'true if any bit is 1' },
    $shl: { kind: 'shift', label: '<<', description: 'shift left' },
    $shr: { kind: 'shift', label: '>>', description: 'shift right' },
    $sshl: { kind: 'shift', label: '<<<', description: 'arithmetic shift left' },
    $sshr: { kind: 'shift', label: '>>>', description: 'arithmetic shift right' },
    $shift: { kind: 'shift', label: 'shift', description: 'variable shift' },
    $shiftx: { kind: 'shift', label: 'shift', description: 'variable shift (part select)' },
    $pos: { kind: 'buffer', label: 'buf', description: 'buffer' },
    $buf: { kind: 'buffer', label: 'buf', description: 'buffer' },
    $dlatch: { kind: 'latch', label: 'Latch', description: 'level-sensitive latch (often unintended: a signal is not assigned in every branch)' },
    $adlatch: { kind: 'latch', label: 'Latch', description: 'latch with asynchronous reset' },
    $dlatchsr: { kind: 'latch', label: 'Latch', description: 'latch with set/reset' },
};

/** Student-facing classification of a Yosys cell type (`modules` = user modules in the netlist). */
export function classifyCell(type: string, modules: ReadonlySet<string>): CellInfo {
    if (REGISTER_DESC[type]) return { kind: 'register', label: 'Register', description: REGISTER_DESC[type]! };
    if (/^\$_(S?DFF|DFFE|ALDFF|DFFSR|SDFF)/.test(type)) return { kind: 'register', label: 'Register', description: 'flip-flop' };
    if (CELLS[type]) return CELLS[type]!;
    if (!type.startsWith('$')) return { kind: 'instance', label: type, description: modules.has(type) ? 'instance of a design module' : 'instance of an external/black-box module' };
    return { kind: 'generic', label: type, description: 'cell type not specially represented; shown as a generic block' };
}

const PIN_LABEL: Record<string, string> = { CLK: 'clk', EN: 'en', ARST: 'rst', SRST: 'rst', CLR: 'clr', SET: 'set', AD: 'load', ALOAD: 'load', S: 'sel', Y: 'y', Q: 'Q', D: 'D', A: 'a', B: 'b' };

function pinLabel(kind: RtlKind, port: string): string {
    if (kind === 'mux' && port === 'A') return '0';
    if (kind === 'mux' && port === 'B') return '1';
    if (kind === 'instance' || kind === 'generic') return port;
    return PIN_LABEL[port] ?? port;
}

const OUTPUT_PINS = new Set(['Y', 'Q', 'X', 'CO']);

// ------------------------------------------------------------- model

export interface SourceRef {
    readonly file: string;
    readonly line: number;
    readonly col: number;
}

export type RtlNodeKind = RtlKind | 'input' | 'output' | 'const' | 'concat';

export interface RtlPin {
    readonly name: string;
    readonly label: string;
    readonly dir: 'in' | 'out';
    readonly width: number;
}

export interface RtlNode {
    readonly id: string;
    readonly kind: RtlNodeKind;
    /** Student-facing label: `Register`, `+`, `MUX`, a port name, a constant. */
    readonly label: string;
    /** Second line, e.g. `27 bits`, `rising edge`, an entity name. */
    readonly sublabel?: string;
    readonly description: string;
    /** Raw Yosys cell type (details only). */
    readonly rawType?: string;
    /** Yosys cell / port name. */
    readonly name: string;
    readonly width: number;
    readonly pins: readonly RtlPin[];
    readonly parameters?: Readonly<Record<string, number | string>>;
    /** VHDL location from GHDL's netlist comments, only when exactly known. */
    readonly source?: SourceRef;
    /** Netlist module of an instance, when it is part of the netlist (drill-down). */
    readonly module?: string;
}

export interface RtlEnd {
    readonly node: string;
    readonly pin: string;
}

export interface RtlEdge {
    readonly from: RtlEnd;
    readonly to: RtlEnd;
    readonly width: number;
    /** Net name when the driver bits form a named signal. */
    readonly label?: string;
    /** Part of the driver used, e.g. `[26]` or `[7:4]`, when not all of it. */
    readonly slice?: string;
}

export interface RtlModuleView {
    readonly name: string;
    /** Entity name when the netlist module maps to one (GHDL adds architecture/generic suffixes). */
    readonly displayName: string;
    readonly nodes: readonly RtlNode[];
    readonly edges: readonly RtlEdge[];
    /** Counts per student label, for the legend/summary. */
    readonly summary: Readonly<Record<string, number>>;
}

export interface RtlModel {
    readonly top: string;
    readonly modules: ReadonlyMap<string, RtlModuleView>;
}

export interface RtlBuildOptions {
    /** Top module name (default: the module with the `top` attribute, else the first). */
    readonly top?: string;
    /** GHDL Verilog text whose `/*# file:line:col *\/` comments give VHDL locations. */
    readonly verilog?: string;
    /** Project root, to make source paths project-relative (others are dropped). */
    readonly projectRoot?: string;
    /** Folder GHDL ran in; relative paths in its comments are relative to it. */
    readonly verilogDir?: string;
    /** Known entity names, to name GHDL's mangled modules (`counter_Brtl_27` -> `counter`). */
    readonly entities?: readonly string[];
}

/**
 * Line -> VHDL location from GHDL's Verilog: a statement line counts only
 * when the line directly above it is GHDL's `/*# path:line:col *\/` comment.
 */
export function ghdlSourceMap(verilog: string, projectRoot?: string, verilogDir?: string): Map<number, SourceRef> {
    const map = new Map<number, SourceRef>();
    const lines = verilog.split(/\r?\n/);
    lines.forEach((text, i) => {
        const m = /^\s*\/\*#\s*(.+):(\d+):(\d+)\s*\*\/\s*$/.exec(text);
        if (!m || i + 1 >= lines.length) return;
        let file = m[1]!;
        if (projectRoot) {
            // GHDL is given workspace-relative sources (non-ASCII project folders), so its comments are relative to verilogDir.
            if (!isAbsolute(file)) {
                if (!verilogDir) return;
                file = resolve(verilogDir, file);
            }
            const rel = relative(projectRoot, file);
            if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return;
            file = rel.split(sep).join('/');
        }
        map.set(i + 2, { file, line: Number(m[2]), col: Number(m[3]) }); // 1-based line of the statement
    });
    return map;
}

/** First line of a Yosys `src` attribute (`generated.v:17.15-17.54|...`) in the given file. */
function srcLine(src: unknown, verilogName = 'generated.v'): number | undefined {
    if (typeof src !== 'string') return undefined;
    for (const part of src.split('|')) {
        const m = /([^/\\:]+):(\d+)\./.exec(part);
        if (m && m[1] === verilogName) return Number(m[2]);
    }
    return undefined;
}

/** Entity a GHDL module name belongs to: exact name, or the longest entity followed by `_`. */
export function entityForModule(module: string, entities: readonly string[]): string | undefined {
    const m = module.toLowerCase();
    let best: string | undefined;
    for (const e of entities) {
        const l = e.toLowerCase();
        if (m === l) return e;
        if (m.startsWith(`${l}_`) && (!best || l.length > best.length)) best = e;
    }
    return best;
}

function formatConst(bits: readonly YosysBit[]): string {
    const width = bits.length;
    const msbFirst = [...bits].reverse().map(String).join('');
    if (width === 1) return `'${msbFirst}'`;
    if (/[xz]/.test(msbFirst) || width <= 8) return `${width}'b${msbFirst}`;
    const padded = msbFirst.padStart(Math.ceil(width / 4) * 4, '0');
    let hex = '';
    for (let i = 0; i < padded.length; i += 4) hex += parseInt(padded.slice(i, i + 4), 2).toString(16).toUpperCase();
    return `${width}'h${hex}`;
}

const rangeText = (lo: number, hi: number) => (lo === hi ? `[${lo}]` : `[${hi}:${lo}]`);

interface Driver {
    readonly node: string;
    readonly pin: string;
    readonly index: number;
    readonly width: number;
    /** All bits of the driving pin (to name a sliced signal by its whole net). */
    readonly bits: readonly YosysBit[];
}

/** One module of the netlist as a word-level schematic. */
function buildModule(name: string, mod: YosysModule, moduleNames: ReadonlySet<string>, sources: Map<number, SourceRef> | undefined, entities: readonly string[]): RtlModuleView {
    const nodes: RtlNode[] = [];
    const edges: RtlEdge[] = [];
    const drivers = new Map<number, Driver>();
    const sinks: Array<{ node: string; pin: string; bits: readonly YosysBit[] }> = [];
    const summary: Record<string, number> = {};

    // Named nets, keyed by their exact bit list, label edges.
    const netNames = new Map<string, string>();
    for (const [n, net] of Object.entries(mod.netnames ?? {})) {
        // GHDL's own temporaries (n9, n14, ...) are not VHDL signals: never use them as labels.
        if (net.hide_name || /^n\d+$/.test(n)) continue;
        const key = net.bits.join(',');
        if (!netNames.has(key)) netNames.set(key, n);
    }

    for (const [port, p] of Object.entries(mod.ports ?? {})) {
        const id = `port:${port}`;
        const input = p.direction !== 'output';
        nodes.push({
            id, kind: input ? 'input' : 'output', label: port, name: port, width: p.bits.length,
            ...(p.bits.length > 1 ? { sublabel: `[${p.bits.length - 1}:0]` } : {}),
            description: p.direction === 'inout' ? 'bidirectional port' : input ? 'input port' : 'output port',
            pins: [{ name: input ? 'out' : 'in', label: '', dir: input ? 'out' : 'in', width: p.bits.length }],
        });
        if (input) p.bits.forEach((b, i) => typeof b === 'number' && drivers.set(b, { node: id, pin: 'out', index: i, width: p.bits.length, bits: p.bits }));
        else sinks.push({ node: id, pin: 'in', bits: p.bits });
    }

    for (const [cellName, cell] of Object.entries(mod.cells ?? {})) {
        const info = classifyCell(cell.type, moduleNames);
        const id = `cell:${cellName}`;
        const params: Record<string, number | string> = {};
        for (const [k, v] of Object.entries(cell.parameters ?? {})) {
            const d = paramValue(v);
            if (d !== undefined) params[k] = d;
        }
        const pins: RtlPin[] = [];
        let outWidth = 0;
        for (const [port, bits] of Object.entries(cell.connections)) {
            const dirRaw = cell.port_directions?.[port] ?? (OUTPUT_PINS.has(port) ? 'output' : 'input');
            const dir = dirRaw === 'output' ? 'out' : 'in';
            pins.push({ name: port, label: pinLabel(info.kind, port), dir, width: bits.length });
            if (dir === 'out') {
                outWidth = Math.max(outWidth, bits.length);
                bits.forEach((b, i) => typeof b === 'number' && drivers.set(b, { node: id, pin: port, index: i, width: bits.length, bits }));
            } else sinks.push({ node: id, pin: port, bits });
        }
        const width = typeof params['WIDTH'] === 'number' ? (params['WIDTH'] as number) : typeof params['Y_WIDTH'] === 'number' ? (params['Y_WIDTH'] as number) : outWidth;
        const line = srcLine(cell.attributes?.['src']);
        const source = line !== undefined ? sources?.get(line) : undefined;
        let sublabel: string | undefined;
        let label = info.label;
        if (info.kind === 'register') {
            const edge = params['CLK_POLARITY'] === 0 ? 'falling edge' : 'rising edge';
            sublabel = `${width} bit${width === 1 ? '' : 's'} · ${cell.type === '$ff' ? 'global clock' : edge}`;
        } else if (info.kind === 'instance') {
            label = cellName;
            sublabel = entityForModule(cell.type, entities) ?? cell.type;
        } else if (width > 1) sublabel = `${width} bits`;
        summary[info.kind === 'instance' ? 'instance' : info.label] = (summary[info.kind === 'instance' ? 'instance' : info.label] ?? 0) + 1;
        nodes.push({
            id, kind: info.kind, label, ...(sublabel ? { sublabel } : {}), description: info.description, rawType: cell.type, name: cellName, width, pins, parameters: params,
            ...(source ? { source } : {}),
            ...(info.kind === 'instance' && moduleNames.has(cell.type) ? { module: cell.type } : {}),
        });
    }

    // Word-level edges: group each sink's bits into runs from one driver (or constants).
    let constCount = 0;
    let concatCount = 0;
    const nodeIndex = new Map(nodes.map((n) => [n.id, n]));
    for (const sink of sinks) {
        type Run = { kind: 'drv'; drv: Driver; lo: number; hi: number; from: number; bits: YosysBit[] } | { kind: 'const'; bits: YosysBit[]; from: number };
        const runs: Run[] = [];
        sink.bits.forEach((b, i) => {
            const last = runs[runs.length - 1];
            if (typeof b !== 'number' || !drivers.has(b)) {
                const bit: YosysBit = typeof b === 'number' ? 'x' : b;
                if (last && last.kind === 'const') last.bits.push(bit);
                else runs.push({ kind: 'const', bits: [bit], from: i });
                return;
            }
            const d = drivers.get(b)!;
            if (last && last.kind === 'drv' && last.drv.node === d.node && last.drv.pin === d.pin && d.index === last.hi + 1) {
                last.hi = d.index;
                last.bits.push(b);
            } else runs.push({ kind: 'drv', drv: d, lo: d.index, hi: d.index, from: i, bits: [b] });
        });
        const edgeFor = (run: Run, to: RtlEnd): RtlEdge => {
            if (run.kind === 'const') {
                const id = `const:${constCount++}`;
                const value = formatConst(run.bits);
                const node: RtlNode = { id, kind: 'const', label: value, name: value, description: 'constant', width: run.bits.length, pins: [{ name: 'out', label: '', dir: 'out', width: run.bits.length }] };
                nodes.push(node);
                nodeIndex.set(id, node);
                return { from: { node: id, pin: 'out' }, to, width: run.bits.length };
            }
            const width = run.hi - run.lo + 1;
            const whole = run.lo === 0 && width === run.drv.width;
            const label = whole ? netNames.get(run.bits.join(',')) : (netNames.get(run.drv.bits.join(',')) ?? netNames.get(run.bits.join(',')));
            return {
                from: { node: run.drv.node, pin: run.drv.pin }, to, width,
                ...(label ? { label } : {}),
                ...(whole ? {} : { slice: rangeText(run.lo, run.hi) }),
            };
        };
        if (runs.length === 1) {
            edges.push(edgeFor(runs[0]!, { node: sink.node, pin: sink.pin }));
            continue;
        }
        // Several sources feed one pin: an explicit concatenation node (MSB part listed first, like VHDL `&`).
        const id = `concat:${concatCount++}`;
        const cpins: RtlPin[] = runs.map((r, k) => {
            const w = r.kind === 'const' ? r.bits.length : r.hi - r.lo + 1;
            return { name: `in${k}`, label: rangeText(r.from, r.from + w - 1), dir: 'in' as const, width: w };
        });
        const node: RtlNode = { id, kind: 'concat', label: '{ }', name: id, description: 'concatenation: several signals form one bus', width: sink.bits.length, pins: [...cpins.slice().reverse(), { name: 'out', label: '', dir: 'out', width: sink.bits.length }] };
        nodes.push(node);
        nodeIndex.set(id, node);
        runs.forEach((r, k) => edges.push(edgeFor(r, { node: id, pin: `in${k}` })));
        edges.push({ from: { node: id, pin: 'out' }, to: { node: sink.node, pin: sink.pin }, width: sink.bits.length });
    }

    return { name, displayName: entityForModule(name, entities) ?? name, nodes, edges, summary };
}

export function buildRtlModel(netlist: YosysNetlist, options: RtlBuildOptions = {}): RtlModel {
    const names = Object.keys(netlist.modules);
    if (names.length === 0) throw new Error('the netlist has no modules');
    const flagged = names.find((n) => {
        const t = netlist.modules[n]!.attributes?.['top'];
        return t === 1 || t === '1' || (typeof t === 'string' && /^0*1$/.test(t));
    });
    // VHDL names are case-insensitive, Verilog module names are not: match the configured top however GHDL spelled it.
    const wanted = options.top?.toLowerCase();
    const named = wanted === undefined ? undefined : (names.find((n) => n === options.top) ?? names.find((n) => n.toLowerCase() === wanted));
    const top = named ?? flagged ?? names[0]!;
    const moduleNames = new Set(names);
    const sources = options.verilog !== undefined ? ghdlSourceMap(options.verilog, options.projectRoot, options.verilogDir) : undefined;
    const modules = new Map<string, RtlModuleView>();
    for (const n of names) modules.set(n, buildModule(n, netlist.modules[n]!, moduleNames, sources, options.entities ?? []));
    return { top, modules };
}
