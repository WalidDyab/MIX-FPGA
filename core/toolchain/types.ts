/**
 * Toolchain version model. What was TESTED (a manifest's expectations) and
 * what is INSTALLED (detection) are deliberately separate types; only
 * evaluateCompatibility() relates them.
 */

export type ToolId = 'ghdl' | 'apio' | 'openxc7' | 'yosys' | 'nextpnr-xilinx' | 'programmer';

export const ALL_TOOL_IDS: readonly ToolId[] = ['ghdl', 'apio', 'openxc7', 'yosys', 'nextpnr-xilinx', 'programmer'];

/** A version string exactly as the tool reports it (normalised by the parsers). */
export type ToolVersion = string;

/** What a manifest says was tested for one tool. */
export interface ToolExpectation {
    readonly tool: ToolId;
    /** Human name of the concrete tool (e.g. a programmer backend's name). Data only. */
    readonly name?: string;
    /** Versions known to work. Empty = no tested version recorded yet. */
    readonly testedVersions: readonly ToolVersion[];
    readonly notes?: string;
}

/** A named, tested combination of tool versions for one host kind. */
export interface ToolchainManifest {
    readonly schemaVersion: 1;
    readonly id: string;
    readonly description: string;
    /** Host this combination was validated on (Node's platform/arch names). */
    readonly host: { readonly platform: string; readonly arch: string };
    /** `reference`: recorded from a validation phase; `release`: shipped as supported. */
    readonly status: 'reference' | 'release';
    readonly validatedBy?: string;
    readonly tools: readonly ToolExpectation[];
}

/** Result of probing the local machine for one tool. */
export interface DetectedTool {
    readonly tool: ToolId;
    readonly found: boolean;
    readonly path?: string;
    /** Parsed version, if it could be determined. */
    readonly version?: ToolVersion;
    /** Raw version text for debug views. */
    readonly rawVersion?: string;
    /** How detection was attempted, e.g. `not checked`, `configured path`. */
    readonly method: string;
}

export type CompatibilityStatus = 'compatible' | 'incompatible' | 'unknown' | 'missing';

export interface ToolCompatibility {
    readonly tool: ToolId;
    readonly status: CompatibilityStatus;
    readonly expected?: ToolExpectation;
    readonly detected?: DetectedTool;
    readonly reason: string;
}

/** Everything the UI needs to show a tool's version state. */
export interface ToolVersionInfo {
    readonly tool: ToolId;
    readonly expected: readonly ToolVersion[];
    readonly detected?: ToolVersion;
    readonly status: CompatibilityStatus;
}
