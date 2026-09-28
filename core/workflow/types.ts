import type { ResourceUtilization, TimingResult } from '../implementation/types';
import type { BuildArtifact } from '../results/artifact';
import type { Diagnostic, LogRef, OperationStatus } from '../results/diagnostic';

export type WorkflowStep = 'validate' | 'workspace' | 'check' | 'simulate' | 'synthesize' | 'constraints' | 'implement';

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
    /** All diagnostics from all steps, in order. */
    readonly diagnostics: readonly Diagnostic[];
    readonly logs: readonly LogRef[];
    readonly durationMs: number;
}

export interface BuildOptions {
    /** Run the selected testbench before synthesis and stop if it fails. */
    readonly simulate?: boolean;
    readonly testbench?: string;
    readonly signal?: AbortSignal;
}
