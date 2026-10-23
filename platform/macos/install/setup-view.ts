import type { ComponentState, ComponentStatus, Ownership } from '../../../core/install/model';
import { BOARD_SUPPORT, type BoardState, type BoardSupportEntry, type BoardSupportId, boardState } from './boards';
import { MACOS_CATALOG } from './catalog';
import { EXPECTED_STORAGE } from './engine-config';

/**
 * What the student sees on the Setup page, built from the component states. Four rows, plain words, three actions.
 * Nothing technical appears here (no tool names, no Linux, no paths): that belongs under Details.
 */
export type SetupRowId = 'vhdl-tools' | 'fpga-engine' | 'programmer' | 'hardware';
export type RowState = 'ready' | 'modified' | 'not-installed' | 'working' | 'needs-repair' | 'problem' | 'not-connected' | 'not-checked';

export interface SetupRowView {
    readonly id: SetupRowId;
    readonly label: string;
    readonly state: RowState;
    /** `Ready`, `Not installed`, `Installing…`, … */
    readonly word: string;
    readonly hint?: string;
}

export type SetupActionId = 'install' | 'verify' | 'repair';

export interface BoardRowView {
    readonly id: BoardSupportId;
    readonly name: string;
    readonly state: BoardState;
    /** `Installed`, `Not installed`, `Setup not finished`, … */
    readonly word: string;
    /** The one thing the student can do for this board, if anything. */
    readonly action?: 'install' | 'repair';
}

export interface SetupActionView {
    readonly id: SetupActionId;
    /** For a board's own Install / Repair; absent for the global actions. */
    readonly board?: BoardSupportId;
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
    /** Every board the student chose or has is installed and working. */
    readonly allReady: boolean;
    /** No board support at all yet: the first-run choice applies. */
    readonly fresh: boolean;
    readonly boards: readonly BoardRowView[];
    readonly rows: readonly SetupRowView[];
    readonly actions: readonly SetupActionView[];
    /** Technical list for the Details section only. */
    readonly details: readonly DetailRow[];
}

const WORD: Record<ComponentState, string> = {
    ready: 'Ready',
    modified: 'Modified',
    'not-installed': 'Not installed',
    installing: 'Installing…',
    repairable: 'Needs repair',
    incompatible: 'Not supported',
    failed: 'Needs attention',
};
const ROW_STATE: Record<ComponentState, RowState> = { ready: 'ready', modified: 'modified', 'not-installed': 'not-installed', installing: 'working', repairable: 'needs-repair', incompatible: 'problem', failed: 'problem' };

const BOARD_WORD: Record<BoardState, string> = { installed: 'Installed', modified: 'Installed (modified)', 'not-installed': 'Not installed', installing: 'Installing…', incomplete: 'Setup not finished', 'needs-repair': 'Needs repair', 'not-supported': 'Not supported' };

/** Shown wherever a component has been changed by the student after installing. Not a failure: the files still work. */
export const MODIFIED_HINT = 'This toolchain has been modified and is no longer the verified MIX-FPGA configuration. You can continue using it, or choose Repair to restore the supported version.';

const HINT: Partial<Record<`${Exclude<SetupRowId, 'hardware'>}:${ComponentState}`, string>> = {
    'vhdl-tools:not-installed': 'Check, Simulate and the schematics need these.',
    'vhdl-tools:modified': MODIFIED_HINT,
    'fpga-engine:modified': MODIFIED_HINT,
    'programmer:modified': MODIFIED_HINT,
    'vhdl-tools:repairable': 'Some files are missing or changed. Repair puts them back.',
    'vhdl-tools:incompatible': 'This computer cannot run MIX-FPGA\'s tools.',
    'fpga-engine:not-installed': 'Needed to build for the DE10-Lite. Setup asks for the DE10-Lite support file from your course and for Altera\'s free download.',
    'fpga-engine:repairable': 'Setup was interrupted or something changed. Repair continues where it stopped.',
    'fpga-engine:failed': 'The last attempt did not finish. Repair tries again; Details says why.',
    'fpga-engine:incompatible': 'An existing setup was found that MIX-FPGA cannot use. Details says why.',
    'programmer:not-installed': 'Needed to program the board.',
    'programmer:repairable': 'Repair puts it back.',
};

const OWNER: Record<Ownership, string> = { managed: 'Installed by MIX-FPGA', external: 'Supplied by you (Altera)', system: 'Provided by macOS' };

/** The words of the student-facing view must never include these (they are shown only under Details). */
export const TECHNICAL_TERMS = /limactl|\blima\b|ubuntu|mixfpga-q|rosettad|namespace|\/opt\/|\/mnt\/|\/usr\/|sudo|\bbash\b|\blinux\b|\.sh\b|\bapio\b|openxc7|nextpnr|\bbsp\b/i;

const SEVERITY: ComponentState[] = ['incompatible', 'failed', 'installing', 'repairable', 'not-installed', 'modified', 'ready'];

function worst(statuses: ReadonlyMap<string, ComponentStatus>, ids: readonly string[]): ComponentState {
    const states = ids.map((id) => statuses.get(id)?.state ?? 'not-installed');
    return SEVERITY.find((s) => states.includes(s)) ?? 'not-installed';
}

/**
 * The Setup page. `selected` are the boards the student chose; a board that is (partly) present counts as chosen too.
 * The Environment rows only describe the chosen boards: a Nexys-only computer has no FPGA Engine row at all.
 */
/**
 * What differs between hosts in the Setup page: which boards exist and their components, who owns each component, and the
 * sentences that mention disk use or downloads. The macOS profile is the default; the Windows one lives in platform/windows/install.
 */
export interface SetupViewProfile {
    readonly boards: readonly BoardSupportEntry[];
    readonly catalog: readonly { readonly id: string; readonly label: string; readonly ownership: Ownership }[];
    readonly owner: Readonly<Record<Ownership, string>>;
    /** The sentence under "Install <board> Support", per board. */
    readonly installDetail: (boardId: BoardSupportId) => string;
    /** How a board's state is derived from its components (default: the macOS rule in boards.ts). */
    readonly boardState?: (statuses: readonly ComponentStatus[], board: BoardSupportEntry) => BoardState;
}

export const MACOS_VIEW_PROFILE: SetupViewProfile = {
    boards: BOARD_SUPPORT,
    catalog: MACOS_CATALOG,
    owner: OWNER,
    installDetail: (id) => (id === 'de10-lite' ? `Uses about ${EXPECTED_STORAGE.vmAfterQuartusGB} GB once finished, needs an internet connection and Altera's free download.` : 'Installs the Nexys A7 tools.'),
};

export function buildSetupView(statuses: readonly ComponentStatus[], hardware: HardwareView, selected: readonly BoardSupportId[] = [], profile: SetupViewProfile = MACOS_VIEW_PROFILE): SetupView {
    const by = new Map(statuses.map((s) => [s.id, s]));
    const boards: BoardRowView[] = profile.boards.map((b) => {
        const state = (profile.boardState ?? boardState)(statuses, b);
        const action = state === 'not-installed' || state === 'incomplete' ? 'install' : state === 'needs-repair' || state === 'modified' ? 'repair' : undefined;
        return { id: b.id, name: b.name, state, word: BOARD_WORD[state], ...(action ? { action } : {}) };
    });
    const relevant: BoardSupportEntry[] = profile.boards.filter((b) => selected.includes(b.id) || boards.find((x) => x.id === b.id)!.state !== 'not-installed');
    const fresh = relevant.length === 0;

    const row = (id: Exclude<SetupRowId, 'hardware'>, label: string, ids: readonly string[]): SetupRowView => {
        const st = worst(by, ids);
        const hint = HINT[`${id}:${st}`];
        return { id, label, state: ROW_STATE[st], word: WORD[st], ...(hint ? { hint } : {}) };
    };
    const rows: SetupRowView[] = [];
    if (!fresh) {
        rows.push(row('vhdl-tools', 'VHDL Tools', relevant.flatMap((b) => b.vhdlTools)));
        const engine = relevant.flatMap((b) => b.engine);
        if (engine.length > 0) rows.push(row('fpga-engine', 'FPGA Engine', engine));
        rows.push(row('programmer', 'Programmer', relevant.flatMap((b) => b.programmer)));
    }
    rows.push({ id: 'hardware', label: 'Hardware', state: hardware.state, word: hardware.word, ...(hardware.hint ? { hint: hardware.hint } : {}) });

    const actions: SetupActionView[] = [];
    if (fresh) actions.push({ id: 'install', label: 'Install FPGA Toolchain', detail: 'Choose the boards you will use; only what they need is installed.', primary: true });
    for (const b of boards) {
        if (b.action === 'install') actions.push({ id: 'install', board: b.id, label: `Install ${b.name} Support`, detail: profile.installDetail(b.id), primary: !fresh && relevant.some((r) => r.id === b.id) });
        if (b.action === 'repair') actions.push(b.state === 'modified'
            ? { id: 'repair', board: b.id, label: `Repair ${b.name} Support`, detail: MODIFIED_HINT, primary: false }
            : { id: 'repair', board: b.id, label: `Repair ${b.name} Support`, detail: 'Continues an interrupted setup or puts back anything missing or changed.', primary: true });
    }
    const installedBoards = boards.filter((b) => b.state === 'installed');
    const verifiable = boards.filter((b) => b.state === 'installed' || b.state === 'modified');
    // The page itself only does a quick look, so a file changed inside an installed board cannot show here. Repair checks every file.
    if (installedBoards.length > 0 && !actions.some((a) => a.id === 'repair' && !a.board)) actions.push({ id: 'repair', label: 'Repair', detail: 'Checks every file of the installed boards and puts back anything missing or changed.', primary: false });
    if (verifiable.length > 0) actions.push({ id: 'verify', label: 'Verify Environment', detail: 'Checks every installed part and proves it really works.', primary: false });

    const relevantRows = relevant.map((b) => boards.find((x) => x.id === b.id)!);
    const allReady = !fresh && relevantRows.every((b) => b.state === 'installed');
    const usable = !fresh && relevantRows.every((b) => b.state === 'installed' || b.state === 'modified');
    const headline = fresh ? 'Setup required' : allReady ? 'Ready' : usable ? 'Ready (modified toolchain)' : relevantRows.some((b) => b.state === 'not-supported') ? 'Needs attention' : relevantRows.some((b) => b.state === 'installing') ? 'Installing…' : relevantRows.some((b) => b.state === 'needs-repair') ? 'Needs repair' : 'Setup not finished';

    const details: DetailRow[] = profile.catalog.map((c) => {
        const st = by.get(c.id);
        return { label: c.label, word: WORD[st?.state ?? 'not-installed'], owner: profile.owner[st?.ownership ?? c.ownership], ...(st?.version ? { version: st.version } : {}), ...(st?.detail ? { note: st.detail } : {}) };
    });
    return { headline, allReady, fresh, boards, rows, actions, details };
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
