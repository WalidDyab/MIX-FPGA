/**
 * Adapters that put the original Nexys A7 flow behind the MIX-FPGA provider contracts.
 *
 * The existing flow stays the reference implementation: nothing here reimplements synthesis,
 * place and route, constraint generation or programming. Each adapter calls the existing
 * WorkflowController / ProgrammingService and translates the result.
 */
import { generateXdc } from '../board/constraints';
import type { BoardRegistry } from '../board/board-registry';
import type { BoardDefinition } from '../board/types';
import type { ImplementationStage } from '../implementation/types';
import { loadProject } from '../project/project-loader';
import type { Project } from '../project/types';
import type { ProgrammingService } from '../programming/programming-service';
import type { BuildArtifact } from '../results/artifact';
import { type Diagnostic, errorDiag, hasErrors, infoDiag } from '../results/diagnostic';
import { sha256File } from '../util/hash';
import type { WorkflowController } from '../workflow/workflow-controller';
import type { BuildProgress, BuildResult, WorkflowStep } from '../workflow/types';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
    type BoardProfile,
    type BuildProgressEvent,
    type BuildRequest,
    type BuildStage,
    type ClockResult,
    type ConstraintProvider,
    type ConstraintSet,
    type HardwareDetection,
    type ImplementationProvider,
    type NormalizedBuildResult,
    type ProgramOutcome,
    type ProgramRequest,
    type ProgrammingArtifactInfo,
    type ProgrammingProvider,
    type VendorMetric,
    profileFromBoardDefinition,
} from './types';

export const NEXYS_A7_ID = 'nexys-a7-100t';
export const OPENXC7_PROVIDER_ID = 'openxc7';

/** The Nexys A7-100T profile, derived from its board data (XDC, openxc7, bitstream, LUT labels). */
export function nexysA7BoardProfile(registry: BoardRegistry): BoardProfile {
    const def = registry.get(NEXYS_A7_ID);
    if (!def) throw new Error(`board ${NEXYS_A7_ID} is not in the registry`);
    return profileFromBoardDefinition(def);
}

// ------------------------------------------------------------------ result normalization

const STEP_STAGE: Record<WorkflowStep, BuildStage> = {
    validate: 'prepare',
    workspace: 'prepare',
    check: 'prepare',
    simulate: 'prepare',
    synthesize: 'synthesis',
    constraints: 'stage',
    implement: 'fit',
    rtl: 'prepare',
};
const IMPL_STAGE: Record<ImplementationStage, BuildStage> = { synthesis: 'synthesis', implementation: 'fit', bitstream: 'assemble' };

const metric = (u: { used: number; available?: number } | undefined, label: string, vendorName: string): VendorMetric | undefined =>
    u ? { used: u.used, ...(u.available !== undefined ? { available: u.available } : {}), label, vendorName } : undefined;

/** Original-flow BuildResult -> vendor-neutral result. The original is kept in `native`. */
export async function normalizeLegacyBuild(legacy: BuildResult, profile: BoardProfile, cancelled = false): Promise<NormalizedBuildResult> {
    const L = profile.metricLabels;
    const u = legacy.utilization;
    const resources: { -readonly [K in keyof NormalizedBuildResult['resources']]: NormalizedBuildResult['resources'][K] } = {};
    const put = <K extends keyof typeof resources>(k: K, m: VendorMetric | undefined) => {
        if (m) resources[k] = m;
    };
    put('logic', metric(u?.luts, L.logic, 'LUTs'));
    put('registers', metric(u?.flipFlops, L.registers, 'Flip-Flops'));
    put('memoryBlocks', metric(u?.bram, L.memory, 'BRAM (36 Kb)'));
    put('dsp', metric(u?.dsp, L.dsp, 'DSP'));
    put('pins', metric(u?.io, 'I/O pins', 'I/O pins'));

    const worst = legacy.timing?.worstSlackNs;
    const clocks: ClockResult[] = (legacy.timing?.clocks ?? []).map((c, i, all) => ({
        name: c.clock,
        ...(c.targetMHz !== undefined ? { targetMHz: c.targetMHz } : {}),
        ...(c.achievedMHz !== undefined ? { fmaxMHz: c.achievedMHz } : {}),
        // A single constrained clock owns the design's worst slack; with several the per-clock value is not reported.
        ...(worst !== undefined && all.length === 1 && i === 0 ? { worstSetupSlackNs: worst } : {}),
    }));
    const timingStatus = legacy.timing?.passed === undefined ? (legacy.timing ? 'unconstrained' : 'not-run') : legacy.timing.passed ? 'met' : 'not-met';

    const failedStep = legacy.steps.find((s) => s.status === 'failed' || s.status === 'not-configured');
    const failedStage: BuildStage | undefined = failedStep ? (failedStep.step === 'implement' ? IMPL_STAGE[legacy.implementationStage ?? 'synthesis'] : STEP_STAGE[failedStep.step]) : undefined;

    let programmingArtifact: NormalizedBuildResult['programmingArtifact'];
    if (legacy.bitstream) {
        programmingArtifact = {
            path: legacy.bitstream.path,
            format: 'bit',
            sizeBytes: legacy.bitstream.sizeBytes ?? (await stat(legacy.bitstream.path).then((s) => s.size, () => 0)),
            sha256: legacy.bitstream.sha256 ?? (await sha256File(legacy.bitstream.path).catch(() => '')),
        };
    }

    const durations: { -readonly [K in BuildStage]?: number } = {};
    for (const s of legacy.steps) durations[STEP_STAGE[s.step]] = (durations[STEP_STAGE[s.step]] ?? 0) + s.durationMs;

    return {
        boardId: profile.id,
        device: profile.fpga.device,
        implementationStatus: cancelled ? 'cancelled' : legacy.success ? 'passed' : legacy.steps.length === 0 ? 'not-run' : 'failed',
        ...(failedStage && !legacy.success ? { failedStage } : {}),
        timingStatus,
        clocks,
        labels: profile.metricLabels,
        resources,
        warnings: legacy.diagnostics.filter((d) => d.severity === 'warning'),
        diagnostics: legacy.diagnostics,
        ...(programmingArtifact ? { programmingArtifact } : {}),
        rawReports: legacy.logs.map((l) => ({ label: l.label, path: l.path })),
        logs: legacy.logs,
        stageDurationsMs: durations,
        durationMs: legacy.durationMs,
        native: legacy,
    };
}

/** Original-flow progress -> the provider contract's events (best effort; the original stream is also forwarded). */
export function legacyProgressToEvents(p: BuildProgress): BuildProgressEvent | undefined {
    if (p.kind === 'implementation-stage') return { kind: 'stage-started', stage: IMPL_STAGE[p.stage] };
    if (p.kind === 'step-started') return { kind: 'stage-started', stage: STEP_STAGE[p.step] };
    if (p.kind === 'step-finished') return { kind: 'stage-finished', stage: STEP_STAGE[p.step], ok: p.status === 'succeeded' || p.status === 'skipped' };
    return undefined;
}

// ------------------------------------------------------------------ implementation

export interface OpenXC7Dependencies {
    /** The original flow's controller for a project (check -> GHDL -> openxc7 -> bitstream). */
    readonly controllerFor: (project: Project) => Promise<WorkflowController>;
    /** The canonical bitstream of the project's last build, if any (the original flow's own lookup). */
    readonly bitstreamFor?: (projectDir: string) => Promise<{ readonly path: string; readonly sizeBytes?: number; readonly modifiedMs: number } | undefined>;
}

/** `openxc7` implementation: delegates to the original WorkflowController; adds no logic of its own. */
export class OpenXC7ImplementationProvider implements ImplementationProvider {
    readonly id = OPENXC7_PROVIDER_ID;
    readonly selfContained = true;

    constructor(private readonly deps: OpenXC7Dependencies) {}

    supports(board: BoardProfile): boolean {
        return board.implementationProviderId === this.id;
    }

    async build(req: BuildRequest): Promise<NormalizedBuildResult> {
        if (req.project) return this.buildProject(req.project, req, req.nativeProgress);
        const loaded = await loadProject(req.projectDir);
        if (!loaded.ok) return this.failed(req, loaded.diagnostics);
        return this.buildProject(loaded.project, req, req.nativeProgress);
    }

    /** Build an already-loaded project. `onLegacyProgress` receives the original flow's progress unchanged. */
    async buildProject(project: Project, req: BuildRequest, onLegacyProgress: ((p: BuildProgress) => void) | undefined): Promise<NormalizedBuildResult> {
        const controller = await this.deps.controllerFor(project);
        const legacy = await controller.build(project, {
            ...(req.signal ? { signal: req.signal } : {}),
            onProgress: (p) => {
                onLegacyProgress?.(p);
                const e = legacyProgressToEvents(p);
                if (e) {
                    try {
                        req.onProgress?.(e);
                    } catch {
                        /* observers must not break a build */
                    }
                }
            },
        });
        return normalizeLegacyBuild(legacy, req.board, req.signal?.aborted === true);
    }

    async artifactFor(projectDir: string): Promise<ProgrammingArtifactInfo | undefined> {
        const b = await this.deps.bitstreamFor?.(projectDir);
        if (!b) return undefined;
        return { path: b.path, format: 'bit', sizeBytes: b.sizeBytes ?? 0, sha256: '', modifiedMs: b.modifiedMs };
    }

    private failed(req: BuildRequest, diagnostics: readonly Diagnostic[]): NormalizedBuildResult {
        return {
            boardId: req.board.id,
            device: req.board.fpga.device,
            implementationStatus: 'failed',
            failedStage: 'prepare',
            timingStatus: 'not-run',
            clocks: [],
            resources: {},
            warnings: [],
            diagnostics,
            rawReports: [],
            logs: [],
            stageDurationsMs: {},
            durationMs: 0,
        };
    }
}

// ------------------------------------------------------------------ constraints

/**
 * XDC constraints: the project's own XDC file, or XDC generated from its pin mapping. Read-only.
 * (The existing flow normalizes and checks the XDC against the netlist during Build.)
 */
export class XdcConstraintProvider implements ConstraintProvider {
    readonly format = 'xdc' as const;

    constructor(private readonly boards: BoardRegistry) {}

    async collect(projectDir: string): Promise<ConstraintSet> {
        const loaded = await loadProject(projectDir);
        if (!loaded.ok) return { format: 'xdc', files: [], origin: 'files' };
        const c = loaded.project.config.constraints;
        if (typeof c === 'string') return { format: 'xdc', files: [{ kind: 'xdc', path: join(loaded.project.root, ...c.split('/')) }], origin: 'files' };
        return { format: 'xdc', files: [], origin: 'generated' };
    }

    async validate(set: ConstraintSet, board: BoardProfile, projectDir?: string): Promise<readonly Diagnostic[]> {
        const out: Diagnostic[] = [];
        if (set.origin === 'generated') {
            const def = this.boards.get(board.id);
            const loaded = projectDir ? await loadProject(projectDir) : undefined;
            if (!def || !loaded?.ok || !loaded.project.config.pins) return [errorDiag('project', 'CONSTRAINTS_NO_PINS', 'The project has neither an XDC file nor a pin mapping.')];
            return generateXdc(def, loaded.project.config.pins).diagnostics;
        }
        if (set.files.length === 0) out.push(errorDiag('project', 'CONSTRAINTS_NO_XDC', 'No .xdc constraints file is set for the project.'));
        for (const f of set.files) {
            if (f.kind !== 'xdc') out.push(errorDiag('project', 'CONSTRAINTS_WRONG_KIND', `${basename(f.path)} is not an .xdc file; ${board.displayName} uses XDC constraints.`));
        }
        return out;
    }
}

// ------------------------------------------------------------------ programming

export interface LegacyProgrammingDependencies {
    readonly boards: BoardRegistry;
    readonly service: ProgrammingService;
    /** Directory for derived programming files when the request names none. */
    readonly programDirFor: (bitstreamPath: string) => string;
    /** Free-text description of the programmer for `availability()`. */
    readonly describe: () => Promise<{ readonly available: boolean; readonly detail: string }>;
}

/** The platform's existing programming backend behind the `ProgrammingProvider` contract. */
export class LegacyProgrammingProvider implements ProgrammingProvider {
    readonly id = 'platform-default';

    constructor(private readonly deps: LegacyProgrammingDependencies) {}

    availability() {
        return this.deps.describe();
    }

    private def(board: BoardProfile): BoardDefinition | undefined {
        return this.deps.boards.get(board.id);
    }

    async detect(board: BoardProfile): Promise<HardwareDetection> {
        const def = this.def(board);
        if (!def) return { status: 'error', probes: [], devices: [], diagnostics: [errorDiag('project', 'PROJECT_BOARD_UNSUPPORTED', `Board "${board.id}" is not supported.`)], logs: [] };
        const r = await this.deps.service.detectBoards(def);
        const probes = r.boards.map((b) => ({ description: b.productName ?? 'board', ...(b.serialNumber ? { serial: b.serialNumber } : {}) }));
        if (!r.configured) return { status: 'programmer-missing', probes: [], devices: [], diagnostics: r.diagnostics, logs: [], native: r };
        if (hasErrors(r.diagnostics) && r.boards.length === 0) return { status: 'error', probes, devices: [], diagnostics: r.diagnostics, logs: [], native: r };
        return { status: r.boards.length === 0 ? 'board-absent' : 'detected', probes, devices: [], diagnostics: r.diagnostics, logs: [], native: r };
    }

    async program(req: ProgramRequest): Promise<ProgramOutcome> {
        const def = this.def(req.board);
        const started = Date.now();
        if (!def) return { status: 'rejected', softwareVerified: false, diagnostics: [errorDiag('project', 'PROJECT_BOARD_UNSUPPORTED', `Board "${req.board.id}" is not supported.`)], logs: [], durationMs: 0 };
        const canonical: BuildArtifact = { kind: 'bitstream', path: req.artifact.path, canonical: true, sizeBytes: req.artifact.sizeBytes };
        const r = await this.deps.service.program(canonical, def, req.workDir ?? this.deps.programDirFor(req.artifact.path), {
            ...(req.serialNumber !== undefined ? { serialNumber: req.serialNumber } : {}),
            ...(req.signal ? { signal: req.signal } : {}),
        });
        const ok = r.status === 'succeeded';
        return {
            status: ok ? 'programmed' : req.signal?.aborted ? 'cancelled' : 'failed',
            softwareVerified: ok,
            diagnostics: ok ? [...r.diagnostics, infoDiag('programming', 'PROGRAMMED_SRAM', 'Configuration loaded into the FPGA.')] : r.diagnostics,
            logs: r.logs,
            durationMs: Date.now() - started,
            native: r,
        };
    }
}

