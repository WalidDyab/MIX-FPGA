import { type Diagnostic, diagnostic } from '../../results/diagnostic';
import type { ClockTiming, ResourceUsage, ResourceUtilization, TimingResult } from '../types';

/** Shape of nextpnr-xilinx's `--report` JSON (fields NexysVHDL reads). */
interface NextpnrReport {
    readonly fmax?: Readonly<Record<string, { achieved?: number; constraint?: number }>>;
    readonly utilization?: Readonly<Record<string, { used?: number; available?: number }>>;
}

const usage = (u: { used?: number; available?: number } | undefined): ResourceUsage | undefined =>
    u && typeof u.used === 'number' ? (typeof u.available === 'number' ? { used: u.used, available: u.available } : { used: u.used }) : undefined;

/** Parses nextpnr-xilinx report JSON into utilization + per-clock timing. Pure. */
export function parseNextpnrReport(json: string): { utilization: ResourceUtilization; clocks: ClockTiming[] } {
    const r = JSON.parse(json) as NextpnrReport;
    const util = r.utilization ?? {};
    const device: Record<string, ResourceUsage> = {};
    for (const [name, u] of Object.entries(util)) {
        const v = usage(u);
        if (v && v.used > 0) device[name] = v;
    }

    const bramUsed = (util['RAMB36E1_RAMB36E1']?.used ?? 0) + (util['RAMB18E1_RAMB18E1']?.used ?? 0);
    const pick = (key: string) => usage(util[key]);
    const utilization: ResourceUtilization = {
        ...(pick('SLICE_LUTX') ? { luts: pick('SLICE_LUTX')! } : {}),
        ...(pick('SLICE_FFX') ? { flipFlops: pick('SLICE_FFX')! } : {}),
        ...(pick('CARRY4') ? { carry: pick('CARRY4')! } : {}),
        ...(pick('DSP48E1_DSP48E1') ? { dsp: pick('DSP48E1_DSP48E1')! } : {}),
        ...('RAMB36E1_RAMB36E1' in util || 'RAMB18E1_RAMB18E1' in util ? { bram: { used: bramUsed } } : {}),
        ...(pick('PAD') ? { io: pick('PAD')! } : {}),
        ...(pick('BUFGCTRL') ? { globalClockBuffers: pick('BUFGCTRL')! } : {}),
        device,
    };

    const clocks: ClockTiming[] = Object.entries(r.fmax ?? {}).map(([clock, f]) => ({
        clock,
        ...(typeof f.constraint === 'number' ? { targetMHz: f.constraint } : {}),
        ...(typeof f.achieved === 'number' ? { achievedMHz: f.achieved } : {}),
        ...(typeof f.constraint === 'number' && typeof f.achieved === 'number' ? { passed: f.achieved >= f.constraint } : {}),
    }));
    return { utilization, clocks };
}

/** Facts extracted from `apio build --verbose` output. */
export interface ApioLogFacts {
    /** From `xc7frames2bit --part_name <part>`. */
    readonly part?: string;
    /** Post-route worst slack (ns), from the last slack histogram's first bucket. */
    readonly worstSlackNs?: number;
    /** Post-route critical path delay (ns), cumulative time of the last report line. */
    readonly criticalPathNs?: number;
    /** Post-route `Max frequency` lines: clock -> {achieved, target, pass}. */
    readonly maxFrequency: readonly ClockTiming[];
    readonly diagnostics: readonly Diagnostic[];
    readonly success: boolean;
}

/** Extracts part, timing summary and warnings/errors from an Apio verbose build log. Pure. */
export function parseApioBuildLog(log: string): ApioLogFacts {
    const lines = log.split(/\r?\n/);
    const diagnostics: Diagnostic[] = [];
    const fmaxByClock = new Map<string, ClockTiming>();
    let part: string | undefined;
    let worstSlackNs: number | undefined;
    let criticalPathNs: number | undefined;
    let inHistogram = false;
    let inCritical = false;
    let lastCumulative: number | undefined;

    for (const line of lines) {
        const partMatch = /--part_name\s+(\S+)/.exec(line);
        if (partMatch) part = partMatch[1];

        const fmax = /Max frequency for clock '([^']+)':\s*([\d.]+) MHz \((PASS|FAIL) at ([\d.]+) MHz\)/.exec(line);
        if (fmax) {
            // Later lines (post-route) replace earlier estimates.
            fmaxByClock.set(fmax[1]!, { clock: fmax[1]!, achievedMHz: Number(fmax[2]), targetMHz: Number(fmax[4]), passed: fmax[3] === 'PASS' });
        }

        // Each report ends with "x ns logic, y ns routing"; the last report is post-route.
        if (/^(?:Info:)?\s*Critical path report for clock/.test(line)) {
            inCritical = true;
            lastCumulative = undefined;
        } else if (inCritical) {
            const step = /^(?:Info:)?\s*([\d.]+)\s+([\d.]+)\s+(?:Source|Net|Setup)\b/.exec(line);
            if (step) lastCumulative = Number(step[2]);
            if (/ns logic, [\d.]+ ns routing/.test(line)) {
                if (lastCumulative !== undefined) criticalPathNs = lastCumulative;
                inCritical = false;
            }
        }

        if (/^(?:Info:)?\s*Slack histogram:/.test(line)) {
            inHistogram = true;
            continue;
        }
        if (inHistogram) {
            const bucket = /^(?:Info:)?\s*\[\s*(-?\d+),\s*(-?\d+)\)/.exec(line);
            if (bucket) {
                worstSlackNs = Number(bucket[1]) / 1000; // histogram is in ps
                inHistogram = false;
            }
        }

        const warn = /^Warning:\s*(.*)$/.exec(line);
        if (warn) diagnostics.push(diagnostic('warning', 'implementation', 'IMPL_WARNING', warn[1]!.trim()));
        const err = /^(?:ERROR|Error):\s*(.*)$/.exec(line) ?? /:\d+: ERROR: (.*)$/.exec(line);
        if (err) diagnostics.push(diagnostic('error', 'implementation', 'IMPL_ERROR', err[1]!.trim()));
    }

    const success = /\[SUCCESS\]/.test(log) && !/\[ERROR\]/.test(log);
    return {
        maxFrequency: [...fmaxByClock.values()],
        diagnostics,
        success,
        ...(part !== undefined ? { part } : {}),
        ...(worstSlackNs !== undefined ? { worstSlackNs } : {}),
        ...(criticalPathNs !== undefined ? { criticalPathNs } : {}),
    };
}

/** Yosys JSON netlist (fields NexysVHDL reads). */
interface YosysJson {
    readonly modules: Readonly<Record<string, { attributes?: Record<string, unknown>; cells?: Record<string, { type: string }> }>>;
}

/**
 * Counts leaf primitives in a Yosys JSON netlist, expanding user submodules
 * (so a counter instantiated inside `top` is counted). Pure.
 */
export function countPrimitives(json: string, top?: string): Record<string, number> {
    const { modules } = JSON.parse(json) as YosysJson;
    const isTopAttr = (v: unknown) => v === 1 || v === '1' || (typeof v === 'string' && /^0*1$/.test(v));
    const root = top ?? Object.keys(modules).find((n) => isTopAttr(modules[n]?.attributes?.['top']));
    const counts: Record<string, number> = {};
    if (!root || !modules[root]) return counts;

    const isUserModule = (name: string) => modules[name] !== undefined && !modules[name]!.attributes?.['blackbox'];
    const walk = (name: string, multiplier: number, depth: number) => {
        if (depth > 64) return; // defensive: malformed recursive netlist
        for (const cell of Object.values(modules[name]?.cells ?? {})) {
            if (isUserModule(cell.type)) walk(cell.type, multiplier, depth + 1);
            else counts[cell.type] = (counts[cell.type] ?? 0) + multiplier;
        }
    };
    walk(root, 1, 0);
    return counts;
}

/** Combines per-clock results into an overall TimingResult. */
export function summarizeTiming(clocks: readonly ClockTiming[], facts: Pick<ApioLogFacts, 'worstSlackNs' | 'criticalPathNs'>): TimingResult {
    const judged = clocks.filter((c) => c.passed !== undefined);
    return {
        clocks,
        ...(facts.worstSlackNs !== undefined ? { worstSlackNs: facts.worstSlackNs } : {}),
        ...(facts.criticalPathNs !== undefined ? { criticalPathNs: facts.criticalPathNs } : {}),
        ...(judged.length > 0 ? { passed: judged.every((c) => c.passed) } : {}),
    };
}
