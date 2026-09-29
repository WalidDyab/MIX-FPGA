import type { PlatformFactory } from '../types';

export { createWindowsPlatformServices, defaultWindowsEnvironment } from './windows-platform';
export type { WindowsPlatformOptions, WindowsPlatformServices } from './windows-platform';
export { DigilentArtifactError, DigilentProgrammer, prepareDigilentBitstream, PREPARED_BITSTREAM_NAME } from './digilent/digilent-programmer';
export { digilentPartName, normalizeForDigilent, parseBitHeader } from './digilent/bit-header';
export { describeAdept, inspectAdept } from './digilent/adept-environment';
export { WindowsToolchainInspector } from './toolchain-inspector';
export { WindowsToolLocator } from './tool-locator';
export { nodeWindowsFileSystem } from './host-environment';
export type { WindowsFileSystem, WindowsHostEnvironment } from './host-environment';

/**
 * Registered Windows entry point — still the Phase 3A placeholder.
 *
 * The real adapter is createWindowsPlatformServices() (./windows-platform).
 * It is deliberately not wired in here during Phase 3B: platform/index.ts and
 * tests/cli.test.ts still expect a placeholder on win32. Phase 3C activates it
 * by pointing this registration at createWindowsPlatformServices.
 */
export const createWindowsPlatform: PlatformFactory = () => ({
    id: 'windows',
    displayName: 'Windows',
    status: 'adapter not implemented yet (Phase 3B)',
});
