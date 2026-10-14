import { join } from 'node:path';

/**
 * Where the DE10-Lite backend finds its own tools. Everything lives under MIX-FPGA's own
 * toolchain root; nothing here may point into another product's toolchain.
 */
export interface De10Paths {
    /** Contains `lima-<ver>/` and `openfpgaloader-<ver>/`. */
    readonly toolchainRoot: string;
    readonly limactl: string;
    readonly limaHome: string;
    readonly instance: string;
    /** Host directory shared with the VM (writable). */
    readonly shareDir: string;
    /** Same directory as seen inside the VM. */
    readonly guestShareDir: string;
    readonly programmer: string;
    readonly programmerDataDir: string;
    /** MIX-FPGA's own GHDL and Yosys (VHDL check, simulation, RTL schematic): no dependency on any other product's toolchain. */
    readonly ghdl: string;
    readonly yosys: string;
    /** Idempotent guest provisioning script, re-run to repair known failure modes. */
    readonly provisionScript: string;
}

export interface De10Versions {
    readonly lima: string;
    readonly programmer: string;
    readonly ghdl: string;
    readonly yosys: string;
    /** Banner fragment the Quartus probe must print. */
    readonly quartusBanner: string;
}

export const PINNED: De10Versions = { lima: '2.2.1', programmer: '1.1.1', ghdl: '6.0.0', yosys: '0.63', quartusBanner: '25.1std.0 Build 1129' };

export function defaultPaths(opts: { repoRoot: string; home: string; toolchainRoot?: string }): De10Paths {
    const toolchainRoot = opts.toolchainRoot ?? join(opts.repoRoot, 'toolchains', 'experimental');
    const programmerDir = join(toolchainRoot, `openfpgaloader-${PINNED.programmer}`);
    return {
        toolchainRoot,
        limactl: join(toolchainRoot, `lima-${PINNED.lima}`, 'bin', 'limactl'),
        limaHome: join(opts.home, 'Library', 'MIX-FPGA', 'lima'),
        instance: 'mix-fpga-de10',
        shareDir: join(opts.home, 'Library', 'MIX-FPGA', 'staging'),
        guestShareDir: '/mnt/mixfpga',
        programmer: join(programmerDir, 'libexec', 'openFPGALoader'),
        programmerDataDir: join(programmerDir, 'share', 'openFPGALoader'),
        ghdl: join(toolchainRoot, `ghdl-${PINNED.ghdl}`, 'bin', 'ghdl'),
        yosys: join(toolchainRoot, `yosys-${PINNED.yosys}`, 'libexec', 'yosys'),
        provisionScript: join(opts.repoRoot, 'platform', 'macos', 'lima', 'provision-quartus-env.sh'),
    };
}
