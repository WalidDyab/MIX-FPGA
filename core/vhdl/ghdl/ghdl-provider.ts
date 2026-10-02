import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type ToolInvocation, type ToolRunResult, type ToolRunner, succeeded } from '../../process/tool-runner';
import type { BuildArtifact } from '../../results/artifact';
import { type Diagnostic, errorDiag, hasErrors, type LogRef } from '../../results/diagnostic';
import type { OperationResult } from '../../results/operation';
import { sha256File } from '../../util/hash';
import type { SimulationOptions, SimulationResult, SynthesisOptions, SynthesisResult, VhdlCheckResult, VhdlContext, VhdlProvider } from '../types';
import { listVerilogModules, parseGhdlOutput } from './ghdl-output';

/** VHDL-2008 flag; the only standard supported for now. */
const STD = '--std=08';
const SIM_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Name of the synthesized netlist inside the workspace synth directory. */
export const GENERATED_VERILOG = 'generated.v';

/** Name of the VCD waveform inside the workspace sim directory. */
export const VCD_FILE = 'waveform.vcd';

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
 * (check/, sim/ or synth/) and receives every path relative to it
 * (`--workdir=.`, `../../src/top.vhd`). GHDL records source paths in its
 * library index (work-obj08.cf) and cannot read that file back when a path
 * contains some non-ASCII characters (e.g. CJK), so the student's project
 * location (e.g. under a Windows profile named "José García 学生") must never
 * reach GHDL. Nothing GHDL
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
        const unsupported = files.filter((f) => !/^[ -~]*$/.test(f));
        if (unsupported.length) {
            // GHDL would fail later with "invalid character" in its own library file; say what to fix instead.
            const diagnostics = unsupported.map((f) => {
                const rel = relative(ctx.project.root, resolve(workdir, f)).split(sep).join('/');
                return { ...errorDiag('vhdl', 'GHDL_FILE_NAME_UNSUPPORTED', `GHDL cannot use the file name "${rel}": rename it using only English letters, digits, "_" and "-".`), location: { file: rel } };
            });
            return { ok: false, diagnostics, run: { invocation: { executable: this.ghdl, args: [] }, outcome: 'exited', exitCode: 1, stdout: '', stderr: '', durationMs: 0 } };
        }
        return this.exec(ctx, workdir, ['-a', STD, '--workdir=.', ...files], logs, label);
    }

    /** Source paths relative to the GHDL working directory (see the class comment). */
    private relativeTo(ctx: VhdlContext, workdir: string, files: readonly string[]): string[] {
        return files.map((f) => relative(workdir, resolve(ctx.project.root, f)));
    }

    private rtl(ctx: VhdlContext, workdir: string): readonly string[] {
        return this.relativeTo(ctx, workdir, ctx.project.config.sources);
    }

    private all(ctx: VhdlContext, workdir: string): readonly string[] {
        return this.relativeTo(ctx, workdir, [...ctx.project.config.sources, ...(ctx.project.config.simulation?.sources ?? [])]);
    }

    async check(ctx: VhdlContext): Promise<VhdlCheckResult> {
        const started = Date.now();
        const logs: LogRef[] = [];
        const diagnostics: Diagnostic[] = [];
        const workdir = ctx.workspace.paths.check;
        const done = (ok: boolean, elaborated: string[]): VhdlCheckResult => ({
            status: ok ? 'succeeded' : 'failed', diagnostics, logs, durationMs: Date.now() - started, elaborated,
        });

        const a = await this.analyze(ctx, workdir, this.all(ctx, workdir), logs, 'ghdl-check-analyze');
        diagnostics.push(...a.diagnostics);
        if (!a.ok) return done(false, []);

        const units = [ctx.project.config.top, ...(ctx.project.config.simulation?.testbench ? [ctx.project.config.simulation.testbench] : [])];
        const elaborated: string[] = [];
        for (const unit of units) {
            const e = await this.exec(ctx, workdir, ['-e', STD, '--workdir=.', unit], logs, `ghdl-elaborate-${unit}`);
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

        const a = await this.analyze(ctx, workdir, this.all(ctx, workdir), logs, 'ghdl-sim-analyze');
        diagnostics.push(...a.diagnostics);
        if (!a.ok) return { ...base, status: 'failed', passed: false, messages: [], diagnostics, durationMs: Date.now() - started };

        // Elaborate here too: with the LLVM/GCC backends `-r` runs the executable that `-e` writes into this directory.
        const e = await this.exec(ctx, workdir, ['-e', STD, '--workdir=.', options.testbench], logs, `ghdl-elaborate-${options.testbench}`);
        diagnostics.push(...e.diagnostics);
        if (!e.ok) return { ...base, status: 'failed', passed: false, messages: [], diagnostics, durationMs: Date.now() - started };

        const wave = join(workdir, `${options.testbench}.ghw`);
        const args = ['-r', STD, '--workdir=.', options.testbench, '--assert-level=error'];
        if (options.waveform) args.push(`--wave=${options.testbench}.ghw`);
        const vcdPath = join(workdir, VCD_FILE);
        if (options.vcd) args.push(`--vcd=${VCD_FILE}`);
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
        let vcd: BuildArtifact | undefined;
        if (options.vcd) {
            try {
                const s = await stat(vcdPath);
                vcd = { kind: 'waveform', path: vcdPath, canonical: false, sizeBytes: s.size, sha256: await sha256File(vcdPath) };
            } catch {
                /* no VCD written */
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
            ...(vcd ? { vcd } : {}),
        };
    }

    async synthesize(ctx: VhdlContext, options: SynthesisOptions = {}): Promise<SynthesisResult> {
        const started = Date.now();
        const logs: LogRef[] = [];
        const top = ctx.project.config.top;
        const workdir = options.outputDir ?? ctx.workspace.paths.synth;
        const out = join(workdir, GENERATED_VERILOG);
        const fail = (diagnostics: Diagnostic[]): SynthesisResult & OperationResult => ({
            status: 'failed', top, modules: [], diagnostics, logs, durationMs: Date.now() - started,
        });

        await rm(workdir, { recursive: true, force: true });
        await mkdir(workdir, { recursive: true });
        const s = await this.exec(ctx, workdir, ['--synth', STD, '--workdir=.', '--out=verilog', ...this.rtl(ctx, workdir), '-e', top], logs, options.outputDir ? 'ghdl-rtl-synth' : 'ghdl-synth');
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
