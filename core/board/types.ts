/**
 * Data-driven board description, loaded from boards/<id>/board.json.
 * Orchestration code never hard-codes pins; new resources (more switches,
 * LED buses, seven-segment, UART, Pmods) are added as data only.
 */

/** Open-ended so new kinds can be added in data without code changes. */
export type BoardResourceKind = 'clock' | 'button' | 'switch' | 'led' | (string & {});

export interface ClockSpec {
    readonly frequencyHz: number;
}

export interface BoardResource {
    /** Logical name used in project pin mappings, e.g. `CLK100MHZ`, `LED0`. */
    readonly id: string;
    readonly kind: BoardResourceKind;
    readonly description?: string;
    /**
     * Package pins, index 0 = bit 0. One pin for a scalar resource;
     * N pins for an N-bit bus (e.g. a future 16-bit `LED` resource).
     */
    readonly pins: readonly string[];
    readonly ioStandard: string;
    /** Present only for clock inputs; drives create_clock generation. */
    readonly clock?: ClockSpec;
}

export interface FpgaSpec {
    readonly family: string;
    /** Full orderable device, e.g. `XC7A100T-1CSG324C`. */
    readonly device: string;
    /** Implementation part name used by the open toolchain, e.g. `xc7a100tcsg324-1`. */
    readonly part: string;
    /** Engineering capacity of this device in this package (vendor data sheet), for utilization reports. */
    readonly capacity?: DeviceCapacity;
}

/**
 * Device resources as the FPGA vendor counts them (what students compare
 * with Vivado). Placer-internal counts can differ: nextpnr-xilinx models each
 * 7-series LUT6 site as two SLICE_LUTX bels and reports every package pad.
 */
export interface DeviceCapacity {
    /** 6-input LUTs (4 per slice on 7-series). */
    readonly luts: number;
    readonly flipFlops: number;
    readonly slices?: number;
    /** 36 Kb block RAMs (each usable as two 18 Kb). */
    readonly bram36: number;
    readonly dsp: number;
    /** User I/O pins of this package. */
    readonly userIo: number;
    readonly globalClockBuffers?: number;
    /** Where the numbers come from (data sheet and table). */
    readonly source: string;
}

/** Physical identity hints a programmer provider may use to recognise the board. */
export interface BoardIdentification {
    readonly usb?: { readonly vendorId: string; readonly productId: string };
    /** Product-name fragments a programming backend may report for this board. */
    readonly productNames?: readonly string[];
}

/** Constraint file family a board's implementation backend consumes. */
export type BoardConstraintFormat = 'xdc' | 'qsf-sdc';

/**
 * How a board is built and programmed (MIX-FPGA multi-board). Optional: a board
 * without it is the original open-source XDC flow (xdc, openxc7, platform programmer, bitstream).
 * Provider ids are looked up in the backend router; the UI never branches on them.
 */
export interface BoardBackend {
    readonly constraints: BoardConstraintFormat;
    readonly implementation: string;
    readonly programming: string;
    readonly programmingFormat: 'bit' | 'svf';
    /** Key the board's programming backend uses for this board (opaque to the core). */
    readonly programmerBoardKey?: string;
    /** JTAG IDCODE of the FPGA as hex text, e.g. `0x031050dd`. */
    readonly jtagIdcode?: string;
    /** Student-facing metric names in this vendor's words. */
    readonly metricLabels?: { readonly logic: string; readonly registers: string; readonly memory: string; readonly dsp: string };
    /** Host platforms this board's backend supports (e.g. `macos-arm64`); absent = every host the base flow supports. */
    readonly hosts?: readonly string[];
}

export interface BoardDefinition {
    readonly schemaVersion: 1;
    readonly id: string;
    readonly name: string;
    /** Short student-facing name (e.g. `DE10-Lite`); falls back to `name`. */
    readonly displayName?: string;
    readonly backend?: BoardBackend;
    readonly vendor: string;
    readonly fpga: FpgaSpec;
    /** Identifiers used by specific backends, keyed by backend name (e.g. `apio`). */
    readonly backendIds: Readonly<Record<string, string>>;
    readonly identification?: BoardIdentification;
    readonly resources: readonly BoardResource[];
}

export function findResource(board: BoardDefinition, id: string): BoardResource | undefined {
    return board.resources.find((r) => r.id === id);
}

export function resourceWidth(resource: BoardResource): number {
    return resource.pins.length;
}
