import {
    type BoardDetectionResult,
    BoardRegistry,
    type BuildProgress,
    type BuildResult,
    errorDiag,
    loadProject,
    type Project,
    type ProjectLoadResult,
    type ProgrammingResult,
    type ProjectValidation,
    type RtlAnalysisResult,
    type SimulationResult,
    validateProject,
    type VhdlCheckResult,
} from '../../core';
import { loadCanonicalBitstream, workspacePaths } from '../../runtime/bitstream';
import { type ContextOverrides, controllerFor, createContext, programmingFor, type RuntimeContext } from '../../runtime/context';
import { type EnvironmentReport, inspectEnvironment } from '../../runtime/environment';

export interface BitstreamInfo {
    readonly path: string;
    readonly sizeBytes?: number;
    readonly modifiedMs: number;
}

/**
 * Everything the extension asks of the Phase 3 core. The extension never
 * runs tools or picks platform code itself; CoreBackend delegates to the
 * shared composition root (runtime/), which selects the platform adapter.
 */
export interface NexysBackend {
    boards(): Promise<BoardRegistry>;
    loadProject(root: string): Promise<ProjectLoadResult>;
    validate(project: Project): Promise<ProjectValidation>;
    check(project: Project, signal?: AbortSignal): Promise<VhdlCheckResult>;
    simulate(project: Project, testbench: string | undefined, signal?: AbortSignal): Promise<SimulationResult>;
    build(project: Project, onProgress: (p: BuildProgress) => void, signal?: AbortSignal): Promise<BuildResult>;
    /** RTL analysis for the RTL schematic (no place/route). */
    rtl(project: Project, signal?: AbortSignal): Promise<RtlAnalysisResult>;
    detectBoards(project: Project): Promise<BoardDetectionResult & { readonly configured: boolean }>;
    bitstream(project: Project): Promise<BitstreamInfo | undefined>;
    program(project: Project, serialNumber: string | undefined, signal?: AbortSignal): Promise<ProgrammingResult>;
    environment(project?: Project): Promise<EnvironmentReport>;
}

/** NexysBackend over the shared Phase 3 core. */
export class CoreBackend implements NexysBackend {
    private context?: Promise<RuntimeContext>;

    /** `overrides` exist for tests (fake platform, refusing runner); production passes none. */
    constructor(private readonly overrides: ContextOverrides = {}) {}

    private ctx(): Promise<RuntimeContext> {
        this.context ??= createContext(this.overrides);
        return this.context;
    }

    async boards(): Promise<BoardRegistry> {
        return (await this.ctx()).boards;
    }

    loadProject(root: string): Promise<ProjectLoadResult> {
        return loadProject(root);
    }

    async validate(project: Project): Promise<ProjectValidation> {
        return validateProject(project, (await this.ctx()).boards);
    }

    async check(project: Project, signal?: AbortSignal): Promise<VhdlCheckResult> {
        return (await controllerFor(await this.ctx(), project)).check(project, signal);
    }

    async simulate(project: Project, testbench: string | undefined, signal?: AbortSignal): Promise<SimulationResult> {
        return (await controllerFor(await this.ctx(), project)).simulate(project, testbench, signal);
    }

    async build(project: Project, onProgress: (p: BuildProgress) => void, signal?: AbortSignal): Promise<BuildResult> {
        return (await controllerFor(await this.ctx(), project)).build(project, { onProgress, ...(signal ? { signal } : {}) });
    }

    async rtl(project: Project, signal?: AbortSignal): Promise<RtlAnalysisResult> {
        return (await controllerFor(await this.ctx(), project)).rtl(project, signal);
    }

    async detectBoards(project: Project): Promise<BoardDetectionResult & { readonly configured: boolean }> {
        const ctx = await this.ctx();
        const board = ctx.boards.get(project.config.board);
        if (!board) {
            return { configured: true, boards: [], diagnostics: [errorDiag('project', 'PROJECT_BOARD_UNSUPPORTED', `Board "${project.config.board}" is not supported.`)] };
        }
        return programmingFor(ctx).detectBoards(board);
    }

    async bitstream(project: Project): Promise<BitstreamInfo | undefined> {
        const b = await loadCanonicalBitstream(project);
        return b ? { path: b.path, modifiedMs: b.modifiedMs, ...(b.sizeBytes !== undefined ? { sizeBytes: b.sizeBytes } : {}) } : undefined;
    }

    async program(project: Project, serialNumber: string | undefined, signal?: AbortSignal): Promise<ProgrammingResult> {
        const ctx = await this.ctx();
        const failed = (code: string, message: string): ProgrammingResult => ({
            status: 'failed', destination: 'volatile', diagnostics: [errorDiag('programming', code, message)], logs: [], durationMs: 0,
        });
        const board = ctx.boards.get(project.config.board);
        if (!board) return failed('PROJECT_BOARD_UNSUPPORTED', `Board "${project.config.board}" is not supported.`);
        const loaded = await loadCanonicalBitstream(project);
        if (!loaded) return failed('PROGRAM_NO_BITSTREAM', 'There is no bitstream yet. Run Build first.');
        const { modifiedMs: _m, ...canonical } = loaded;
        return programmingFor(ctx).program(canonical, board, workspacePaths(project).program, {
            ...(serialNumber !== undefined ? { serialNumber } : {}),
            ...(signal ? { signal } : {}),
        });
    }

    async environment(project?: Project): Promise<EnvironmentReport> {
        return inspectEnvironment(await this.ctx(), project);
    }
}
