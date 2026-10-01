/**
 * Pure waveform rendering helpers: value formatting, cursor lookup and
 * pixel-level segment reduction. This file has NO imports so its compiled
 * JavaScript also runs unchanged inside the waveform webview (loaded as a
 * script after `var exports = {}`): the code the tests exercise is the code
 * that draws.
 */

export type Radix = 'bin' | 'hex';

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

/** Formats a value (MSB-first 0/1/x/z string) as binary or hexadecimal; scalars stay as is. */
export function formatValue(value: string | undefined, width: number, radix: Radix): string {
    if (value === undefined) return '—';
    if (width <= 1 || !/^[01xz]+$/.test(value)) return value;
    if (radix === 'bin') return value;
    const padded = value.padStart(Math.ceil(value.length / 4) * 4, value[0] === 'x' || value[0] === 'z' ? value[0] : '0');
    let out = '';
    for (let i = 0; i < padded.length; i += 4) {
        const nib = padded.slice(i, i + 4);
        if (/^[01]{4}$/.test(nib)) out += parseInt(nib, 2).toString(16).toUpperCase();
        else if (nib === 'zzzz') out += 'Z';
        else out += 'X';
    }
    return out;
}

/** One drawable stretch of a trace. `dense` = several changes inside less than `minPx` pixels. */
export interface Segment {
    readonly x0: number;
    readonly x1: number;
    readonly value: string;
    readonly dense?: boolean;
}

/**
 * Reduces a trace to the segments visible between `t0` and `t1` on a
 * `width`-pixel canvas. Changes closer together than `minPx` merge into one
 * dense segment, so drawing cost depends on the canvas width, not on the
 * number of simulation events.
 */
export function traceSegments(times: readonly number[], values: readonly string[], t0: number, t1: number, width: number, minPx = 2): Segment[] {
    const out: Segment[] = [];
    if (times.length === 0 || t1 <= t0 || width <= 0) return out;
    const scale = width / (t1 - t0);
    const px = (t: number) => (t - t0) * scale;
    let i = Math.max(0, indexAt(times, t0));
    if (times[i]! > t1) return out;
    let x0 = Math.max(0, px(times[i]!));
    let value = values[i]!;
    let dense = false;
    for (i = i + 1; i < times.length && times[i]! <= t1; i++) {
        const x = px(times[i]!);
        if (x - x0 < minPx) {
            dense = true;
            value = values[i]!;
            continue;
        }
        out.push(dense ? { x0, x1: x, value, dense: true } : { x0, x1: x, value });
        x0 = x;
        value = values[i]!;
        dense = false;
    }
    out.push(dense ? { x0, x1: width, value, dense: true } : { x0, x1: width, value });
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
