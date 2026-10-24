import type { ComponentStatus, Ownership } from '../../../core/install/model';
import { type BoardState, type BoardSupportEntry, boardState } from '../../macos/install/boards';
import type { SetupViewProfile } from '../../macos/install/setup-view';

/**
 * The two boards MIX-FPGA supports on Windows, each a set of Setup components installed only when chosen. The macOS components
 * (Lima, Rosetta, the Linux engine, openFPGALoader) do not exist here: the DE10-Lite builds with Altera's own Windows Quartus
 * and programs with its `quartus_pgm`, through the standard Altera USB-Blaster driver, which MIX-FPGA never changes.
 */
export const WINDOWS_BOARD_SUPPORT: readonly BoardSupportEntry[] = [
    // Everything the Nexys A7 needs from MIX-FPGA is in one validated bundle (VHDL tools and the openXC7 build). Its programmer is Digilent's.
    { id: 'nexys-a7-100t', name: 'Nexys A7-100T', steps: ['nexys-toolchain'], components: ['nexys-toolchain'], vhdlTools: ['nexys-toolchain'], engine: [], programmer: ['digilent-adept'] },
    {
        id: 'de10-lite',
        name: 'DE10-Lite',
        steps: ['toolchain', 'quartus'],
        components: ['toolchain', 'ghdl', 'yosys', 'quartus', 'max10'],
        vhdlTools: ['toolchain', 'ghdl', 'yosys'],
        engine: ['quartus', 'max10'],
        programmer: ['programmer'],
    },
];

export interface WindowsCatalogEntry {
    readonly id: string;
    readonly label: string;
    /** Who is responsible: MIX-FPGA (`managed`), the student/vendor (`external`), or Windows (`system`). */
    readonly ownership: Ownership;
}

/**
 * Every component of the Windows setup. Shown only under Details. `usb-driver` and `digilent-adept` are looked at, never installed or
 * changed by MIX-FPGA: they are the vendors' and Windows' own.
 */
export const WINDOWS_CATALOG: readonly WindowsCatalogEntry[] = [
    { id: 'nexys-toolchain', label: 'Nexys A7 tools (GHDL, Yosys, openXC7)', ownership: 'managed' },
    { id: 'digilent-adept', label: 'Digilent USB/JTAG support', ownership: 'external' },
    { id: 'toolchain', label: 'MIX-FPGA Toolchain', ownership: 'managed' },
    { id: 'ghdl', label: 'GHDL', ownership: 'managed' },
    { id: 'yosys', label: 'Yosys', ownership: 'managed' },
    { id: 'quartus', label: 'Quartus Prime Lite', ownership: 'external' },
    { id: 'max10', label: 'MAX 10 support', ownership: 'external' },
    { id: 'programmer', label: 'Quartus Programmer', ownership: 'external' },
    { id: 'usb-driver', label: 'Altera USB-Blaster driver', ownership: 'system' },
];

/**
 * A Windows board counts as "touched" only by what MIX-FPGA itself manages: Altera's Quartus, Digilent's utilities and Windows'
 * driver are the student's and the vendors' own, and being on the computer already (the development machine, a lab image) does
 * not mean the student chose that board. Everything else is the same rule as on macOS.
 */
export function windowsBoardState(statuses: readonly ComponentStatus[], board: BoardSupportEntry): BoardState {
    const managed = new Set(WINDOWS_CATALOG.filter((c) => c.ownership === 'managed').map((c) => c.id));
    const mine = board.components.filter((c) => managed.has(c));
    const by = new Map(statuses.map((s) => [s.id, s.state]));
    if (mine.length > 0 && mine.every((c) => (by.get(c) ?? 'not-installed') === 'not-installed')) {
        const all = board.components.map((c) => by.get(c) ?? 'not-installed');
        // Not touched by MIX-FPGA, unless a part is in a state that needs attention or is being installed.
        if (!all.includes('installing') && !all.includes('incompatible')) return 'not-installed';
    }
    return boardState(statuses, board);
}

/** Digilent's page for the free Adept Runtime and Utilities (the Nexys A7 programmer MIX-FPGA uses on Windows). */
export const DIGILENT_ADEPT_URL = 'https://digilent.com/reference/software/adept/start';

export const WINDOWS_VIEW_PROFILE: SetupViewProfile = {
    boardState: windowsBoardState,
    boards: WINDOWS_BOARD_SUPPORT,
    catalog: WINDOWS_CATALOG,
    owner: { managed: 'Installed by MIX-FPGA', external: 'Supplied by you (Altera, Digilent)', system: 'Provided by Windows' },
    hints: { 'programmer:not-installed': "Needed only to program the Nexys A7: install Digilent's free Adept Runtime and Adept Utilities (the link is in this page). Everything else works without it." },
    links: { 'programmer:not-installed': { label: 'Get Digilent Adept (free) from Digilent', url: DIGILENT_ADEPT_URL } },
    installDetail: (id) => (id === 'de10-lite' ? "Uses about 9 GB for Altera's free software (it may already be on this computer) and asks Windows for permission once." : 'Installs the Nexys A7 tools (about 3 GB).'),
};

/** The words of the student-facing Windows view must never include these (they are shown only under Details). */
export const TECHNICAL_TERMS_WINDOWS = /quartus_\w+|powershell|\.cmd\b|\.ps1\b|\.exe\b|\.tcl\b|%\w+%|[A-Za-z]:\\|\\\\|\bdriver\b|\bjtag\b|\bUAC\b|\bregistry\b|--accept|\bnpm\b/i;

/** Student wording for a failed Windows step; the raw message always goes to the Console / Details. */
export function windowsStudentFailure(code: string): string {
    switch (code) {
        case 'INSUFFICIENT_DISK':
            return 'There is not enough free space on this computer.';
        case 'ELEVATION_DECLINED':
            return 'Windows did not give permission, so Quartus was not installed. Choose Install again when you are ready to allow it.';
        case 'ELEVATION_FAILED':
        case 'HELPER_TIMEOUT':
            return 'Windows could not start the installation. Choose Repair to try again; Details has more.';
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
        case 'PART_CHECK_FAILED':
            return 'The installed FPGA software did not pass its check.';
        case 'QUARTUS_INSTALL_FAILED':
            return "Altera's installer did not finish. Choose Repair to try again; Details has more.";
        case 'PATH_TOO_LONG':
            return 'MIX-FPGA cannot set up here yet: the folder it would use is too deeply nested for Windows. Details has more.';
        case 'CANCELLED':
            return 'Setup was cancelled. Choose Repair to continue.';
        default:
            return 'A part of the setup did not finish. Choose Repair to try again; Details has more.';
    }
}
