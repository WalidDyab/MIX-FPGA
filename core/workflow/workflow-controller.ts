import type { BoardRegistry } from '../board/board-registry';
import { generateXdc } from '../board/constraints';
import type { BoardDefinition } from '../board/types';
import type { ImplementationProvider, ImplementationResult } from '../implementation/types';
import { validateProject } from '../project/validation';
import type { Project } from '../project/types';
import { type Diagnostic, errorDiag, type LogRef, type OperationStatus } from '../results/diagnostic';
import { notConfigured } from '../results/operation';
import type { SimulationResult, SynthesisResult, VhdlCheckResult, VhdlContext, VhdlProvider } from '../vhdl/types';
import type { BuildWorkspace, WorkspaceManager } from '../workspace/build-workspace';
import type { BoardInfo, BuildOptions, BuildResult, StepResult, WorkflowStep } from './types';

export interface WorkflowDependencies {
    readonly boards: BoardRegistry;
    readonly workspaces: WorkspaceManager;
    /** Absent when no VHDL front end is configured on this host. */
    readonly vhdl?: VhdlProvider;
    /** Absent when no implementation backend is configured on this host. */
    readonly implementation?: ImplementationProvider;
}

export function boardInfo(board: BoardDefinition): BoardInfo {
    return { id: board.id, name: board.name, device: board.fpga.device, part: board.fpga.part };
}

/** Prepared, validated inputs shared by every workflow operation. */
interface Prepared {
    readonly board: BoardDefinition;
    readonly workspace: BuildWorkspace;
}

/** Accumulates step results for one run. */
class Run {
    readonly steps: StepResult[] = [];
    readonly diagnostics: Diagnostic[] = [];
    readonly logs: LogRef[] = [];
    private readonly started = Date.now();

    record(step: WorkflowStep, status: OperationStatus, diagnostics: readonly Diagnostic[], durationMs = 0, logs: readonly LogRef[] = []): boolean {
        this.steps.push({ step, status, durationMs, diagnostics });
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
        const validation = await validateProject(project, this.deps.boards);
        if (!run.record('validate', validation.valid ? 'succeeded' : 'failed', validation.diagnostics)) return undefined;

        const board = this.deps.boards.get(project.config.board)!;
        const opened = await this.deps.workspaces.open(project);
        if (!run.record('workspace', opened.workspace ? 'succeeded' : 'failed', opened.diagnostics)) return undefined;
        return { board, workspace: opened.workspace! };
    }

    private context(project: Project, workspace: BuildWorkspace, signal?: AbortSignal): VhdlContext {
        return signal ? { project, workspace, signal } : { project, workspace };
    }

    async check(project: Project, signal?: AbortSignal): Promise<VhdlCheckResult> {
        const run = new Run();
        const prepared = await this.prepare(project, run);
        if (!prepared) return { status: 'failed', diagnostics: run.diagnostics, logs: [], durationMs: run.elapsed(), elaborated: [] };
        if (!this.deps.vhdl) return notConfigured<VhdlCheckResult>('VHDL', 'VHDL_PROVIDER_NOT_CONFIGURED', { elaborated: [] });
        return this.deps.vhdl.check(this.context(project, prepared.workspace, signal));
    }

    async simulate(project: Project, testbench?: string, signal?: AbortSignal): Promise<SimulationResult> {
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
        return this.deps.vhdl.simulate(this.context(project, prepared.workspace, signal), { testbench: tb, waveform: true });
    }

    async build(project: Project, options: BuildOptions = {}): Promise<BuildResult> {
        const run = new Run();
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

        const check = await vhdl.check(ctx);
        if (!run.record('check', check.status, check.diagnostics, check.durationMs, check.logs)) return finish(info);

        if (options.simulate) {
            const tb = options.testbench ?? project.config.simulation?.testbench;
            if (!tb) {
                run.record('simulate', 'failed', [errorDiag('workflow', 'SIM_NO_TESTBENCH', 'Simulation requested but no testbench is selected.')]);
                return finish(info);
            }
            const sim = await vhdl.simulate(ctx, { testbench: tb, waveform: true });
            const status: OperationStatus = sim.status === 'succeeded' && !sim.passed ? 'failed' : sim.status;
            if (!run.record('simulate', status, sim.diagnostics, sim.durationMs, sim.logs)) return finish(info);
        } else {
            run.record('simulate', 'skipped', []);
        }

        const synth: SynthesisResult = await vhdl.synthesize(ctx);
        if (!run.record('synthesize', synth.status, synth.diagnostics, synth.durationMs, synth.logs)) return finish(info);
        if (!synth.generatedVerilog) {
            run.record('synthesize', 'failed', [errorDiag('workflow', 'SYNTH_NO_OUTPUT', 'Synthesis reported success but produced no netlist.')]);
            return finish(info);
        }
        const verilog = { generatedVerilog: synth.generatedVerilog };

        const constraints = generateXdc(board, project.config.pins);
        if (!run.record('constraints', constraints.diagnostics.length ? 'failed' : 'succeeded', constraints.diagnostics)) {
            return finish({ ...info, ...verilog });
        }

        const impl = this.deps.implementation;
        if (!impl) {
            const nc = notConfigured<ImplementationResult>('Implementation', 'IMPLEMENTATION_PROVIDER_NOT_CONFIGURED', { stagedFiles: [] });
            run.record('implement', nc.status, nc.diagnostics);
            return finish({ ...info, ...verilog });
        }
        const result = await impl.implement({
            project,
            board,
            workspace,
            verilog: synth.generatedVerilog,
            xdc: constraints.xdc,
            ...(options.signal ? { signal: options.signal } : {}),
        });
        run.record('implement', result.status, result.diagnostics, result.durationMs, result.logs);

        return finish({
            ...info,
            ...verilog,
            ...(result.bitstream ? { bitstream: result.bitstream } : {}),
            ...(result.utilization ? { utilization: result.utilization } : {}),
            ...(result.timing ? { timing: result.timing } : {}),
        });
    }
}
