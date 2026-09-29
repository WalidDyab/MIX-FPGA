import type { DetectedTool, Diagnostic, HostInfo, ProgrammerProvider, ToolchainManifest, ToolId, ToolLocator, ToolRunner } from '../core';

/** What the composition root hands a platform factory. */
export interface PlatformContext {
    /** Base process runner (a NodeToolRunner in production, a fake in tests). */
    readonly runner: ToolRunner;
    /** Environment the adapter may read (process.env in production). */
    readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ToolchainInspectionRequest {
    readonly tools: readonly ToolId[];
    /** Tested versions for this host, if a manifest was selected. */
    readonly manifest?: ToolchainManifest;
    /** The composition root's locator (explicit settings first, then platform discovery). */
    readonly locator: ToolLocator;
}

/** Platform-specific toolchain state, in the shared toolchain model. */
export interface ToolchainInspection {
    /** Detection per tool; a tool that was not checked is absent. */
    readonly tools: ReadonlyMap<ToolId, DetectedTool>;
    /** Platform findings worth showing (e.g. an unusable pin or an unsupported package). */
    readonly diagnostics: readonly Diagnostic[];
}

/**
 * Capabilities a platform adapter contributes. Everything is optional:
 * a missing capability surfaces as "not configured", never as success.
 */
export interface PlatformServices {
    /** Adapter id, e.g. `windows`, `macos`, `unsupported`. */
    readonly id: string;
    readonly displayName: string;
    /** One-line state for `doctor`. */
    readonly status: string;
    /**
     * The runner every external tool must be started through on this platform.
     * It may decorate the base runner from PlatformContext (e.g. per-tool
     * environment); absent means the base runner is used unchanged.
     */
    readonly runner?: ToolRunner;
    readonly programmer?: ProgrammerProvider;
    /** Discovers tool executables on this platform. */
    readonly toolLocator?: ToolLocator;
    /** Full toolchain detection for `doctor`; absent means the core ToolDetector is used. */
    inspectToolchain?(request: ToolchainInspectionRequest): Promise<ToolchainInspection>;
}

export type PlatformFactory = (host: HostInfo, context: PlatformContext) => PlatformServices;
