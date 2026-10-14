import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolInvocation, ToolRunResult, ToolRunner } from '../../core';
import type { RosettaCommand, RosettaHost } from '../../platform/macos/install/rosetta';

export const QUARTUS_BANNER = 'Quartus Prime Shell\nVersion 25.1std.0 Build 1129 10/21/2025 SC Lite Edition\n';

/** One scripted stand-in for the whole Mac: Rosetta, Lima, the engine's Linux and Altera's installer. Nothing real runs. */
export class FakeMachine implements ToolRunner, RosettaHost {
    // Rosetta
    rosettaPresent = false;
    rosettaCommands: RosettaCommand[] = [];
    // Lima
    calls: string[][] = [];
    guest: string[] = [];
    instance: { status: string; config: Record<string, unknown> } | undefined;
    // the engine's contents
    wrapperInstalled = false;
    quartusInstalled = false;
    licenseText = 'QUARTUS PRIME AND INTEL FPGA IP LICENSE AGREEMENT (test text)\n';
    smokeFails = false;
    guestNetworkDown = false;
    quartusInstalls = 0;

    constructor(private readonly limactl: string, private readonly shareDir: string) {}

    // ---- RosettaHost
    appleSilicon = async (): Promise<boolean> => true;
    runtimePresent = async (): Promise<boolean> => this.rosettaPresent;
    translates = async (): Promise<boolean> => this.rosettaPresent;

    async runRosetta(c: RosettaCommand): Promise<{ exitCode: number; output: string }> {
        this.rosettaCommands.push(c);
        this.rosettaPresent = true;
        return { exitCode: 0, output: '' };
    }

    count(verb: string): number {
        return this.calls.filter((c) => c[0] === verb).length;
    }

    async run(inv: ToolInvocation): Promise<ToolRunResult> {
        const base: ToolRunResult = { invocation: inv, outcome: 'exited', exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
        if (inv.executable !== this.limactl) return { ...base, outcome: 'spawn-failed', exitCode: null };
        const a = [...inv.args];
        this.calls.push(a);
        switch (a[0]) {
            case 'list':
                if (a.includes('--format')) return this.instance ? { ...base, stdout: `${this.instance.status}\n` } : { ...base, exitCode: 1, stderr: 'No instance matching' };
                return this.instance ? { ...base, stdout: `${JSON.stringify({ name: 'mix-fpga-de10', status: this.instance.status, errors: null, config: this.instance.config })}\n` } : { ...base, exitCode: 1, stderr: 'No instance matching mix-fpga-de10 found.' };
            case 'create':
                return this.create(a[a.length - 1]!, base);
            case 'delete':
                this.instance = undefined;
                return base;
            case 'start':
                this.instance!.status = 'Running';
                return base;
            case 'stop':
                this.instance!.status = 'Stopped';
                return base;
            case 'shell':
                return this.shell(a[a.length - 1]!, base);
            default:
                return { ...base, exitCode: 2 };
        }
    }

    private async create(yamlFile: string, base: ToolRunResult): Promise<ToolRunResult> {
        const { readFile } = await import('node:fs/promises');
        const y = await readFile(yamlFile, 'utf8');
        const pick = (re: RegExp) => re.exec(y)?.[1];
        this.instance = {
            status: 'Stopped',
            config: {
                cpus: Number(pick(/^cpus: (\d+)/m)), memory: pick(/^memory: (\S+)/m), disk: pick(/^disk: (\S+)/m), vmType: pick(/^vmType: (\S+)/m), arch: pick(/^arch: (\S+)/m),
                images: [{ digest: pick(/digest: "([^"]+)"/) }],
                mounts: [{ location: pick(/mounts:\n- location: "([^"]+)"/), mountPoint: pick(/mountPoint: (\S+)/), writable: /writable: true/.test(y) }],
                vmOpts: { vz: { rosetta: { enabled: /enabled: true/.test(y), binfmt: /binfmt: true/.test(y) } } },
            },
        };
        return base;
    }

    private async shell(s: string, base: ToolRunResult): Promise<ToolRunResult> {
        this.guest.push(s);
        const ok = (stdout = ''): ToolRunResult => ({ ...base, stdout });
        if (s.includes('WRAPPER_OK')) return ok(`${this.wrapperInstalled ? 'WRAPPER_OK\n' : ''}SOCKET_ABSENT\n${this.quartusInstalled ? QUARTUS_BANNER : ''}`);
        if (s.includes('provision-guest.sh')) return this.guestNetworkDown ? { ...base, exitCode: 100, stderr: 'E: Could not resolve archive.ubuntu.com' } : ok();
        if (s.includes('provision-quartus-env.sh')) return ((this.wrapperInstalled = true), ok());
        if (s.includes('MIXFPGA_GUEST_OK')) return this.wrapperInstalled ? ok('MIXFPGA_GUEST_OK\n') : { ...base, exitCode: 1 };
        if (s.includes('ROSETTAD_SOCKET_ACTIVE')) return ok('ROSETTAD_SOCKET_ABSENT\n');
        if (s === 'mixfpga-q quartus_sh --version') return this.quartusInstalled ? ok(QUARTUS_BANNER) : { ...base, exitCode: 127, stderr: 'mixfpga-q: Quartus not found' };
        if (s.includes('--install_lic')) {
            await mkdir(join(this.shareDir, 'provision', 'license-out', 'licenses'), { recursive: true });
            await writeFile(join(this.shareDir, 'provision', 'license-out', 'licenses', 'license.txt'), this.licenseText);
            return ok('MIXFPGA_LICENSE_OK\n');
        }
        if (s.includes('rm -rf "$d"')) return ((this.quartusInstalled = false), ok());
        if (s.includes('--accept_eula')) {
            this.quartusInstalls++;
            if ((await readdir(join(this.shareDir, 'installers')).catch(() => [])).length < 2) return { ...base, exitCode: 1, stderr: 'installer files not found' };
            this.quartusInstalled = true;
            return ok();
        }
        if (s.includes('MISSING_')) return ok();
        if (s.includes('verify-device.tcl')) return ok('MIXFPGA_FAMILY=1\nMIXFPGA_DEVICE=1\n');
        if (s.includes('MIXFPGA_SMOKE_OK')) return this.smokeFails ? { ...base, exitCode: 1, stderr: 'Error (12006)' } : ok('MIXFPGA_SMOKE_OK\n');
        return ok();
    }
}
