import type { ImplementationStage, TimingResult } from '../implementation/types';
import type { BuildArtifact } from '../results/artifact';
import { type Diagnostic, hasErrors } from '../results/diagnostic';
import type { OperationStatus } from '../results/diagnostic';
import type { BuildProgress, BuildResult, StepResult } from '../workflow/types';
import type { BoardProfile, BuildProgressEvent, BuildStage, NormalizedBuildResult } from './types';

/** Student-friendly status line for a provider stage (no tool or infrastructure words). */
export const STAGE_STATUS: Readonly<Record<BuildStage, string>> = {
    prepare: 'Preparing FPGA engine…',
    stage: 'Preparing the project…',
    synthesis: 'Synthesis…',
    fit: 'Fitting…',
    timing: 'Timing…',
    assemble: 'Generating programming file…',
    package: 'Generating programming file…',
    collect: 'Collecting results…',
};

/** The three educational stages of the Build row that a provider stage belongs to. */
export const STAGE_TO_IMPLEMENTATION: Readonly<Record<BuildStage, ImplementationStage>> = {
    prepare: 'synthesis',
    stage: 'synthesis',
    synthesis: 'synthesis',
    fit: 'implementation',
    timing: 'implementation',
    assemble: 'bitstream',
    package: 'bitstream',
    collect: 'bitstream',
};

/** Provider progress -> the workflow progress the Build row already shows, plus a status line. */
export function progressFromProviderEvent(e: BuildProgressEvent): { progress?: BuildProgress; status?: string } {
    if (e.kind === 'stage-started') {
        // The preparing/staging stages belong to Synthesis visibly (nothing is running yet); only later stages move the row.
        const impl = STAGE_TO_IMPLEMENTATION[e.stage];
        return { status: STAGE_STATUS[e.stage], ...(e.stage === 'prepare' || e.stage === 'stage' ? {} : { progress: { kind: 'implementation-stage', stage: impl } }) };
    }
    return {};
}

function timingOf(n: NormalizedBuildResult): TimingResult | undefined {
    if (n.timingStatus === 'not-run') return undefined;
    const clocks = n.clocks.map((c) => ({
        clock: c.name,
        ...(c.targetMHz !== undefined ? { targetMHz: c.targetMHz } : {}),
        ...(c.fmaxMHz !== undefined ? { achievedMHz: c.fmaxMHz } : {}),
        ...(c.targetMHz !== undefined && c.worstSetupSlackNs !== undefined ? { passed: c.worstSetupSlackNs >= 0 } : {}),
    }));
    const slacks = n.clocks.map((c) => c.worstSetupSlackNs).filter((v): v is number => v !== undefined);
    return {
        clocks,
        ...(slacks.length ? { worstSlackNs: Math.min(...slacks) } : {}),
        ...(n.timingStatus === 'met' ? { passed: true } : n.timingStatus === 'not-met' ? { passed: false } : {}),
    };
}

/**
 * Normalized provider result -> the BuildResult the Workflow and Results views render. `checkSteps` are the
 * steps that ran before the provider (Check). The vendor-neutral result is carried along as `normalized`.
 */
export function workflowResultFrom(n: NormalizedBuildResult, profile: BoardProfile, checkSteps: readonly StepResult[], extraDiagnostics: readonly Diagnostic[], durationMs: number): BuildResult {
    const implStatus: OperationStatus = n.implementationStatus === 'passed' ? 'succeeded' : n.implementationStatus === 'not-run' ? 'skipped' : 'failed';
    const steps: StepResult[] = [
        ...checkSteps,
        { step: 'implement', status: implStatus, durationMs: n.durationMs, diagnostics: n.diagnostics.filter((d) => d.severity === 'error') },
    ];
    const timing = timingOf(n);
    const artifact: BuildArtifact | undefined = n.programmingArtifact
        ? { kind: 'bitstream', path: n.programmingArtifact.path, canonical: true, sizeBytes: n.programmingArtifact.sizeBytes, sha256: n.programmingArtifact.sha256 }
        : undefined;
    const diagnostics = [...extraDiagnostics, ...n.diagnostics];
    return {
        success: n.implementationStatus === 'passed' && timing?.passed !== false,
        steps,
        board: { id: profile.id, name: profile.name, device: profile.fpga.device, part: profile.fpga.device },
        ...(artifact ? { bitstream: artifact } : {}),
        ...(timing ? { timing } : {}),
        ...(n.failedStage ? { implementationStage: STAGE_TO_IMPLEMENTATION[n.failedStage] } : n.implementationStatus === 'passed' ? { implementationStage: 'bitstream' as const } : {}),
        diagnostics,
        logs: n.logs,
        durationMs,
        normalized: n,
    };
}

/** A build that never reached the provider (host unsupported, no provider, check failed ...). */
export function failedWorkflowResult(profile: BoardProfile | undefined, steps: readonly StepResult[], diagnostics: readonly Diagnostic[], durationMs = 0): BuildResult {
    return {
        success: false,
        steps,
        ...(profile ? { board: { id: profile.id, name: profile.name, device: profile.fpga.device, part: profile.fpga.device } } : {}),
        diagnostics,
        logs: [],
        durationMs,
    };
}

export { hasErrors };
