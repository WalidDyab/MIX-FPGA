/**
 * Value Change Dump (IEEE 1364 §18) parser for the subset GHDL writes:
 * header sections ($date, $version, $timescale, $comment), nested $scope /
 * $upscope, $var (scalars and vectors, with or without a separate bit
 * range), $enddefinitions, simulation times (#t), scalar changes (0 1 x z
 * and VHDL-ish u/w/l/h/-), vector changes (b…, left-extended per the
 * standard), real changes (r…) and $dumpvars/$dumpall/$dumpon/$dumpoff
 * blocks. A token-level state machine, not line regexes. Pure; no VS Code API.
 */

export type TimeUnit = 's' | 'ms' | 'us' | 'ns' | 'ps' | 'fs';

const UNIT_FS: Record<TimeUnit, number> = { s: 1e15, ms: 1e12, us: 1e9, ns: 1e6, ps: 1e3, fs: 1 };

export interface VcdSignal {
    /** Hierarchical name with the bit range, e.g. `top_tb.dut.u_blink.count[3:0]`. */
    readonly path: string;
    /** Name as declared (without range). */
    readonly name: string;
    readonly scope: readonly string[];
    /** VCD identifier code; several signals may share one (aliases). */
    readonly code: string;
    readonly width: number;
    readonly msb?: number;
    readonly lsb?: number;
    /** VCD variable type (`reg`, `wire`, `real`, ...). */
    readonly varType: string;
}

export interface VcdScope {
    readonly name: string;
    readonly type: string;
    readonly scopes: VcdScope[];
    readonly signals: VcdSignal[];
}

/** Value changes of one identifier code. Consecutive equal values are collapsed. */
export interface VcdTrace {
    readonly width: number;
    /** Change times, ascending, in timescale units. */
    readonly times: number[];
    /** Full-width values: `0`/`1`/`x`/`z` strings MSB first, or a real as text for real variables. */
    readonly values: string[];
}

export interface VcdModel {
    readonly date?: string;
    readonly version?: string;
    /** One timescale unit in femtoseconds (e.g. 1 for `1 fs`, 1e6 for `1 ns`). */
    readonly timescaleFs: number;
    readonly timescale: string;
    /** Virtual root holding the top-level scopes. */
    readonly root: VcdScope;
    readonly signals: readonly VcdSignal[];
    readonly traces: ReadonlyMap<string, VcdTrace>;
    /** Last time stamp in the file (timescale units). */
    readonly endTime: number;
    /** Problems that did not stop parsing (e.g. a change for an undeclared code). */
    readonly warnings: readonly string[];
}

/** Splits on whitespace; VCD tokens never contain spaces. */
function* tokens(text: string): Generator<string> {
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) yield m[0];
}

function parseTimescale(parts: string[]): { fs: number; text: string } {
    const joined = parts.join('');
    const m = /^(1|10|100)(s|ms|us|ns|ps|fs)$/.exec(joined);
    if (!m) throw new Error(`unsupported $timescale "${parts.join(' ')}"`);
    return { fs: Number(m[1]) * UNIT_FS[m[2] as TimeUnit], text: `${m[1]} ${m[2]}` };
}

/** Normalizes a scalar VCD/VHDL value to 0, 1, x or z. */
function scalarValue(c: string): string {
    switch (c.toLowerCase()) {
        case '0':
        case 'l':
            return '0';
        case '1':
        case 'h':
            return '1';
        case 'z':
            return 'z';
        default:
            return 'x'; // x, u, w, -
    }
}

/** A vector value at full width: VCD left-extends with 0, or with x/z when the leftmost bit is x/z. */
export function extendVector(bits: string, width: number): string {
    const b = [...bits.toLowerCase()].map((c) => (c === '0' || c === '1' || c === 'x' || c === 'z' ? c : scalarValue(c))).join('');
    if (b.length >= width) return b.slice(b.length - width);
    const fill = b[0] === 'x' || b[0] === 'z' ? b[0] : '0';
    return fill.repeat(width - b.length) + b;
}

export function parseVcd(text: string): VcdModel {
    const root: VcdScope = { name: '', type: 'root', scopes: [], signals: [] };
    const stack: VcdScope[] = [root];
    const signals: VcdSignal[] = [];
    const traces = new Map<string, VcdTrace>();
    const warnings: string[] = [];
    let timescale = { fs: 1, text: '1 fs' };
    let date: string | undefined;
    let version: string | undefined;
    let time = 0;
    let endTime = 0;
    let definitions = true;

    const it = tokens(text);
    const section = (): string[] => {
        const out: string[] = [];
        for (let t = it.next(); !t.done; t = it.next()) {
            if (t.value === '$end') return out;
            out.push(t.value);
        }
        throw new Error('unterminated $ section');
    };
    const change = (code: string, value: string) => {
        const tr = traces.get(code);
        if (!tr) {
            if (warnings.length < 20) warnings.push(`value change for undeclared identifier "${code}" at ${time}`);
            return;
        }
        const last = tr.values.length - 1;
        if (last >= 0 && tr.times[last] === time) {
            // Several changes at one time: the last one wins; drop it if it now repeats the previous value.
            tr.values[last] = value;
            if (last > 0 && tr.values[last - 1] === value) {
                tr.values.pop();
                tr.times.pop();
            }
            return;
        }
        if (last >= 0 && tr.values[last] === value) return; // redundant transition
        tr.times.push(time);
        tr.values.push(value);
    };

    for (let t = it.next(); !t.done; t = it.next()) {
        const tok = t.value;
        if (tok.startsWith('$')) {
            switch (tok) {
                case '$date':
                    date = section().join(' ');
                    break;
                case '$version':
                    version = section().join(' ');
                    break;
                case '$comment':
                    section();
                    break;
                case '$timescale':
                    timescale = parseTimescale(section());
                    break;
                case '$scope': {
                    const [type = 'module', name = ''] = section();
                    const scope: VcdScope = { name, type, scopes: [], signals: [] };
                    stack[stack.length - 1]!.scopes.push(scope);
                    stack.push(scope);
                    break;
                }
                case '$upscope':
                    section();
                    if (stack.length > 1) stack.pop();
                    break;
                case '$var': {
                    const parts = section();
                    if (parts.length < 4) throw new Error(`malformed $var: ${parts.join(' ')}`);
                    const [varType, size, code, ref, ...rest] = parts as [string, string, string, string, ...string[]];
                    const width = Number(size);
                    if (!Number.isInteger(width) || width < 1) throw new Error(`malformed $var size "${size}"`);
                    // The range may be glued to the name (`count[3:0]`) or a separate token (`count [3:0]`).
                    const rangeText = /\[.*\]$/.test(ref) ? ref.slice(ref.indexOf('[')) : rest.join('');
                    const name = /\[.*\]$/.test(ref) ? ref.slice(0, ref.indexOf('[')) : ref;
                    const range = /^\[(-?\d+)(?::(-?\d+))?\]$/.exec(rangeText);
                    const scope = stack.slice(1).map((s) => s.name);
                    const signal: VcdSignal = {
                        path: [...scope, name].join('.') + (rangeText || ''),
                        name, scope, code, width, varType,
                        ...(range ? { msb: Number(range[1]), lsb: Number(range[2] ?? range[1]) } : {}),
                    };
                    stack[stack.length - 1]!.signals.push(signal);
                    signals.push(signal);
                    if (!traces.has(code)) traces.set(code, { width, times: [], values: [] });
                    break;
                }
                case '$enddefinitions':
                    section();
                    definitions = false;
                    break;
                case '$dumpvars':
                case '$dumpall':
                case '$dumpon':
                case '$dumpoff':
                case '$end':
                    break; // value changes inside these blocks are read normally
                default:
                    if (definitions) section(); // unknown header section
            }
            continue;
        }
        if (definitions) continue;
        const c = tok[0]!;
        if (c === '#') {
            const next = Number(tok.slice(1));
            if (!Number.isFinite(next)) throw new Error(`malformed time "${tok}"`);
            if (next < time) warnings.push(`time goes backwards at #${next}`);
            time = next;
            endTime = Math.max(endTime, time);
        } else if (c === 'b' || c === 'B') {
            const code = it.next().value;
            if (code === undefined) throw new Error('vector change without identifier');
            const tr = traces.get(code);
            change(code, extendVector(tok.slice(1), tr?.width ?? tok.length - 1));
        } else if (c === 'r' || c === 'R') {
            const code = it.next().value;
            if (code === undefined) throw new Error('real change without identifier');
            change(code, tok.slice(1));
        } else if (/[01xXzZuUwWlLhH-]/.test(c)) {
            change(tok.slice(1), scalarValue(c));
        } else {
            if (warnings.length < 20) warnings.push(`unrecognised token "${tok}" at ${time}`);
        }
    }
    return { ...(date ? { date } : {}), ...(version ? { version } : {}), timescaleFs: timescale.fs, timescale: timescale.text, root, signals, traces, endTime, warnings };
}

/** Removes scopes that (recursively) declare no signals, e.g. GHDL's package scopes. */
export function pruneEmptyScopes(scope: VcdScope): VcdScope {
    const scopes = scope.scopes.map(pruneEmptyScopes).filter((s) => s.signals.length > 0 || s.scopes.length > 0);
    return { ...scope, scopes };
}
