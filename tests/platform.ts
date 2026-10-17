/**
 * Platform gates for tests whose subject only exists on one host. A gated test keeps its assertions exactly as written; it
 * simply does not run where the thing it exercises (APFS clones, POSIX mode bits and symbolic links, Lima, Rosetta, the
 * macOS install layout) does not exist. The Windows product has its own tests for its own flow in tests/windows-install.
 */
export const ONLY_MACOS: string | false = process.platform === 'darwin' ? false : 'macOS-only: exercises the macOS install flow (Lima, Rosetta, APFS, POSIX modes and links)';
export const ONLY_WINDOWS: string | false = process.platform === 'win32' ? false : 'Windows-only: exercises the Windows install flow';
