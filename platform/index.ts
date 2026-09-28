import type { HostInfo } from '../core';
import { createMacosPlatform } from './macos';
import type { PlatformFactory, PlatformServices } from './types';
import { createWindowsPlatform } from './windows';

export type { PlatformFactory, PlatformServices } from './types';

/** The single place where a host is mapped to its adapter. */
const FACTORIES: Readonly<Record<string, PlatformFactory>> = {
    win32: createWindowsPlatform,
    darwin: createMacosPlatform,
};

export function createPlatformServices(host: HostInfo): PlatformServices {
    const factory = FACTORIES[host.platform];
    return factory
        ? factory(host)
        : { id: 'unsupported', displayName: host.platform, status: `platform "${host.platform}" is not supported` };
}
