import { win32 } from 'node:path';
import type { ToolRunner } from '../../../core/process/tool-runner';
import type { WindowsDe10Paths } from '../de10/config';
import type { WindowsRuntimeLayout } from './layout';

/** Default Altera install locations, in order; a different location is found through the Windows uninstall records. */
export const QUARTUS_DEFAULT_ROOTS: readonly string[] = ['C:\\intelFPGA_lite\\25.1std', 'C:\\altera_lite\\25.1std', 'C:\\intelFPGA_lite\\25.1', 'C:\\altera_lite\\25.1'];

/**
 * The DE10-Lite backend's tool paths when everything comes from the installed MIX-FPGA toolchain.
 * This is the only place the runtime learns where its tools are; there is no repository fallback.
 */
export function installedWindowsDe10Paths(layout: WindowsRuntimeLayout, runner?: ToolRunner): WindowsDe10Paths {
    return {
        toolchainRoot: layout.toolchainDir,
        ghdl: win32.join(layout.unit('ghdl'), 'bin', 'ghdl.exe'),
        yosys: win32.join(layout.unit('yosys'), 'bin', 'yosys.exe'),
        partCheckScript: win32.join(layout.unit('scripts'), 'part-check.tcl'),
        jobsRoot: layout.jobsRoot,
        quartusCandidates: QUARTUS_DEFAULT_ROOTS,
        ...(runner ? { discoverRoots: () => registryQuartusRoots(runner) } : {}),
    };
}

/** `Key    REG_SZ    value` lines of `reg query`. */
export function parseRegValue(text: string, name: string): string | undefined {
    for (const line of text.split(/\r?\n/)) {
        const m = new RegExp(`^\\s+${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*?)\\s*$`, 'i').exec(line);
        if (m) return m[1]!;
    }
    return undefined;
}

const UNINSTALL = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

/**
 * Install roots of Quartus Prime Lite 25.1 recorded by the Windows uninstall records (Altera's installer writes one per
 * install), read with `reg query`. Read-only. A folder chosen at install time is found this way.
 */
export async function registryQuartusRoots(runner: ToolRunner): Promise<string[]> {
    const roots = new Set<string>();
    for (const hive of [`HKLM\\${UNINSTALL}`, `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, `HKCU\\${UNINSTALL}`]) {
        // Keys whose DisplayName mentions Quartus Prime Lite 25.1 (the query prints the key, then the matching value).
        const found = await runner.run({ executable: 'reg.exe', args: ['query', hive, '/s', '/f', 'Quartus Prime Lite Edition (Free) 25.1', '/d'], timeoutMs: 20_000 });
        if (found.outcome !== 'exited') continue;
        for (const key of found.stdout.split(/\r?\n/).filter((l) => /^HKEY_/i.test(l.trim())).map((l) => l.trim())) {
            const v = await runner.run({ executable: 'reg.exe', args: ['query', key, '/v', 'InstallLocation'], timeoutMs: 10_000 });
            const loc = v.outcome === 'exited' ? parseRegValue(v.stdout, 'InstallLocation') : undefined;
            if (loc) roots.add(loc.replace(/\//g, '\\').replace(/\\+$/, ''));
        }
    }
    return [...roots];
}

/** `LongPathsEnabled` from the registry (read only). Undefined when it cannot be read. */
export async function readLongPathsEnabled(runner: ToolRunner): Promise<boolean | undefined> {
    const r = await runner.run({ executable: 'reg.exe', args: ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'], timeoutMs: 10_000 });
    if (r.outcome !== 'exited' || r.exitCode !== 0) return undefined;
    const m = /LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.stdout);
    return m ? Number.parseInt(m[1]!, 16) !== 0 : undefined;
}

/** Whether Altera's USB-Blaster driver package is in the Windows driver store (`pnputil /enum-drivers`; read only). MIX-FPGA never installs or changes drivers. */
export async function alteraDriverPresent(runner: ToolRunner): Promise<boolean | undefined> {
    const r = await runner.run({ executable: 'pnputil.exe', args: ['/enum-drivers'], timeoutMs: 30_000 });
    if (r.outcome !== 'exited' || r.exitCode !== 0) return undefined;
    return /usbblstr\.inf/i.test(r.stdout);
}
