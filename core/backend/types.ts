/**
 * MIX-FPGA multi-board backend contracts (Phase 1 proposal, proven by the DE10-Lite backend).
 *
 * These are additive: the Nexys A7 path keeps using core/implementation, core/programming and
 * core/workflow unchanged. A later phase makes the Nexys A7 path implement these same contracts
 * through thin adapters so the VS Code UI can call one generic Check / Build / Detect / Program.
 */
import type { BoardDefinition } from '../board/types';
import type { Diagnostic, LogRef } from '../results/diagnostic';

// ---------------------------------------------------------------- board profile

/** Constraint file family a board's implementation backend consumes. */
export type ConstraintFormat = 'xdc' | 'qsf-sdc';

/** What the board's programmer is given. `bit` = canonical bitstream, `svf` = serial vector file. */
export type ProgrammingFormat = 'bit' | 'svf';

/** Vendor-native names for the headline metrics (students see `Logic Elements`, `LUTs`, ...). */
export interface MetricLabels {
    readonly logic: string;
    readonly registers: string;
    readonly memory: string;
    readonly dsp: string;
}

export interface BoardProfile {
    readonly id: string;
    readonly name: string;
    readonly vendor: string;
    readonly fpga: {
        readonly family: string;
        /** Exact orderable device, e.g. `10M50DAF484C7G`. */
        readonly device: string;
        /** JTAG IDCODE of the FPGA, when known (used to confirm the right chip is on the board). */
        readonly jtagIdcode?: number;
    };
    readonly constraintFormat: ConstraintFormat;
    readonly implementationProviderId: string;
    readonly programmingProviderId: string;
    readonly programmingFormat: ProgrammingFormat;
    /** Key the board's programming backend uses for this board (opaque to the core). */
    readonly programmerBoardKey?: string;
    readonly metricLabels: MetricLabels;
    readonly identification?: { readonly usb?: { readonly vendorId: string; readonly productId: string }; readonly productNames?: readonly string[] };
}

// ---------------------------------------------------------------- constraints

export type ConstraintFileKind = 'xdc' | 'qsf' | 'sdc';

export interface ConstraintFile {
    readonly kind: ConstraintFileKind;
    /** Absolute path in the student's project (read-only for the backend). */
    readonly path: string;
}

export interface ConstraintSet {
    readonly format: ConstraintFormat;
    readonly files: readonly ConstraintFile[];
}

/** Finds and validates the constraint files that belong to one board. Never writes to the project. */
export interface ConstraintProvider {
    readonly format: ConstraintFormat;
    collect(projectDir: string): Promise<ConstraintSet>;
    validate(set: ConstraintSet, board: BoardProfile): Promise<readonly Diagnostic[]>;
}

// ---------------------------------------------------------------- normalized build result

export type ImplementationStatus = 'passed' | 'failed' | 'cancelled' | 'not-run';
export type TimingStatus = 'met' | 'not-met' | 'unconstrained' | 'not-run';

/** A number in the vendor's own unit; never converted between vendors (a Logic Element is not a LUT). */
export interface VendorMetric {
    readonly used: number;
    readonly available?: number;
    /** Student-facing label, e.g. `Logic Elements`. */
    readonly label: string;
    /** Exact name in the vendor report, e.g. `Total logic elements`. */
    readonly vendorName: string;
}

export interface ClockResult {
    readonly name: string;
    readonly targetMHz?: number;
    /** Worst-corner Fmax before I/O restrictions, MHz. */
    readonly fmaxMHz?: number;
    /** Fmax after the device's own limits (min pulse width, I/O toggle), MHz. */
    readonly restrictedFmaxMHz?: number;
    readonly worstSetupSlackNs?: number;
    readonly worstHoldSlackNs?: number;
}

export type BuildStage = 'prepare' | 'stage' | 'synthesis' | 'fit' | 'assemble' | 'timing' | 'package' | 'collect';

export interface ProgrammingArtifactRef {
    readonly path: string;
    readonly format: ProgrammingFormat;
    readonly sizeBytes: number;
    readonly sha256: string;
}

export interface RawReport {
    readonly label: string;
    readonly path: string;
}

export interface NormalizedBuildResult {
    readonly boardId: string;
    readonly device: string;
    readonly implementationStatus: ImplementationStatus;
    /** The stage that failed or was running when cancelled. */
    readonly failedStage?: BuildStage;
    readonly timingStatus: TimingStatus;
    readonly clocks: readonly ClockResult[];
    readonly resources: {
        readonly logic?: VendorMetric;
        readonly combinational?: VendorMetric;
        readonly registers?: VendorMetric;
        readonly memoryBits?: VendorMetric;
        readonly memoryBlocks?: VendorMetric;
        readonly dsp?: VendorMetric;
        readonly pins?: VendorMetric;
    };
    readonly warnings: readonly Diagnostic[];
    readonly diagnostics: readonly Diagnostic[];
    readonly programmingArtifact?: ProgrammingArtifactRef;
    readonly rawReports: readonly RawReport[];
    readonly logs: readonly LogRef[];
    readonly stageDurationsMs: Readonly<Partial<Record<BuildStage, number>>>;
    readonly durationMs: number;
}

// ---------------------------------------------------------------- implementation provider

export type BuildProgressEvent =
    | { readonly kind: 'stage-started'; readonly stage: BuildStage }
    | { readonly kind: 'stage-finished'; readonly stage: BuildStage; readonly ok: boolean };

export interface BuildRequest {
    readonly projectDir: string;
    readonly board: BoardProfile;
    /** Top-level entity; defaults to the provider's convention. */
    readonly top?: string;
    readonly signal?: AbortSignal;
    readonly onProgress?: (event: BuildProgressEvent) => void;
    /** Live tool output (stdout and stderr) for a console. */
    readonly onOutput?: (text: string) => void;
}

/** Synthesis -> place and route -> timing -> programming artifact for one family of boards. */
export interface ImplementationProvider {
    readonly id: string;
    supports(board: BoardProfile): boolean;
    build(request: BuildRequest): Promise<NormalizedBuildResult>;
}

// ---------------------------------------------------------------- programming provider

export interface DetectedDevice {
    readonly index: number;
    readonly idcode: number;
    readonly family?: string;
    readonly model?: string;
}

export type HardwareStatus = 'detected' | 'board-absent' | 'programmer-missing' | 'unexpected-device' | 'error';

export interface HardwareDetection {
    readonly status: HardwareStatus;
    readonly probes: readonly { readonly description: string; readonly vendorId?: string; readonly productId?: string; readonly serial?: string }[];
    readonly devices: readonly DetectedDevice[];
    readonly diagnostics: readonly Diagnostic[];
    readonly logs: readonly LogRef[];
}

export type ProgramStatus = 'programmed' | 'failed' | 'cancelled' | 'rejected';

export interface ProgramRequest {
    readonly artifact: ProgrammingArtifactRef;
    readonly board: BoardProfile;
    readonly signal?: AbortSignal;
    readonly onOutput?: (text: string) => void;
}

export interface ProgramOutcome {
    readonly status: ProgramStatus;
    /** Software evidence only (tool completion + device still on the JTAG chain). Never a claim about the board's behaviour. */
    readonly softwareVerified: boolean;
    readonly diagnostics: readonly Diagnostic[];
    readonly logs: readonly LogRef[];
    readonly durationMs: number;
}

export interface ProgrammingProvider {
    readonly id: string;
    availability(): Promise<{ readonly available: boolean; readonly detail: string }>;
    detect(board: BoardProfile): Promise<HardwareDetection>;
    program(request: ProgramRequest): Promise<ProgramOutcome>;
}

// ---------------------------------------------------------------- environment / toolchain provider

export type EngineState = 'not-installed' | 'stopped' | 'starting' | 'running' | 'unhealthy';

export interface EngineStatus {
    readonly state: EngineState;
    /** Exact implementation-tool version when it answered the probe. */
    readonly toolVersion?: string;
    readonly problems: readonly Diagnostic[];
}

/** The hidden machinery behind an implementation provider (VM, SDK install, ...). */
export interface EngineProvider {
    readonly id: string;
    status(): Promise<EngineStatus>;
    /** Starts and health-checks the engine, remediating known failure modes. */
    ensureReady(signal?: AbortSignal): Promise<EngineStatus>;
    restart(signal?: AbortSignal): Promise<EngineStatus>;
    shutdown(): Promise<void>;
}

/** Adapter from the existing Xilinx-style board data to a profile (no behaviour change to that path). */
export function profileFromBoardDefinition(def: BoardDefinition): BoardProfile {
    return {
        id: def.id,
        name: def.name,
        vendor: def.vendor,
        fpga: { family: def.fpga.family, device: def.fpga.device },
        constraintFormat: 'xdc',
        implementationProviderId: 'apio-openxc7',
        programmingProviderId: 'platform-default',
        programmingFormat: 'bit',
        metricLabels: { logic: 'LUTs', registers: 'Flip-flops', memory: 'Block RAM', dsp: 'DSP' },
        ...(def.identification?.usb || def.identification?.productNames
            ? {
                  identification: {
                      ...(def.identification.usb ? { usb: def.identification.usb } : {}),
                      ...(def.identification.productNames ? { productNames: def.identification.productNames } : {}),
                  },
              }
            : {}),
    };
}
