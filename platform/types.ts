import type { BundledToolchain, PathAlias, DetectedTool, Diagnostic, HostInfo, ProgrammerProvider, ToolchainManifest, ToolId, ToolLocator, ToolRunner } from '../core';

/** What the composition root hands a platform factory. */
export interface PlatformContext {
    /** Base process runner (a NodeToolRunner in production, a fake in tests). */
    readonly runner: ToolRunner;
    /** Environment the adapter may read (process.env in production). */
    readonly env: Readonly<Record<string, string | undefined>>;
    /**
     * Classroom mode. When present the adapter must take GHDL/Apio (and a
     * bundled programmer) only from `classroom.toolchain` and must never
     * discover tools anywhere else; without an installed toolchain those tools
     * are simply not available.
     */
    readonly classroom?: { readonly toolchain?: BundledToolchain };
}

/** How the board programmer is provided on a platform, for the setup view. */
export interface ProgrammerSetup {
    /** Student-facing name, e.g. "Digilent USB/JTAG Support". */
    readonly name: string;
    /** true: shipped in the NexysVHDL toolchain; false: a system prerequisite the student installs. */
    readonly bundled: boolean;
    /** Official installation guide for a system prerequisite. */
    readonly guide?: string;
    readonly instructions?: string;
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
    /** Where the programmer comes from (bundled, or a system prerequisite with install guidance). */
    readonly programmerSetup?: ProgrammerSetup;
    /** Discovers tool executables on this platform. */
    readonly toolLocator?: ToolLocator;
    /** Full toolchain detection for `doctor`; absent means the core ToolDetector is used. */
    inspectToolchain?(request: ToolchainInspectionRequest): Promise<ToolchainInspection>;
}

export type PlatformFactory = (host: HostInfo, context: PlatformContext) => PlatformServices;

/** Host facts the composition root needs before an adapter exists (classroom toolchain store, tool PATH). */
export interface PlatformHostFacts {
    /** Per-user store of the board-support toolchain (installed toolchains, tool state). */
    userDataRoot(env: Readonly<Record<string, string | undefined>>): string | undefined;
    /** Stores of the predecessor product that may hold the same validated toolchain; reused read-only, never written. */
    legacyDataRoots?(env: Readonly<Record<string, string | undefined>>): string[];
    /** Where the board-support tools keep writable state, when that is not inside their own store (Windows: the MIX-FPGA state area). */
    toolStateRoot?(env: Readonly<Record<string, string | undefined>>): string | undefined;
    /** Operating-system folders every bundled tool may need on PATH. */
    systemPath(env: Readonly<Record<string, string | undefined>>): string[];
    /** An ASCII path resolving to `target`, for folders Apio refuses (Windows profile names, or a macOS home folder, with spaces/Unicode). */
    pathAlias?(target: string, env: Readonly<Record<string, string | undefined>>): Promise<PathAlias>;
}
