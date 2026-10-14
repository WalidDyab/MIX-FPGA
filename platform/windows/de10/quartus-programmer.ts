import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { BoardProfile, DetectedDevice, HardwareDetection, ProgramOutcome, ProgramRequest, ProgrammingProvider } from '../../../core/backend/types';
import type { ToolRunResult } from '../../../core/process/tool-runner';
import { errorDiag, hasErrors, infoDiag, type Diagnostic } from '../../../core/results/diagnostic';
import type { NativeQuartusEngine } from './native-quartus-engine';
import type { QuartusInstall } from './quartus-install';

const P = (code: string, msg: string): Diagnostic => errorDiag('programming', code, msg);

/** Rows of `quartus_pgm -l`: `1) USB-Blaster [USB-0]`. */
export function parseCables(text: string): string[] {
    const out: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*\d+\)\s+(.+?)\s*$/.exec(line);
        if (m) out.push(m[1]!);
    }
    return out;
}

export interface CableChain {
    readonly cable: string;
    readonly devices: readonly DetectedDevice[];
    /** Quartus's own complaint about this cable's chain (`Unable to read device chain`), if any. */
    readonly problem?: string;
}

/**
 * Blocks of `jtagconfig`:
 *
 *     1) USB-Blaster [USB-0]
 *       031050DD   10M50DA(.|ES)/10M50DC
 *
 * `index` is the 1-based position in the chain, which is what `quartus_pgm -o "p;file.sof@N"` addresses.
 */
export function parseChains(text: string): CableChain[] {
    const out: { cable: string; devices: DetectedDevice[]; problem?: string }[] = [];
    for (const line of text.split(/\r?\n/)) {
        const c = /^\s*\d+\)\s+(.+?)\s*$/.exec(line);
        if (c) {
            out.push({ cable: c[1]!, devices: [] });
            continue;
        }
        const cur = out[out.length - 1];
        if (!cur || line.trim() === '') continue;
        const d = /^\s+([0-9A-Fa-f]{8})\s+(.+?)\s*$/.exec(line);
        if (d) cur.devices.push({ index: cur.devices.length + 1, idcode: Number.parseInt(d[1]!, 16), model: d[2]! });
        else if (/unable|error|broken|not found/i.test(line)) cur.problem = line.trim();
    }
    return out;
}

const hex = (n: number): string => `0x${n.toString(16).padStart(8, '0')}`;

/** Only the three words a programming run must say; anything else is not trusted. */
const CONFIGURED = /Configuration succeeded -- 1 device\(s\) configured/;
const PROGRAMMER_OK = /Quartus Prime Programmer was successful/;

/**
 * Windows programmer for boards with an Altera USB-Blaster: the Quartus `quartus_pgm` through the standard Altera
 * driver, loading the build's `.sof` into SRAM over JTAG. It never changes a driver, never writes configuration
 * flash, and uses no other programming tool.
 */
export class QuartusPgmProgrammer implements ProgrammingProvider {
    // Same role id as the macOS programmer: the board names the role, the host supplies the tool.
    readonly id = 'native-jtag';
    readonly artifactFormat = 'sof' as const;

    constructor(private readonly engine: NativeQuartusEngine) {}

    private run(i: QuartusInstall, tool: string, args: string[], extra: { cwd?: string; signal?: AbortSignal; onOutput?: (t: string) => void; timeoutMs: number }): Promise<ToolRunResult> {
        return this.engine.run(i, tool, args, extra);
    }

    async availability(): Promise<{ available: boolean; detail: string }> {
        const i = await this.engine.install();
        if (!i) return { available: false, detail: 'Quartus Prime Lite is not installed' };
        const r = await this.run(i, 'quartus_pgm', ['--version'], { timeoutMs: 30_000 });
        const v = /Version (\S+ Build \d+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1];
        return r.outcome === 'exited' && r.exitCode === 0 && v ? { available: true, detail: `Quartus Programmer ${v}` } : { available: false, detail: `quartus_pgm did not start (${r.outcome}${r.exitCode !== null ? ` exit ${r.exitCode}` : ''})` };
    }

    async detect(board: BoardProfile, signal?: AbortSignal): Promise<HardwareDetection> {
        const fail = (status: HardwareDetection['status'], d: Diagnostic[], probes: HardwareDetection['probes'] = [], devices: DetectedDevice[] = []): HardwareDetection => ({ status, probes, devices, diagnostics: d, logs: [] });
        const i = await this.engine.install();
        if (!i) return fail('programmer-missing', [P('PROGRAMMER_MISSING', 'Quartus Prime Lite is not installed, so the board cannot be programmed.')]);

        // 1. Which cables does Quartus see?
        const list = await this.run(i, 'quartus_pgm', ['-l'], { ...(signal ? { signal } : {}), timeoutMs: 60_000 });
        if (list.outcome !== 'exited' || list.exitCode !== 0) return fail('error', [P('JTAG_SERVER_FAILED', `Quartus could not list the programming cables (${list.outcome === 'exited' ? `exit ${list.exitCode}` : list.outcome}). Close other programs using the board and try again.`)]);
        const cables = parseCables(`${list.stdout}\n${list.stderr}`);
        if (cables.length === 0) return fail('board-absent', [P('CABLE_ABSENT', `No programming cable found. Connect the ${board.displayName} USB-Blaster port and switch the board on.`)]);
        const wanted = (board.identification?.productNames ?? ['USB-Blaster']).map((n) => n.toLowerCase());
        const blasters = cables.filter((c) => wanted.some((w) => c.toLowerCase().includes(w)));
        const probes = blasters.map((c) => ({ description: c }));
        if (blasters.length === 0) return fail('board-absent', [P('CABLE_ABSENT', `Quartus sees ${cables.join(', ')}, but not the ${board.displayName} USB-Blaster.`)], cables.map((c) => ({ description: c })));
        if (blasters.length > 1) return fail('error', [P('CABLE_AMBIGUOUS', `${blasters.length} USB-Blasters are connected (${blasters.join(', ')}). Disconnect all but the ${board.displayName} so the right board is programmed.`)], probes);
        const cable = blasters[0]!;

        // 2. What is on that cable's JTAG chain?
        const chainRun = await this.run(i, 'jtagconfig', [], { ...(signal ? { signal } : {}), timeoutMs: 60_000 });
        if (chainRun.outcome !== 'exited' || chainRun.exitCode !== 0) return fail('error', [P('JTAG_SERVER_FAILED', `Quartus could not read the JTAG chain (${chainRun.outcome === 'exited' ? `exit ${chainRun.exitCode}` : chainRun.outcome}).`)], probes);
        const chain = parseChains(`${chainRun.stdout}\n${chainRun.stderr}`).find((c) => c.cable === cable);
        if (!chain || chain.devices.length === 0) return fail('board-absent', [P('BOARD_ABSENT', `The USB-Blaster is connected, but no FPGA answered on its JTAG chain${chain?.problem ? ` (${chain.problem})` : ''}. Is the ${board.displayName} switched on?`)], probes);
        const want = board.fpga.jtagIdcode;
        if (want !== undefined && !chain.devices.some((d) => d.idcode === want)) {
            return fail('unexpected-device', [P('UNEXPECTED_DEVICE', `JTAG chain has ${chain.devices.map((d) => hex(d.idcode)).join(', ')}, expected ${hex(want)} (${board.fpga.device}).`)], probes, [...chain.devices]);
        }
        return { status: 'detected', probes, devices: chain.devices, diagnostics: [infoDiag('programming', 'BOARD_DETECTED', `${chain.devices.map((d) => d.model ?? hex(d.idcode)).join(', ')} on ${cable}`)], logs: [] };
    }

    async program(req: ProgramRequest): Promise<ProgramOutcome> {
        const started = performance.now();
        const result = (status: ProgramOutcome['status'], softwareVerified: boolean, diagnostics: Diagnostic[]): ProgramOutcome => ({ status, softwareVerified, diagnostics, logs: [], durationMs: Math.round(performance.now() - started) });
        const a = req.artifact;
        // SRAM only: a .sof, nothing else. Flash and programming-file operations are never requested.
        if (a.format !== 'sof' || !a.path.toLowerCase().endsWith('.sof'))
            return result('rejected', false, [P('UNSUPPORTED_ARTIFACT', `The ${req.board.name} programmer on this computer loads only a .sof file into SRAM; got ${basename(a.path)}.`)]);
        let bytes: Buffer;
        try {
            bytes = await readFile(a.path);
        } catch {
            return result('rejected', false, [P('ARTIFACT_MISSING', `Programming file not found: ${a.path}. Build first.`)]);
        }
        if (createHash('sha256').update(bytes).digest('hex') !== a.sha256) return result('rejected', false, [P('ARTIFACT_CHANGED', 'The programming file changed since the build. Build again.')]);
        const i = await this.engine.install();
        if (!i) return result('failed', false, [P('PROGRAMMER_MISSING', 'Quartus Prime Lite is not installed, so the board cannot be programmed.')]);

        const pre = await this.detect(req.board, req.signal);
        if (pre.status !== 'detected') return result(req.signal?.aborted ? 'cancelled' : 'failed', false, [...pre.diagnostics]);
        const cable = pre.probes[0]!.description;
        const index = pre.devices.find((d) => d.idcode === req.board.fpga.jtagIdcode)?.index ?? pre.devices[0]!.index;

        // The file is addressed by name from its own folder: no path with spaces or drive colons inside the -o operation.
        const r = await this.run(i, 'quartus_pgm', ['-c', cable, '-m', 'jtag', '-o', `p;${basename(a.path)}@${index}`], { cwd: dirname(a.path), ...(req.signal ? { signal: req.signal } : {}), ...(req.onOutput ? { onOutput: req.onOutput } : {}), timeoutMs: 180_000 });
        const text = `${r.stdout}\n${r.stderr}`;
        if (r.outcome === 'cancelled') return result('cancelled', false, [P('PROGRAM_CANCELLED', 'Programming was cancelled; the board configuration is undefined until it is programmed again.')]);
        if (r.outcome !== 'exited') return result('failed', false, [P('PROGRAMMER_FAILED', `Programmer ${r.outcome}${r.errorMessage ? `: ${r.errorMessage}` : ''}.`)]);
        // Exit code alone is not trusted: Quartus must say the device was configured and the programmer succeeded.
        const errLine = text.split(/\r?\n/).find((l) => /^\s*(Error|Critical Warning)/i.test(l));
        if (r.exitCode !== 0 || errLine || !CONFIGURED.test(text) || !PROGRAMMER_OK.test(text)) {
            return result('failed', false, [P('PROGRAM_FAILED', errLine?.trim() || (r.exitCode !== 0 ? `Programmer exited ${r.exitCode}.` : 'Programmer exited 0 without reporting that the device was configured.'))]);
        }
        const post = await this.detect(req.board, req.signal);
        const d: Diagnostic[] = [infoDiag('programming', 'PROGRAMMED_SRAM', 'Configuration loaded into SRAM (temporary; lost at power-off). Check the board to confirm behaviour.')];
        if (post.status !== 'detected') d.push(...(post.diagnostics.length > 0 ? post.diagnostics.filter((x) => x.severity === 'error') : [P('JTAG_CHAIN_LOST', 'The JTAG chain could not be read after programming.')]));
        return result(hasErrors(d) ? 'failed' : 'programmed', post.status === 'detected', d);
    }
}
