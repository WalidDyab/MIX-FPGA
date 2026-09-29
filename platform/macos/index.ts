import { posix } from 'node:path';
import {
    ApioImplementationProvider,
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
import { apioRemoteConfigUrl, APIO_REMOTE_CONFIG_ENV, PinnedApioRunner, pinnedConfigDir } from './apio-pin';
import { OpenFpgaLoaderProgrammer } from './programmer';
import { type MacosSystem, nodeSystem } from './system';
import { MacosToolchainDetector } from './toolchain';
import { type MacosLocatorOptions, MacosToolLocator } from './tool-locator';

export * from './apio-pin';
export * from './executable';
export * from './openfpgaloader';
export * from './openxc7';
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
    createMacosAdapter(host, { runner: context.runner, system: nodeSystem(context.env) });

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
}

/**
 * GHDL installed by the Phase 1/2 macOS experiments (official 6.0.0 aarch64
 * release, project-local). Last-resort development fallback only.
 */
export function developmentLocations(system: MacosSystem): NonNullable<MacosLocatorOptions['developmentLocations']> {
    return {
        ghdl: [{ path: posix.join(system.homeDir, 'WSClaude', 'NexysVHDL', 'tools', 'ghdl', 'bin', 'ghdl'), method: 'Phase 1/2 development install' }],
    };
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
    const runner = new PinnedApioRunner(options.runner ?? new NodeToolRunner(), apioEnvironment);
    const common = { id: 'macos', displayName: 'macOS', runner, pinnedConfigDir: configDir, apioEnvironment };
    const inspect = (detector: () => MacosToolchainDetector) => async (request: ToolchainInspectionRequest) => {
        // macOS discovery checks executable architecture, so it uses its own locator.
        const report = await detector().detect(request.manifest);
        return { tools: report.tools, diagnostics: report.diagnostics };
    };

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

    const locator = new MacosToolLocator(system, options.locator ?? { developmentLocations: developmentLocations(system) });
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
