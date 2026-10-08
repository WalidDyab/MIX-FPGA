/**
 * Pure waveform rendering helpers: value formatting, cursor lookup and
 * pixel-level segment reduction. This file has NO imports so its compiled
 * JavaScript also runs unchanged inside the waveform webview (loaded as a
 * script after `var exports = {}`): the code the tests exercise is the code
 * that draws.
 */

export type Radix = 'bin' | 'hex' | 'udec' | 'sdec';

/** The four ways a signal can be shown ("Display As"), with the labels students see. */
export const RADIX_CHOICES: ReadonlyArray<{ readonly radix: Radix; readonly label: string }> = [
    { radix: 'bin', label: 'Binary' },
    { radix: 'hex', label: 'Hex' },
    { radix: 'udec', label: 'Unsigned Decimal' },
    { radix: 'sdec', label: 'Signed Decimal' },
];

export function isRadix(v: unknown): v is Radix {
    return v === 'bin' || v === 'hex' || v === 'udec' || v === 'sdec';
}

/**
 * Radix choices as stored for a workspace: the "Buses" default and per-signal
 * overrides keyed by the signal's hierarchical path. Anything malformed in a
 * stored value is dropped.
 */
export interface RadixState {
    readonly buses: Radix;
    readonly signals: Readonly<Record<string, Radix>>;
}

export function sanitizeRadixState(value: unknown): RadixState {
    const v = (typeof value === 'object' && value !== null ? value : {}) as { buses?: unknown; signals?: unknown };
    const signals: Record<string, Radix> = {};
    if (typeof v.signals === 'object' && v.signals !== null) {
        for (const [path, radix] of Object.entries(v.signals as Record<string, unknown>)) if (isRadix(radix)) signals[path] = radix;
    }
    return { buses: isRadix(v.buses) ? v.buses : 'hex', signals };
}

/**
 * The radix a signal is shown in: its own choice, else (integer-typed
 * signals) signed decimal, else the "Buses" default.
 */
export function effectiveRadix(state: RadixState, path: string, varType: string | undefined): Radix {
    return state.signals[path] ?? (varType === 'integer' ? 'sdec' : state.buses);
}

/** Index of the last change at or before `t`, or -1 before the first change. Binary search. */
export function indexAt(times: readonly number[], t: number): number {
    let lo = 0;
    let hi = times.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid]! <= t) {
            found = mid;
            lo = mid + 1;
        } else hi = mid - 1;
    }
    return found;
}

/** Value at time `t`, or undefined before the first recorded value. */
export function valueAt(times: readonly number[], values: readonly string[], t: number): string | undefined {
    const i = indexAt(times, t);
    return i < 0 ? undefined : values[i];
}

export interface FormatOptions {
    /** The value with VHDL metavalues kept apart (`u x 0 1 z w l h -`), when it has any. */
    readonly raw?: string;
}

/** `0`/`1` only: a number can be read from it. */
const NUMERIC = /^[01]+$/;

/** One digit for a group of bits that is not all 0/1: the shared metavalue letter, or X for a mix. */
function metaDigit(group: string): string {
    const first = group[0]!.toLowerCase();
    return [...group].every((c) => c.toLowerCase() === first) ? first.toUpperCase() : 'X';
}

/**
 * Formats a value (MSB-first bit string) as binary, hexadecimal, unsigned or
 * signed decimal. Scalars stay as they are. Decimal uses BigInt, so vectors
 * of any width are exact (a 64-bit counter does not overflow). A value with
 * a VHDL metavalue (U X Z W L H -) never becomes a number: decimal shows the
 * metavalue (`U`, `Z`, ...) or `X` when the bits disagree, hexadecimal shows
 * it per nibble and binary shows the bits as they are. `raw` carries the
 * metavalues the drawing form `value` folded away (L and H count as
 * metavalues too: weakly driven bits are not shown as numbers).
 */
export function formatValue(value: string | undefined, width: number, radix: Radix, options: FormatOptions = {}): string {
    if (value === undefined) return '—';
    const bits = options.raw ?? value;
    if (width <= 1) return options.raw ? options.raw.toUpperCase() : value;
    if (!/^[01xzuwlh-]+$/i.test(bits)) return value; // real numbers and other text
    const numeric = NUMERIC.test(bits);
    if (radix === 'bin') return numeric ? bits : options.raw ? bits.toUpperCase() : bits;
    if (radix === 'udec' || radix === 'sdec') {
        if (!numeric) return metaDigit(bits);
        const unsigned = BigInt('0b' + bits);
        if (radix === 'udec' || bits[0] === '0') return unsigned.toString();
        return (unsigned - (BigInt(1) << BigInt(bits.length))).toString();
    }
    const pad = /[^01]/.test(bits[0]!) ? bits[0]! : '0';
    const padded = bits.padStart(Math.ceil(bits.length / 4) * 4, pad);
    let out = '';
    for (let i = 0; i < padded.length; i += 4) {
        const nib = padded.slice(i, i + 4);
        out += NUMERIC.test(nib) ? parseInt(nib, 2).toString(16).toUpperCase() : metaDigit(nib);
    }
    return out;
}

/** GHDL time units a simulation duration may use. */
export const DURATION_UNITS = ['fs', 'ps', 'ns', 'us', 'ms', 'sec'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

/** Splits a stored duration (`2us`, `500 ns`) into the number and unit the toolbar shows; empty or invalid gives an empty number. */
export function splitDuration(text: string | undefined): { number: string; unit: DurationUnit } {
    const m = /^\s*(\d+)\s*(fs|ps|ns|us|ms|sec)\s*$/i.exec(text ?? '');
    return m ? { number: String(Number(m[1])), unit: m[2]!.toLowerCase() as DurationUnit } : { number: '', unit: 'us' };
}

/**
 * The value written to the project for what the toolbar holds. `''` is valid and means "no fixed
 * duration: the testbench decides" (the behavior of projects that never set one). Otherwise a whole
 * number above zero and a unit; anything else is undefined (invalid).
 */
export function joinDuration(number: string, unit: string): string | undefined {
    const n = number.trim();
    if (n === '') return '';
    if (!/^\d+$/.test(n) || Number(n) <= 0 || !(DURATION_UNITS as readonly string[]).includes(unit)) return undefined;
    return String(Number(n)) + unit;
}

/** Widths (px) of the two resizable panes of the viewer: the signal list on the left and the name/value column. */
export interface PaneLayout {
    readonly treeWidth: number;
    readonly namesWidth: number;
}

export const DEFAULT_LAYOUT: PaneLayout = { treeWidth: 210, namesWidth: 380 };
export const TREE_LIMITS = { min: 120, max: 600 } as const;
export const NAMES_LIMITS = { min: 160, max: 720 } as const;

/**
 * Keeps a pane width inside its limits, and never so wide that fewer than
 * `reserve` pixels are left for what is beside it (the waveform needs room).
 * A non-number gives the fallback.
 */
export function clampPaneWidth(width: unknown, limits: { readonly min: number; readonly max: number }, available: number, reserve: number, fallback: number): number {
    const w = typeof width === 'number' && Number.isFinite(width) ? width : fallback;
    const max = Math.max(limits.min, Math.min(limits.max, available - reserve));
    return Math.round(Math.min(max, Math.max(limits.min, w)));
}

/** A stored layout with anything malformed replaced by the defaults. */
export function sanitizeLayout(value: unknown): PaneLayout {
    const v = (typeof value === 'object' && value !== null ? value : {}) as { treeWidth?: unknown; namesWidth?: unknown };
    const ok = (n: unknown, limits: { min: number; max: number }, fallback: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(limits.max, Math.max(limits.min, Math.round(n))) : fallback);
    return { treeWidth: ok(v.treeWidth, TREE_LIMITS, DEFAULT_LAYOUT.treeWidth), namesWidth: ok(v.namesWidth, NAMES_LIMITS, DEFAULT_LAYOUT.namesWidth) };
}

/**
 * The signals the student chose to display, remembered per testbench by hierarchical path.
 * Bounded and cleaned so a damaged or hand-edited state file can never cause trouble.
 */
export type SignalChoices = Readonly<Record<string, readonly string[]>>;

export function sanitizeSignalChoices(value: unknown): SignalChoices {
    const out: Record<string, string[]> = {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
    for (const [testbench, paths] of Object.entries(value as Record<string, unknown>).slice(0, 64)) {
        if (!Array.isArray(paths)) continue;
        out[testbench] = paths.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 400).slice(0, 2000);
    }
    return out;
}

/** One drawable stretch of a trace. `dense` = several changes inside less than `minPx` pixels. */
export interface Segment {
    readonly x0: number;
    readonly x1: number;
    readonly value: string;
    /** The value with VHDL metavalues kept apart; only when `raws` was passed to traceSegments. */
    readonly raw?: string;
    readonly dense?: boolean;
}

/**
 * Reduces a trace to the segments visible between `t0` and `t1` on a
 * `width`-pixel canvas. Changes closer together than `minPx` merge into one
 * dense segment, so drawing cost depends on the canvas width, not on the
 * number of simulation events.
 */
export function traceSegments(times: readonly number[], values: readonly string[], t0: number, t1: number, width: number, minPx = 2, raws?: readonly string[]): Segment[] {
    const out: Segment[] = [];
    if (times.length === 0 || t1 <= t0 || width <= 0) return out;
    const scale = width / (t1 - t0);
    const px = (t: number) => (t - t0) * scale;
    let i = Math.max(0, indexAt(times, t0));
    if (times[i]! > t1) return out;
    let x0 = Math.max(0, px(times[i]!));
    let value = values[i]!;
    let raw = raws?.[i];
    let dense = false;
    const seg = (x1: number): Segment => ({ x0, x1, value, ...(raw !== undefined ? { raw } : {}), ...(dense ? { dense: true } : {}) });
    for (i = i + 1; i < times.length && times[i]! <= t1; i++) {
        const x = px(times[i]!);
        if (x - x0 < minPx) {
            dense = true;
            value = values[i]!;
            raw = raws?.[i];
            continue;
        }
        out.push(seg(x));
        x0 = x;
        value = values[i]!;
        raw = raws?.[i];
        dense = false;
    }
    out.push(seg(width));
    return out;
}

/** Human time for a value in timescale units: `660 ns`, `5 ns`, `1.25 us`. */
export function formatTime(t: number, timescaleFs: number): string {
    const fs = t * timescaleFs;
    const units: Array<[string, number]> = [['s', 1e15], ['ms', 1e12], ['us', 1e9], ['ns', 1e6], ['ps', 1e3], ['fs', 1]];
    for (const [u, f] of units) {
        if (Math.abs(fs) >= f || u === 'fs') {
            const v = fs / f;
            return `${Math.round(v * 1000) / 1000} ${u}`;
        }
    }
    return `${fs} fs`;
}

/** Evenly spaced "nice" tick times (1, 2, 5 × 10^n) for an axis about `width` pixels wide. */
export function niceTicks(t0: number, t1: number, width: number, minSpacingPx = 90): number[] {
    if (t1 <= t0 || width <= 0) return [];
    const raw = ((t1 - t0) * minSpacingPx) / width;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
    const out: number[] = [];
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
    return out;
}

/** Clamps a view window [t0, t1] to [0, end] while keeping its span when possible. */
export function clampView(t0: number, t1: number, end: number): [number, number] {
    const span = Math.max(1e-9, Math.min(t1 - t0, end > 0 ? end : t1 - t0));
    let a = t0;
    if (a < 0) a = 0;
    if (end > 0 && a + span > end) a = Math.max(0, end - span);
    return [a, a + span];
}
