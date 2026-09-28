import type { PlatformFactory } from '../types';

/**
 * Windows x64 adapter — placeholder.
 *
 * Phase 3B (Windows agent) adds, in this folder only:
 *  - a ProgrammerProvider for the Digilent Adept stack (board detection,
 *    serial selection, bit-header preparation, SRAM programming);
 *  - a ToolLocator for Windows tool discovery (GHDL, Apio).
 * See docs/phase3-plan.md.
 */
export const createWindowsPlatform: PlatformFactory = () => ({
    id: 'windows',
    displayName: 'Windows',
    status: 'adapter not implemented yet (Phase 3B)',
});
