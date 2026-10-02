import {
    ALL_TOOL_IDS,
    type CompatibilityStatus,
    type DetectedTool,
    inspectBundledTools,
    type ToolId,
    type ToolLocator,
    type Diagnostic,
    evaluateToolchain,
    type LocatedTool,
    type ProgrammerAvailability,
    type Project,
    selectManifest,
    type ToolCompatibility,
    type ToolchainManifest,
    ToolDetector,
} from '../core';
import type { ProgrammerSetup } from '../platform';
import { type ClassroomState, providersFor, type RuntimeContext, toolLocatorFor } from './context';

/** Structured environment state: what `doctor` prints and what the extension summarizes. */
export interface EnvironmentReport {
    readonly adapter: { readonly id: string; readonly displayName: string; readonly status: string };
    /** Manifest the toolchain was evaluated against, if any. */
    readonly manifest?: ToolchainManifest;
    /** Manifest id the project asked for, if any (it may not exist). */
    readonly requestedManifest?: string;
    readonly toolchain: { readonly overall: CompatibilityStatus; readonly tools: readonly ToolCompatibility[] };
    /** Platform findings from toolchain inspection. */
    readonly diagnostics: readonly Diagnostic[];
    readonly providers: { readonly ghdl?: LocatedTool; readonly apio?: LocatedTool };
    readonly programmer?: { readonly displayName: string; readonly availability: ProgrammerAvailability };
    /** How the programmer is provided on this platform (bundled, or a system prerequisite). */
    readonly programmerSetup?: ProgrammerSetup;
    /** Classroom mode only: the required/installed NexysVHDL toolchain. */
    readonly classroom?: ClassroomState;
}

/**
 * Collects host/toolchain/provider state through the platform adapter and
 * the shared toolchain model. Never requires hardware.
 */
export async function inspectEnvironment(ctx: RuntimeContext, project?: Project): Promise<EnvironmentReport> {
    const requestedManifest = project?.config.toolchain?.manifest;
    const manifest = selectManifest(ctx.manifests, ctx.host, requestedManifest);
    const locator = toolLocatorFor(ctx, project);
    const inspection = ctx.classroom
        ? await inspectClassroom(ctx, ctx.classroom, locator)
        : ctx.platform.inspectToolchain
          ? await ctx.platform.inspectToolchain({ tools: ALL_TOOL_IDS, locator, ...(manifest ? { manifest } : {}) })
          : { tools: await new ToolDetector(locator, ctx.runner).detectAll(ALL_TOOL_IDS), diagnostics: [] };
    const toolchain = evaluateToolchain(manifest, inspection.tools, ALL_TOOL_IDS);
    const providers = await providersFor(ctx, project);
    const programmer = ctx.platform.programmer;
    return {
        adapter: { id: ctx.platform.id, displayName: ctx.platform.displayName, status: ctx.platform.status },
        ...(manifest ? { manifest } : {}),
        ...(requestedManifest !== undefined ? { requestedManifest } : {}),
        toolchain,
        diagnostics: inspection.diagnostics,
        providers: providers.located,
        ...(programmer ? { programmer: { displayName: programmer.displayName, availability: await programmer.availability() } } : {}),
        ...(ctx.platform.programmerSetup ? { programmerSetup: ctx.platform.programmerSetup } : {}),
        ...(ctx.classroom ? { classroom: ctx.classroom } : {}),
    };
}

/**
 * Classroom mode: the bundled user-space tools are probed from the installed
 * toolchain; only the programmer is asked of the platform adapter (it may be a
 * system prerequisite such as Digilent Adept on Windows).
 */
async function inspectClassroom(ctx: RuntimeContext, classroom: ClassroomState, locator: ToolLocator) {
    const tools = new Map<ToolId, DetectedTool>();
    const userSpace = ALL_TOOL_IDS.filter((t) => t !== 'programmer');
    if (classroom.toolchain) for (const [k, v] of await inspectBundledTools(classroom.toolchain, ctx.runner, userSpace)) tools.set(k, v);
    else for (const t of userSpace) tools.set(t, { tool: t, found: false, method: 'NexysVHDL toolchain not installed' });
    const platform = ctx.platform.inspectToolchain ? await ctx.platform.inspectToolchain({ tools: ['programmer'], locator }) : undefined;
    const prog = platform?.tools.get('programmer');
    if (prog) tools.set('programmer', prog);
    return { tools, diagnostics: [...classroom.diagnostics, ...(platform?.diagnostics ?? [])] };
}
