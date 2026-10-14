import type { ComponentState, ComponentStatus, Ownership } from '../../../core/install/model';
import { MACOS_CATALOG, studentRows, type StudentGroup } from './catalog';
import { EXPECTED_STORAGE } from './engine-config';

/**
 * What the student sees on the Setup page, built from the component states. Four rows, plain words, three actions.
 * Nothing technical appears here (no tool names, no Linux, no paths): that belongs under Details.
 */
export type SetupRowId = 'vhdl-tools' | 'fpga-engine' | 'programmer' | 'hardware';
export type RowState = 'ready' | 'not-installed' | 'working' | 'needs-repair' | 'problem' | 'not-connected' | 'not-checked';

export interface SetupRowView {
    readonly id: SetupRowId;
    readonly label: string;
    readonly state: RowState;
    /** `Ready`, `Not installed`, `Installing…`, … */
    readonly word: string;
    readonly hint?: string;
}

export type SetupActionId = 'install' | 'verify' | 'repair';

export interface SetupActionView {
    readonly id: SetupActionId;
    readonly label: string;
    readonly detail: string;
    readonly primary: boolean;
}

export interface DetailRow {
    readonly label: string;
    readonly word: string;
    readonly owner: string;
    readonly version?: string;
    readonly note?: string;
}

export interface HardwareView {
    readonly state: 'ready' | 'not-connected' | 'not-checked';
    /** e.g. `DE10-Lite` or `Not connected`. */
    readonly word: string;
    readonly hint?: string;
}

export interface SetupView {
    readonly headline: string;
    readonly allReady: boolean;
    readonly rows: readonly SetupRowView[];
    readonly actions: readonly SetupActionView[];
    /** Technical list for the Details section only. */
    readonly details: readonly DetailRow[];
}

const WORD: Record<ComponentState, string> = {
    ready: 'Ready',
    'not-installed': 'Not installed',
    installing: 'Installing…',
    repairable: 'Needs repair',
    incompatible: 'Not supported',
    failed: 'Needs attention',
};
const ROW_STATE: Record<ComponentState, RowState> = { ready: 'ready', 'not-installed': 'not-installed', installing: 'working', repairable: 'needs-repair', incompatible: 'problem', failed: 'problem' };

const HINT: Partial<Record<`${StudentGroup}:${ComponentState}`, string>> = {
    'vhdl-tools:not-installed': 'Check, Simulate and the schematics need these.',
    'vhdl-tools:repairable': 'Some files are missing or changed. Repair puts them back.',
    'vhdl-tools:incompatible': 'This computer cannot run MIX-FPGA\'s tools.',
    'fpga-engine:not-installed': 'Needed to build for the DE10-Lite. Setup also asks for Altera\'s free download.',
    'fpga-engine:repairable': 'Setup was interrupted or something changed. Repair continues where it stopped.',
    'fpga-engine:failed': 'The last attempt did not finish. Repair tries again; Details says why.',
    'fpga-engine:incompatible': 'An existing setup was found that MIX-FPGA cannot use. Details says why.',
    'programmer:not-installed': 'Needed to program the board.',
    'programmer:repairable': 'Repair puts it back.',
};

const OWNER: Record<Ownership, string> = { managed: 'Installed by MIX-FPGA', external: 'Supplied by you (Altera)', system: 'Provided by macOS' };

/** The words of the student-facing view must never include these (they are shown only under Details). */
export const TECHNICAL_TERMS = /limactl|\blima\b|ubuntu|mixfpga-q|rosettad|namespace|\/opt\/|\/mnt\/|\/usr\/|sudo|\bbash\b|\blinux\b|\.sh\b/i;

export function buildSetupView(statuses: readonly ComponentStatus[], hardware: HardwareView): SetupView {
    const rows: SetupRowView[] = studentRows(statuses).map((r) => {
        const hint = HINT[`${r.group}:${r.state}`];
        return { id: r.group, label: r.label, state: ROW_STATE[r.state], word: WORD[r.state], ...(hint ? { hint } : {}) };
    });
    rows.push({ id: 'hardware', label: 'Hardware', state: hardware.state, word: hardware.word, ...(hardware.hint ? { hint: hardware.hint } : {}) });

    const by = new Map(statuses.map((s) => [s.id, s]));
    const states = MACOS_CATALOG.map((c) => by.get(c.id)?.state ?? 'not-installed');
    const some = (s: ComponentState) => states.includes(s);
    const allReady = states.every((s) => s === 'ready');
    const anyInstalled = states.some((s) => s === 'ready' || s === 'repairable');

    const actions: SetupActionView[] = [];
    if (some('not-installed')) {
        actions.push({ id: 'install', label: 'Install FPGA Toolchain', detail: `Installs everything the DE10-Lite needs (about ${EXPECTED_STORAGE.vmAfterQuartusGB} GB on this computer once finished; an internet connection is needed).`, primary: !anyInstalled });
    }
    if (some('repairable') || some('failed')) {
        actions.push({ id: 'repair', label: 'Repair', detail: 'Continues an interrupted setup or puts back anything missing or changed.', primary: true });
    }
    if (anyInstalled || allReady) actions.push({ id: 'verify', label: 'Verify Environment', detail: 'Checks every part and proves the FPGA engine really builds.', primary: allReady });

    const headline = allReady ? 'Ready' : some('incompatible') ? 'Needs attention' : some('installing') ? 'Installing…' : some('failed') ? 'Needs attention' : some('repairable') ? 'Needs repair' : 'Setup required';

    const details: DetailRow[] = MACOS_CATALOG.map((c) => {
        const s = by.get(c.id);
        return { label: c.label, word: WORD[s?.state ?? 'not-installed'], owner: OWNER[s?.ownership ?? c.ownership], ...(s?.version ? { version: s.version } : {}), ...(s?.detail ? { note: s.detail } : {}) };
    });
    return { headline, allReady, rows, actions, details };
}

/** Student wording for a failed step; the raw message always goes to the Console / Details. */
export function studentFailure(code: string): string {
    switch (code) {
        case 'INSUFFICIENT_DISK':
            return 'There is not enough free space on this computer.';
        case 'IMAGE_DOWNLOAD_FAILED':
        case 'GUEST_NETWORK':
            return 'Setup needs an internet connection. Connect and choose Repair to continue where it stopped.';
        case 'LIMA_SOCKET_PATH_TOO_LONG':
            return 'MIX-FPGA cannot set up the FPGA engine under this account name yet.';
        case 'FILES_SWAPPED':
        case 'WRONG_FILE':
        case 'FILE_HASH_MISMATCH':
        case 'FILE_DIFFERENT_VERSION':
        case 'FILE_NOT_FOUND':
            return 'The file you chose is not the one Setup needs. Download it again from Altera.';
        case 'LICENSE_UNVERIFIED':
        case 'LICENSE_NOT_AVAILABLE':
        case 'LICENSE_NOT_SHOWN':
            return 'The licence could not be shown, so nothing was installed.';
        case 'VERSION_MISMATCH':
        case 'MAX10_MISSING':
        case 'DEVICE_MISSING':
        case 'TOOLS_MISSING':
        case 'SMOKE_TEST_FAILED':
            return 'The installed FPGA software did not pass its check.';
        case 'CANCELLED':
            return 'Setup was cancelled. Choose Repair to continue.';
        case 'RECREATE_NEEDS_CONFIRMATION':
            return 'The FPGA engine is damaged. MIX-FPGA will not remove it without your confirmation.';
        default:
            return 'A part of the setup did not finish. Choose Repair to try again; Details has more.';
    }
}
