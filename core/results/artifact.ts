/**
 * Build artifacts. The canonical bitstream produced by implementation is
 * immutable; programming works on a separately represented ProgrammingArtifact
 * (see core/programming).
 */

export type BuildArtifactKind = 'bitstream' | 'generated-verilog' | 'constraints' | 'report' | 'waveform' | 'rtl-netlist';

export interface BuildArtifact {
    readonly kind: BuildArtifactKind;
    readonly path: string;
    /** True for the one artifact that must never be modified after the build (hardware.bit). */
    readonly canonical: boolean;
    readonly sizeBytes?: number;
    readonly sha256?: string;
}
