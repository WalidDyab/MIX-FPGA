import { join } from 'node:path';
import type { De10Paths } from '../de10/config';
import { LIMA_INSTANCE, type RuntimeLayout } from './layout';

/**
 * The DE10-Lite backend's tool paths when everything comes from the installed MIX-FPGA toolchain.
 * This is the only place the runtime learns where its tools are; there is no repository fallback.
 */
export function installedDe10Paths(layout: RuntimeLayout): De10Paths {
    const programmerDir = layout.unit('openfpgaloader');
    return {
        toolchainRoot: layout.toolchainDir,
        limactl: join(layout.unit('lima'), 'bin', 'limactl'),
        limaHome: layout.limaHome,
        instance: LIMA_INSTANCE,
        shareDir: layout.shareDir,
        guestShareDir: '/mnt/mixfpga',
        programmer: join(programmerDir, 'libexec', 'openFPGALoader'),
        programmerDataDir: join(programmerDir, 'share', 'openFPGALoader'),
        ghdl: join(layout.unit('ghdl'), 'bin', 'ghdl'),
        yosys: join(layout.unit('yosys'), 'libexec', 'yosys'),
        provisionScript: join(layout.unit('engine'), 'provision-quartus-env.sh'),
    };
}
