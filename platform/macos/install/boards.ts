import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ComponentId, ComponentState, ComponentStatus } from '../../../core/install/model';
import { writeFileAtomic } from '../../../core/util/atomic-write';

/** The boards MIX-FPGA supports. Exactly these two; each is a set of Setup components, installed only when chosen. */
export type BoardSupportId = 'nexys-a7-100t' | 'de10-lite';

export interface BoardSupportEntry {
    readonly id: BoardSupportId;
    readonly name: string;
    /** The install steps this board needs (the Setup engine adds what they require). */
    readonly steps: readonly ComponentId[];
    /** Every component that must be ready for the board to count as installed. */
    readonly components: readonly ComponentId[];
    /** Components behind the student-facing rows, for this board. */
    readonly vhdlTools: readonly ComponentId[];
    readonly engine: readonly ComponentId[];
    readonly programmer: readonly ComponentId[];
}

export const BOARD_SUPPORT: readonly BoardSupportEntry[] = [
    // Everything the Nexys A7 needs is in one validated bundle: VHDL tools, the openXC7 build and the programmer. No engine.
    { id: 'nexys-a7-100t', name: 'Nexys A7-100T', steps: ['nexys-toolchain'], components: ['nexys-toolchain'], vhdlTools: ['nexys-toolchain'], engine: [], programmer: ['nexys-toolchain'] },
    {
        id: 'de10-lite',
        name: 'DE10-Lite',
        steps: ['toolchain', 'rosetta', 'linux-vm', 'quartus'],
        components: ['toolchain', 'ghdl', 'yosys', 'openfpgaloader', 'lima', 'rosetta', 'linux-vm', 'quartus', 'max10', 'programmer'],
        vhdlTools: ['toolchain', 'ghdl', 'yosys'],
        engine: ['lima', 'rosetta', 'linux-vm', 'quartus', 'max10'],
        programmer: ['openfpgaloader', 'programmer'],
    },
];

export const boardEntry = (id: string): BoardSupportEntry | undefined => BOARD_SUPPORT.find((b) => b.id === id);
export const isBoardSupportId = (id: unknown): id is BoardSupportId => typeof id === 'string' && BOARD_SUPPORT.some((b) => b.id === id);

export type BoardState = 'installed' | 'not-installed' | 'installing' | 'incomplete' | 'needs-repair' | 'not-supported';

/** One board's support, derived from its components (never stored). */
export function boardState(statuses: readonly ComponentStatus[], board: BoardSupportEntry): BoardState {
    const by = new Map(statuses.map((s) => [s.id, s.state]));
    const states: ComponentState[] = board.components.map((c) => by.get(c) ?? 'not-installed');
    if (states.every((s) => s === 'ready')) return 'installed';
    if (states.includes('installing')) return 'installing';
    if (states.includes('incompatible')) return 'not-supported';
    // A board whose own steps are all untouched is not installed, even if a system part (Rosetta) happens to be there.
    const own = board.steps.filter((s) => s !== 'rosetta').map((s) => by.get(s) ?? 'not-installed');
    if (own.every((s) => s === 'not-installed')) return 'not-installed';
    if (states.some((s) => s === 'repairable' || s === 'failed')) return 'needs-repair';
    return 'incomplete';
}

/** Which boards the student chose (persisted so an interrupted setup continues with the same choice). */
export class BoardSelectionStore {
    constructor(private readonly file: string) {}
    async read(): Promise<BoardSupportId[]> {
        try {
            const j = JSON.parse(await readFile(this.file, 'utf8')) as { schemaVersion?: number; selected?: unknown[] };
            return j.schemaVersion === 1 && Array.isArray(j.selected) ? j.selected.filter(isBoardSupportId) : [];
        } catch {
            return [];
        }
    }
    async add(ids: readonly BoardSupportId[]): Promise<BoardSupportId[]> {
        const have = await this.read();
        const merged = BOARD_SUPPORT.map((b) => b.id).filter((id) => have.includes(id) || ids.includes(id));
        await mkdir(dirname(this.file), { recursive: true });
        await writeFileAtomic(this.file, `${JSON.stringify({ schemaVersion: 1, selected: merged }, null, 2)}\n`);
        return merged;
    }
}
