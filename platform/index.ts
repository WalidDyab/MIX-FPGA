import type { HostInfo } from '../core';
import { createMacosPlatform } from './macos';
import type { PlatformContext, PlatformFactory, PlatformServices } from './types';
import { createWindowsPlatform } from './windows';

export type { PlatformContext, PlatformFactory, PlatformServices, ToolchainInspection, ToolchainInspectionRequest } from './types';

interface Registration {
    readonly platform: string;
    readonly arch: string;
    readonly factory: PlatformFactory;
}

/** The single place where a host is mapped to its adapter. Only validated host kinds are listed. */
const REGISTRY: readonly Registration[] = [
    { platform: 'win32', arch: 'x64', factory: createWindowsPlatform },
    { platform: 'darwin', arch: 'arm64', factory: createMacosPlatform },
];

/** Why a host has no adapter, for doctor and command output. */
function unsupportedReason(host: HostInfo): string {
    if (host.platform === 'darwin') {
        return `macOS on ${host.arch} is not supported: NexysVHDL requires native arm64 (Apple silicon), not Intel or Rosetta`;
    }
    if (REGISTRY.some((r) => r.platform === host.platform)) return `${host.platform} on ${host.arch} is not supported (not validated)`;
    return `platform "${host.platform}" is not supported`;
}

export function findRegistration(host: HostInfo): Registration | undefined {
    return REGISTRY.find((r) => r.platform === host.platform && r.arch === host.arch);
}

export function createPlatformServices(host: HostInfo, context: PlatformContext): PlatformServices {
    const registration = findRegistration(host);
    return registration
        ? registration.factory(host, context)
        : { id: 'unsupported', displayName: `${host.platform}/${host.arch}`, status: unsupportedReason(host) };
}
