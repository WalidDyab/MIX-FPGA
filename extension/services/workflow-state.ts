import {
    type BuildProgress,
    type BuildResult,
    countBySeverity,
    type Diagnostic,
    type ImplementationStage,
    type OperationStatus,
    type ProgrammingResult,
    type SimulationResult,
    type VhdlCheckResult,
    type WorkflowStep,
} from '../../core';

/**
 * Student-facing workflow state: Check, Simulate, Build (Synthesis,
 * Implementation, Bitstream) and Program. Pure reducers over Phase 3
 * results; nothing here runs tools.
 */
export type ActionState = 'idle' | 'running' | 'passed' | 'failed' | 'unavailable';
export type WorkflowAction = 'check' | 'simulate' | 'build' | 'program';
export type BuildStageId = ImplementationStage;
export const BUILD_STAGES: readonly BuildStageId[] = ['synthesis', 'implementation', 'bitstream'];

export interface ActionStatus {
    readonly state: ActionState;
    /** Short description, e.g. `No VHDL errors`, `2 errors`, `Passed · stopped at 280 ns`. */
    readonly summary?: string;
}

export interface WorkflowState {
    readonly check: ActionStatus;
    readonly simulate: ActionStatus;
    readonly build: ActionStatus;
    readonly stages: Readonly<Record<BuildStageId, ActionStatus>>;
    readonly program: ActionStatus;
    /** The action currently running, if any (one at a time). */
    readonly running?: WorkflowAction;
}

const idle: ActionStatus = { state: 'idle' };
const idleStages = (): Record<BuildStageId, ActionStatus> => ({ synthesis: idle, implementation: idle, bitstream: idle });

export function initialWorkflow(): WorkflowState {
    return { check: idle, simulate: idle, build: idle, stages: idleStages(), program: idle };
}

export function actionStarted(s: WorkflowState, action: WorkflowAction): WorkflowState {
    const running: ActionStatus = { state: 'running', summary: RUNNING_TEXT[action] };
    if (action === 'build') return { ...s, running: action, build: running, stages: { ...idleStages(), synthesis: { state: 'running' } } };
    return { ...s, running: action, [action]: running };
}

const RUNNING_TEXT: Record<WorkflowAction, string> = {
    check: 'Checking VHDL…',
    simulate: 'Simulating…',
    build: 'Building…',
    program: 'Programming…',
};

/** An action stopped by the user. */
export function actionCancelled(s: WorkflowState, action: WorkflowAction, summary = 'Cancelled'): WorkflowState {
    const cancelled: ActionStatus = { state: 'idle', summary };
    const { running: _r, ...rest } = s;
    if (action === 'build') {
        const stages = Object.fromEntries(BUILD_STAGES.map((id) => [id, s.stages[id].state === 'running' ? cancelled : s.stages[id]])) as Record<BuildStageId, ActionStatus>;
        return { ...rest, build: cancelled, stages };
    }
    return { ...rest, [action]: cancelled };
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function firstError(diagnostics: readonly Diagnostic[]): string | undefined {
    return diagnostics.find((d) => d.severity === 'error')?.message;
}

export function checkFinished(s: WorkflowState, r: VhdlCheckResult): WorkflowState {
    const { running: _r, ...rest } = s;
    const counts = countBySeverity(r.diagnostics);
    let check: ActionStatus;
    if (r.status === 'not-configured') check = { state: 'unavailable', summary: 'VHDL checker not set up' };
    else if (r.status === 'succeeded') check = { state: 'passed', summary: counts.warning ? `No VHDL errors · ${plural(counts.warning, 'warning')}` : 'No VHDL errors' };
    else check = { state: 'failed', summary: counts.error ? plural(counts.error, 'error') : (firstError(r.diagnostics) ?? 'Check failed') };
    return { ...rest, check };
}

/** `280ns` -> `280 ns`. */
export function formatSimTime(t: string): string {
    return t.replace(/^(-?[\d.]+)\s*([a-z]+)$/i, '$1 $2');
}

export function simulateFinished(s: WorkflowState, r: SimulationResult): WorkflowState {
    const { running: _r, ...rest } = s;
    let simulate: ActionStatus;
    const at = r.stoppedAt ? ` · stopped at ${formatSimTime(r.stoppedAt)}` : '';
    if (r.status === 'not-configured') simulate = { state: 'unavailable', summary: 'Simulator not set up' };
    else if (r.status === 'succeeded' && r.passed) simulate = { state: 'passed', summary: `Passed${at}` };
    else if (r.status === 'succeeded') simulate = { state: 'failed', summary: `Failed${at}` };
    else simulate = { state: 'failed', summary: firstError(r.diagnostics) ?? 'Simulation failed' };
    return { ...rest, simulate };
}

/** Educational stage a core workflow step belongs to (constraints = I/O placement = implementation). */
export function stageOfStep(step: WorkflowStep): BuildStageId | undefined {
    switch (step) {
        case 'validate':
        case 'workspace':
        case 'check':
        case 'simulate':
        case 'synthesize':
            return 'synthesis';
        case 'constraints':
            return 'implementation';
        case 'implement':
            return undefined; // depends on the backend's own stages
        case 'rtl':
            return undefined; // RTL analysis is not part of a build
    }
}

function setStage(stages: Readonly<Record<BuildStageId, ActionStatus>>, upTo: BuildStageId, current: ActionStatus): Record<BuildStageId, ActionStatus> {
    const out = { ...stages };
    for (const id of BUILD_STAGES) {
        if (id === upTo) {
            out[id] = current;
            break;
        }
        if (out[id].state !== 'failed') out[id] = { ...out[id], state: 'passed' };
    }
    return out;
}

/**
 * Live progress while a build runs. Synthesis covers VHDL checking, VHDL
 * synthesis and the backend's technology mapping, so it stays running
 * until the backend reports placement/routing.
 */
export function buildProgressed(s: WorkflowState, p: BuildProgress): WorkflowState {
    if (s.running !== 'build') return s;
    if (p.kind === 'implementation-stage') return { ...s, stages: setStage(s.stages, p.stage, { state: 'running' }) };
    if (p.kind === 'step-finished' && (p.status === 'failed' || p.status === 'not-configured')) {
        const current = BUILD_STAGES.find((id) => s.stages[id].state === 'running') ?? 'synthesis';
        return { ...s, stages: { ...s.stages, [current]: { state: p.status === 'failed' ? 'failed' : 'unavailable' } } };
    }
    return s;
}

const fmtMHz = (v: number | undefined) => (v === undefined ? '?' : `${Math.round(v * 100) / 100} MHz`);

function formatBytes(n: number | undefined): string {
    if (n === undefined) return '';
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
}

/** Final, authoritative stage states from a BuildResult. */
export function stagesFromResult(r: BuildResult): Record<BuildStageId, ActionStatus> {
    const stages = idleStages();
    const failedStep = r.steps.find((st) => st.status === 'failed' || st.status === 'not-configured');
    const bad = (st: OperationStatus, summary?: string): ActionStatus => ({ state: st === 'not-configured' ? 'unavailable' : 'failed', ...(summary ? { summary } : {}) });

    const util = r.utilization;
    // A board whose flow has its own vendor words (Logic Elements, Registers) says them; the original flow keeps its summary.
    const nz = r.normalized && !r.normalized.native ? r.normalized : undefined;
    const nzParts = nz ? [nz.resources.logic, nz.resources.registers].filter((m): m is NonNullable<typeof m> => m !== undefined).map((m) => `${m.used} ${m.label}`) : [];
    const synthSummary = nz ? (nzParts.join(' · ') || 'VHDL → netlist') : util?.luts || util?.flipFlops ? [util.luts ? `${util.luts.used} LUTs` : '', util.flipFlops ? `${util.flipFlops.used} FFs` : ''].filter(Boolean).join(' · ') : 'VHDL → netlist';
    const clock = r.timing?.clocks[0];
    const implSummary = r.timing?.passed === undefined ? 'Placed and routed' : `Timing ${r.timing.passed ? 'PASS' : 'FAIL'}${clock ? ` · ${fmtMHz(clock.achievedMHz)}` : ''}`;
    const bitName = nz && r.bitstream ? r.bitstream.path.split(/[\\/]/).pop()! : 'hardware.bit';
    const bitSummary = r.bitstream ? `${bitName} · ${formatBytes(r.bitstream.sizeBytes)}`.replace(/ · $/, '') : undefined;

    if (failedStep) {
        const reason = firstError(failedStep.diagnostics);
        let at: BuildStageId;
        if (failedStep.step === 'implement') at = r.implementationStage ?? 'synthesis';
        else at = stageOfStep(failedStep.step)!;
        const done = setStage(stages, at, bad(failedStep.status, reason));
        return done;
    }
    const implemented = r.steps.some((st) => st.step === 'implement' && st.status === 'succeeded');
    if (!implemented) return stages;
    return {
        synthesis: { state: 'passed', summary: synthSummary },
        implementation: { state: r.timing?.passed === false ? 'failed' : 'passed', summary: implSummary },
        bitstream: r.bitstream ? { state: 'passed', ...(bitSummary ? { summary: bitSummary } : {}) } : { state: 'failed', summary: nz ? 'No programming file produced' : 'No bitstream produced' },
    };
}

/** A student-facing status line while a build runs (`Preparing FPGA engine…`, `Fitting…`). */
export function buildStatus(s: WorkflowState, message: string): WorkflowState {
    if (s.running !== 'build') return s;
    return { ...s, build: { state: 'running', summary: message } };
}

export function buildFinished(s: WorkflowState, r: BuildResult): WorkflowState {
    const { running: _r, ...rest } = s;
    const stages = stagesFromResult(r);
    let build: ActionStatus;
    if (r.success) build = { state: 'passed', summary: 'BUILD COMPLETE' };
    else if (r.steps.some((st) => st.status === 'not-configured')) build = { state: 'unavailable', summary: 'Build tools not set up' };
    else if (r.timing?.passed === false && r.bitstream) build = { state: 'failed', summary: 'BUILD FAILED · timing not met' };
    else build = { state: 'failed', summary: 'BUILD FAILED' };
    // A build also checked the VHDL: reflect that in Check when it got that far.
    const checkStep = r.steps.find((st) => st.step === 'check');
    const check: ActionStatus = checkStep
        ? checkStep.status === 'succeeded'
            ? { state: 'passed', summary: 'No VHDL errors' }
            : checkStep.status === 'failed'
              ? { state: 'failed', summary: plural(countBySeverity(checkStep.diagnostics).error || 1, 'error') }
              : s.check
        : s.check;
    return { ...rest, check, build, stages };
}

export function programFinished(s: WorkflowState, r: ProgrammingResult): WorkflowState {
    const { running: _r, ...rest } = s;
    let program: ActionStatus;
    if (r.status === 'succeeded') program = { state: 'passed', summary: 'FPGA programmed' };
    else if (r.status === 'not-configured') program = { state: 'unavailable', summary: 'Programmer not set up' };
    else program = { state: 'failed', summary: firstError(r.diagnostics) ?? 'Programming failed' };
    return { ...rest, program };
}

/** Programming refused before it started (no bitstream, failed build, …). */
export function programBlocked(s: WorkflowState, message: string): WorkflowState {
    const { running: _r, ...rest } = s;
    return { ...rest, program: { state: 'failed', summary: message } };
}
