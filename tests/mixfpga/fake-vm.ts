import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { ToolInvocation, ToolRunResult, ToolRunner } from '../../core';
import { defaultPaths, type De10Paths } from '../../platform/macos/de10/config';
import { FIXTURES, REPO, writeFiles } from '../helpers';

export const QFIX = join(FIXTURES, 'quartus-de10');
export const BANNER = 'Quartus Prime Shell\nVersion 25.1std.0 Build 1129 10/21/2025 SC Lite Edition\n';
const SUCCESS = (what: string) => `Info: Quartus Prime ${what} was successful. 0 errors, 1 warning\n`;
const OK = (stdout = '', exitCode = 0): Partial<ToolRunResult> => ({ outcome: 'exited', exitCode, stdout });

/** An isolated "home" with a share dir, a fake programmer binary and the repo's real provisioning script. */
export async function testPaths(t: TestContext): Promise<{ home: string; paths: De10Paths }> {
    const home = await mkdtemp(join(tmpdir(), 'mix fpga home '));
    t.after(() => rm(home, { recursive: true, force: true }));
    const base = defaultPaths({ repoRoot: REPO, home, toolchainRoot: join(home, 'toolchain') });
    await mkdir(join(home, 'toolchain', 'openfpgaloader-1.1.1', 'libexec'), { recursive: true });
    await writeFile(base.programmer, '#!/bin/sh\n');
    await mkdir(base.shareDir, { recursive: true });
    return { home, paths: base };
}

export interface VmOptions {
    vm?: 'Running' | 'Stopped' | 'missing';
    startFails?: boolean;
    /** What `mixfpga-q quartus_sh --version` does. Sequence: each probe consumes the next entry (last repeats). */
    probes?: Array<'ok' | 'sigbus' | 'missing' | 'wrong-version'>;
    rosettadActive?: boolean;
    failStep?: { tool: string; exitCode: number; withoutSuccessLine?: boolean };
    noSvf?: boolean;
    /** Called with each guest script before it is answered (tests can cancel or tamper here). */
    onGuest?: (script: string) => void | Promise<void>;
    cancelOn?: string;
}

/** A scripted stand-in for limactl + the Linux VM. Never starts a process. */
export class FakeVm implements ToolRunner {
    readonly calls: ToolInvocation[] = [];
    readonly guestScripts: string[] = [];
    readonly limaArgs: string[][] = [];
    remediated = 0;
    private probeIdx = 0;
    state: 'Running' | 'Stopped' | 'missing';
    rosettad: boolean;
    constructor(
        private readonly paths: De10Paths,
        private readonly o: VmOptions = {},
    ) {
        this.state = o.vm ?? 'Running';
        this.rosettad = o.rosettadActive ?? false;
    }

    async run(inv: ToolInvocation): Promise<ToolRunResult> {
        this.calls.push(inv);
        const base: ToolRunResult = { invocation: inv, outcome: 'exited', exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
        if (inv.executable !== this.paths.limactl) return { ...base, outcome: 'spawn-failed', exitCode: null, errorMessage: 'unexpected executable' };
        const a = inv.args;
        this.limaArgs.push([...a]);
        if (a[0] === 'list') return this.state === 'missing' ? { ...base, exitCode: 1, stderr: 'no instance' } : { ...base, stdout: `${this.state}\n` };
        if (a[0] === 'start') {
            if (this.o.startFails) return { ...base, exitCode: 1, stderr: 'FATA[0001] vz driver failed\n' };
            this.state = 'Running';
            return base;
        }
        if (a[0] === 'stop') {
            this.state = 'Stopped';
            return base;
        }
        if (a[0] === 'shell') {
            const script = a[a.length - 1]!;
            this.guestScripts.push(script);
            await this.o.onGuest?.(script);
            if (this.o.cancelOn && script.includes(this.o.cancelOn)) return { ...base, outcome: 'cancelled', exitCode: null };
            return { ...base, ...(await this.guest(script)) };
        }
        return { ...base, exitCode: 2 };
    }

    private async guest(script: string): Promise<Partial<ToolRunResult>> {
        if (script.includes('ROSETTAD_SOCKET_ACTIVE')) return OK(this.rosettad ? 'ROSETTAD_SOCKET_ACTIVE\n' : 'ROSETTAD_SOCKET_ABSENT\n');
        if (script.includes('provision-quartus-env.sh')) {
            this.remediated++;
            this.rosettad = false;
            return OK();
        }
        if (script === 'mixfpga-q quartus_sh --version') {
            const seq = this.o.probes ?? ['ok'];
            const kind = seq[Math.min(this.probeIdx++, seq.length - 1)]!;
            if (kind === 'ok' && !this.rosettad) return OK(BANNER);
            if (kind === 'wrong-version') return OK('Quartus Prime Shell\nVersion 99.9 Build 1\n');
            if (kind === 'missing') return { outcome: 'exited', exitCode: 127, stderr: 'bash: mixfpga-q: command not found\n' };
            return { outcome: 'exited', exitCode: 135, stderr: 'bash: line 1:  4721 Bus error               mixfpga-q quartus_sh --version\n' };
        }
        if (script.includes('pkill')) return OK();
        if (script.includes('sha256sum -c')) return OK('STAGE_OK_1\n');
        const tool = /mixfpga-q (quartus_\w+)/.exec(script)?.[1];
        if (tool) {
            const f = this.o.failStep;
            if (f && f.tool === tool) return f.withoutSuccessLine ? OK(`Info: ran ${tool}\n`) : { outcome: 'exited', exitCode: f.exitCode, stdout: `Error (12345): something broke in ${tool}\nError: Quartus Prime ${tool} was unsuccessful. 1 error, 0 warnings\n` };
            const what = { quartus_map: 'Analysis & Synthesis', quartus_fit: 'Fitter', quartus_asm: 'Assembler', quartus_sta: 'Timing Analyzer', quartus_cpf: 'Convert_programming_file' }[tool] ?? tool;
            return OK(`Warning (18236): Number of processors has not been specified\n${SUCCESS(what)}`);
        }
        const out = /cp -a .* '(?:\/mnt\/mixfpga)\/jobs\/([^/']+)\/output_files'/.exec(script);
        if (out) {
            const dir = join(this.paths.shareDir, 'jobs', out[1]!, 'output_files');
            await mkdir(dir, { recursive: true });
            for (const n of ['blink.map.summary', 'blink.fit.summary', 'blink.sta.summary']) await copyFile(join(QFIX, n), join(dir, n));
            await copyFile(join(QFIX, 'blink.sta.fmax.rpt'), join(dir, 'blink.sta.rpt'));
            await writeFiles(dir, { 'blink.sof': 'SOF-BYTES', ...(this.o.noSvf ? {} : { 'blink.svf': 'SVF-BYTES-1234' }) });
            return OK();
        }
        return OK(); // rm/mkdir/cp staging commands
    }
}

/** A tiny student project: src/blink.vhd + constraints/{de10-lite.qsf,.sdc}. Returns its root (name contains spaces). */
export async function makeDe10Project(t: TestContext, qsfDevice = '10M50DAF484C7G'): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'my de10 project '));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFiles(root, {
        'src/blink.vhd': 'entity blink is\n port (clk_50 : in bit; ledr0 : out bit);\nend entity blink;\n',
        'constraints/de10-lite.qsf': `set_global_assignment -name FAMILY "MAX 10"\nset_global_assignment -name DEVICE ${qsfDevice}\nset_location_assignment PIN_P11 -to clk_50\n`,
        'constraints/de10-lite.sdc': 'create_clock -name clk_50 -period 20.000 [get_ports clk_50]\n',
    });
    return root;
}
