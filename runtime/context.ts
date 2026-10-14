import { mkdir } from 'node:fs/promises';
import {
    ApioImplementationProvider,
    type BundleResolution,
    bundleCompatibilityManifest,
    type BundledToolchain,
    BundledToolRunner,
    bundleTarget,
    errorDiag,
    type InstalledState,
    type PathAlias,
    installedToolchain,
    loadBundledToolchain,
    type ToolchainRequirement,
    ApioYosysRtlProvider,
    BoardRegistry,
    ChainedToolLocator,
    ConfiguredToolLocator,
    currentHost,
    dataPaths,
    type Diagnostic,
    GhdlVhdlProvider,
    type HostInfo,
    type ImplementationProvider,
    type RtlProvider,
    loadManifests,
    loadProject,
    type LocatedTool,
    NodeToolRunner,
    OutputTeeRunner,
    type ToolInvocation,
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
import { createPlatformServices, platformHostFacts, type PlatformServices } from '../platform';

/**
 * Shared composition root for every NexysVHDL front end (CLI, VS Code
 * extension): host -> platform adapter -> configured runner -> locators ->
 * providers -> WorkflowController / ProgrammingService. Front ends never
 * construct tools or adapters themselves.
 */
export interface RuntimeContext {
    readonly host: HostInfo;
    readonly platform: PlatformServices;
    readonly boards: BoardRegistry;
    readonly boardDiagnostics: readonly Diagnostic[];
    readonly manifests: readonly ToolchainManifest[];
    /** The platform-configured runner; every external tool goes through it. */
    readonly runner: ToolRunner;
    readonly env: Readonly<Record<string, string | undefined>>;
    /** Present in classroom mode (the VS Code extension): tools come only from the installed NexysVHDL toolchain. */
    readonly classroom?: ClassroomState;
}

/** Classroom mode: which toolchain version is required, and whether it is installed and usable. */
export interface ClassroomOptions {
    /** The toolchain version this release requires (toolchains/bundle/requirement.json). */
    readonly requirement: ToolchainRequirement;
    /** Per-user data root; defaults to the platform's (e.g. %LOCALAPPDATA%NexysVHDL). Tests pass a temp folder. */
    readonly dataRoot?: string;
    /** Replaces the platform's ASCII path alias (tests: never touch %ProgramData%). */
    readonly pathAlias?: (target: string) => Promise<PathAlias>;
}

export interface ClassroomState {
    readonly requirement: ToolchainRequirement;
    readonly target: string;
    readonly dataRoot?: string;
    readonly installed?: InstalledState;
    readonly resolution?: BundleResolution;
    /** The usable installed toolchain, if any. */
    readonly toolchain?: BundledToolchain;
    readonly diagnostics: readonly Diagnostic[];
}

export interface ContextOverrides {
    readonly host?: HostInfo;
    /** Replaces the registry's adapter (tests inject a fake so no host tool is ever found). */
    readonly platform?: PlatformServices;
    /** Base runner; the platform's `runner`, if it has one, is used instead. */
    readonly runner?: ToolRunner;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly dataRoot?: string;
    /** Classroom mode: bundled toolchain only, never discovery (used by the VS Code extension). */
    readonly classroom?: ClassroomOptions;
    /** Receives the live output of every tool run (the NexysVHDL Console streams it). */
    readonly onToolOutput?: (text: string, invocation: ToolInvocation) => void;
}

/** Resolves the installed toolchain for classroom mode. Never looks anywhere but the NexysVHDL data root. */
async function resolveClassroom(host: HostInfo, env: Readonly<Record<string, string | undefined>>, options: ClassroomOptions): Promise<ClassroomState> {
    const target = bundleTarget(host);
    const base = { requirement: options.requirement, target };
    const facts = platformHostFacts(host);
    if (!facts) return { ...base, diagnostics: [errorDiag('toolchain', 'TOOLCHAIN_TARGET_UNSUPPORTED', `MIX-FPGA does not support ${target}.`)] };
    const dataRoot = options.dataRoot ?? facts.userDataRoot(env);
    if (!dataRoot) return { ...base, diagnostics: [errorDiag('toolchain', 'TOOLCHAIN_DATA_ROOT_UNKNOWN', 'Cannot determine the per-user MIX-FPGA folder on this computer.')] };
    const installed = await installedToolchain(dataRoot, target, options.requirement);
    if (installed.status !== 'installed') return { ...base, dataRoot, installed, diagnostics: installed.diagnostics };
    const resolution = await loadBundledToolchain({
        bundleDir: installed.paths.versionDir,
        host,
        stateDir: installed.paths.stateDir,
        systemPath: facts.systemPath(env),
        inheritedEnv: env,
        ...(options.pathAlias ? { pathAlias: options.pathAlias } : facts.pathAlias ? { pathAlias: (t: string) => facts.pathAlias!(t, env) } : {}),
    });
    return { ...base, dataRoot, installed, resolution, ...(resolution.toolchain ? { toolchain: resolution.toolchain } : {}), diagnostics: resolution.diagnostics };
}

export async function createContext(overrides: ContextOverrides = {}): Promise<RuntimeContext> {
    const host = overrides.host ?? currentHost();
    const paths = overrides.dataRoot ? dataPaths(overrides.dataRoot) : dataPaths();
    const { registry, diagnostics } = await BoardRegistry.loadDirectory(paths.boards);
    const env = overrides.env ?? process.env;
    const classroom = overrides.classroom ? await resolveClassroom(host, env, overrides.classroom) : undefined;
    // Classroom mode compares against the installed bundle's own versions, never the reference manifests.
    const manifests = classroom ? (classroom.toolchain ? [bundleCompatibilityManifest(classroom.toolchain.manifest)] : []) : (await loadManifests(paths.toolchains)).manifests;
    const plainRunner = overrides.runner ?? new NodeToolRunner();
    const rawRunner = overrides.onToolOutput ? new OutputTeeRunner(plainRunner, overrides.onToolOutput) : plainRunner;
    const baseRunner = classroom?.toolchain ? new BundledToolRunner(rawRunner, classroom.toolchain, (p) => mkdir(p, { recursive: true })) : rawRunner;
    const platform =
        overrides.platform ??
        createPlatformServices(host, { runner: baseRunner, env, ...(classroom ? { classroom: classroom.toolchain ? { toolchain: classroom.toolchain } : {} } : {}) });
    return {
        host,
        platform,
        boards: registry,
        boardDiagnostics: diagnostics,
        manifests,
        ...(classroom ? { classroom } : {}),
        // The platform's configured runner (e.g. with a pinned tool environment) is used for
        // every tool: detection, GHDL, Apio and anything the adapter itself runs.
        runner: platform.runner ?? baseRunner,
        env,
    };
}

/**
 * Explicit configuration (project setting, then NEXYSVHDL_* env var) wins over
 * platform discovery. In classroom mode there is no explicit configuration and
 * no discovery: only the platform's bundled locator.
 */
export function toolLocatorFor(ctx: RuntimeContext, project?: Project): ToolLocator {
    if (ctx.classroom) return ctx.platform.toolLocator ?? new ChainedToolLocator([]);
    const locators: ToolLocator[] = [new ConfiguredToolLocator(project?.config.toolchain?.tools ?? {}, ctx.env)];
    if (ctx.platform.toolLocator) locators.push(ctx.platform.toolLocator);
    return new ChainedToolLocator(locators);
}

export interface ConfiguredProviders {
    readonly vhdl?: VhdlProvider;
    readonly implementation?: ImplementationProvider;
    readonly rtl?: RtlProvider;
    readonly located: Partial<Record<ToolId, LocatedTool>>;
}

/** Instantiates the shared GHDL/Apio providers when their executables are located. */
export async function providersFor(ctx: RuntimeContext, project?: Project): Promise<ConfiguredProviders> {
    const locator = toolLocatorFor(ctx, project);
    const ghdl = await locator.locate('ghdl');
    const apio = await locator.locate('apio');
    return {
        ...(ghdl ? { vhdl: new GhdlVhdlProvider(ghdl.path, ctx.runner) } : {}),
        ...(apio ? { implementation: new ApioImplementationProvider(apio.path, ctx.runner), rtl: new ApioYosysRtlProvider(apio.path, ctx.runner) } : {}),
        located: { ...(ghdl ? { ghdl } : {}), ...(apio ? { apio } : {}) },
    };
}

export async function controllerFor(ctx: RuntimeContext, project: Project): Promise<WorkflowController> {
    const providers = await providersFor(ctx, project);
    return new WorkflowController({
        boards: ctx.boards,
        workspaces: new WorkspaceManager(),
        ...(providers.vhdl ? { vhdl: providers.vhdl } : {}),
        ...(providers.implementation ? { implementation: providers.implementation } : {}),
        ...(providers.rtl ? { rtl: providers.rtl } : {}),
    });
}

export function programmingFor(ctx: RuntimeContext): ProgrammingService {
    return new ProgrammingService(ctx.platform.programmer);
}

export { loadProject };
