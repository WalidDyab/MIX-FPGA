import type { BoardDetectionResult, DetectedBoard, Diagnostic } from '../../core';

/**
 * - `unknown`: not detected yet
 * - `detecting`: detection running
 * - `unavailable`: no programmer is configured on this machine
 * - `none` / `one` / `many`: number of boards found
 */
export type HardwareStatus = 'unknown' | 'detecting' | 'unavailable' | 'none' | 'one' | 'many';

export interface HardwareState {
    readonly status: HardwareStatus;
    readonly boards: readonly DetectedBoard[];
    /** Serial number chosen by the student when several boards are connected. */
    readonly selectedSerial?: string;
    /** Structured diagnostics from detection (warnings such as an unpowered JTAG chain). */
    readonly diagnostics: readonly Diagnostic[];
}

export const initialHardware: HardwareState = { status: 'unknown', boards: [], diagnostics: [] };

export function detectionStarted(s: HardwareState): HardwareState {
    return { ...s, status: 'detecting' };
}

/** Applies a detection result; a previous choice survives only if that board is still connected. */
export function applyDetection(prev: HardwareState, result: BoardDetectionResult & { readonly configured: boolean }): HardwareState {
    const diagnostics = result.diagnostics.filter((d) => d.severity !== 'info');
    if (!result.configured) return { status: 'unavailable', boards: [], diagnostics };
    const boards = result.boards;
    const status: HardwareStatus = boards.length === 0 ? 'none' : boards.length === 1 ? 'one' : 'many';
    const keep = prev.selectedSerial !== undefined && boards.some((b) => b.serialNumber === prev.selectedSerial);
    return { status, boards, diagnostics, ...(keep ? { selectedSerial: prev.selectedSerial } : {}) };
}

export function selectBoard(s: HardwareState, serial: string): HardwareState {
    if (!s.boards.some((b) => b.serialNumber === serial)) return s;
    return { ...s, selectedSerial: serial };
}

export type ProgramTarget =
    | { readonly kind: 'single' }
    | { readonly kind: 'selected'; readonly serial: string }
    | { readonly kind: 'choose'; readonly boards: readonly DetectedBoard[] }
    | { readonly kind: 'none' };

/**
 * Which board Program should use. With several boards and no choice made,
 * the student must choose: NexysVHDL never picks one silently (the shared
 * ProgrammingService refuses ambiguity too).
 */
export function resolveProgramTarget(s: HardwareState): ProgramTarget {
    if (s.boards.length === 0) return { kind: 'none' };
    if (s.boards.length === 1) return { kind: 'single' };
    if (s.selectedSerial !== undefined && s.boards.some((b) => b.serialNumber === s.selectedSerial)) return { kind: 'selected', serial: s.selectedSerial };
    return { kind: 'choose', boards: s.boards };
}

/** One-line description for the Hardware view and status bar. */
export function hardwareHeadline(s: HardwareState, boardName = 'Nexys A7'): string {
    switch (s.status) {
        case 'unknown':
            return 'Not checked yet';
        case 'detecting':
            return 'Looking for boards…';
        case 'unavailable':
            return 'Programmer not set up';
        case 'none':
            return `No ${boardName} detected`;
        case 'one':
            return s.boards[0]!.productName ?? boardName;
        case 'many':
            return `${s.boards.length} ${boardName} boards`;
    }
}
