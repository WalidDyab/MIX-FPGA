import { homedir } from 'node:os';
import { join, sep } from 'node:path';

/** The toolchain MIX-FPGA installs on macOS Apple silicon, and the folder name of its target. */
export const TOOLCHAIN_VERSION = '1.0';
export const TOOLCHAIN_TARGET = 'macos-arm64';
export const LIMA_INSTANCE = 'mix-fpga-de10';

/** The one runtime path override. Relocates the whole MIX-FPGA root (tests, lab images). Students never set it. */
export const HOME_OVERRIDE_VARIABLE = 'MIXFPGA_HOME';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Every location MIX-FPGA uses on macOS, resolved once. Nothing here depends on where the
 * extension or the repository lives.
 *
 *   <root>/toolchains/<version>/<target>/   immutable installed toolchain
 *   <root>/toolchains/.staging/             installs in progress (renamed into place when verified)
 *   <root>/lima/<instance>/                 the Linux engine (LIMA_HOME is <root>/lima)
 *   <root>/staging/                         the only folder shared with the engine
 *   <root>/downloads/                       verified cached downloads (e.g. the Ubuntu image)
 *   <root>/state/                           install state, completion markers, lock
 *   <root>/logs/
 */
export interface RuntimeLayout {
    readonly root: string;
    readonly toolchainsDir: string;
    readonly toolchainStaging: string;
    readonly toolchainDir: string;
    readonly manifestFile: string;
    readonly limaHome: string;
    readonly instanceDir: string;
    readonly shareDir: string;
    readonly installersDir: string;
    readonly downloadsDir: string;
    readonly stateDir: string;
    readonly logsDir: string;
    readonly installStateFile: string;
    readonly lockFile: string;
    /** Written last, outside the immutable toolchain folder: its presence means the install finished and verified. */
    readonly toolchainMarker: string;
    /** Absolute path of a top-level entry (tool folder, `engine`, ...) of the installed toolchain. */
    unit(name: string): string;
}

export function resolveRuntimeLayout(opts: { home?: string; env?: Env } = {}): RuntimeLayout {
    const env = opts.env ?? process.env;
    const override = env[HOME_OVERRIDE_VARIABLE];
    const root = override && override.length > 0 ? override : join(opts.home ?? homedir(), 'Library', 'MIX-FPGA');
    const toolchainsDir = join(root, 'toolchains');
    const toolchainDir = join(toolchainsDir, TOOLCHAIN_VERSION, TOOLCHAIN_TARGET);
    const limaHome = join(root, 'lima');
    const stateDir = join(root, 'state');
    return {
        root,
        toolchainsDir,
        toolchainStaging: join(toolchainsDir, '.staging'),
        toolchainDir,
        manifestFile: join(toolchainDir, 'manifest.json'),
        limaHome,
        instanceDir: join(limaHome, LIMA_INSTANCE),
        shareDir: join(root, 'staging'),
        installersDir: join(root, 'staging', 'installers'),
        downloadsDir: join(root, 'downloads'),
        stateDir,
        logsDir: join(root, 'logs'),
        installStateFile: join(stateDir, 'install-state.json'),
        lockFile: join(stateDir, 'setup.lock'),
        toolchainMarker: join(stateDir, `toolchain-${TOOLCHAIN_VERSION}-${TOOLCHAIN_TARGET}.complete.json`),
        unit: (name) => join(toolchainDir, name),
    };
}

/** MIX-FPGA never writes into another product's folders. */
export function isInsideForeignProduct(path: string): boolean {
    return path.split(sep).some((seg) => /^nexysvhdl$/i.test(seg));
}

// ---- Lima socket length

/** macOS limits a UNIX socket path to 104 bytes including the terminating NUL. */
export const UNIX_SOCKET_PATH_LIMIT = 103;
/** The longest socket names Lima creates inside an instance folder. */
const LIMA_SOCKET_NAMES = ['default_fd.sock', 'default_ep.sock', 'serialv.sock', 'ssh.sock', 'ha.sock'];

export interface SocketPathCheck {
    readonly ok: boolean;
    /** Longest socket path the engine will need. */
    readonly path: string;
    readonly length: number;
    readonly limit: number;
    /** How many characters too long (0 when ok). */
    readonly over: number;
}

/**
 * Detects, before creating the engine, that its socket paths would not fit. Detection only:
 * there is deliberately no workaround here yet (see the setup documentation).
 */
export function checkLimaSocketLength(layout: RuntimeLayout): SocketPathCheck {
    const longest = LIMA_SOCKET_NAMES.map((n) => join(layout.instanceDir, n)).reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a));
    const length = Buffer.byteLength(longest);
    return { ok: length <= UNIX_SOCKET_PATH_LIMIT, path: longest, length, limit: UNIX_SOCKET_PATH_LIMIT, over: Math.max(0, length - UNIX_SOCKET_PATH_LIMIT) };
}
