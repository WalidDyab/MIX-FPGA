import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type ToolInvocation, type ToolRunResult, type ToolRunner, succeeded } from '../../process/tool-runner';
import type { BuildArtifact } from '../../results/artifact';
import { type Diagnostic, errorDiag, hasErrors, type LogRef } from '../../results/diagnostic';
import type { OperationResult } from '../../results/operation';
import type { SimulationOptions, SimulationResult, SynthesisResult, VhdlCheckResult, VhdlContext, VhdlProvider } from '../types';
import { listVerilogModules, parseGhdlOutput } from './ghdl-output';

/** VHDL-2008 flag; the only standard supported for now. */
const STD = '--std=08';
const SIM_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Name of the synthesized netlist inside the workspace synth directory. */
export const GENERATED_VERILOG = 'generated.v';

interface StepOutcome {
    readonly ok: boolean;
    readonly diagnostics: Diagnostic[];
    readonly run: ToolRunResult;
}

/** Diagnostics name source files project-relative (forward slashes), whatever form GHDL printed. */
function projectRelative(d: Diagnostic, projectRoot: string, cwd: string): Diagnostic {
    if (!d.location) return d;
    const abs = isAbsolute(d.location.file) ? d.location.file : resolve(cwd, d.location.file);
    const rel = relative(projectRoot, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return d;
    return { ...d, location: { ...d.location, file: rel.split(sep).join('/') } };
}

/**
 * VhdlProvider backed by GHDL. Platform-neutral: it needs only the path of a
 * GHDL executable.
 *
 * Every GHDL run uses a build-workspace directory as its working directory
 * (check/, sim/ or synth/) and receives absolute source paths. Nothing GHDL
 * writes — work libraries and, with the LLVM/GCC backends, elaborated
 * executables and `e~*.o` objects — can land in the student's tree (ADR-001).
 * Diagnostics are mapped back to project-relative paths.
 */
export class GhdlVhdlProvider implements VhdlProvider {
    readonly id = 'ghdl';

    constructor(
        private readonly ghdl: string,
        private readonly runner: ToolRunner,
    ) {}

    private async exec(ctx: VhdlContext, cwd: string, args: string[], logs: LogRef[], label: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<StepOutcome> {
        const invocation: ToolInvocation = { executable: this.ghdl, args, cwd, timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) };
        const run = await this.runner.run(invocation);
        const logPath = join(ctx.workspace.paths.logs, `${label}.log`);
        await writeFile(logPath, `$ ghdl ${args.join(' ')}\n[exit ${run.exitCode ?? run.outcome}]\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}\n`, 'utf8');
        logs.push({ label, path: logPath });

        const diagnostics = parseGhdlOutput(`${run.stdout}\n${run.stderr}`).diagnostics.map((d) => projectRelative(d, ctx.project.root, cwd));
        if (run.outcome === 'spawn-failed') {
            diagnostics.push(errorDiag('vhdl', 'GHDL_NOT_STARTED', `Could not start GHDL (${this.ghdl}): ${run.errorMessage ?? 'unknown error'}`));
        } else if (run.outcome !== 'exited') {
            diagnostics.push(errorDiag('vhdl', `GHDL_${run.outcome.toUpperCase().replace('-', '_')}`, `GHDL ${label} ${run.outcome}.`));
        } else if (!succeeded(run) && !hasErrors(diagnostics)) {
            diagnostics.push(errorDiag('vhdl', 'GHDL_FAILED', `GHDL ${label} exited with code ${run.exitCode}.`));
        }
        return { ok: succeeded(run), diagnostics, run };
    }

    /** Fresh library each time, so removed/renamed units never linger. */
    private async analyze(ctx: VhdlContext, workdir: string, files: readonly string[], logs: LogRef[], label: string): Promise<StepOutcome> {
        await rm(workdir, { recursive: true, force: true });
        await mkdir(workdir, { recursive: true });
        return this.exec(ctx, workdir, ['-a', STD, `--workdir=${workdir}`, ...files], logs, label);
    }

    private absolute(ctx: VhdlContext, files: readonly string[]): string[] {
        return files.map((f) => resolve(ctx.project.root, f));
    }

    private rtl(ctx: VhdlContext): readonly string[] {
        return this.absolute(ctx, ctx.project.config.sources);
    }

    private all(ctx: VhdlContext): readonly string[] {
        return this.absolute(ctx, [...ctx.project.config.sources, ...(ctx.project.config.simulation?.sources ?? [])]);
    }

    async check(ctx: VhdlContext): Promise<VhdlCheckResult> {
        const started = Date.now();
        const logs: LogRef[] = [];
        const diagnostics: Diagnostic[] = [];
        const workdir = ctx.workspace.paths.check;
        const done = (ok: boolean, elaborated: string[]): VhdlCheckResult => ({
            status: ok ? 'succeeded' : 'failed', diagnostics, logs, durationMs: Date.now() - started, elaborated,
        });

        const a = await this.analyze(ctx, workdir, this.all(ctx), logs, 'ghdl-check-analyze');
        diagnostics.push(...a.diagnostics);
        if (!a.ok) return done(false, []);

        const units = [ctx.project.config.top, ...(ctx.project.config.simulation?.testbench ? [ctx.project.config.simulation.testbench] : [])];
        const elaborated: string[] = [];
        for (const unit of units) {
            const e = await this.exec(ctx, workdir, ['-e', STD, `--workdir=${workdir}`, unit], logs, `ghdl-elaborate-${unit}`);
            diagnostics.push(...e.diagnostics);
            if (!e.ok) return done(false, elaborated);
            elaborated.push(unit);
        }
        return done(true, elaborated);
    }

    async simulate(ctx: VhdlContext, options: SimulationOptions): Promise<SimulationResult> {
        const started = Date.now();
        const logs: LogRef[] = [];
        const diagnostics: Diagnostic[] = [];
        const workdir = ctx.workspace.paths.sim;
        const base = { testbench: options.testbench, logs };

        const a = await this.analyze(ctx, workdir, this.all(ctx), logs, 'ghdl-sim-analyze');
        diagnostics.push(...a.diagnostics);
        if (!a.ok) return { ...base, status: 'failed', passed: false, messages: [], diagnostics, durationMs: Date.now() - started };

        // Elaborate here too: with the LLVM/GCC backends `-r` runs the executable that `-e` writes into this directory.
        const e = await this.exec(ctx, workdir, ['-e', STD, `--workdir=${workdir}`, options.testbench], logs, `ghdl-elaborate-${options.testbench}`);
        diagnostics.push(...e.diagnostics);
        if (!e.ok) return { ...base, status: 'failed', passed: false, messages: [], diagnostics, durationMs: Date.now() - started };

        const wave = join(workdir, `${options.testbench}.ghw`);
        const args = ['-r', STD, `--workdir=${workdir}`, options.testbench, '--assert-level=error'];
        if (options.waveform) args.push(`--wave=${wave}`);
        const r = await this.exec(ctx, workdir, args, logs, `ghdl-run-${options.testbench}`, SIM_TIMEOUT_MS);
        diagnostics.push(...r.diagnostics);

        const parsed = parseGhdlOutput(`${r.run.stdout}\n${r.run.stderr}`);
        const passed = r.ok && !hasErrors(r.diagnostics);
        let waveform: BuildArtifact | undefined;
        if (options.waveform) {
            try {
                const s = await stat(wave);
                waveform = { kind: 'waveform', path: wave, canonical: false, sizeBytes: s.size };
            } catch {
                /* no waveform written (e.g. run failed before start) */
            }
        }
        return {
            ...base,
            status: r.run.outcome === 'exited' ? 'succeeded' : 'failed',
            passed,
            messages: parsed.runtime.map((m) => `@${m.time} ${m.kind} ${m.level}: ${m.text}`),
            diagnostics,
            durationMs: Date.now() - started,
            ...(parsed.stoppedAt !== undefined ? { stoppedAt: parsed.stoppedAt } : {}),
            ...(waveform ? { waveform } : {}),
        };
    }

    async synthesize(ctx: VhdlContext): Promise<SynthesisResult> {
        const started = Date.now();
        const logs: LogRef[] = [];
        const top = ctx.project.config.top;
        const workdir = ctx.workspace.paths.synth;
        const out = join(workdir, GENERATED_VERILOG);
        const fail = (diagnostics: Diagnostic[]): SynthesisResult & OperationResult => ({
            status: 'failed', top, modules: [], diagnostics, logs, durationMs: Date.now() - started,
        });

        await rm(workdir, { recursive: true, force: true });
        await mkdir(workdir, { recursive: true });
        const s = await this.exec(ctx, workdir, ['--synth', STD, `--workdir=${workdir}`, '--out=verilog', ...this.rtl(ctx), '-e', top], logs, 'ghdl-synth');
        if (!s.ok) return fail(s.diagnostics);

        const verilog = s.run.stdout;
        const modules = listVerilogModules(verilog);
        if (!modules.includes(top.toLowerCase())) {
            return fail([...s.diagnostics, errorDiag('vhdl', 'GHDL_SYNTH_NO_TOP', `GHDL output has no module "${top.toLowerCase()}".`)]);
        }
        await writeFile(out, verilog, 'utf8');
        return {
            status: 'succeeded',
            top,
            modules,
            generatedVerilog: { kind: 'generated-verilog', path: out, canonical: false, sizeBytes: Buffer.byteLength(verilog) },
            diagnostics: s.diagnostics,
            logs,
            durationMs: Date.now() - started,
        };
    }
}
