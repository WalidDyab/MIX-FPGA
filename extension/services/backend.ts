import {
    type BoardDetectionResult,
    BoardRegistry,
    type BuildProgress,
    type BuildResult,
    type Diagnostic,
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
    busyDiagnostic,
    withProjectLock,
} from '../../core';
import { stat } from 'node:fs/promises';
import { loadCanonicalBitstream, workspacePaths } from '../../runtime/bitstream';
import { expectedArchiveName, installClassroomToolchain, verifyClassroomToolchain } from '../../runtime/classroom';
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
    /** Classroom mode: installs a NexysVHDL toolchain archive into the per-user store. */
    installToolchain(archive: string, onProgress: (fraction: number | undefined, message: string) => void, signal?: AbortSignal): Promise<ToolchainInstallOutcome>;
    /** Classroom mode: re-hashes the installed toolchain. */
    verifyToolchain(onFile?: (path: string) => void): Promise<{ readonly ok: boolean; readonly files?: number; readonly diagnostics: readonly Diagnostic[] }>;
    /** File name of the toolchain archive this release needs, for the install dialog. */
    toolchainArchiveName(): Promise<string | undefined>;
}

export interface ToolchainInstallOutcome {
    readonly status: 'installed' | 'already-installed' | 'failed';
    readonly version?: string;
    readonly location?: string;
    readonly diagnostics: readonly Diagnostic[];
}

/** NexysBackend over the shared Phase 3 core. */
export class CoreBackend implements NexysBackend {
    private context: Promise<RuntimeContext> | undefined;

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

    /** Programming shares the project's single-flight guard with Check/Simulate/Build/RTL (a Build rewrites the bitstream). */
    program(project: Project, serialNumber: string | undefined, signal?: AbortSignal): Promise<ProgrammingResult> {
        return withProjectLock(project.root, 'program', () => this.runProgram(project, serialNumber, signal), (running) => ({
            status: 'failed', destination: 'volatile', diagnostics: [busyDiagnostic(running)], logs: [], durationMs: 0,
        }));
    }

    private async runProgram(project: Project, serialNumber: string | undefined, signal?: AbortSignal): Promise<ProgrammingResult> {
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

    async installToolchain(archive: string, onProgress: (fraction: number | undefined, message: string) => void, signal?: AbortSignal): Promise<ToolchainInstallOutcome> {
        const ctx = await this.ctx();
        const size = await stat(archive).then((s) => s.size, () => undefined);
        const r = await installClassroomToolchain(ctx, archive, onProgress, signal, size);
        // The composition root resolves the toolchain once; rebuild it so the new install is used.
        if (r.status !== 'failed') this.context = undefined;
        return r.status === 'failed'
            ? { status: 'failed', diagnostics: r.diagnostics }
            : { status: r.status, version: r.marker.bundleVersion, location: r.paths.versionDir, diagnostics: [] };
    }

    async verifyToolchain(onFile?: (path: string) => void): Promise<{ ok: boolean; files?: number; diagnostics: readonly Diagnostic[] }> {
        const r = await verifyClassroomToolchain(await this.ctx(), onFile);
        return { ok: r.ok, ...(r.files !== undefined ? { files: r.files } : {}), diagnostics: r.diagnostics };
    }

    async toolchainArchiveName(): Promise<string | undefined> {
        return expectedArchiveName(await this.ctx());
    }
}
