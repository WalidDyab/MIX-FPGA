import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { BoardProfile, DetectedDevice, HardwareDetection, ProgramOutcome, ProgramRequest, ProgrammingProvider } from '../../../core/backend/types';
import type { ToolRunResult, ToolRunner } from '../../../core/process/tool-runner';
import { errorDiag, hasErrors, infoDiag, type Diagnostic } from '../../../core/results/diagnostic';
import type { De10Paths } from './config';

const P = (code: string, msg: string): Diagnostic => errorDiag('programming', code, msg);

export interface UsbProbe {
    readonly description: string;
    readonly vendorId: string;
    readonly productId: string;
    readonly serial: string;
}

/** Rows of `--scan-usb`: `001 004 0x09fb:0x6001 usb-blaster Altera 91d28408 USB-Blaster`. */
export function parseScanUsb(text: string): UsbProbe[] {
    const out: UsbProbe[] = [];
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*\d+\s+\d+\s+0x([0-9a-f]{4}):0x([0-9a-f]{4})\s+(\S+)\s+\S+\s+(\S+)\s+(.+?)\s*$/i.exec(line);
        if (m) out.push({ vendorId: m[1]!.toLowerCase(), productId: m[2]!.toLowerCase(), description: `${m[5]} (${m[3]})`, serial: m[4]! });
    }
    return out;
}

/** Blocks of `--detect`: `index 0:\n idcode 0x31050dd\n family MAX 10\n model 10M50D`. */
export function parseDetect(text: string): DetectedDevice[] {
    const out: DetectedDevice[] = [];
    let cur: { index: number; idcode?: number; family?: string; model?: string } | undefined;
    const push = () => {
        if (cur && cur.idcode !== undefined) out.push({ index: cur.index, idcode: cur.idcode, ...(cur.family ? { family: cur.family } : {}), ...(cur.model ? { model: cur.model } : {}) });
    };
    for (const line of text.split(/\r?\n/)) {
        const i = /^\s*index\s+(\d+)\s*:/.exec(line);
        if (i) {
            push();
            cur = { index: Number(i[1]) };
            continue;
        }
        if (!cur) continue;
        const kv = /^\s*(idcode|family|model)\s+(.+?)\s*$/.exec(line);
        if (!kv) continue;
        if (kv[1] === 'idcode') cur.idcode = Number(kv[2]);
        else if (kv[1] === 'family') cur.family = kv[2]!;
        else cur.model = kv[2]!;
    }
    push();
    return out;
}

const hex = (n: number): string => `0x${n.toString(16).padStart(8, '0')}`;

/** Native macOS programmer for boards with a USB-Blaster. Programs only through the vendor-neutral SVF route. */
export class NativeJtagProgrammer implements ProgrammingProvider {
    readonly id = 'native-jtag';

    constructor(
        private readonly paths: De10Paths,
        private readonly runner: ToolRunner,
    ) {}

    private run(args: string[], signal?: AbortSignal, onOutput?: (t: string) => void, timeoutMs = 60_000): Promise<ToolRunResult> {
        return this.runner.run({
            executable: this.paths.programmer,
            args,
            env: { OPENFPGALOADER_SOJ_DIR: this.paths.programmerDataDir },
            timeoutMs,
            ...(signal ? { signal } : {}),
            ...(onOutput ? { onOutput } : {}),
        });
    }

    private async installed(): Promise<boolean> {
        try {
            return (await stat(this.paths.programmer)).isFile();
        } catch {
            return false;
        }
    }

    async availability(): Promise<{ available: boolean; detail: string }> {
        if (!(await this.installed())) return { available: false, detail: `programmer not found at ${this.paths.programmer}` };
        const r = await this.run(['--Version'], undefined, undefined, 15_000);
        const v = /openFPGALoader\s+(v\S+)/.exec(r.stdout + r.stderr)?.[1];
        return r.exitCode === 0 && v ? { available: true, detail: `openFPGALoader ${v}` } : { available: false, detail: `programmer did not start (${r.outcome}${r.exitCode !== null ? ` exit ${r.exitCode}` : ''})` };
    }

    async detect(board: BoardProfile, signal?: AbortSignal): Promise<HardwareDetection> {
        const none = (status: HardwareDetection['status'], d: Diagnostic[], probes: HardwareDetection['probes'] = []): HardwareDetection => ({ status, probes, devices: [], diagnostics: d, logs: [] });
        if (!(await this.installed())) return none('programmer-missing', [P('PROGRAMMER_MISSING', 'The programming tool is not installed.')]);
        const scan = await this.run(['--scan-usb'], signal, undefined, 30_000);
        if (scan.outcome !== 'exited') return none('error', [P('PROGRAMMER_FAILED', `USB scan ${scan.outcome}.`)]);
        const probes = parseScanUsb(scan.stdout + scan.stderr);
        if (probes.length === 0) return none('board-absent', [P('BOARD_ABSENT', `No ${board.name} found. Connect its USB-Blaster port and switch the board on.`)]);
        const key = board.programmerBoardKey;
        const det = await this.run(['--detect', ...(key ? ['-b', key] : [])], signal, undefined, 60_000);
        const text = det.stdout + det.stderr;
        const devices = parseDetect(text);
        const base = { probes, devices, logs: [] as never[] };
        if (det.outcome !== 'exited') return { status: 'error', ...base, diagnostics: [P('PROGRAMMER_FAILED', `JTAG detection ${det.outcome}.`)] };
        if (devices.length === 0) {
            const absent = /device not found|unable to open|No USB devices/i.test(text);
            return { status: absent ? 'board-absent' : 'error', ...base, diagnostics: [P(absent ? 'BOARD_ABSENT' : 'JTAG_NO_DEVICE', absent ? 'The USB-Blaster could not be opened.' : 'The JTAG chain reported no device. Is the board powered?')] };
        }
        const want = board.fpga.jtagIdcode;
        if (want !== undefined && !devices.some((d) => d.idcode === want))
            return { status: 'unexpected-device', ...base, diagnostics: [P('UNEXPECTED_DEVICE', `JTAG chain has ${devices.map((d) => hex(d.idcode)).join(', ')}, expected ${hex(want)} (${board.fpga.device}).`)] };
        return { status: 'detected', ...base, diagnostics: [infoDiag('programming', 'BOARD_DETECTED', `${devices.map((d) => `${d.family ?? ''} ${d.model ?? hex(d.idcode)}`.trim()).join(', ')} on ${probes[0]!.description}`)] };
    }

    async program(req: ProgramRequest): Promise<ProgramOutcome> {
        const started = performance.now();
        const result = (status: ProgramOutcome['status'], softwareVerified: boolean, diagnostics: Diagnostic[]): ProgramOutcome => ({ status, softwareVerified, diagnostics, logs: [], durationMs: Math.round(performance.now() - started) });
        const a = req.artifact;
        if (a.format !== 'svf' || !a.path.toLowerCase().endsWith('.svf'))
            return result('rejected', false, [P('UNSUPPORTED_ARTIFACT', `The ${req.board.name} programmer accepts only an .svf file for temporary (SRAM) configuration; got ${a.path.split('/').pop()}. A .sof is not loadable by this tool.`)]);
        let bytes: Buffer;
        try {
            bytes = await readFile(a.path);
        } catch {
            return result('rejected', false, [P('ARTIFACT_MISSING', `Programming file not found: ${a.path}. Build first.`)]);
        }
        if (createHash('sha256').update(bytes).digest('hex') !== a.sha256) return result('rejected', false, [P('ARTIFACT_CHANGED', 'The programming file changed since the build. Build again.')]);
        const pre = await this.detect(req.board, req.signal);
        if (pre.status !== 'detected') return result(req.signal?.aborted ? 'cancelled' : 'failed', false, [...pre.diagnostics]);
        const key = req.board.programmerBoardKey;
        const r = await this.run([...(key ? ['-b', key] : []), a.path], req.signal, req.onOutput, 180_000);
        const text = r.stdout + r.stderr;
        if (r.outcome === 'cancelled') return result('cancelled', false, [P('PROGRAM_CANCELLED', 'Programming was cancelled; the board configuration is undefined until it is programmed again.')]);
        if (r.outcome !== 'exited') return result('failed', false, [P('PROGRAMMER_FAILED', `Programmer ${r.outcome}${r.errorMessage ? `: ${r.errorMessage}` : ''}.`)]);
        const errLine = text.split(/\r?\n/).find((l) => /error|fail|unable|not supported/i.test(l));
        // Exit code alone is not trusted: the SVF player must report that it reached the end of the file.
        if (r.exitCode !== 0 || errLine || !/end of SVF file/i.test(text)) return result('failed', false, [P('PROGRAM_FAILED', errLine?.trim() || `Programmer exited ${r.exitCode} without reporting completion.`)]);
        const post = await this.detect(req.board, req.signal);
        const d: Diagnostic[] = [infoDiag('programming', 'PROGRAMMED_SRAM', 'Configuration loaded into SRAM (temporary; lost at power-off). Check the board to confirm behaviour.')];
        if (post.status !== 'detected') d.push(...post.diagnostics.filter((x) => x.severity === 'error'));
        return result(hasErrors(d) ? 'failed' : 'programmed', post.status === 'detected', d);
    }
}
