import {
    ALL_TOOL_IDS,
    type CompatibilityStatus,
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
import { providersFor, type RuntimeContext, toolLocatorFor } from './context';

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
}

/**
 * Collects host/toolchain/provider state through the platform adapter and
 * the shared toolchain model. Never requires hardware.
 */
export async function inspectEnvironment(ctx: RuntimeContext, project?: Project): Promise<EnvironmentReport> {
    const requestedManifest = project?.config.toolchain?.manifest;
    const manifest = selectManifest(ctx.manifests, ctx.host, requestedManifest);
    const locator = toolLocatorFor(ctx, project);
    const inspection = ctx.platform.inspectToolchain
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
    };
}
