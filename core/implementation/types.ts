import type { BoardDefinition } from '../board/types';
import type { Project } from '../project/types';
import type { BuildArtifact } from '../results/artifact';
import type { OperationResult } from '../results/operation';
import type { BuildWorkspace } from '../workspace/build-workspace';

export interface ResourceUsage {
    readonly used: number;
    readonly available?: number;
}

/** Normalised resource counts. Fields are absent when the backend did not report them. */
export interface ResourceUtilization {
    readonly luts?: ResourceUsage;
    readonly flipFlops?: ResourceUsage;
    readonly bram?: ResourceUsage;
    readonly dsp?: ResourceUsage;
    readonly carry?: ResourceUsage;
    readonly io?: ResourceUsage;
    readonly globalClockBuffers?: ResourceUsage;
    /** Synthesis primitive counts (e.g. FDRE, CARRY4) for advanced views. */
    readonly primitives?: Readonly<Record<string, number>>;
    /** Every device resource the placer reported, verbatim names. */
    readonly device?: Readonly<Record<string, ResourceUsage>>;
}

export interface ClockTiming {
    readonly clock: string;
    readonly targetMHz?: number;
    readonly achievedMHz?: number;
    readonly passed?: boolean;
}

export interface TimingResult {
    readonly clocks: readonly ClockTiming[];
    readonly worstSlackNs?: number;
    readonly criticalPathNs?: number;
    /** True when every constrained clock met its target; undefined when no clock was constrained. */
    readonly passed?: boolean;
}

export interface ImplementationRequest {
    readonly project: Project;
    readonly board: BoardDefinition;
    readonly workspace: BuildWorkspace;
    /** Netlist from VHDL synthesis. */
    readonly verilog: BuildArtifact;
    /** Constraints generated from board data + project pin mapping. */
    readonly xdc: string;
    readonly signal?: AbortSignal;
}

export interface ImplementationResult extends OperationResult {
    /** Implementation part actually targeted, as reported by the backend. */
    readonly part?: string;
    /** The canonical bitstream (hardware.bit). Never modified after this point. */
    readonly bitstream?: BuildArtifact;
    readonly utilization?: ResourceUtilization;
    readonly timing?: TimingResult;
    /** Files the backend was given (all inside the staging directory). */
    readonly stagedFiles: readonly string[];
}

/**
 * Synthesis-to-bitstream backend. Implementations must stage their inputs with
 * BuildWorkspace.stageImplementation() and run only inside that directory.
 */
export interface ImplementationProvider {
    readonly id: string;
    implement(request: ImplementationRequest): Promise<ImplementationResult>;
}
