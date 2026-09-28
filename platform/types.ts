import type { HostInfo, ProgrammerProvider, ToolLocator } from '../core';

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
    readonly programmer?: ProgrammerProvider;
    /** Discovers tool executables on this platform. */
    readonly toolLocator?: ToolLocator;
}

export type PlatformFactory = (host: HostInfo) => PlatformServices;
