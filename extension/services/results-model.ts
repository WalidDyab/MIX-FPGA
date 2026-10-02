import type { BuildResult, LogRef, ResourceUsage, SimulationResult, VhdlCheckResult } from '../../core';
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
    if (build) {
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
