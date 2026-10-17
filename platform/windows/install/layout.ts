import { win32 } from 'node:path';

/** The toolchain MIX-FPGA installs on Windows x64, and the folder name of its target. */
export const TOOLCHAIN_VERSION = '1.0';
export const TOOLCHAIN_TARGET = 'windows-x64';

/** The one runtime path override. Relocates the whole MIX-FPGA root (tests, lab images). Students never set it. */
export const HOME_OVERRIDE_VARIABLE = 'MIXFPGA_HOME';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Every location MIX-FPGA uses on Windows, resolved once. Nothing here depends on where the extension or a repository lives.
 *
 *   <root>\support\nexys-a7\toolchains\win32-x64\1.0\   the Nexys A7 support: NexysVHDL Toolchain 1.0, unchanged and immutable
 *   <root>\state\nexys-a7\win32-x64-1.0\                 writable state of those tools (Apio's home): never inside the toolchain
 *   <root>\toolchains\1.0\windows-x64\                   DE10-Lite managed tools (GHDL, Yosys) and their support scripts
 *   <root>\toolchains\.staging\                          installs in progress (renamed into place when verified)
 *   <root>\staging\jobs\                                 one private folder per DE10-Lite build
 *   <root>\staging\installers\                           verified temporary copies of the student's Altera files
 *   <root>\downloads\ <root>\state\ <root>\logs\
 *
 * `root` is %LOCALAPPDATA%\MIX-FPGA unless MIXFPGA_HOME relocates it.
 */
export interface WindowsRuntimeLayout {
    readonly root: string;
    /** Data root of the Nexys A7 support store (core/toolchain/store layout beneath it). */
    readonly nexysRoot: string;
    /** Writable state of the Nexys tools. */
    readonly nexysStateRoot: string;
    readonly toolchainsDir: string;
    readonly toolchainStaging: string;
    readonly toolchainDir: string;
    readonly manifestFile: string;
    readonly stagingDir: string;
    readonly jobsRoot: string;
    readonly installersDir: string;
    readonly downloadsDir: string;
    readonly stateDir: string;
    readonly logsDir: string;
    readonly installStateFile: string;
    readonly lockFile: string;
    /** The elevated helper's working folder (commands and answers), private to one Quartus installation. */
    readonly helperDir: string;
    /** Written last, outside the immutable toolchain folder: its presence means the install finished and verified. */
    readonly toolchainMarker: string;
    /** Absolute path of a top-level entry (tool folder, `scripts`, ...) of the installed toolchain. */
    unit(name: string): string;
}

export function resolveWindowsLayout(opts: { env?: Env; localAppData?: string } = {}): WindowsRuntimeLayout {
    const env = opts.env ?? process.env;
    const override = env[HOME_OVERRIDE_VARIABLE];
    const local = opts.localAppData ?? env['LOCALAPPDATA'] ?? '';
    const root = override && override.length > 0 ? override : win32.join(local, 'MIX-FPGA');
    const toolchainsDir = win32.join(root, 'toolchains');
    const toolchainDir = win32.join(toolchainsDir, TOOLCHAIN_VERSION, TOOLCHAIN_TARGET);
    const stateDir = win32.join(root, 'state');
    const stagingDir = win32.join(root, 'staging');
    return {
        root,
        nexysRoot: win32.join(root, 'support', 'nexys-a7'),
        nexysStateRoot: win32.join(stateDir, 'nexys-a7'),
        toolchainsDir,
        toolchainStaging: win32.join(toolchainsDir, '.staging'),
        toolchainDir,
        manifestFile: win32.join(toolchainDir, 'manifest.json'),
        stagingDir,
        jobsRoot: win32.join(stagingDir, 'jobs'),
        installersDir: win32.join(stagingDir, 'installers'),
        downloadsDir: win32.join(root, 'downloads'),
        stateDir,
        logsDir: win32.join(root, 'logs'),
        installStateFile: win32.join(stateDir, 'install-state.json'),
        lockFile: win32.join(stateDir, 'setup.lock'),
        helperDir: win32.join(stateDir, 'helper'),
        toolchainMarker: win32.join(stateDir, `toolchain-${TOOLCHAIN_VERSION}-${TOOLCHAIN_TARGET}.complete.json`),
        unit: (name) => win32.join(toolchainDir, name),
    };
}

/** MIX-FPGA never writes into another product's folders. */
export function isInsideForeignProduct(path: string): boolean {
    return path.split(/[\\/]/).some((seg) => /^nexysvhdl$/i.test(seg));
}

// ---- path-length preflight

/** Windows' classic limit for a full path (MAX_PATH), counting the terminating NUL. */
export const MAX_PATH = 260;

/** The longest path, relative to the Nexys toolchain folder, inside NexysVHDL Toolchain 1.0 for Windows (measured, 160 characters). */
export const NEXYS_LONGEST_RELATIVE_PATH = 160;
/** The longest relative path in the DE10-Lite managed tools (measured; Yosys' share folder). */
export const DE10_LONGEST_RELATIVE_PATH = 120;

export interface PathLengthCheck {
    readonly ok: boolean;
    /** `ok` also when the limit would be exceeded but this computer allows long paths. */
    readonly longPathsEnabled: boolean;
    /** The deepest folder the support needs a path for, and how long the longest file below it will be. */
    readonly worstPath: string;
    readonly worstLength: number;
    readonly limit: number;
    /** How many characters too long (0 when it fits). */
    readonly over: number;
}

/**
 * Detects, before installing, that the longest file of a support set would not fit in Windows' path limit under this root.
 * Detection only: nothing is changed (no registry, no group policy, no alias). When long paths are enabled the limit does
 * not apply, but the measurement is still reported.
 */
export function checkPathLength(rootToStoreFolder: string, longestRelative: number, longPathsEnabled: boolean): PathLengthCheck {
    const worstLength = rootToStoreFolder.length + 1 + longestRelative;
    const over = Math.max(0, worstLength - (MAX_PATH - 1));
    return { ok: over === 0 || longPathsEnabled, longPathsEnabled, worstPath: rootToStoreFolder, worstLength, limit: MAX_PATH - 1, over };
}
