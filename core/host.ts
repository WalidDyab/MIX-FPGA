/**
 * Description of the machine NexysVHDL runs on. The core only reports and
 * passes this along (e.g. to select a toolchain manifest from data); it never
 * branches on it. Platform differences live in platform/ adapters.
 */
export interface HostInfo {
    /** Node's platform name, e.g. `win32`, `darwin`, `linux`. */
    readonly platform: string;
    /** Node's arch name, e.g. `x64`, `arm64`. */
    readonly arch: string;
    readonly nodeVersion: string;
}

export function currentHost(): HostInfo {
    return { platform: process.platform, arch: process.arch, nodeVersion: process.version };
}
