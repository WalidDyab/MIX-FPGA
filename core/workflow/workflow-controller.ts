import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BoardRegistry } from '../board/board-registry';
import { generateXdc } from '../board/constraints';
import { checkPortConstraints, normalizeXdcForImplementation, verilogTopPorts } from '../board/xdc';
import type { BoardDefinition } from '../board/types';
import type { ImplementationProvider, ImplementationResult } from '../implementation/types';
import { validateProject } from '../project/validation';
import { normalizeStopTime, type Project } from '../project/types';
import { type Diagnostic, errorDiag, hasErrors, type LogRef, type OperationStatus } from '../results/diagnostic';
import { notConfigured } from '../results/operation';
import type { RtlAnalysisResult, RtlProvider } from '../rtl/types';
import type { SimulationResult, SynthesisResult, VhdlCheckResult, VhdlContext, VhdlProvider } from '../vhdl/types';
import type { BuildWorkspace, WorkspaceManager } from '../workspace/build-workspace';
import { busyDiagnostic, withProjectLock } from './project-lock';
import type { BoardInfo, BuildOptions, BuildProgress, BuildResult, StepResult, WorkflowStep } from './types';

export interface WorkflowDependencies {
    readonly boards: BoardRegistry;
    readonly workspaces: WorkspaceManager;
    /** Absent when no VHDL front end is configured on this host. */
    readonly vhdl?: VhdlProvider;
    /** Absent when no implementation backend is configured on this host. */
    readonly implementation?: ImplementationProvider;
    /** Absent when no RTL analysis backend is configured on this host. */
    readonly rtl?: RtlProvider;
}

export function boardInfo(board: BoardDefinition): BoardInfo {
    return { id: board.id, name: board.name, device: board.fpga.device, part: board.fpga.part };
}

/** GHDL `--stop-time` from the project, when it sets one (absent: run until the testbench ends itself). */
function stopTimeOption(project: Project): { stopTime?: string } {
    const configured = project.config.simulation?.stopTime;
    const stopTime = typeof configured === 'string' ? normalizeStopTime(configured) : undefined;
    return stopTime ? { stopTime } : {};
}

/** Prepared, validated inputs shared by every workflow operation. */
interface Prepared {
    readonly board: BoardDefinition;
    readonly workspace: BuildWorkspace;
}

/** Accumulates step results for one run and reports progress. */
class Run {
    readonly steps: StepResult[] = [];
    readonly diagnostics: Diagnostic[] = [];
    readonly logs: LogRef[] = [];
    private readonly started = Date.now();

    constructor(private readonly onProgress?: (progress: BuildProgress) => void) {}

    emit(progress: BuildProgress): void {
        try {
            this.onProgress?.(progress);
        } catch {
            /* a progress observer must never break the run */
        }
    }

    start(step: WorkflowStep): void {
        this.emit({ kind: 'step-started', step });
    }

    record(step: WorkflowStep, status: OperationStatus, diagnostics: readonly Diagnostic[], durationMs = 0, logs: readonly LogRef[] = []): boolean {
        this.steps.push({ step, status, durationMs, diagnostics });
        this.emit({ kind: 'step-finished', step, status });
        this.diagnostics.push(...diagnostics);
        this.logs.push(...logs);
        return status === 'succeeded' || status === 'skipped';
    }

    elapsed(): number {
        return Date.now() - this.started;
    }
}

/**
 * Orchestrates check / simulate / build over injected providers.
 * Contains no tool- or platform-specific logic.
 */
export class WorkflowController {
    constructor(private readonly deps: WorkflowDependencies) {}

    /** validate + open workspace; records both steps. */
    private async prepare(project: Project, run: Run): Promise<Prepared | undefined> {
        run.start('validate');
        const validation = await validateProject(project, this.deps.boards);
        if (!run.record('validate', validation.valid ? 'succeeded' : 'failed', validation.diagnostics)) return undefined;

        const board = this.deps.boards.get(project.config.board)!;
        run.start('workspace');
        const opened = await this.deps.workspaces.open(project);
        if (!run.record('workspace', opened.workspace ? 'succeeded' : 'failed', opened.diagnostics)) return undefined;
        return { board, workspace: opened.workspace! };
    }

    private context(project: Project, workspace: BuildWorkspace, signal?: AbortSignal): VhdlContext {
        return signal ? { project, workspace, signal } : { project, workspace };
    }

    /**
     * Constraints for implementation: the project's own XDC file (normalized
     * for nextpnr-xilinx; the student's file is never modified), or XDC
     * generated from `pins`. Either way every top-level port of the netlist
     * must receive a PACKAGE_PIN.
     */
    private async constraints(
        project: Project,
        board: BoardDefinition,
        verilogPath: string,
        topModule: string,
    ): Promise<{ xdc: string; diagnostics: Diagnostic[]; source: NonNullable<BuildResult['constraintsSource']> }> {
        const file = project.config.constraints;
        let xdc: string;
        const diagnostics: Diagnostic[] = [];
        if (file !== undefined) {
            try {
                xdc = normalizeXdcForImplementation(await readFile(resolve(project.root, file), 'utf8'));
            } catch (err) {
                const reason = (err as Error).message;
                return { xdc: '', diagnostics: [errorDiag('board', 'XDC_UNREADABLE', `Cannot read constraints file "${file}": ${reason}`, { file })], source: { kind: 'file', file } };
            }
        } else {
            const generated = generateXdc(board, project.config.pins ?? {});
            xdc = generated.xdc;
            diagnostics.push(...generated.diagnostics);
        }
        const source = file !== undefined ? ({ kind: 'file', file } as const) : ({ kind: 'generated' } as const);
        if (hasErrors(diagnostics)) return { xdc, diagnostics, source };

        const ports = verilogTopPorts(await readFile(verilogPath, 'utf8').catch(() => ''), topModule);
        // An unreadable or port-less netlist header is not judged here; implementation reports real problems.
        if (ports && ports.length > 0) diagnostics.push(...checkPortConstraints(ports, xdc, file));
        return { xdc, diagnostics, source };
    }

    /**
     * RTL analysis for the RTL schematic: GHDL synthesis into `rtl/`, then the
     * RtlProvider's generic netlist. No implementation, placement, routing or
     * bitstream. Everything is written inside the build workspace.
     */
    rtl(project: Project, signal?: AbortSignal): Promise<RtlAnalysisResult> {
        return withProjectLock(project.root, 'rtl', () => this.runRtl(project, signal), (running) => ({
            status: 'failed', diagnostics: [busyDiagnostic(running)], logs: [], durationMs: 0, top: project.config.top,
        }));
    }

    private async runRtl(project: Project, signal?: AbortSignal): Promise<RtlAnalysisResult> {
        const run = new Run();
        const top = project.config.top;
        const done = (extra: Partial<RtlAnalysisResult> = {}): RtlAnalysisResult => ({
            status: run.steps.length > 0 && run.steps.every((st) => st.status === 'succeeded') ? 'succeeded' : (run.steps[run.steps.length - 1]?.status ?? 'failed'),
            diagnostics: run.diagnostics, logs: run.logs, durationMs: run.elapsed(), top, ...extra,
        });
        const prepared = await this.prepare(project, run);
        if (!prepared) return done();
        if (!this.deps.vhdl) return notConfigured<RtlAnalysisResult>('VHDL', 'VHDL_PROVIDER_NOT_CONFIGURED', { top });
        if (!this.deps.rtl) return notConfigured<RtlAnalysisResult>('RTL analysis', 'RTL_PROVIDER_NOT_CONFIGURED', { top });
        const ctx = this.context(project, prepared.workspace, signal);
        const synth = await this.deps.vhdl.synthesize(ctx, { outputDir: prepared.workspace.paths.rtl });
        if (!run.record('synthesize', synth.status, synth.diagnostics, synth.durationMs, synth.logs) || !synth.generatedVerilog) return done();
        const verilog = synth.generatedVerilog;
        // Yosys is case-sensitive: use the module exactly as GHDL spelled it in the netlist.
        const r = await this.deps.rtl.elaborate({ project, workspace: prepared.workspace, verilog, top: synth.topModule ?? top.toLowerCase(), ...(signal ? { signal } : {}) });
        run.record('rtl', r.status, r.diagnostics, r.durationMs, r.logs);
        return done({ verilog, ...(r.netlist ? { netlist: r.netlist } : {}) });
    }

    /**
     * Check without taking the project's single-flight claim, for a caller that already holds it
     * (a board's Build runs Check as its first step inside its own claim).
     */
    checkUnlocked(project: Project, signal?: AbortSignal): Promise<VhdlCheckResult> {
        return this.runCheck(project, signal);
    }

    check(project: Project, signal?: AbortSignal): Promise<VhdlCheckResult> {
        return withProjectLock(project.root, 'check', () => this.runCheck(project, signal), (running) => ({
            status: 'failed', diagnostics: [busyDiagnostic(running)], logs: [], durationMs: 0, elaborated: [],
        }));
    }

    private async runCheck(project: Project, signal?: AbortSignal): Promise<VhdlCheckResult> {
        const run = new Run();
        const prepared = await this.prepare(project, run);
        if (!prepared) return { status: 'failed', diagnostics: run.diagnostics, logs: [], durationMs: run.elapsed(), elaborated: [] };
        if (!this.deps.vhdl) return notConfigured<VhdlCheckResult>('VHDL', 'VHDL_PROVIDER_NOT_CONFIGURED', { elaborated: [] });
        return this.deps.vhdl.check(this.context(project, prepared.workspace, signal));
    }

    simulate(project: Project, testbench?: string, signal?: AbortSignal): Promise<SimulationResult> {
        return withProjectLock(project.root, 'simulate', () => this.runSimulate(project, testbench, signal), (running) => ({
            status: 'failed', diagnostics: [busyDiagnostic(running)], logs: [], durationMs: 0,
            testbench: testbench ?? project.config.simulation?.testbench ?? '', passed: false, messages: [],
        }));
    }

    private async runSimulate(project: Project, testbench?: string, signal?: AbortSignal): Promise<SimulationResult> {
        const run = new Run();
        const tb = testbench ?? project.config.simulation?.testbench;
        const base = { testbench: tb ?? '', passed: false, messages: [] as string[] };
        const prepared = await this.prepare(project, run);
        if (!prepared) return { status: 'failed', diagnostics: run.diagnostics, logs: [], durationMs: run.elapsed(), ...base };
        if (!tb) {
            return {
                status: 'failed',
                diagnostics: [errorDiag('workflow', 'SIM_NO_TESTBENCH', 'No testbench selected (set simulation.testbench or pass one).')],
                logs: [],
                durationMs: run.elapsed(),
                ...base,
            };
        }
        if (!this.deps.vhdl) return notConfigured<SimulationResult>('VHDL', 'VHDL_PROVIDER_NOT_CONFIGURED', base);
        return this.deps.vhdl.simulate(this.context(project, prepared.workspace, signal), { testbench: tb, waveform: true, vcd: true, ...stopTimeOption(project) });
    }

    build(project: Project, options: BuildOptions = {}): Promise<BuildResult> {
        return withProjectLock(project.root, 'build', () => this.runBuild(project, options), (running) => ({
            success: false, steps: [], diagnostics: [busyDiagnostic(running)], logs: [], durationMs: 0,
        }));
    }

    private async runBuild(project: Project, options: BuildOptions): Promise<BuildResult> {
        const run = new Run(options.onProgress);
        const finish = (extra: Partial<BuildResult> = {}): BuildResult => ({
            success:
                run.steps.length > 0 &&
                run.steps.every((s) => s.status === 'succeeded' || s.status === 'skipped') &&
                extra.timing?.passed !== false,
            steps: run.steps,
            diagnostics: run.diagnostics,
            logs: run.logs,
            durationMs: run.elapsed(),
            ...extra,
        });

        const prepared = await this.prepare(project, run);
        if (!prepared) return finish();
        const { board, workspace } = prepared;
        const info = { board: boardInfo(board) };
        const ctx = this.context(project, workspace, options.signal);

        const vhdl = this.deps.vhdl;
        if (!vhdl) {
            const nc = notConfigured<VhdlCheckResult>('VHDL', 'VHDL_PROVIDER_NOT_CONFIGURED', { elaborated: [] });
            run.record('check', nc.status, nc.diagnostics);
            return finish(info);
        }

        run.start('check');
        const check = await vhdl.check(ctx);
        if (!run.record('check', check.status, check.diagnostics, check.durationMs, check.logs)) return finish(info);

        if (options.simulate) {
            const tb = options.testbench ?? project.config.simulation?.testbench;
            if (!tb) {
                run.record('simulate', 'failed', [errorDiag('workflow', 'SIM_NO_TESTBENCH', 'Simulation requested but no testbench is selected.')]);
                return finish(info);
            }
            run.start('simulate');
            const sim = await vhdl.simulate(ctx, { testbench: tb, waveform: true, ...stopTimeOption(project) });
            const status: OperationStatus = sim.status === 'succeeded' && !sim.passed ? 'failed' : sim.status;
            if (!run.record('simulate', status, sim.diagnostics, sim.durationMs, sim.logs)) return finish(info);
        } else {
            run.record('simulate', 'skipped', []);
        }

        run.start('synthesize');
        const synth: SynthesisResult = await vhdl.synthesize(ctx);
        if (!run.record('synthesize', synth.status, synth.diagnostics, synth.durationMs, synth.logs)) return finish(info);
        if (!synth.generatedVerilog) {
            run.record('synthesize', 'failed', [errorDiag('workflow', 'SYNTH_NO_OUTPUT', 'Synthesis reported success but produced no netlist.')]);
            return finish(info);
        }
        const verilog = { generatedVerilog: synth.generatedVerilog };

        run.start('constraints');
        const topModule = synth.topModule ?? project.config.top;
        const constraints = await this.constraints(project, board, synth.generatedVerilog.path, topModule);
        const withConstraints = { ...info, ...verilog, constraintsSource: constraints.source };
        if (!run.record('constraints', hasErrors(constraints.diagnostics) ? 'failed' : 'succeeded', constraints.diagnostics)) {
            return finish(withConstraints);
        }

        const impl = this.deps.implementation;
        if (!impl) {
            const nc = notConfigured<ImplementationResult>('Implementation', 'IMPLEMENTATION_PROVIDER_NOT_CONFIGURED', { stagedFiles: [] });
            run.record('implement', nc.status, nc.diagnostics);
            return finish(withConstraints);
        }
        run.start('implement');
        const result = await impl.implement({
            project,
            board,
            workspace,
            verilog: synth.generatedVerilog,
            xdc: constraints.xdc,
            ...(synth.topModule ? { topModule: synth.topModule } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            onStage: (stage) => run.emit({ kind: 'implementation-stage', stage }),
        });
        run.record('implement', result.status, result.diagnostics, result.durationMs, result.logs);

        return finish({
            ...withConstraints,
            ...(result.reachedStage ? { implementationStage: result.reachedStage } : {}),
            ...(result.bitstream ? { bitstream: result.bitstream } : {}),
            ...(result.utilization ? { utilization: result.utilization } : {}),
            ...(result.timing ? { timing: result.timing } : {}),
        });
    }
}
