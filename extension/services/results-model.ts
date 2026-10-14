import type { BuildResult, LogRef, ResourceUsage, SimulationResult, VhdlCheckResult } from '../../core';
import type { NormalizedBuildResult, VendorMetric } from '../../core/backend';
import { formatSimTime } from './workflow-state';

export interface ResultRow {
    readonly label: string;
    readonly value: string;
    /** For colouring: true = good, false = bad, undefined = neutral. */
    readonly good?: boolean;
}

export interface ResultsModel {
    readonly check?: { readonly passed: boolean; readonly rows: readonly ResultRow[]; readonly logs: readonly LogRef[] };
    readonly simulation?: { readonly passed: boolean; readonly rows: readonly ResultRow[]; readonly messages: readonly string[]; readonly logs: readonly LogRef[] };
    readonly build?: {
        readonly success: boolean;
        readonly timing: readonly ResultRow[];
        readonly resources: readonly ResultRow[];
        readonly bitstream?: ResultRow;
        readonly logs: readonly LogRef[];
    };
}

const count = (n: number) => n.toLocaleString('en-US');
const usage = (u: ResourceUsage | undefined) => (u ? `${count(u.used)}${u.available !== undefined ? ` / ${count(u.available)}` : ''}` : undefined);
const mhz = (v: number) => `${Math.round(v * 100) / 100} MHz`;

/**
 * Rows for the Results view, taken only from Phase 3 result objects.
 * A value the backend did not report is shown as "not reported", never guessed. Pure.
 */
export function buildResultsModel(check?: VhdlCheckResult, sim?: SimulationResult, build?: BuildResult): ResultsModel {
    const model: { -readonly [K in keyof ResultsModel]: ResultsModel[K] } = {};
    if (check) {
        const errors = check.diagnostics.filter((d) => d.severity === 'error').length;
        const warnings = check.diagnostics.filter((d) => d.severity === 'warning').length;
        model.check = {
            passed: check.status === 'succeeded',
            rows: [
                { label: 'Errors', value: String(errors), good: errors === 0 },
                { label: 'Warnings', value: String(warnings) },
                ...(check.elaborated.length ? [{ label: 'Elaborated', value: check.elaborated.join(', ') }] : []),
            ],
            logs: check.logs,
        };
    }
    if (sim) {
        const passed = sim.status === 'succeeded' && sim.passed;
        model.simulation = {
            passed,
            rows: [
                { label: 'Testbench', value: sim.testbench || '(none)' },
                { label: 'Result', value: passed ? 'Passed' : 'Failed', good: passed },
                ...(sim.stoppedAt ? [{ label: 'Stopped at', value: formatSimTime(sim.stoppedAt) }] : []),
                ...(sim.waveform ? [{ label: 'Waveform', value: sim.waveform.path.split(/[\\/]/).pop()! }] : []),
            ],
            messages: sim.messages,
            logs: sim.logs,
        };
    }
    if (build?.normalized) {
        model.build = normalizedBuildRows(build.normalized, build);
    } else if (build) {
        const timing: ResultRow[] = [];
        if (build.timing) {
            if (build.timing.passed !== undefined) timing.push({ label: 'Timing', value: build.timing.passed ? 'PASS' : 'FAIL', good: build.timing.passed });
            const many = build.timing.clocks.length > 1;
            for (const c of build.timing.clocks) {
                const suffix = many ? ` (${c.clock})` : '';
                if (c.targetMHz !== undefined) timing.push({ label: `Target${suffix}`, value: mhz(c.targetMHz) });
                if (c.achievedMHz !== undefined) timing.push({ label: `Achieved${suffix}`, value: mhz(c.achievedMHz), ...(c.passed !== undefined ? { good: c.passed } : {}) });
            }
            if (build.timing.worstSlackNs !== undefined) timing.push({ label: 'Worst slack', value: `${build.timing.worstSlackNs} ns` });
        }
        const u = build.utilization;
        const resources: ResultRow[] = u
            ? [
                  { label: 'LUTs', value: usage(u.luts) ?? 'not reported' },
                  { label: 'Flip-Flops', value: usage(u.flipFlops) ?? 'not reported' },
                  { label: 'BRAM (36 Kb)', value: usage(u.bram) ?? 'not reported' },
                  { label: 'DSP', value: usage(u.dsp) ?? 'not reported' },
                  ...(u.io ? [{ label: 'I/O pins', value: usage(u.io)! }] : []),
              ]
            : [];
        model.build = {
            success: build.success,
            timing,
            resources,
            ...(build.bitstream ? { bitstream: { label: 'Bitstream', value: build.bitstream.path.split(/[\\/]/).pop()! } } : {}),
            logs: build.logs,
        };
    }
    return model;
}

/** `+16.6 ns`; below 1 ns two decimals keep the value readable (`+0.16 ns`). */
const signed = (v: number) => `${v >= 0 ? '+' : ''}${Math.abs(v) >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100} ns`;
const metricText = (m: VendorMetric | undefined) => (m ? `${count(m.used)}${m.available !== undefined ? ` / ${count(m.available)}` : ''}` : 'not reported');

/**
 * Build rows from a vendor-neutral result. Resource names are the board's own words (Logic Elements are
 * not LUTs); timing uses one presentation for every board. A metric the tool did not report is shown as
 * "not reported", never guessed.
 */
function normalizedBuildRows(n: NormalizedBuildResult, build: BuildResult): NonNullable<ResultsModel['build']> {
    const timing: ResultRow[] = [];
    if (n.timingStatus === 'met' || n.timingStatus === 'not-met') timing.push({ label: 'Timing', value: n.timingStatus === 'met' ? 'PASS' : 'FAIL', good: n.timingStatus === 'met' });
    const many = n.clocks.length > 1;
    for (const c of n.clocks) {
        const suffix = many ? ` (${c.name})` : '';
        if (c.targetMHz !== undefined) timing.push({ label: `Target${suffix}`, value: mhz(c.targetMHz) });
        if (c.fmaxMHz !== undefined) timing.push({ label: `Fmax${suffix}`, value: mhz(c.fmaxMHz), ...(c.targetMHz !== undefined ? { good: c.fmaxMHz >= c.targetMHz } : {}) });
        if (c.worstSetupSlackNs !== undefined) timing.push({ label: `Setup slack${suffix}`, value: signed(c.worstSetupSlackNs), good: c.worstSetupSlackNs >= 0 });
        if (c.worstHoldSlackNs !== undefined) timing.push({ label: `Hold slack${suffix}`, value: signed(c.worstHoldSlackNs), good: c.worstHoldSlackNs >= 0 });
    }
    const L = n.labels;
    const r = n.resources;
    const resources: ResultRow[] = [];
    if (L && (Object.keys(r).length > 0 || n.implementationStatus === 'passed')) {
        resources.push(
            { label: L.logic, value: metricText(r.logic) },
            { label: L.registers, value: metricText(r.registers) },
            { label: L.memory, value: metricText(r.memoryBlocks ?? r.memoryBits) },
            { label: L.dsp, value: metricText(r.dsp) },
        );
        if (r.pins) resources.push({ label: 'I/O pins', value: metricText(r.pins) });
    }
    const file = build.bitstream ? build.bitstream.path.split(/[\\/]/).pop()! : undefined;
    return {
        success: build.success,
        timing,
        resources,
        ...(file ? { bitstream: { label: n.programmingArtifact && n.programmingArtifact.format !== 'bit' ? 'Programming file' : 'Bitstream', value: file } } : {}),
        logs: build.logs,
    };
}
