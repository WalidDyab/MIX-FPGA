import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { ToolInvocation, ToolRunResult, ToolRunner } from '../../core';
import { defaultWindowsPaths, type WindowsDe10Paths } from '../../platform/windows/de10/config';
import { FIXTURES, REPO, writeFiles } from '../helpers';

export const QFIX = join(FIXTURES, 'quartus-de10');
export const BANNER = 'TBBmalloc: skip allocation functions replacement in ucrtbase.dll: unknown prologue for function _msize\r\nQuartus Prime Shell\r\nVersion 25.1std.0 Build 1129 10/21/2025 SC Lite Edition\r\n';
const SUCCESS = (what: string) => `Info: Quartus Prime ${what} was successful. 0 errors, 1 warning\r\n`;
const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

export interface WindowsTestEnv {
    readonly root: string;
    readonly paths: WindowsDe10Paths;
    /** The fake Quartus install root (contains quartus\bin64\quartus_sh.exe). */
    readonly quartusRoot: string;
}

export interface Hardware {
    /** Cables Quartus lists (default one USB-Blaster). */
    cables?: string[];
    /** Chain per cable: IDCODEs (hex), or 'none' for an unpowered board (default 031050DD on every cable). */
    chains?: Record<string, string[] | 'none'>;
    /** `quartus_pgm -l` / `jtagconfig` fail (JTAG server problem). */
    serverFails?: boolean;
    /** quartus_pgm programming run: exit code and whether it prints the success lines. */
    programExit?: number;
    programQuiet?: boolean;
    /** After a successful programming run the chain can no longer be read. */
    chainLostAfterProgram?: boolean;
    /** Called when the programming run starts (tests cancel or tamper here). */
    onProgram?: (inv: ToolInvocation) => void | Promise<void>;
}

export const DEFAULT_CABLE = 'USB-Blaster [USB-0]';

export interface QuartusOptions {
    /** Which Quartus is installed: the pinned one, an older one, or none. */
    install?: 'pinned' | 'other-version' | 'none';
    /** What Quartus's own device database says when asked for the MAX 10 part list (default: the part is there). */
    parts?: 'ok' | 'no-max10' | 'part-missing' | 'command-fails' | 'empty-output' | 'garbage';
    failStep?: { tool: string; exitCode: number; withoutSuccessLine?: boolean };
    noSvf?: boolean;
    /** Called with each tool name before it is answered. */
    onTool?: (tool: string, inv: ToolInvocation) => void | Promise<void>;
    cancelOn?: string;
    /** What the JTAG hardware looks like (default: one USB-Blaster with the DE10-Lite's MAX 10 on its chain). */
    hardware?: Hardware;
    /** Write report files with Windows line endings (real Quartus on Windows does). */
    crlf?: boolean;
}

/** An isolated "LOCALAPPDATA" and a fake Quartus install layout; nothing here is ever executed. */
export async function windowsEnv(t: TestContext, o: QuartusOptions = {}): Promise<WindowsTestEnv> {
    const root = await mkdtemp(join(tmpdir(), 'mix fpga win '));
    t.after(() => rm(root, { recursive: true, force: true }));
    const quartusRoot = join(root, 'intelFPGA_lite', o.install === 'other-version' ? '23.1std' : '25.1std');
    const paths = defaultWindowsPaths({ repoRoot: REPO, localAppData: join(root, 'AppData Local'), toolchainRoot: join(root, 'toolchain'), quartusRoot: join(root, 'intelFPGA_lite', '25.1std') });
    const withParents = { ...paths, quartusCandidates: [join(root, 'intelFPGA_lite', '25.1std')] };
    if (o.install !== 'none') {
        await mkdir(join(quartusRoot, 'quartus', 'bin64'), { recursive: true });
        await writeFile(join(quartusRoot, 'quartus', 'bin64', 'quartus_sh.exe'), 'MZ');
    }
    for (const p of [paths.ghdl, paths.yosys]) {
        await mkdir(join(p, '..'), { recursive: true });
        await writeFile(p, 'MZ');
    }
    return { root, paths: withParents, quartusRoot };
}

/** A scripted stand-in for the native Quartus command-line tools. Never starts a process. */
export class FakeQuartusRunner implements ToolRunner {
    readonly calls: ToolInvocation[] = [];
    /** Programming runs seen: their full argument lists. */
    get programRuns(): string[][] {
        return this.calls.filter((c) => /quartus_pgm\.exe$/.test(c.executable) && c.args.includes('-o')).map((c) => [...c.args]);
    }
    private readonly state = { programmed: false };
    constructor(
        private readonly env: WindowsTestEnv,
        private readonly o: QuartusOptions = {},
    ) {}

    /** Names of the Quartus tools run, in order (`quartus_sh --version` and `-t` part-check script excluded). */
    get chain(): string[] {
        return this.calls.filter((c) => /quartus_(?!pgm)\w+\.exe$/.test(c.executable) && c.args[0] !== '--version' && c.args[0] !== '-t').map((c) => /(quartus_\w+)\.exe$/.exec(c.executable)![1]!);
    }

    async run(inv: ToolInvocation): Promise<ToolRunResult> {
        this.calls.push(inv);
        const base: ToolRunResult = { invocation: inv, outcome: 'exited', exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
        const tool = /[\\/](quartus_\w+|jtagconfig)\.exe$/.exec(inv.executable)?.[1];
        if (!tool) return { ...base, outcome: 'spawn-failed', exitCode: null, errorMessage: `unexpected executable ${inv.executable}` };
        await this.o.onTool?.(tool, inv);
        if (this.o.cancelOn === tool) return { ...base, outcome: 'cancelled', exitCode: null };
        if (tool === 'quartus_sh' && inv.args[0] === '--version') {
            return this.env.quartusRoot.endsWith('23.1std') ? { ...base, stdout: crlf('Quartus Prime Shell\nVersion 23.1std.0 Build 991 11/28/2023 SC Lite Edition\n'), stderr: 'TBBmalloc: skip\r\n' } : { ...base, stdout: BANNER };
        }
        if (tool === 'quartus_pgm' || tool === 'jtagconfig') return jtagResponse(this.o.hardware ?? {}, this.state, tool, inv, base);
        if (tool === 'quartus_sh' && inv.args[0] === '-t') {
            assertTcl(await readFile(inv.args[1]!, 'utf8'));
            switch (this.o.parts ?? 'ok') {
                case 'ok': return { ...base, stdout: 'Info: Running Quartus Prime Shell\r\nMIXFPGA_PARTS count=271 target=1\r\nInfo: Quartus Prime Shell was successful.\r\n' };
                case 'no-max10': return { ...base, stdout: 'MIXFPGA_PARTS count=0 target=0\r\n' };
                case 'part-missing': return { ...base, stdout: 'MIXFPGA_PARTS count=270 target=0\r\n' };
                case 'command-fails': return { ...base, exitCode: 2, stderr: "Error: Can't load package device\r\n" };
                case 'empty-output': return { ...base, stdout: '' };
                case 'garbage': return { ...base, stdout: 'MIXFPGA_PARTS count=abc target=maybe\r\n{MAX 10}\r\n' };
            }
        }
        const f = this.o.failStep;
        if (f && f.tool === tool) return f.withoutSuccessLine ? { ...base, stdout: `Info: ran ${tool}\r\n` } : { ...base, exitCode: f.exitCode, stdout: `Error (12345): something broke in ${tool}\r\nError: Quartus Prime ${tool} was unsuccessful. 1 error, 0 warnings\r\n` };
        const what = ({ quartus_map: 'Analysis & Synthesis', quartus_fit: 'Fitter', quartus_asm: 'Assembler', quartus_sta: 'Timing Analyzer', quartus_cpf: 'Convert_programming_file' } as Record<string, string>)[tool] ?? tool;
        // The tools write into their working directory (the job folder, or output_files for the conversion).
        const cwd = inv.cwd!;
        if (tool === 'quartus_asm') {
            const dir = join(cwd, 'output_files');
            await mkdir(dir, { recursive: true });
            await writeFiles(dir, { 'blink.sof': 'SOF-BYTES' });
        }
        if (tool === 'quartus_sta') {
            const dir = join(cwd, 'output_files');
            await mkdir(dir, { recursive: true });
            await copyReports(dir, this.o.crlf === true);
        }
        if (tool === 'quartus_cpf' && !this.o.noSvf) await writeFiles(cwd, { 'blink.svf': 'SVF-BYTES-1234' });
        return { ...base, stdout: `Warning (18236): Number of processors has not been specified\r\n${SUCCESS(what)}` };
    }
}

/** The query must go through Quartus's device package and ask for the exact part. */
function assertTcl(script: string | undefined): void {
    if (!script || !/load_package device/.test(script) || !/get_part_list -family {MAX 10}]/.test(script) || !script.includes('10M50DAF484C7G')) throw new Error(`unexpected part query: ${script}`);
}

/** Quartus's `Info:` banner and footer around a tool's real output. */
const pgmWrap = (body: string): string => `Info: Running Quartus Prime Programmer\r\n    Info: Version 25.1std.0 Build 1129 10/21/2025 SC Lite Edition\r\n${body}`;

async function jtagResponse(hw: Hardware, state: { programmed: boolean }, tool: string, inv: ToolInvocation, base: ToolRunResult): Promise<ToolRunResult> {
    const cables = hw.cables ?? [DEFAULT_CABLE];
    const chainOf = (cable: string): string[] | 'none' => state.programmed && hw.chainLostAfterProgram ? 'none' : (hw.chains?.[cable] ?? ['031050DD']);
    if (hw.serverFails && !inv.args.includes('--version')) return { ...base, exitCode: 1, stderr: 'Error: Can\'t connect to JTAG server\r\n' };
    if (tool === 'jtagconfig') {
        const lines = cables.flatMap((c, n) => {
            const chain = chainOf(c);
            return [`${n + 1}) ${c}`, ...(chain === 'none' ? ['  Unable to read device chain - JTAG chain broken'] : chain.map((id) => `  ${id}   10M50DA(.|ES)/10M50DC`))];
        });
        return { ...base, stdout: lines.join('\r\n') + '\r\n' };
    }
    if (inv.args[0] === '--version') return { ...base, stdout: BANNER };
    if (inv.args[0] === '-l') return { ...base, stdout: pgmWrap(cables.map((c, n) => `${n + 1}) ${c}`).join('\r\n') + '\r\nInfo: Quartus Prime Programmer was successful. 0 errors, 0 warnings\r\n') };
    // a programming run
    await hw.onProgram?.(inv);
    if (inv.signal?.aborted) return { ...base, outcome: 'cancelled', exitCode: null };
    const target = join(inv.cwd ?? '', /^p;(.+)@\d+$/.exec(inv.args[inv.args.indexOf('-o') + 1] ?? '')?.[1] ?? '?');
    const exists = await import('node:fs/promises').then((f) => f.stat(target)).then(() => true, () => false);
    if (!exists) return { ...base, exitCode: 2, stdout: 'Error (213019): file not found\r\n' };
    if ((hw.programExit ?? 0) !== 0) return { ...base, exitCode: hw.programExit!, stdout: pgmWrap('Error (209012): Operation failed\r\nError: Quartus Prime Programmer was unsuccessful. 1 error, 0 warnings\r\n') };
    state.programmed = true;
    if (hw.programQuiet) return { ...base, stdout: pgmWrap('Info: nothing happened\r\n') };
    return { ...base, stdout: pgmWrap('Info (209016): Configuring device index 1\r\nInfo (209017): Device 1 contains JTAG ID code 0x031050DD\r\nInfo (209007): Configuration succeeded -- 1 device(s) configured\r\nInfo (209011): Successfully performed operation(s)\r\nInfo: Quartus Prime Programmer was successful. 0 errors, 0 warnings\r\n') };
}

async function copyReports(dir: string, windowsEndings: boolean): Promise<void> {
    for (const [from, to] of [['blink.map.summary', 'blink.map.summary'], ['blink.fit.summary', 'blink.fit.summary'], ['blink.sta.summary', 'blink.sta.summary'], ['blink.sta.fmax.rpt', 'blink.sta.rpt']] as const) {
        if (windowsEndings) await writeFile(join(dir, to), crlf((await (await import('node:fs/promises')).readFile(join(QFIX, from), 'utf8'))));
        else await copyFile(join(QFIX, from), join(dir, to));
    }
}
