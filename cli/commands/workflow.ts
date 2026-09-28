import type { BuildResult, Project, ResourceUsage } from '../../core';
import { type CliContext, controllerFor } from '../context';
import { EXIT, type ExitCode, type Output, printDiagnostics, STATUS_LABEL, statusExit } from '../output';

export async function check(ctx: CliContext, out: Output, project: Project): Promise<ExitCode> {
    const result = await (await controllerFor(ctx, project)).check(project);
    out.line(`VHDL check: ${STATUS_LABEL[result.status]}${result.elaborated.length ? `  (elaborated: ${result.elaborated.join(', ')})` : ''}`);
    printDiagnostics(out, result.diagnostics);
    for (const l of result.logs) out.line(`  log: ${l.path}`);
    return statusExit(result.status);
}

export async function simulate(ctx: CliContext, out: Output, project: Project, testbench?: string): Promise<ExitCode> {
    const result = await (await controllerFor(ctx, project)).simulate(project, testbench);
    const verdict = result.status === 'succeeded' ? (result.passed ? 'PASSED' : 'FAILED') : STATUS_LABEL[result.status];
    out.line(`Simulation ${result.testbench || '(no testbench)'}: ${verdict}${result.stoppedAt ? `  (stopped @${result.stoppedAt})` : ''}`);
    for (const m of result.messages) out.line(`  ${m}`);
    printDiagnostics(out, result.diagnostics.filter((d) => d.code !== 'GHDL_REPORT_NOTE'));
    if (result.waveform) out.line(`  waveform: ${result.waveform.path} (${result.waveform.sizeBytes} bytes)`);
    if (result.status === 'succeeded' && !result.passed) return EXIT.failed;
    return statusExit(result.status);
}

const usage = (u: ResourceUsage | undefined) => (u ? `${u.used}${u.available !== undefined ? ` / ${u.available}` : ''}` : '—');

export function printBuild(out: Output, r: BuildResult): void {
    out.line(`Build: ${r.success ? 'SUCCEEDED' : 'FAILED'}  (${(r.durationMs / 1000).toFixed(1)} s)`);
    if (r.board) out.line(`  board: ${r.board.name}, part ${r.board.part}`);
    out.line('  steps:');
    for (const s of r.steps) out.line(`    ${s.step.padEnd(12)} ${STATUS_LABEL[s.status]}${s.durationMs ? `  ${(s.durationMs / 1000).toFixed(1)} s` : ''}`);
    if (r.utilization) {
        const u = r.utilization;
        out.line(`  resources: LUT ${usage(u.luts)}, FF ${usage(u.flipFlops)}, BRAM ${usage(u.bram)}, DSP ${usage(u.dsp)}, IO ${usage(u.io)}`);
        if (u.primitives) out.line(`  primitives: ${Object.entries(u.primitives).sort().map(([k, v]) => `${v} ${k}`).join(', ')}`);
    }
    if (r.timing) {
        for (const c of r.timing.clocks) {
            out.line(`  clock ${c.clock}: target ${c.targetMHz ?? '?'} MHz, achieved ${c.achievedMHz ?? '?'} MHz — ${c.passed === undefined ? 'n/a' : c.passed ? 'PASS' : 'FAIL'}`);
        }
        if (r.timing.criticalPathNs !== undefined) out.line(`  critical path: ${r.timing.criticalPathNs} ns`);
        if (r.timing.worstSlackNs !== undefined) out.line(`  worst slack: ${r.timing.worstSlackNs} ns`);
    }
    if (r.bitstream) out.line(`  bitstream: ${r.bitstream.path} (${r.bitstream.sizeBytes} bytes)`);
    printDiagnostics(out, r.diagnostics);
    for (const l of r.logs) out.line(`  log: ${l.path}`);
}

export async function build(ctx: CliContext, out: Output, project: Project, withSimulation: boolean, json: boolean): Promise<ExitCode> {
    const result = await (await controllerFor(ctx, project)).build(project, { simulate: withSimulation });
    if (json) out.line(JSON.stringify(result, null, 2));
    else printBuild(out, result);
    if (result.success) return EXIT.ok;
    return result.steps.some((s) => s.status === 'not-configured') ? EXIT.notConfigured : EXIT.failed;
}
