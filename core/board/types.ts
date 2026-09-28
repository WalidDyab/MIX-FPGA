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
}

/** Physical identity hints a programmer provider may use to recognise the board. */
export interface BoardIdentification {
    readonly usb?: { readonly vendorId: string; readonly productId: string };
    /** Product-name fragments a programming backend may report for this board. */
    readonly productNames?: readonly string[];
}

export interface BoardDefinition {
    readonly schemaVersion: 1;
    readonly id: string;
    readonly name: string;
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
