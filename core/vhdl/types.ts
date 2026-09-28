import type { Project } from '../project/types';
import type { BuildArtifact } from '../results/artifact';
import type { OperationResult } from '../results/operation';
import type { BuildWorkspace } from '../workspace/build-workspace';

export interface VhdlContext {
    readonly project: Project;
    readonly workspace: BuildWorkspace;
    readonly signal?: AbortSignal;
}

/** Analysis + elaboration of the RTL (and simulation sources, if any). */
export interface VhdlCheckResult extends OperationResult {
    /** Top-level units that elaborated successfully. */
    readonly elaborated: readonly string[];
}

export interface SimulationOptions {
    readonly testbench: string;
    /** Write a waveform file into the workspace. */
    readonly waveform: boolean;
}

export interface SimulationResult extends OperationResult {
    readonly testbench: string;
    /** True only if the simulation ran to completion without assertion errors. */
    readonly passed: boolean;
    /** Simulation time at which it stopped, as reported (e.g. `280ns`). */
    readonly stoppedAt?: string;
    readonly waveform?: BuildArtifact;
    /** `report`/`assert` messages from the testbench, in order. */
    readonly messages: readonly string[];
}

export interface SynthesisResult extends OperationResult {
    readonly top: string;
    /** Verilog netlist produced from the VHDL; input to implementation. */
    readonly generatedVerilog?: BuildArtifact;
    /** Module names in the netlist (hierarchy check). */
    readonly modules: readonly string[];
}

/** VHDL front end: check, simulate, and synthesize to a Verilog netlist. */
export interface VhdlProvider {
    readonly id: string;
    check(ctx: VhdlContext): Promise<VhdlCheckResult>;
    simulate(ctx: VhdlContext, options: SimulationOptions): Promise<SimulationResult>;
    synthesize(ctx: VhdlContext): Promise<SynthesisResult>;
}
