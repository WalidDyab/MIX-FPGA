import type { BoardProfile, EngineStatus } from './types';

export type ReadyState = 'ready' | 'not-ready' | 'unknown';

export interface EnvironmentRow {
    readonly label: string;
    readonly value: string;
}

export interface EnvironmentSummary {
    /** The student-facing rows, in display order. */
    readonly rows: readonly EnvironmentRow[];
    /** Optional "Details" section: the real tools behind the rows. */
    readonly details: readonly EnvironmentRow[];
    readonly allReady: boolean;
}

export interface EnvironmentInputs {
    readonly board: BoardProfile;
    readonly vhdlReady: boolean;
    readonly engine: EngineStatus;
    readonly programmerAvailable: boolean;
    readonly details?: readonly EnvironmentRow[];
}

const word = (ok: boolean): string => (ok ? 'Ready' : 'Not ready');

/** Student-facing environment table: simple words, infrastructure kept in Details. */
export function describeEnvironment(i: EnvironmentInputs): EnvironmentSummary {
    const engineOk = i.engine.state === 'running' && i.engine.problems.every((p) => p.severity !== 'error');
    const engineWord = engineOk ? 'Ready' : i.engine.state === 'stopped' ? 'Starting on first use' : 'Not ready';
    return {
        rows: [
            { label: 'Board', value: i.board.name.replace(/^Terasic\s+/, '') },
            { label: 'FPGA', value: `${i.board.fpga.family} ${i.board.fpga.device}` },
            { label: 'VHDL', value: word(i.vhdlReady) },
            { label: 'Simulation', value: word(i.vhdlReady) },
            { label: 'Implementation Engine', value: engineWord },
            { label: 'Programmer', value: word(i.programmerAvailable) },
        ],
        details: i.details ?? [],
        allReady: i.vhdlReady && engineOk && i.programmerAvailable,
    };
}

// ---------------------------------------------------------------- board environment (boards with their own engine)

/** One tool behind a board, as the Environment page lists it under Details. */
export interface ToolReport {
    readonly id: string;
    readonly label: string;
    readonly found: boolean;
    readonly version?: string;
    readonly detail?: string;
    /** MIX-FPGA ships it (`owned`) or the student/Apple/Altera supplies it (`external`). */
    readonly ownership: 'owned' | 'external';
}

/** The environment of a board that brings its own tools and engine (everything the Environment page shows for it). */
export interface BoardEnvironment {
    readonly boardId: string;
    readonly displayName: string;
    readonly engine: EngineStatus;
    readonly tools: readonly ToolReport[];
    /** MIX-FPGA's own VHDL tools (GHDL, and Yosys for the RTL view) are installed and start. */
    readonly vhdlReady: boolean;
    readonly programmer: { readonly available: boolean; readonly detail: string };
}

/** Result of "Verify Environment": integrity of the owned tools, then a real run of the engine. */
export interface EnvironmentVerification {
    readonly ok: boolean;
    readonly steps: readonly { readonly label: string; readonly ok: boolean; readonly detail?: string }[];
    readonly engine?: EngineStatus;
    /** A covered file differs from the supported release because the user changed it: usable, not the verified configuration. */
    readonly modified?: boolean;
}
