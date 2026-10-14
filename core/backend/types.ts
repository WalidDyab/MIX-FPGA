/**
 * MIX-FPGA multi-board backend contracts (Phase 1 proposal, proven by the DE10-Lite backend).
 *
 * These are additive: the Nexys A7 path keeps using core/implementation, core/programming and
 * core/workflow unchanged. A later phase makes the Nexys A7 path implement these same contracts
 * through thin adapters so the VS Code UI can call one generic Check / Build / Detect / Program.
 */
import type { BoardDefinition } from '../board/types';
import type { Diagnostic, LogRef } from '../results/diagnostic';
import type { BoardDetectionResult, ProgrammingResult } from '../programming/types';
import type { Project } from '../project/types';
import type { BuildProgress, BuildResult } from '../workflow/types';

// ---------------------------------------------------------------- board profile

/** Constraint file family a board's implementation backend consumes. */
export type ConstraintFormat = 'xdc' | 'qsf-sdc';

/**
 * A programming file a build can produce and a programmer can load. `bit` = canonical bitstream, `svf` = serial vector
 * file (openFPGALoader), `sof` = Quartus SRAM object file (quartus_pgm). A build may produce several; the host's
 * ProgrammingProvider says which one it loads (`artifactFormat`).
 */
export type ProgrammingFormat = 'bit' | 'svf' | 'sof';

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
    /** Short student-facing name (`DE10-Lite`, `Nexys A7-100T`). */
    readonly displayName: string;
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
    /** The board family's default programming file (`bit` = the original bitstream flow). A host's programmer may load another format of the same build. */
    readonly programmingFormat: ProgrammingFormat;
    /** Key the board's programming backend uses for this board (opaque to the core). */
    readonly programmerBoardKey?: string;
    readonly metricLabels: MetricLabels;
    /** Host platforms this board's backend supports; absent = the base flow's hosts. */
    readonly hosts?: readonly string[];
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
    /** `generated`: no file; the constraints are produced from the project's pin mapping (original Nexys flow). */
    readonly origin?: 'files' | 'generated';
}

/** Finds and validates the constraint files that belong to one board. Never writes to the project. */
export interface ConstraintProvider {
    readonly format: ConstraintFormat;
    /** `exclude`: project-relative files the student removed from the project (they stay on disk and are ignored). */
    collect(projectDir: string, exclude?: readonly string[]): Promise<ConstraintSet>;
    validate(set: ConstraintSet, board: BoardProfile, projectDir?: string): Promise<readonly Diagnostic[]>;
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

/** The programming artifact of the last good build and what it was built from. */
export interface ProgrammingArtifactInfo extends ProgrammingArtifactRef {
    readonly modifiedMs: number;
    /** Board the build was for; absent for artifacts of the original flow. */
    readonly boardId?: string;
    /** Hashes of the project files the build read (project-relative path -> sha256); absent for the original flow. */
    readonly inputs?: Readonly<Record<string, string>>;
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
    /** The board's own metric names, so a metric the tool did not report can still be listed by name. */
    readonly labels?: MetricLabels;
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
    /** The artifact this host's programmer loads. */
    readonly programmingArtifact?: ProgrammingArtifactRef;
    /** Every programming file the build produced, typed (a DE10 Quartus build yields `.sof` and `.svf`). */
    readonly programmingArtifacts?: readonly ProgrammingArtifactRef[];
    readonly rawReports: readonly RawReport[];
    readonly logs: readonly LogRef[];
    readonly stageDurationsMs: Readonly<Partial<Record<BuildStage, number>>>;
    readonly durationMs: number;
    /** The board family's own full result for UI code that already understands it (the original Nexys flow). */
    readonly native?: BuildResult;
}

// ---------------------------------------------------------------- implementation provider

export type BuildProgressEvent =
    | { readonly kind: 'stage-started'; readonly stage: BuildStage }
    | { readonly kind: 'stage-finished'; readonly stage: BuildStage; readonly ok: boolean };

export interface BuildRequest {
    readonly projectDir: string;
    /** The already-loaded project, when the caller has it (avoids re-reading the project file). */
    readonly project?: Project;
    readonly board: BoardProfile;
    /** Top-level entity; defaults to the provider's convention. */
    readonly top?: string;
    /** The project's VHDL sources (project-relative, compile order). Absent: the provider's folder convention. */
    readonly sources?: readonly string[];
    readonly signal?: AbortSignal;
    readonly onProgress?: (event: BuildProgressEvent) => void;
    /** Providers that wrap a flow with a richer progress stream forward it here unchanged (the original Nexys flow). */
    readonly nativeProgress?: (progress: BuildProgress) => void;
    /** Live tool output (stdout and stderr) for a console. */
    readonly onOutput?: (text: string) => void;
}

/** Synthesis -> place and route -> timing -> programming artifact for one family of boards. */
export interface ImplementationProvider {
    readonly id: string;
    /**
     * True for a provider that runs validation and Check itself and takes the project's single-flight
     * claim (the original Nexys flow). Others get Check and the claim from the caller.
     */
    readonly selfContained?: boolean;
    supports(board: BoardProfile): boolean;
    build(request: BuildRequest): Promise<NormalizedBuildResult>;
    /** The programming artifact of the project's last good build, if any. */
    artifactFor?(projectDir: string, top: string, format?: ProgrammingFormat): Promise<ProgrammingArtifactInfo | undefined>;
    /** The project files an artifact would be built from, hashed now (to detect a stale artifact). */
    currentInputs?(projectDir: string, sources: readonly string[], exclude?: readonly string[]): Promise<Readonly<Record<string, string>>>;
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
    /** The original flow's own detection result (board list with selectors), kept exact for its UI. */
    readonly native?: BoardDetectionResult & { readonly configured: boolean };
}

export type ProgramStatus = 'programmed' | 'failed' | 'cancelled' | 'rejected';

export interface ProgramRequest {
    readonly artifact: ProgrammingArtifactRef;
    readonly board: BoardProfile;
    /** Which board to program when several identical ones are connected. */
    readonly serialNumber?: string;
    /** A private directory the provider may write derived files into. */
    readonly workDir?: string;
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
    /** The original flow's own result, kept exact for its UI. */
    readonly native?: ProgrammingResult;
}

export interface ProgrammingProvider {
    readonly id: string;
    /** The programming file this provider loads; absent = the board's `programmingFormat`. */
    readonly artifactFormat?: ProgrammingFormat;
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

const DEFAULT_LABELS: MetricLabels = { logic: 'LUTs', registers: 'Flip-Flops', memory: 'BRAM (36 Kb)', dsp: 'DSP' };

/**
 * Board profile from board data. A board without a `backend` block is the original open-source
 * flow: XDC constraints, the openxc7 implementation, the platform programmer and a bitstream.
 */
export function profileFromBoardDefinition(def: BoardDefinition): BoardProfile {
    const be = def.backend;
    const idcode = be?.jtagIdcode !== undefined ? Number.parseInt(be.jtagIdcode, 16) : undefined;
    return {
        id: def.id,
        name: def.name,
        displayName: def.displayName ?? def.name,
        vendor: def.vendor,
        fpga: { family: def.fpga.family, device: def.fpga.device, ...(idcode !== undefined && Number.isFinite(idcode) ? { jtagIdcode: idcode } : {}) },
        constraintFormat: be?.constraints ?? 'xdc',
        implementationProviderId: be?.implementation ?? 'openxc7',
        programmingProviderId: be?.programming ?? 'platform-default',
        programmingFormat: be?.programmingFormat ?? 'bit',
        ...(be?.programmerBoardKey ? { programmerBoardKey: be.programmerBoardKey } : {}),
        metricLabels: be?.metricLabels ?? DEFAULT_LABELS,
        ...(be?.hosts ? { hosts: be.hosts } : {}),
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
