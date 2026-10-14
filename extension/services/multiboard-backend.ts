import {
    type BoardDetectionResult,
    type BoardRegistry,
    type BoardDefinition,
    type BuildProgress,
    type BuildResult,
    type DetectedBoard,
    type Diagnostic,
    errorDiag,
    busyDiagnostic,
    withProjectLock,
    type Project,
    type ProgrammingResult,
    type RtlAnalysisResult,
    type SimulationResult,
    type StepResult,
    type VhdlCheckResult,
} from '../../core';
import {
    type BoardFlows,
    type BoardProfile,
    type EngineStatus,
    type EnvironmentVerification,
    type HardwareDetection,
    type ImplementationProvider,
    type ProgramOutcome,
    type ProgrammingArtifactRef,
    failedWorkflowResult,
    progressFromProviderEvent,
    workflowResultFrom,
} from '../../core/backend';
import type { BitstreamInfo, NexysBackend, ToolchainInstallOutcome } from './backend';
import type { EnvironmentReport } from '../../runtime/environment';

const PROGRAM_NO_FILE = (profile: BoardProfile) =>
    profile.programmingFormat === 'bit' ? 'There is no bitstream yet. Run Build first.' : 'There is no programming file yet. Run Build first.';

/** Maps a provider's hardware detection to the board list the Hardware view shows. */
export function detectionToBoards(det: HardwareDetection, profile: BoardProfile): BoardDetectionResult & { readonly configured: boolean } {
    if (det.native) return det.native;
    const configured = det.status !== 'programmer-missing';
    if (det.status === 'detected') {
        const boards: DetectedBoard[] = det.probes.map((p, i) => ({
            selector: p.serial ?? `${profile.id}-${i}`,
            ...(p.serial ? { serialNumber: p.serial } : {}),
            productName: profile.displayName,
            boardId: profile.id,
            transport: 'usb-jtag',
        }));
        return { configured, boards, diagnostics: det.diagnostics };
    }
    // An absent board is the "No <board> detected" state, not an error; a wrong chip or a broken programmer is reported.
    const diagnostics = det.status === 'board-absent' ? det.diagnostics.filter((d) => d.code !== 'BOARD_ABSENT') : det.diagnostics;
    return { configured, boards: [], diagnostics };
}

function programmingResultFrom(o: ProgramOutcome, profile: BoardProfile): ProgrammingResult {
    if (o.native) return o.native;
    return {
        status: o.status === 'programmed' ? 'succeeded' : 'failed',
        destination: 'volatile',
        diagnostics: o.diagnostics,
        logs: o.logs,
        durationMs: o.durationMs,
        ...(o.status === 'programmed' ? { target: { selector: profile.id, productName: profile.displayName, boardId: profile.id } } : {}),
    };
}

/**
 * The one place that dispatches Check / Simulate / Build / Detect / Program to the open project's
 * board. Everything board-specific lives behind providers resolved from the project's board profile;
 * commands and views call this backend and never test which board is open.
 *
 * The original Nexys flow is the reference implementation: its providers are thin adapters over the
 * existing controller and programming service, and their native results are returned unchanged.
 */
/** The original backend plus the board providers built on top of its context (CoreBackend). */
export interface ReferenceBackend extends NexysBackend {
    flows(): Promise<BoardFlows>;
}

export class MixFpgaBackend implements NexysBackend {
    private cached: BoardFlows | undefined;

    constructor(readonly core: ReferenceBackend) {}

    private async flows(): Promise<BoardFlows> {
        this.cached = await this.core.flows();
        return this.cached;
    }

    // ------------------------------------------------------------------ project and boards

    async boards(): Promise<BoardRegistry> {
        await this.flows();
        return this.core.boards();
    }

    supportsBoard(board: BoardDefinition): boolean {
        const f = this.cached;
        const p = f?.profileOf(board.id);
        return f && p ? f.registry.supportsHost(p) : true;
    }

    loadProject(root: string) {
        return this.core.loadProject(root);
    }

    validate(project: Project) {
        return this.core.validate(project);
    }

    // ------------------------------------------------------------------ vendor-neutral steps (GHDL / Yosys)

    async check(project: Project, signal?: AbortSignal): Promise<VhdlCheckResult> {
        return (await (await this.flows()).controllerFor(project)).check(project, signal);
    }

    async simulate(project: Project, testbench: string | undefined, signal?: AbortSignal): Promise<SimulationResult> {
        return (await (await this.flows()).controllerFor(project)).simulate(project, testbench, signal);
    }

    async rtl(project: Project, signal?: AbortSignal): Promise<RtlAnalysisResult> {
        return (await (await this.flows()).controllerFor(project)).rtl(project, signal);
    }

    // ------------------------------------------------------------------ build

    async build(project: Project, onProgress: (p: BuildProgress) => void, signal?: AbortSignal, onStatus?: (message: string) => void): Promise<BuildResult> {
        const flows = await this.flows();
        const profile = flows.profileOf(project.config.board);
        // An unknown board is reported by the original flow's own validation.
        if (!profile) return this.core.build(project, onProgress, signal);
        const resolved = flows.registry.implementation(profile);
        if (!resolved.ok) return failedWorkflowResult(profile, [], [resolved.diagnostic]);
        const provider = resolved.provider;

        const request = (extra: object = {}) => ({
            projectDir: project.root,
            project,
            board: profile,
            top: project.config.top,
            sources: flows.sourcesOf(project),
            ...(signal ? { signal } : {}),
            ...extra,
        });

        if (provider.selfContained) {
            // The provider owns validation, Check and the project claim; its native progress and result stay exact.
            const n = await provider.build(request({ nativeProgress: onProgress }));
            return n.native ? { ...n.native, normalized: n } : workflowResultFrom(n, profile, [], [], n.durationMs);
        }
        return withProjectLock(project.root, 'build', () => this.buildWithCheck(flows, provider, profile, project, request, onProgress, onStatus), (running) => failedWorkflowResult(profile, [], [busyDiagnostic(running)]));
    }

    /** Check first (the board's VHDL tools), then the board's implementation provider; one claim for both. */
    private async buildWithCheck(
        flows: BoardFlows,
        provider: ImplementationProvider,
        profile: BoardProfile,
        project: Project,
        request: (extra?: object) => Parameters<ImplementationProvider['build']>[0],
        onProgress: (p: BuildProgress) => void,
        onStatus: ((message: string) => void) | undefined,
    ): Promise<BuildResult> {
        const started = Date.now();
        onProgress({ kind: 'step-started', step: 'check' });
        const req0 = request();
        const chk = await (await flows.controllerFor(project)).checkUnlocked(project, req0.signal);
        const checkStep: StepResult = { step: 'check', status: chk.status, durationMs: chk.durationMs, diagnostics: chk.diagnostics };
        onProgress({ kind: 'step-finished', step: 'check', status: chk.status });
        if (chk.status !== 'succeeded') return { ...failedWorkflowResult(profile, [checkStep], chk.diagnostics, Date.now() - started), logs: chk.logs };

        let lastStatus = '';
        const n = await provider.build({
            ...req0,
            onProgress: (e) => {
                const m = progressFromProviderEvent(e);
                // Two stages can share a student-facing line (assemble and package): say it once.
                if (m.status && m.status !== lastStatus) onStatus?.((lastStatus = m.status));
                if (m.progress) onProgress(m.progress);
            },
        });
        // Check diagnostics (warnings) are part of the build's diagnostics, once.
        return { ...workflowResultFrom(n, profile, [checkStep], chk.diagnostics, Date.now() - started), logs: [...chk.logs, ...n.logs] };
    }

    // ------------------------------------------------------------------ hardware

    async detectBoards(project: Project): Promise<BoardDetectionResult & { readonly configured: boolean }> {
        const flows = await this.flows();
        const profile = flows.profileOf(project.config.board);
        if (!profile) return this.core.detectBoards(project);
        const p = flows.registry.programming(profile);
        if (!p.ok) return { configured: false, boards: [], diagnostics: [p.diagnostic] };
        return detectionToBoards(await p.provider.detect(profile), profile);
    }

    async bitstream(project: Project): Promise<BitstreamInfo | undefined> {
        const flows = await this.flows();
        const profile = flows.profileOf(project.config.board);
        if (!profile || profile.programmingFormat === 'bit') return this.core.bitstream(project);
        const impl = flows.registry.implementation(profile);
        const prog = flows.registry.programming(profile);
        const a = impl.ok ? await impl.provider.artifactFor?.(project.root, project.config.top, prog.ok ? prog.provider.artifactFormat : undefined) : undefined;
        return a ? { path: a.path, sizeBytes: a.sizeBytes, modifiedMs: a.modifiedMs } : undefined;
    }

    program(project: Project, serialNumber: string | undefined, signal?: AbortSignal): Promise<ProgrammingResult> {
        return withProjectLock(project.root, 'program', () => this.runProgram(project, serialNumber, signal), (running) => ({
            status: 'failed', destination: 'volatile', diagnostics: [busyDiagnostic(running)], logs: [], durationMs: 0,
        }));
    }

    private async runProgram(project: Project, serialNumber: string | undefined, signal: AbortSignal | undefined): Promise<ProgrammingResult> {
        const flows = await this.flows();
        const failed = (code: string, message: string): ProgrammingResult => ({ status: 'failed', destination: 'volatile', diagnostics: [errorDiag('programming', code, message)], logs: [], durationMs: 0 });
        const profile = flows.profileOf(project.config.board);
        if (!profile) return failed('PROJECT_BOARD_UNSUPPORTED', `Board "${project.config.board}" is not supported.`);
        const prog = flows.registry.programming(profile);
        if (!prog.ok) return { status: 'failed', destination: 'volatile', diagnostics: [prog.diagnostic], logs: [], durationMs: 0 };

        const impl = flows.registry.implementation(profile);
        // The host's programmer says which of the build's programming files it loads (macOS: .svf, Windows: .sof).
        const info = impl.ok ? await impl.provider.artifactFor?.(project.root, project.config.top, prog.provider.artifactFormat) : undefined;
        if (!info) return failed('PROGRAM_NO_BITSTREAM', PROGRAM_NO_FILE(profile));
        if (info.boardId !== undefined && info.boardId !== profile.id) {
            return failed('PROGRAM_ARTIFACT_WRONG_BOARD', `The last build was made for a different board (${info.boardId}), not ${profile.displayName}. Run Build again.`);
        }
        if (info.inputs && impl.ok && impl.provider.currentInputs) {
            const now = await impl.provider.currentInputs(project.root, flows.sourcesOf(project), project.config.exclude);
            const changed = Object.keys({ ...info.inputs, ...now }).filter((k) => info.inputs![k] !== now[k]);
            if (changed.length > 0) return failed('PROGRAM_ARTIFACT_STALE', `The design or constraints changed since the last build (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', …' : ''}). Run Build again before programming.`);
        }
        const artifact: ProgrammingArtifactRef = { path: info.path, format: info.format, sizeBytes: info.sizeBytes, sha256: info.sha256 };
        const outcome = await prog.provider.program({
            artifact,
            board: profile,
            workDir: flows.programWorkDir(project, profile),
            ...(serialNumber !== undefined ? { serialNumber } : {}),
            ...(signal ? { signal } : {}),
        });
        return programmingResultFrom(outcome, profile);
    }

    // ------------------------------------------------------------------ environment and toolchain (unchanged)

    async environment(project?: Project): Promise<EnvironmentReport> {
        const base = await this.core.environment(project);
        if (!project) return base;
        const flows = await this.flows();
        const profile = flows.profileOf(project.config.board);
        const board = profile ? await flows.environmentFor?.(profile) : undefined;
        return board ? { ...base, board } : base;
    }

    async verifyEnvironment(project: Project, signal?: AbortSignal): Promise<EnvironmentVerification | undefined> {
        const flows = await this.flows();
        const profile = flows.profileOf(project.config.board);
        return profile ? flows.verifyEnvironment?.(profile, signal) : undefined;
    }

    async restartEngine(project: Project, signal?: AbortSignal): Promise<EngineStatus | undefined> {
        const flows = await this.flows();
        const profile = flows.profileOf(project.config.board);
        return profile ? flows.engineFor(profile)?.restart(signal) : undefined;
    }

    installToolchain(archive: string, onProgress: (fraction: number | undefined, message: string) => void, signal?: AbortSignal): Promise<ToolchainInstallOutcome> {
        return this.core.installToolchain(archive, onProgress, signal);
    }

    verifyToolchain(onFile?: (path: string) => void): Promise<{ readonly ok: boolean; readonly files?: number; readonly diagnostics: readonly Diagnostic[] }> {
        return this.core.verifyToolchain(onFile);
    }

    toolchainArchiveName(): Promise<string | undefined> {
        return this.core.toolchainArchiveName();
    }
}
