import type { Project } from '../project/types';
import type { BuildArtifact } from '../results/artifact';
import type { OperationResult } from '../results/operation';
import type { BuildWorkspace } from '../workspace/build-workspace';

export interface RtlRequest {
    readonly project: Project;
    readonly workspace: BuildWorkspace;
    /** GHDL netlist (Verilog) of the design, inside `workspace.paths.rtl`. */
    readonly verilog: BuildArtifact;
    readonly top: string;
    readonly signal?: AbortSignal;
}

export interface RtlProviderResult extends OperationResult {
    /** Generic RTL netlist (Yosys JSON: registers, muxes, arithmetic, logic), before technology mapping. */
    readonly netlist?: BuildArtifact;
}

/**
 * Turns the synthesized VHDL netlist into a generic RTL netlist for the RTL
 * schematic. Analysis only: no technology mapping, placement, routing or
 * bitstream. Must write only inside `workspace.paths.rtl` and `logs`.
 */
export interface RtlProvider {
    readonly id: string;
    elaborate(request: RtlRequest): Promise<RtlProviderResult>;
}

/** Outcome of WorkflowController.rtl(): the inputs and outputs of the RTL analysis. */
export interface RtlAnalysisResult extends OperationResult {
    readonly top: string;
    /** GHDL netlist the RTL was derived from (carries `/*# file:line:col *\/` source comments). */
    readonly verilog?: BuildArtifact;
    /** Yosys JSON RTL netlist. */
    readonly netlist?: BuildArtifact;
}
