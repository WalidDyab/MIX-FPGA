import { join } from 'node:path';

/**
 * Where the DE10-Lite backend finds its own tools on Windows. The MIX-FPGA-owned tools live under MIX-FPGA's
 * own toolchain root; nothing here may point into another product's toolchain (the NexysVHDL Toolchain).
 * Quartus is the one external piece: the student installs it from Altera, so its location is discovered.
 */
export interface WindowsDe10Paths {
    /** Contains `ghdl-<ver>/` and `yosys-<ver>/`. Programming uses the student's own Quartus (quartus_pgm), not an owned tool. */
    readonly toolchainRoot: string;
    readonly ghdl: string;
    readonly yosys: string;
    /** MIX-FPGA's support script that asks Quartus whether the MAX 10 part is available (hash-verified with the toolchain). */
    readonly partCheckScript: string;
    /** Host directory in which every build gets a private job folder (`<MIX-FPGA root>\staging\jobs`). */
    readonly jobsRoot: string;
    /** Install roots to look in for Quartus, in order (each contains `quartus\bin64\quartus_sh.exe`). */
    readonly quartusCandidates: readonly string[];
    /** More install roots found at run time (the Windows uninstall records); consulted after the candidates. */
    readonly discoverRoots?: () => Promise<readonly string[]>;
}

export interface WindowsDe10Versions {
    readonly ghdl: string;
    readonly yosys: string;
    /** Banner fragment the Quartus probe must print. */
    readonly quartusBanner: string;
    /** The exact orderable part Quartus itself must list as available. */
    readonly targetPart: string;
}

export const WINDOWS_PINNED: WindowsDe10Versions = { ghdl: '6.0.0', yosys: '0.63', quartusBanner: '25.1std.0 Build 1129', targetPart: '10M50DAF484C7G' };

/** Development and test paths (tools in a folder beside the repository). The product itself resolves its tools only from the installed layout. */
export function defaultWindowsPaths(opts: { repoRoot: string; localAppData: string; toolchainRoot?: string; quartusRoot?: string }): WindowsDe10Paths {
    const toolchainRoot = opts.toolchainRoot ?? join(opts.repoRoot, 'toolchains', 'experimental');
    const stateDir = join(opts.localAppData, 'MIX-FPGA');
    return {
        toolchainRoot,
        ghdl: join(toolchainRoot, `ghdl-${WINDOWS_PINNED.ghdl}`, 'bin', 'ghdl.exe'),
        yosys: join(toolchainRoot, `yosys-${WINDOWS_PINNED.yosys}`, 'bin', 'yosys.exe'),
        partCheckScript: join(opts.repoRoot, 'platform', 'windows', 'scripts', 'part-check.tcl'),
        jobsRoot: join(stateDir, 'staging', 'jobs'),
        // Altera's default install location first, then the older vendor folder names.
        quartusCandidates: opts.quartusRoot ? [opts.quartusRoot] : ['C:\\intelFPGA_lite\\25.1std', 'C:\\altera_lite\\25.1std', 'C:\\intelFPGA_lite\\25.1', 'C:\\altera_lite\\25.1'],
    };
}
