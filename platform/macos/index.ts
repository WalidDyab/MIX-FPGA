import { posix } from 'node:path';
import {
    ApioImplementationProvider,
    type BundledToolchain,
    type DetectedTool,
    GhdlVhdlProvider,
    type HostInfo,
    type ImplementationProvider,
    type LocatedTool,
    NodeToolRunner,
    packageRoot,
    type ToolId,
    type ToolRunner,
    type VhdlProvider,
} from '../../core';
import type { PlatformFactory, PlatformServices, ToolchainInspectionRequest } from '../types';
import { apioRemoteConfigUrl, APIO_REMOTE_CONFIG_ENV, PinnedApioRunner, pinnedConfigDir, ResolvedApioIdentity } from './apio-pin';
import { parseOpenFpgaLoaderVersion } from './openfpgaloader';
import { OpenFpgaLoaderProgrammer } from './programmer';
import { type MacosSystem, nodeSystem } from './system';
import { MacosToolchainDetector } from './toolchain';
import { APIO_APP_PATH, type MacosLocatorOptions, MacosToolLocator } from './tool-locator';

export * from './apio-pin';
export * from './executable';
export * from './openfpgaloader';
export * from './openxc7';
export * from './path-alias';
export * from './programmer';
export * from './system';
export * from './toolchain';
export * from './tool-locator';

/**
 * The factory registered in platform/index.ts for darwin/arm64: the real
 * adapter, built on the composition root's base runner and environment. Its
 * `runner` (a PinnedApioRunner) becomes the CLI's runner, so every Apio call —
 * doctor probes, `apio raw`, `apio build` — carries the pinned
 * APIO_REMOTE_CONFIG_URL, and Apio is refused if the pin cannot be expressed.
 */
export const createMacosPlatform: PlatformFactory = (host, context) =>
    createMacosAdapter(host, { runner: context.runner, system: nodeSystem(context.env), ...(context.classroom ? { classroom: context.classroom } : {}) });

/** Operating-system folders bundled tools may need on PATH. */
export function macosSystemPath(): string[] {
    return ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
}

/**
 * Per-user store of the Nexys A7 support (the NexysVHDL Toolchain 1.0 bundle, unchanged): <MIX-FPGA root>/support/nexys-a7,
 * the MIX-FPGA root being $MIXFPGA_HOME or ~/Library/MIX-FPGA. Not "Application Support": Apio refuses paths that contain a
 * space. A home folder whose path itself has a space or non-ASCII character is reached through macosPathAlias.
 */
export function macosUserDataRoot(env: Readonly<Record<string, string | undefined>>): string | undefined {
    const override = env['MIXFPGA_HOME'];
    const root = override && override.length > 0 ? override : env['HOME'] ? posix.join(env['HOME'], 'Library', 'MIX-FPGA') : undefined;
    return root ? posix.join(root, 'support', 'nexys-a7') : undefined;
}

/**
 * Where a NexysVHDL 0.6.0 installation keeps the same validated toolchain (~/Library/NexysVHDL). MIX-FPGA is its update: it
 * may reuse that toolchain read-only (the installed marker must match the validated content hash) until it is adopted into the
 * MIX-FPGA store. Never written to. Not consulted when MIXFPGA_HOME relocates MIX-FPGA (isolated and fresh-install tests).
 */
export function macosLegacyDataRoots(env: Readonly<Record<string, string | undefined>>): string[] {
    if (env['MIXFPGA_HOME']) return [];
    return env['HOME'] ? [posix.join(env['HOME'], 'Library', 'NexysVHDL')] : [];
}

/** The real macOS adapter: PlatformServices plus the pieces a composition root needs. */
export interface MacosAdapter extends PlatformServices {
    readonly toolLocator?: MacosToolLocator;
    readonly programmer?: OpenFpgaLoaderProgrammer;
    /**
     * The adapter's ToolRunner: every Apio invocation made through it carries the
     * pinned APIO_REMOTE_CONFIG_URL. Everything this adapter runs uses it.
     */
    readonly runner: ToolRunner;
    /** Folder holding the tracked pinned Apio configs. */
    readonly pinnedConfigDir: string;
    /** `{ APIO_REMOTE_CONFIG_URL: file://... }`; empty if the pin path is unusable (Apio is then refused). */
    readonly apioEnvironment: Readonly<Record<string, string>>;
    /** Shared GHDL/Apio providers, built with the pinned runner, for the tools this adapter locates. */
    providers(): Promise<{ vhdl?: VhdlProvider; implementation?: ImplementationProvider; located: Partial<Record<ToolId, LocatedTool>> }>;
    toolchainDetector(): MacosToolchainDetector;
}

export interface MacosAdapterOptions {
    readonly system?: MacosSystem;
    /** Underlying process runner (tests inject a fake); always wrapped with the Apio pin. */
    readonly runner?: ToolRunner;
    /** Package root containing toolchains/ (defaults to this installation). */
    readonly root?: string;
    readonly locator?: MacosLocatorOptions;
    /** Classroom mode: tools only from the installed NexysVHDL toolchain (no pin; the bundle pins Apio itself). */
    readonly classroom?: { readonly toolchain?: BundledToolchain };
}

/**
 * GHDL installed by the Phase 1/2 macOS experiments (official 6.0.0 aarch64
 * release) in the repository's own tools/ folder. Last-resort development
 * fallback for the developer CLI only; never used in classroom mode.
 */
export function developmentLocations(root?: string): NonNullable<MacosLocatorOptions['developmentLocations']> {
    let base = root;
    if (base === undefined) {
        try {
            base = packageRoot();
        } catch {
            return {};
        }
    }
    return { ghdl: [{ path: posix.join(base, 'tools', 'ghdl', 'bin', 'ghdl'), method: 'Phase 1/2 development install' }] };
}

/** Apple-silicon macOS adapter. Registered through createMacosPlatform; also usable directly (tests, tools). */
export function createMacosAdapter(host: HostInfo, options: MacosAdapterOptions = {}): MacosAdapter {
    const system = options.system ?? nodeSystem();
    // POSIX join: this adapter handles macOS paths only (also keeps its unit tests host-independent).
    const configDir = pinnedConfigDir(posix.join(options.root ?? packageRoot(), 'toolchains'));
    let apioEnvironment: Record<string, string> = {};
    let pinProblem: string | undefined;
    try {
        apioEnvironment = { [APIO_REMOTE_CONFIG_ENV]: apioRemoteConfigUrl(configDir) };
    } catch (err) {
        pinProblem = (err as Error).message;
    }
    // Apio is recognised by resolved identity: the locator's Apio (which honours NEXYSVHDL_APIO) is the reference.
    const locator = new MacosToolLocator(system, options.locator ?? { developmentLocations: developmentLocations(options.root) });
    const identity = new ResolvedApioIdentity(system, async () => {
        const found = await locator.discover('apio');
        return [...(found.located ? [found.located.path] : []), APIO_APP_PATH];
    });
    const runner = new PinnedApioRunner(options.runner ?? new NodeToolRunner(), apioEnvironment, identity);
    const common = { id: 'macos', displayName: 'macOS', runner, pinnedConfigDir: configDir, apioEnvironment };
    const inspect = (detector: () => MacosToolchainDetector) => async (request: ToolchainInspectionRequest) => {
        // macOS discovery checks executable architecture, so it uses its own locator.
        const report = await detector().detect(request.manifest);
        return { tools: report.tools, diagnostics: report.diagnostics };
    };

    if (host.arch === 'arm64' && options.classroom) return bundledMacosAdapter(system, options.classroom.toolchain, options.runner ?? new NodeToolRunner());

    if (host.arch !== 'arm64') {
        // Intel Macs are not validated; on Apple silicon x64 means Node runs under Rosetta.
        const locator = new MacosToolLocator(system);
        return {
            ...common,
            status: `unsupported architecture ${host.arch}: requires native arm64 (Apple silicon, no Rosetta)`,
            providers: async () => ({ located: {} }),
            toolchainDetector: () => new MacosToolchainDetector(system, locator, runner, configDir),
            inspectToolchain: inspect(() => new MacosToolchainDetector(system, locator, runner, configDir)),
        };
    }

    return {
        ...common,
        status: pinProblem
            ? `native arm64; openFPGALoader programmer; Apio pin unusable (Apio refused): ${pinProblem}`
            : 'native arm64; openFPGALoader programmer; Apio pinned via toolchains/apio-remote-config',
        toolLocator: locator,
        programmer: new OpenFpgaLoaderProgrammer({ runner, locator }),
        async providers() {
            const ghdl = await locator.locate('ghdl');
            const apio = await locator.locate('apio');
            return {
                ...(ghdl ? { vhdl: new GhdlVhdlProvider(ghdl.path, runner) } : {}),
                ...(apio ? { implementation: new ApioImplementationProvider(apio.path, runner) } : {}),
                located: { ...(ghdl ? { ghdl } : {}), ...(apio ? { apio } : {}) },
            };
        },
        toolchainDetector: () => new MacosToolchainDetector(system, locator, runner, configDir),
        inspectToolchain: inspect(() => new MacosToolchainDetector(system, locator, runner, configDir)),
    };
}

/**
 * Classroom mode on Apple silicon: GHDL, Apio and openFPGALoader come only from
 * the installed NexysVHDL toolchain. The composition root's runner already
 * carries the bundle environment (pinned APIO_REMOTE_CONFIG_URL, private
 * APIO_HOME/APIO_PACKAGES), so no PinnedApioRunner is involved and the
 * repository's toolchains/apio-remote-config is not used.
 * PENDING real validation on an Apple-silicon Mac (Phase 4B, Mac step).
 */
function bundledMacosAdapter(system: MacosSystem, toolchain: BundledToolchain | undefined, runner: ToolRunner): MacosAdapter {
    const locator = new MacosToolLocator(system, { bundled: toolchain?.executables ?? {} });
    const remoteConfigDir = toolchain ? posix.join(toolchain.root, ...toolchain.manifest.apio.remoteConfig.split('/').slice(0, -1)) : '';
    return {
        id: 'macos',
        displayName: 'macOS',
        status: `native arm64; NexysVHDL toolchain ${toolchain ? toolchain.manifest.bundleVersion : '(not installed)'}; openFPGALoader programmer (bundled)`,
        runner,
        pinnedConfigDir: remoteConfigDir,
        apioEnvironment: {},
        toolLocator: locator,
        programmer: new OpenFpgaLoaderProgrammer({ runner, locator }),
        programmerSetup: { name: 'Board programmer (openFPGALoader)', bundled: true },
        async providers() {
            const ghdl = await locator.locate('ghdl');
            const apio = await locator.locate('apio');
            return {
                ...(ghdl ? { vhdl: new GhdlVhdlProvider(ghdl.path, runner) } : {}),
                ...(apio ? { implementation: new ApioImplementationProvider(apio.path, runner) } : {}),
                located: { ...(ghdl ? { ghdl } : {}), ...(apio ? { apio } : {}) },
            };
        },
        toolchainDetector: () => new MacosToolchainDetector(system, locator, runner, remoteConfigDir),
        async inspectToolchain(request) {
            // Classroom mode: the shared bundle inspection covers GHDL/Apio/Yosys/nextpnr/openXC7; only the programmer is ours.
            const tools = new Map<ToolId, DetectedTool>();
            if (!request.tools.includes('programmer')) return { tools, diagnostics: [] };
            const found = await locator.discover('programmer');
            if (!found.located) {
                tools.set('programmer', { tool: 'programmer', found: false, method: 'NexysVHDL bundled toolchain' });
                return { tools, diagnostics: [...found.diagnostics] };
            }
            const run = await runner.run({ executable: found.located.path, args: ['--Version'], timeoutMs: 15_000 });
            const raw = `${run.stdout}
${run.stderr}`.trim();
            const version = run.outcome === 'exited' ? parseOpenFpgaLoaderVersion(raw) : undefined;
            const base = { tool: 'programmer' as const, found: run.outcome !== 'spawn-failed', path: found.located.path, method: found.located.method, rawVersion: raw };
            tools.set('programmer', version ? { ...base, version } : base);
            return { tools, diagnostics: [...found.diagnostics] };
        },
    };
}
