import type { ComponentId, ComponentState, ComponentStatus, Ownership } from '../../../core/install/model';

/** The student sees three rows; everything else is detail. */
export type StudentGroup = 'vhdl-tools' | 'fpga-engine' | 'programmer';

export interface CatalogEntry {
    readonly id: ComponentId;
    readonly label: string;
    /** Default ownership; an inspection may report a different one (for example an unadopted external copy). */
    readonly ownership: Ownership;
    readonly group: StudentGroup;
    /** Must be ready before this one can be installed. */
    readonly requires: readonly ComponentId[];
}

/**
 * The ten components of the macOS setup. `ownership` says who is responsible for each:
 *  managed  MIX-FPGA installs, verifies and repairs it
 *  external supplied by the student under the vendor's own licence (Altera); MIX-FPGA installs it only on their explicit approval
 *  system   provided by macOS (Apple's Rosetta); MIX-FPGA detects it and can only start Apple's own installer on the student's request
 */
export const MACOS_CATALOG: readonly CatalogEntry[] = [
    { id: 'toolchain', label: 'MIX-FPGA Toolchain', ownership: 'managed', group: 'vhdl-tools', requires: [] },
    { id: 'ghdl', label: 'GHDL', ownership: 'managed', group: 'vhdl-tools', requires: [] },
    { id: 'yosys', label: 'Yosys', ownership: 'managed', group: 'vhdl-tools', requires: [] },
    { id: 'openfpgaloader', label: 'openFPGALoader', ownership: 'managed', group: 'programmer', requires: [] },
    { id: 'lima', label: 'Lima', ownership: 'managed', group: 'fpga-engine', requires: [] },
    { id: 'rosetta', label: 'Rosetta', ownership: 'system', group: 'fpga-engine', requires: [] },
    { id: 'linux-vm', label: 'Linux VM', ownership: 'managed', group: 'fpga-engine', requires: ['toolchain', 'rosetta'] },
    { id: 'quartus', label: 'Quartus Prime Lite', ownership: 'external', group: 'fpga-engine', requires: ['linux-vm'] },
    { id: 'max10', label: 'MAX 10 support', ownership: 'external', group: 'fpga-engine', requires: ['quartus'] },
    { id: 'programmer', label: 'Programmer', ownership: 'managed', group: 'programmer', requires: ['openfpgaloader'] },
];

const WORD: Record<ComponentState, string> = {
    ready: 'Ready',
    'not-installed': 'Not installed',
    installing: 'Installing…',
    repairable: 'Needs repair',
    incompatible: 'Not supported',
    failed: 'Failed',
};

const SEVERITY: ComponentState[] = ['incompatible', 'failed', 'installing', 'repairable', 'not-installed', 'ready'];

export interface StudentRow {
    readonly group: StudentGroup;
    readonly label: string;
    readonly state: ComponentState;
    readonly word: string;
}

const GROUP_LABEL: Record<StudentGroup, string> = { 'vhdl-tools': 'VHDL Tools', 'fpga-engine': 'FPGA Engine', programmer: 'Programmer' };

/** Three plain rows for the Setup page: each takes the worst state among its components. */
export function studentRows(statuses: readonly ComponentStatus[]): StudentRow[] {
    const byId = new Map(statuses.map((s) => [s.id, s]));
    return (['vhdl-tools', 'fpga-engine', 'programmer'] as const).map((group) => {
        const states = MACOS_CATALOG.filter((c) => c.group === group).map((c) => byId.get(c.id)?.state ?? 'not-installed');
        const state = SEVERITY.find((s) => states.includes(s)) ?? 'not-installed';
        return { group, label: GROUP_LABEL[group], state, word: WORD[state] };
    });
}
