import {
    ApioImplementationProvider,
    BoardRegistry,
    ChainedToolLocator,
    ConfiguredToolLocator,
    currentHost,
    dataPaths,
    type Diagnostic,
    GhdlVhdlProvider,
    type HostInfo,
    type ImplementationProvider,
    loadManifests,
    loadProject,
    type LocatedTool,
    NodeToolRunner,
    type Project,
    ProgrammingService,
    type ToolchainManifest,
    type ToolId,
    type ToolLocator,
    type ToolRunner,
    type VhdlProvider,
    WorkflowController,
    WorkspaceManager,
} from '../core';
import { createPlatformServices, type PlatformServices } from '../platform';

/** Everything a command may need, built once per invocation (composition root). */
export interface CliContext {
    readonly host: HostInfo;
    readonly platform: PlatformServices;
    readonly boards: BoardRegistry;
    readonly boardDiagnostics: readonly Diagnostic[];
    readonly manifests: readonly ToolchainManifest[];
    /** The platform-configured runner; every external tool goes through it. */
    readonly runner: ToolRunner;
    readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ContextOverrides {
    readonly host?: HostInfo;
    /** Replaces the registry's adapter (tests inject a fake so no host tool is ever found). */
    readonly platform?: PlatformServices;
    /** Base runner; the platform's `runner`, if it has one, is used instead. */
    readonly runner?: ToolRunner;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly dataRoot?: string;
}

export async function createContext(overrides: ContextOverrides = {}): Promise<CliContext> {
    const host = overrides.host ?? currentHost();
    const paths = overrides.dataRoot ? dataPaths(overrides.dataRoot) : dataPaths();
    const { registry, diagnostics } = await BoardRegistry.loadDirectory(paths.boards);
    const { manifests } = await loadManifests(paths.toolchains);
    const env = overrides.env ?? process.env;
    const baseRunner = overrides.runner ?? new NodeToolRunner();
    const platform = overrides.platform ?? createPlatformServices(host, { runner: baseRunner, env });
    return {
        host,
        platform,
        boards: registry,
        boardDiagnostics: diagnostics,
        manifests,
        // The platform's configured runner (e.g. with a pinned tool environment) is used for
        // every tool: detection, GHDL, Apio and anything the adapter itself runs.
        runner: platform.runner ?? baseRunner,
        env,
    };
}

/** Explicit configuration (project setting, then NEXYSVHDL_* env var) wins over platform discovery. */
export function toolLocatorFor(ctx: CliContext, project?: Project): ToolLocator {
    const locators: ToolLocator[] = [new ConfiguredToolLocator(project?.config.toolchain?.tools ?? {}, ctx.env)];
    if (ctx.platform.toolLocator) locators.push(ctx.platform.toolLocator);
    return new ChainedToolLocator(locators);
}

export interface ConfiguredProviders {
    readonly vhdl?: VhdlProvider;
    readonly implementation?: ImplementationProvider;
    readonly located: Partial<Record<ToolId, LocatedTool>>;
}

/** Instantiates the shared GHDL/Apio providers when their executables are located. */
export async function providersFor(ctx: CliContext, project?: Project): Promise<ConfiguredProviders> {
    const locator = toolLocatorFor(ctx, project);
    const ghdl = await locator.locate('ghdl');
    const apio = await locator.locate('apio');
    return {
        ...(ghdl ? { vhdl: new GhdlVhdlProvider(ghdl.path, ctx.runner) } : {}),
        ...(apio ? { implementation: new ApioImplementationProvider(apio.path, ctx.runner) } : {}),
        located: { ...(ghdl ? { ghdl } : {}), ...(apio ? { apio } : {}) },
    };
}

export async function controllerFor(ctx: CliContext, project: Project): Promise<WorkflowController> {
    const providers = await providersFor(ctx, project);
    return new WorkflowController({
        boards: ctx.boards,
        workspaces: new WorkspaceManager(),
        ...(providers.vhdl ? { vhdl: providers.vhdl } : {}),
        ...(providers.implementation ? { implementation: providers.implementation } : {}),
    });
}

export function programmingFor(ctx: CliContext): ProgrammingService {
    return new ProgrammingService(ctx.platform.programmer);
}

export { loadProject };
