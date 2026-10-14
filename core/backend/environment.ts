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
