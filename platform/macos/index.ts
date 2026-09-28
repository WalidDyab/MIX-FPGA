import type { PlatformFactory } from '../types';

/**
 * Apple-silicon macOS adapter — placeholder.
 *
 * Phase 3B (macOS agent) adds, in this folder only:
 *  - a ProgrammerProvider for the macOS programming backend (board
 *    detection, artifact preparation, SRAM programming);
 *  - a ToolLocator for macOS tool discovery (GHDL, Apio).
 * See docs/phase3-plan.md.
 */
export const createMacosPlatform: PlatformFactory = () => ({
    id: 'macos',
    displayName: 'macOS',
    status: 'adapter not implemented yet (Phase 3B)',
});
