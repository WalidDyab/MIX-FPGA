import type { HostInfo } from '../core';
import { createMacosPlatform, macosLegacyDataRoots, macosPathAlias, macosSystemPath, macosUserDataRoot } from './macos';
import type { PlatformContext, PlatformFactory, PlatformHostFacts, PlatformServices } from './types';
import { createWindowsPlatform, windowsLegacyDataRoots, windowsPathAlias, windowsSystemPath, windowsToolStateRoot, windowsUserDataRoot } from './windows';

export type { PlatformContext, PlatformFactory, PlatformHostFacts, PlatformServices, ProgrammerSetup, ToolchainInspection, ToolchainInspectionRequest } from './types';

interface Registration extends PlatformHostFacts {
    readonly platform: string;
    readonly arch: string;
    readonly factory: PlatformFactory;
}

/** The single place where a host is mapped to its adapter. Only validated host kinds are listed. */
const REGISTRY: readonly Registration[] = [
    { platform: 'win32', arch: 'x64', factory: createWindowsPlatform, userDataRoot: windowsUserDataRoot, legacyDataRoots: windowsLegacyDataRoots, toolStateRoot: windowsToolStateRoot, systemPath: windowsSystemPath, pathAlias: (target, env) => windowsPathAlias(target, env) },
    { platform: 'darwin', arch: 'arm64', factory: createMacosPlatform, userDataRoot: macosUserDataRoot, legacyDataRoots: macosLegacyDataRoots, systemPath: macosSystemPath, pathAlias: (target, env) => macosPathAlias(target, env) },
];

/** Why a host has no adapter, for doctor and command output. */
export function unsupportedReason(host: HostInfo): string {
    if (host.platform === 'darwin') {
        return `macOS on ${host.arch} is not supported: NexysVHDL requires native arm64 (Apple silicon), not Intel or Rosetta`;
    }
    if (REGISTRY.some((r) => r.platform === host.platform)) return `${host.platform} on ${host.arch} is not supported (not validated)`;
    return `platform "${host.platform}" is not supported`;
}

export function findRegistration(host: HostInfo): Registration | undefined {
    return REGISTRY.find((r) => r.platform === host.platform && r.arch === host.arch);
}

/** Host facts for a supported host; undefined for an unsupported one. */
export function platformHostFacts(host: HostInfo): PlatformHostFacts | undefined {
    return findRegistration(host);
}

export function createPlatformServices(host: HostInfo, context: PlatformContext): PlatformServices {
    const registration = findRegistration(host);
    return registration
        ? registration.factory(host, context)
        : { id: 'unsupported', displayName: `${host.platform}/${host.arch}`, status: unsupportedReason(host) };
}
