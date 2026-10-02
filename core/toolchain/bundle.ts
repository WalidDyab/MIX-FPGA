import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HostInfo } from '../host';
import type { ToolInvocation, ToolRunner, ToolRunResult } from '../process/tool-runner';
import { type Diagnostic, errorDiag, infoDiag } from '../results/diagnostic';
import { ToolDetector } from './tool-detector';
import type { LocatedTool, ToolLocator } from './tool-locator';
import type { DetectedTool, ToolchainManifest, ToolId } from './types';
import { parseOpenXc7ReleaseTag } from './version-parsers';

/**
 * The private FPGA toolchain of NexysVHDL (Phase 4B, classroom mode). It is a
 * versioned artifact of its own, installed once per user beside other
 * versions and reused by every NexysVHDL extension version that requires it
 * (see store.ts):
 *
 *   <data root>/toolchains/<platform>-<arch>/<bundle version>/toolchain-manifest.json
 *
 * Tools are resolved only from that folder: there is no PATH search, no
 * environment override and no fallback to another installation. The bundle is
 * immutable. Tools that need writable state (Apio's remote-config cache,
 * profile and tmp folder) get a separate NexysVHDL-owned folder (`stateDir`).
 */

export const BUNDLE_MANIFEST = 'toolchain-manifest.json';
export const BUNDLE_NOTICES = 'THIRD_PARTY_NOTICES.md';

/** Apio's documented environment options (apio/utils/env_options.py). Never inherited by bundled tools. */
export const APIO_ENV_VARS = ['APIO_HOME', 'APIO_PACKAGES', 'APIO_PLATFORM', 'APIO_REMOTE_CONFIG_URL', 'APIO_DEBUG'] as const;

export type BundledExecutable = 'ghdl' | 'apio' | 'programmer';

/** The parts of the generated toolchain-manifest.json the runtime relies on. */
export interface BundleManifest {
    readonly schemaVersion: 1;
    readonly product: string;
    readonly bundleVersion: string;
    readonly target: string;
    readonly platform: string;
    readonly arch: string;
    readonly displayPlatform: string;
    readonly versions: Readonly<Record<string, string | number>>;
    /** Relative (POSIX) executable paths; `programmer` only when the platform bundles one. */
    readonly executables: Readonly<Partial<Record<BundledExecutable, { readonly path: string; readonly sha256: string }>>>;
    readonly apio: {
        readonly version: string;
        readonly platformId: string;
        readonly packagesDir: string;
        readonly remoteConfig: string;
        readonly remoteConfigTemplate: string;
        /** Apio package name -> installed version (Apio's dotted form, e.g. 2026.09.24). */
        readonly packages: Readonly<Record<string, string>>;
    };
    /** Process environment policy: PATH = these bundle folders + the OS folders; extra variables. */
    readonly environment?: { readonly pathPrepend: readonly string[]; readonly set: Readonly<Record<string, string>> };
    readonly programmer: {
        readonly kind: 'system' | 'bundled';
        readonly name: string;
        readonly bundled: boolean;
        readonly reason?: string;
        readonly installGuide?: string;
        readonly validated?: Readonly<Record<string, string>>;
        /** The programmer version the shared compatibility model compares with (bundled or system). */
        readonly testedVersion?: string;
    };
    readonly components: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly version: string;
        readonly license: string;
        readonly path: string;
        readonly content: { readonly files: number; readonly bytes: number; readonly treeSha256: string };
    }>;
}

/** A resolved, usable bundle: absolute paths only. */
export interface BundledToolchain {
    readonly root: string;
    readonly target: string;
    readonly manifest: BundleManifest;
    /** Absolute executable paths. Apio is absent when Apio cannot run on this machine. */
    readonly executables: Readonly<Partial<Record<BundledExecutable, string>>>;
    readonly apioPackagesDir: string;
    /** NexysVHDL-owned writable folder for this toolchain version. */
    readonly stateDir: string;
    /** Apio's private home (remote-config cache, profile, tmp). */
    readonly apioHome: string;
    /**
     * ASCII aliases used to run the tools when a real path is one Apio refuses
     * (a space or non-ASCII character, e.g. in a Windows profile name). The
     * files stay where they are; only the path the tools see changes.
     */
    readonly aliases?: { readonly toolchain?: string; readonly state?: string };
    /**
     * Environment for every process NexysVHDL starts: Apio is pointed at the
     * bundle's packages, the private home and the pinned remote config, so it
     * never reads or writes ~/.apio and never upgrades a package.
     */
    readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface BundleResolution {
    /** Absent when the bundle is unusable. */
    readonly toolchain?: BundledToolchain;
    readonly root: string;
    readonly target: string;
    readonly manifest?: BundleManifest;
    readonly diagnostics: readonly Diagnostic[];
}

export interface LoadBundleOptions {
    /** The installed version folder (`<data root>/toolchains/<target>/<version>`). */
    readonly bundleDir: string;
    readonly host: Pick<HostInfo, 'platform' | 'arch'>;
    /** NexysVHDL-owned writable folder for this toolchain version. */
    readonly stateDir: string;
    /** Operating-system folders every tool may need (shell, system libraries); from the platform adapter. */
    readonly systemPath: readonly string[];
    /** The environment NexysVHDL runs in; tool-affecting variables in it are removed for bundled tools. */
    readonly inheritedEnv: Readonly<Record<string, string | undefined>>;
    /**
     * Platform hook: an ASCII path that resolves to `target` (Windows: a
     * directory junction under %ProgramData%\NexysVHDL\links). Used only for
     * folders Apio would refuse; absent means such folders disable Apio.
     */
    readonly pathAlias?: (target: string) => Promise<PathAlias>;
}

export interface PathAlias {
    readonly path?: string;
    readonly problem?: string;
}

export function bundleTarget(host: Pick<HostInfo, 'platform' | 'arch'>): string {
    return `${host.platform}-${host.arch}`;
}

/** Apio refuses home/packages paths with spaces or non-ASCII characters (apio/utils/util.py, issue #515). */
export function apioPathProblem(path: string): string | undefined {
    for (const ch of path) {
        const code = ch.codePointAt(0)!;
        if (code < 33 || code > 127) return ch === ' ' ? 'a space' : `the character "${ch}"`;
    }
    return undefined;
}

/**
 * `file://` URL for APIO_REMOTE_CONFIG_URL. Apio strips the 7-character
 * `file://` prefix and opens the rest verbatim (no percent-decoding), and
 * replaces `{major}`/`{minor}` with its own version.
 */
export function apioFileUrl(absolutePath: string): string {
    if (!isAbsolute(absolutePath)) throw new Error(`not an absolute path: ${absolutePath}`);
    if (/[{}\n\r]/.test(absolutePath.replace('{major}', '').replace('{minor}', ''))) throw new Error(`path contains characters Apio cannot use in a URL template: ${absolutePath}`);
    return `file://${absolutePath.split(sep).join('/')}`;
}

/** Resolves a manifest-relative POSIX path inside the bundle; refuses anything that escapes it. */
export function insideBundle(root: string, rel: string): string | undefined {
    if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return undefined;
    const full = resolve(root, ...rel.split('/'));
    const back = relative(root, full);
    return back === '' || back.startsWith('..') || isAbsolute(back) ? undefined : full;
}

async function isFile(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

/** Package -> pinned version (dotted) from the bundle's Apio remote config (JSON after `//` comment lines). */
function pinnedVersions(remoteConfigText: string): Record<string, string> {
    const data = JSON.parse(remoteConfigText.replace(/^\s*\/\/.*$/gm, '')) as { packages?: Record<string, { release?: { tag?: unknown } }> };
    const out: Record<string, string> = {};
    for (const [name, pkg] of Object.entries(data.packages ?? {})) {
        if (typeof pkg?.release?.tag === 'string') out[name] = pkg.release.tag.replaceAll('-', '.');
    }
    return out;
}

/**
 * Environment for bundled tools: inherited PATH, APIO_* and PYTHON* variables
 * are removed (a student's own Python or Apio settings can never leak in),
 * PATH becomes the bundle's shim folders followed by the operating-system
 * folders, and the bundle's own variables are set (e.g.
 * PYTHONDONTWRITEBYTECODE, so nothing is ever written into the bundle).
 */
export function bundleEnvironment(manifest: BundleManifest, root: string, options: Pick<LoadBundleOptions, 'systemPath' | 'inheritedEnv'>): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = Object.fromEntries(APIO_ENV_VARS.map((v) => [v, undefined]));
    for (const key of Object.keys(options.inheritedEnv)) {
        if (/^(APIO_|PYTHON)/i.test(key) || /^path$/i.test(key)) env[key] = undefined;
    }
    const prepend = (manifest.environment?.pathPrepend ?? []).map((rel) => insideBundle(root, rel)).filter((p): p is string => p !== undefined);
    env['PATH'] = [...prepend, ...options.systemPath].join(delimiter);
    for (const [key, value] of Object.entries(manifest.environment?.set ?? {})) env[key] = value;
    return env;
}

/**
 * Loads and checks one installed bundle. Fast (no hashing; the full content
 * hash is checked at install time and by Verify Toolchain): manifest,
 * platform/arch, executables, and the Apio package state, which must be
 * exactly what the pinned remote config describes. Otherwise Apio would
 * "repair" the bundle by deleting and re-downloading packages.
 */
export async function loadBundledToolchain(options: LoadBundleOptions): Promise<BundleResolution> {
    const target = bundleTarget(options.host);
    const root = options.bundleDir;
    const diagnostics: Diagnostic[] = [];
    const problem = (code: string, message: string) => diagnostics.push(errorDiag('toolchain', code, message));
    const result = (extra: Partial<BundleResolution> = {}): BundleResolution => ({ root, target, diagnostics, ...extra });
    const reinstall = 'Install the NexysVHDL toolchain again.';

    let manifest: BundleManifest;
    try {
        manifest = JSON.parse(await readFile(join(root, BUNDLE_MANIFEST), 'utf8')) as BundleManifest;
    } catch {
        problem('BUNDLE_MISSING', `The NexysVHDL FPGA toolchain in ${root} has no ${BUNDLE_MANIFEST}. ${reinstall}`);
        return result();
    }
    if (manifest.schemaVersion !== 1 || typeof manifest.bundleVersion !== 'string' || !manifest.apio || !manifest.executables) {
        problem('BUNDLE_MANIFEST_INVALID', `${join(root, BUNDLE_MANIFEST)} is not a valid NexysVHDL toolchain manifest.`);
        return result();
    }
    if (manifest.target !== target || manifest.platform !== options.host.platform || manifest.arch !== options.host.arch) {
        problem('BUNDLE_WRONG_PLATFORM', `This NexysVHDL toolchain is for ${manifest.target}, but this computer is ${target}. Install the NexysVHDL toolchain built for this computer.`);
        return result({ manifest });
    }

    // Folders Apio would refuse are reached through an ASCII alias (same files, different path).
    let runRoot = root;
    let runState = options.stateDir;
    const aliases: { toolchain?: string; state?: string } = {};
    if (options.pathAlias && (apioPathProblem(root) || apioPathProblem(options.stateDir))) {
        await mkdir(options.stateDir, { recursive: true });
        for (const which of ['toolchain', 'state'] as const) {
            const real = which === 'toolchain' ? root : options.stateDir;
            if (!apioPathProblem(real)) continue;
            const alias = await options.pathAlias(real);
            if (!alias.path) {
                problem('BUNDLE_PATH_ALIAS_FAILED', `Could not create a plain-ASCII path for ${real}: ${alias.problem ?? 'unknown reason'}.`);
                continue;
            }
            aliases[which] = alias.path;
            if (which === 'toolchain') runRoot = alias.path;
            else runState = alias.path;
            diagnostics.push(infoDiag('toolchain', 'BUNDLE_PATH_ALIAS', `${real} is used through ${alias.path} (the FPGA build tools need a path without spaces or non-English characters).`));
        }
    }

    const executables: Partial<Record<BundledExecutable, string>> = {};
    for (const [tool, entry] of Object.entries(manifest.executables) as Array<[BundledExecutable, { path: string }]>) {
        const full = insideBundle(runRoot, entry.path);
        if (!full) problem('BUNDLE_MANIFEST_INVALID', `Toolchain manifest entry for ${tool} points outside the toolchain folder: ${entry.path}`);
        else if (!(await isFile(full))) problem('BUNDLE_INCOMPLETE', `The bundled ${tool} executable is missing (${full}). ${reinstall}`);
        else executables[tool] = full;
    }
    if (!executables.ghdl || !manifest.executables.apio) return result({ manifest });

    // Apio package state: every package present, versions identical to the pinned config, nothing extra.
    const packagesDir = insideBundle(runRoot, manifest.apio.packagesDir);
    const remoteConfig = insideBundle(runRoot, manifest.apio.remoteConfig);
    const remoteTemplate = insideBundle(runRoot, manifest.apio.remoteConfigTemplate);
    if (!packagesDir || !remoteConfig || !remoteTemplate || !(await isDirectory(packagesDir))) {
        problem('BUNDLE_INCOMPLETE', `The bundled Apio packages are missing (${packagesDir ?? manifest.apio.packagesDir}). ${reinstall}`);
        return result({ manifest });
    }
    let apioUsable = executables.apio !== undefined;
    try {
        const installed = JSON.parse(await readFile(join(packagesDir, 'installed_packages.json'), 'utf8')) as Record<string, { version?: string; platform?: string }>;
        const pinned = pinnedVersions(await readFile(remoteConfig, 'utf8'));
        const expected = manifest.apio.packages;
        for (const name of new Set([...Object.keys(expected), ...Object.keys(installed), ...Object.keys(pinned)])) {
            const want = expected[name];
            if (want === undefined || installed[name]?.version !== want || pinned[name] !== want || installed[name]?.platform !== manifest.apio.platformId) {
                problem('BUNDLE_APIO_INCONSISTENT', `Bundled Apio package "${name}" does not match the toolchain manifest (manifest ${want ?? 'none'}, installed ${installed[name]?.version ?? 'none'}, pinned ${pinned[name] ?? 'none'}).`);
                apioUsable = false;
            } else if (!(await isDirectory(join(packagesDir, name)))) {
                problem('BUNDLE_INCOMPLETE', `Bundled Apio package "${name}" is missing. ${reinstall}`);
                apioUsable = false;
            }
        }
        // Apio deletes unknown entries in its packages folder; there must be none.
        for (const entry of await readdir(packagesDir)) {
            if (entry !== 'installed_packages.json' && expected[entry] === undefined) {
                problem('BUNDLE_APIO_INCONSISTENT', `Unexpected entry "${entry}" in the bundled Apio packages folder.`);
                apioUsable = false;
            }
        }
    } catch (err) {
        problem('BUNDLE_APIO_INCONSISTENT', `Cannot read the bundled Apio package state: ${(err as Error).message}`);
        apioUsable = false;
    }

    const apioHome = join(runState, 'apio-home');
    for (const [what, path] of [['NexysVHDL toolchain folder', packagesDir], ['NexysVHDL tool-state folder', apioHome]] as const) {
        const bad = apioPathProblem(path);
        if (bad) {
            problem(
                'BUNDLE_PATH_UNSUPPORTED',
                `The ${what} (${path}) contains ${bad}. The FPGA build tools (Apio) only work in folders whose path uses plain English letters, digits and symbols without spaces, so Build and the RTL Schematic are unavailable. Check and Simulate still work.`,
            );
            apioUsable = false;
        }
    }

    let remoteUrl: string | undefined;
    try {
        remoteUrl = apioFileUrl(remoteTemplate);
    } catch (err) {
        problem('BUNDLE_PATH_UNSUPPORTED', (err as Error).message);
        apioUsable = false;
    }

    const environment = bundleEnvironment(manifest, runRoot, options);
    if (apioUsable && remoteUrl) {
        environment['APIO_HOME'] = apioHome;
        environment['APIO_PACKAGES'] = packagesDir;
        environment['APIO_REMOTE_CONFIG_URL'] = remoteUrl;
    } else delete executables.apio;

    return result({
        manifest,
        toolchain: {
            root,
            target,
            manifest,
            executables,
            apioPackagesDir: packagesDir,
            stateDir: options.stateDir,
            apioHome,
            environment,
            ...(aliases.toolchain || aliases.state ? { aliases } : {}),
        },
    });
}

/** Locates only the bundled executables. Everything else is "not found" (no PATH, no overrides). */
export class BundledToolLocator implements ToolLocator {
    static readonly METHOD = 'NexysVHDL bundled toolchain';

    constructor(private readonly toolchain: Pick<BundledToolchain, 'executables'>) {}

    async locate(tool: ToolId): Promise<LocatedTool | undefined> {
        const path = (this.toolchain.executables as Partial<Record<string, string>>)[tool];
        return path ? { path, method: BundledToolLocator.METHOD } : undefined;
    }
}

/** Starts every tool with the bundle's environment; Apio's private home is created on first use. */
export class BundledToolRunner implements ToolRunner {
    private ready?: Promise<void>;

    constructor(
        private readonly inner: ToolRunner,
        private readonly toolchain: Pick<BundledToolchain, 'environment'>,
        private readonly makeDirectory: (path: string) => Promise<unknown>,
    ) {}

    async run(invocation: ToolInvocation): Promise<ToolRunResult> {
        const home = this.toolchain.environment['APIO_HOME'];
        if (home) this.ready ??= this.makeDirectory(home).then(() => undefined);
        await this.ready;
        return this.inner.run({ ...invocation, env: { ...(invocation.env ?? {}), ...this.toolchain.environment } });
    }
}

/** Expected versions for the shared compatibility model, from the bundle itself. */
export function bundleCompatibilityManifest(manifest: BundleManifest): ToolchainManifest {
    const v = (key: string) => (manifest.versions[key] !== undefined ? [String(manifest.versions[key])] : []);
    const programmerVersion = manifest.programmer.testedVersion;
    return {
        schemaVersion: 1,
        id: `bundle-${manifest.target}-${manifest.bundleVersion}`,
        description: `NexysVHDL toolchain ${manifest.bundleVersion} (${manifest.displayPlatform})`,
        host: { platform: manifest.platform, arch: manifest.arch },
        status: 'release',
        tools: [
            { tool: 'ghdl', testedVersions: v('ghdl') },
            { tool: 'apio', testedVersions: v('apio') },
            { tool: 'openxc7', testedVersions: v('openxc7') },
            { tool: 'yosys', testedVersions: v('yosys') },
            { tool: 'nextpnr-xilinx', testedVersions: v('nextpnr-xilinx') },
            { tool: 'programmer', name: manifest.programmer.name, testedVersions: programmerVersion ? [programmerVersion] : [] },
        ],
    };
}

/**
 * Version detection for the bundled user-space tools (everything except the
 * programmer, which belongs to the platform adapter). Runs the bundled
 * executables through the bundled runner; openXC7 is read from the bundled
 * package metadata.
 */
export async function inspectBundledTools(toolchain: BundledToolchain, runner: ToolRunner, tools: readonly ToolId[]): Promise<Map<ToolId, DetectedTool>> {
    const detector = new ToolDetector(new BundledToolLocator(toolchain), runner);
    const out = new Map<ToolId, DetectedTool>();
    for (const tool of tools) {
        if (tool === 'programmer') continue;
        if (tool === 'openxc7') {
            const path = join(toolchain.apioPackagesDir, 'openxc7', 'BUILD-INFO.json');
            try {
                const raw = await readFile(path, 'utf8');
                const version = parseOpenXc7ReleaseTag(raw);
                out.set(tool, { tool, found: true, path, method: BundledToolLocator.METHOD, rawVersion: raw.trim(), ...(version ? { version } : {}) });
            } catch {
                out.set(tool, { tool, found: false, path, method: BundledToolLocator.METHOD });
            }
            continue;
        }
        out.set(tool, (await detector.detect(tool)) ?? { tool, found: false, method: BundledToolLocator.METHOD });
    }
    return out;
}
