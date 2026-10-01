import type { ImplementationStage, ResourceUtilization, TimingResult } from '../implementation/types';
import type { BuildArtifact } from '../results/artifact';
import type { Diagnostic, LogRef, OperationStatus } from '../results/diagnostic';

export type WorkflowStep = 'validate' | 'workspace' | 'check' | 'simulate' | 'synthesize' | 'constraints' | 'implement' | 'rtl';

export interface StepResult {
    readonly step: WorkflowStep;
    readonly status: OperationStatus;
    readonly durationMs: number;
    readonly diagnostics: readonly Diagnostic[];
}

/** Board summary for UI display. */
export interface BoardInfo {
    readonly id: string;
    readonly name: string;
    readonly device: string;
    readonly part: string;
}

/** Everything a UI needs to show a build outcome without parsing tool output. */
export interface BuildResult {
    readonly success: boolean;
    readonly steps: readonly StepResult[];
    readonly board?: BoardInfo;
    /** Canonical hardware.bit (ADR: never modified by programming). */
    readonly bitstream?: BuildArtifact;
    readonly generatedVerilog?: BuildArtifact;
    readonly utilization?: ResourceUtilization;
    readonly timing?: TimingResult;
    /** Last implementation stage the backend started (absent if implementation never ran). */
    readonly implementationStage?: ImplementationStage;
    /** Where the constraints came from: the project's XDC file, or generated from `pins`. */
    readonly constraintsSource?: { readonly kind: 'file'; readonly file: string } | { readonly kind: 'generated' };
    /** All diagnostics from all steps, in order. */
    readonly diagnostics: readonly Diagnostic[];
    readonly logs: readonly LogRef[];
    readonly durationMs: number;
}

/** Progress of a running build, for UIs. Informational only; the BuildResult is authoritative. */
export type BuildProgress =
    | { readonly kind: 'step-started'; readonly step: WorkflowStep }
    | { readonly kind: 'step-finished'; readonly step: WorkflowStep; readonly status: OperationStatus }
    | { readonly kind: 'implementation-stage'; readonly stage: ImplementationStage };

export interface BuildOptions {
    /** Run the selected testbench before synthesis and stop if it fails. */
    readonly simulate?: boolean;
    readonly testbench?: string;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: BuildProgress) => void;
}
