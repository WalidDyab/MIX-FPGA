import { open, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    type BoardDefinition,
    type BoardDetectionResult,
    type DetectedBoard,
    type Diagnostic,
    diagnostic,
    errorDiag,
    type LogRef,
    type PrepareRequest,
    type ProgrammerAvailability,
    type ProgrammerProvider,
    type ProgrammingArtifact,
    type ProgrammingResult,
    type ProgramRequest,
    type ToolRunner,
    type ToolRunResult,
    warningDiag,
} from '../../core';
import {
    classifyOpenFpgaLoaderFailure,
    FAILURE_MESSAGES,
    lastErrorLine,
    parseConfigurationStatus,
    parseDetect,
    parseOpenFpgaLoaderVersion,
    parseScanUsb,
    sameIdcodeIgnoringRevision,
    type UsbProbe,
} from './openfpgaloader';
import type { MacosToolLocator, ToolDiscovery } from './tool-locator';

/** How openFPGALoader addresses a board definition, and what must answer on JTAG. */
export interface OpenFpgaLoaderBoardProfile {
    /** openFPGALoader `--board` name. */
    readonly board: string;
    /** Expected FPGA IDCODE (revision bits ignored). */
    readonly idcode: number;
    /** Model string openFPGALoader reports for that IDCODE. */
    readonly model: string;
}

/**
 * Board definitions this backend can program. Kept in the adapter because
 * boards/*.json has no openFPGALoader backend id yet (see docs/phase3b-macos.md).
 */
export const OPENFPGALOADER_BOARDS: Readonly<Record<string, OpenFpgaLoaderBoardProfile>> = {
    'nexys-a7-100t': { board: 'nexys_a7_100', idcode: 0x3631093, model: 'xc7a100' },
};

const VERSION_TIMEOUT_MS = 15_000;
const DETECT_TIMEOUT_MS = 30_000;
const PROGRAM_TIMEOUT_MS = 180_000;

/** Flags that would write non-volatile configuration memory; never passed. */
const FLASH_FLAGS = ['-f', '--write-flash', '--bulk-erase', '--external-flash', '--spi'];

/** Selector encoding: `ftdi-serial=<SN>` or `busdev-num=<bus>:<dev>`. */
export function selectorFor(probe: UsbProbe): string {
    return probe.serialNumber ? `ftdi-serial=${probe.serialNumber}` : `busdev-num=${probe.bus}:${probe.device}`;
}

export function selectorArgs(selector: string): string[] {
    const [key, value] = [selector.slice(0, selector.indexOf('=')), selector.slice(selector.indexOf('=') + 1)];
    if (key === 'ftdi-serial' && value) return ['--ftdi-serial', value];
    if (key === 'busdev-num' && /^\d+:\d+$/.test(value)) return ['--busdev-num', value];
    throw new Error(`Unrecognised openFPGALoader target selector "${selector}".`);
}

/** Arguments for a volatile (SRAM) load. `--verify` is omitted: it applies to flash writes only. */
export function programArgs(profile: OpenFpgaLoaderBoardProfile, selector: string, bitstream: string): string[] {
    const args = ['--board', profile.board, ...selectorArgs(selector), '--write-sram', '--force-terminal-mode', bitstream];
    if (args.some((a) => FLASH_FLAGS.includes(a))) throw new Error('Refusing to build a flash-programming command.');
    return args;
}

/** Part name stored in a Xilinx .bit header (field 'b'), read without modifying the file. */
export async function readBitstreamPart(path: string): Promise<string | undefined> {
    const handle = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(512);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return parseBitHeaderPart(buffer.subarray(0, bytesRead));
    } finally {
        await handle.close();
    }
}

/** Header: <u16 len><preamble><u16 1>'a'<u16 n>design 'b'<u16 n>part ... ; returns the part without trailing NUL. */
export function parseBitHeaderPart(head: Uint8Array): string | undefined {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < 4) return undefined;
    let offset = 2 + view.getUint16(0, false); // skip preamble
    offset += 2; // u16 0x0001
    while (offset + 3 <= head.length) {
        const key = String.fromCharCode(head[offset]!);
        if (key === 'e') return undefined;
        const len = view.getUint16(offset + 1, false);
        const start = offset + 3;
        if (start + len > head.length) return undefined;
        if (key === 'b') return Buffer.from(head.subarray(start, start + len)).toString('latin1').replace(/\0+$/, '');
        offset = start + len;
    }
    return undefined;
}

export interface OpenFpgaLoaderProgrammerOptions {
    readonly runner: ToolRunner;
    readonly locator: MacosToolLocator;
    readonly boards?: Readonly<Record<string, OpenFpgaLoaderBoardProfile>>;
}

/**
 * macOS ProgrammerProvider backed by openFPGALoader (from Apio's oss-cad-suite).
 * Talks to the Nexys A7's FT2232H through libusb in user space: no drivers,
 * no Vivado, no Rosetta. Volatile (SRAM) configuration only.
 */
export class OpenFpgaLoaderProgrammer implements ProgrammerProvider {
    readonly id = 'openfpgaloader';
    readonly displayName = 'openFPGALoader';

    private discovery: Promise<ToolDiscovery> | undefined;
    /** outputDir from prepareArtifact, keyed by artifact path, for writing programming logs. */
    private readonly logDirs = new Map<string, string>();

    constructor(private readonly options: OpenFpgaLoaderProgrammerOptions) {}

    private discover(): Promise<ToolDiscovery> {
        this.discovery ??= this.options.locator.discover('programmer');
        return this.discovery;
    }

    private profile(board: BoardDefinition): OpenFpgaLoaderBoardProfile | undefined {
        return (this.options.boards ?? OPENFPGALOADER_BOARDS)[board.id];
    }

    private run(executable: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<ToolRunResult> {
        return this.options.runner.run({ executable, args, timeoutMs, ...(signal ? { signal } : {}) });
    }

    async availability(): Promise<ProgrammerAvailability> {
        const { located, diagnostics } = await this.discover();
        if (!located) {
            const why = diagnostics.map((d) => d.message).join(' ');
            return { available: false, detail: `openFPGALoader not found (expected in Apio's oss-cad-suite package or on PATH).${why ? ' ' + why : ''}` };
        }
        const run = await this.run(located.path, ['--Version'], VERSION_TIMEOUT_MS);
        if (run.outcome === 'spawn-failed') return { available: false, detail: `Cannot start ${located.path}: ${run.errorMessage ?? 'unknown error'}` };
        const version = parseOpenFpgaLoaderVersion(`${run.stdout}\n${run.stderr}`);
        const arch = located.architecture.status === 'native' ? 'native arm64' : 'architecture unknown';
        return { available: true, detail: `openFPGALoader ${version ?? '(version unknown)'} — ${located.method}, ${arch}` };
    }

    async detectBoards(board: BoardDefinition): Promise<BoardDetectionResult> {
        const diagnostics: Diagnostic[] = [];
        const profile = this.profile(board);
        if (!profile) {
            return { boards: [], diagnostics: [errorDiag('programming', 'MACOS_BOARD_UNSUPPORTED', `openFPGALoader support for ${board.name} is not configured.`)] };
        }
        const { located, diagnostics: found } = await this.discover();
        if (!located) {
            return { boards: [], diagnostics: [...found, errorDiag('programming', 'MACOS_PROGRAMMER_NOT_FOUND', 'openFPGALoader was not found.')] };
        }

        const scan = await this.run(located.path, ['--scan-usb'], DETECT_TIMEOUT_MS);
        if (scan.outcome !== 'exited') {
            return { boards: [], diagnostics: [errorDiag('programming', 'MACOS_USB_SCAN_FAILED', `openFPGALoader --scan-usb ${scan.outcome}.`)] };
        }
        const usb = board.identification?.usb;
        const probes = parseScanUsb(`${scan.stdout}\n${scan.stderr}`).filter(
            (p) => !usb || (p.vendorId === usb.vendorId.toLowerCase() && p.productId === usb.productId.toLowerCase()),
        );
        if (probes.length === 0) {
            diagnostics.push(diagnostic('info', 'programming', 'MACOS_NO_BOARD', `No ${board.name} USB/JTAG interface (${usb ? `${usb.vendorId}:${usb.productId}` : 'any'}) is connected.`));
            return { boards: [], diagnostics };
        }

        const boards: DetectedBoard[] = [];
        for (const probe of probes) {
            const selector = selectorFor(probe);
            const where = `${probe.vendorId}:${probe.productId} ${probe.probeType}${probe.serialNumber ? ` serial ${probe.serialNumber}` : ''} (bus ${probe.bus} device ${probe.device})`;
            const detect = await this.run(located.path, ['--board', profile.board, ...selectorArgs(selector), '--detect'], DETECT_TIMEOUT_MS);
            const text = `${detect.stdout}\n${detect.stderr}`;
            const fpga = parseDetect(text).find((d) => sameIdcodeIgnoringRevision(d.idcode, profile.idcode));
            if (detect.outcome !== 'exited' || detect.exitCode !== 0 || !fpga) {
                const kind = detect.outcome === 'exited' ? classifyOpenFpgaLoaderFailure(text) : 'unknown';
                const detail = fpga === undefined && detect.exitCode === 0 ? 'the expected FPGA did not answer on JTAG' : FAILURE_MESSAGES[kind];
                diagnostics.push(
                    warningDiag('programming', 'MACOS_USB_VISIBLE_JTAG_UNAVAILABLE', `USB interface ${where} is present but not usable for programming: ${detail}`),
                );
                continue;
            }
            boards.push({
                selector,
                ...(probe.serialNumber ? { serialNumber: probe.serialNumber } : {}),
                ...(probe.product ? { productName: probe.product } : {}),
                boardId: board.id,
                transport: `USB JTAG ${probe.probeType} ${probe.vendorId}:${probe.productId}, FPGA ${fpga.model ?? profile.model} idcode 0x${fpga.idcode.toString(16)}`,
            });
        }
        return { boards, diagnostics };
    }

    /**
     * openFPGALoader accepts openXC7's hardware.bit as-is, so the canonical file
     * is referenced unchanged (never copied or opened for writing).
     */
    async prepareArtifact(request: PrepareRequest): Promise<ProgrammingArtifact> {
        this.logDirs.set(request.canonical.path, request.outputDir);
        return { path: request.canonical.path, source: request.canonical, transformation: 'none' };
    }

    async program(request: ProgramRequest): Promise<ProgrammingResult> {
        const started = Date.now();
        const logs: LogRef[] = [];
        const base = { destination: request.destination, target: request.target, artifact: request.artifact };
        const result = (status: ProgrammingResult['status'], diagnostics: Diagnostic[]): ProgrammingResult => ({
            ...base, status, diagnostics, logs, durationMs: Date.now() - started,
        });

        if (request.destination !== 'volatile') {
            return result('failed', [errorDiag('programming', 'MACOS_DESTINATION_UNSUPPORTED', 'Only volatile (SRAM) programming is supported.')]);
        }
        const profile = this.profile(request.board);
        if (!profile) return result('failed', [errorDiag('programming', 'MACOS_BOARD_UNSUPPORTED', `openFPGALoader support for ${request.board.name} is not configured.`)]);
        const { located } = await this.discover();
        if (!located) return result('failed', [errorDiag('programming', 'MACOS_PROGRAMMER_NOT_FOUND', 'openFPGALoader was not found.')]);

        const path = request.artifact.path;
        try {
            if ((await stat(path)).size === 0) throw new Error('empty');
        } catch {
            return result('failed', [errorDiag('programming', 'MACOS_BITSTREAM_MISSING', `Bitstream ${path} is missing or empty.`)]);
        }
        const part = await readBitstreamPart(path).catch(() => undefined);
        if (part !== undefined && part.toLowerCase() !== request.board.fpga.part.toLowerCase()) {
            return result('failed', [
                errorDiag('programming', 'MACOS_BITSTREAM_PART_MISMATCH', `Bitstream is for ${part}, but ${request.board.name} has ${request.board.fpga.part}.`),
            ]);
        }

        let args: string[];
        try {
            args = programArgs(profile, request.target.selector, path);
        } catch (err) {
            return result('failed', [errorDiag('programming', 'MACOS_TARGET_INVALID', (err as Error).message)]);
        }
        const run = await this.run(located.path, args, PROGRAM_TIMEOUT_MS, request.signal);
        const text = `${run.stdout}\n${run.stderr}`;

        const logDir = this.logDirs.get(request.artifact.source.path);
        if (logDir) {
            const logPath = join(logDir, 'openfpgaloader-program.log');
            await writeFile(logPath, `$ ${located.path} ${args.join(' ')}\n[${run.outcome} ${run.exitCode ?? ''}]\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}\n`, 'utf8');
            logs.push({ label: 'openfpgaloader-program', path: logPath });
        }

        if (run.outcome === 'spawn-failed') {
            return result('failed', [errorDiag('programming', 'MACOS_PROGRAMMER_NOT_STARTED', `Could not start openFPGALoader (${located.path}): ${run.errorMessage ?? 'unknown error'}`)]);
        }
        if (run.outcome !== 'exited') {
            return result('failed', [errorDiag('programming', `MACOS_PROGRAM_${run.outcome.toUpperCase().replace('-', '_')}`, `Programming ${run.outcome}.`)]);
        }
        const status = parseConfigurationStatus(text);
        if (run.exitCode !== 0) {
            const kind = classifyOpenFpgaLoaderFailure(text);
            const last = lastErrorLine(text);
            return result('failed', [
                errorDiag('programming', 'MACOS_PROGRAM_FAILED', `${FAILURE_MESSAGES[kind]}${last ? ` (openFPGALoader: ${last})` : ''}`),
            ]);
        }
        if (!status || status.done !== 1) {
            return result('failed', [
                errorDiag(
                    'programming',
                    'MACOS_PROGRAM_DONE_NOT_REACHED',
                    status
                        ? `The FPGA did not report configuration DONE (done=${status.done}, init=${status.init}).`
                        : 'openFPGALoader exited without reporting the FPGA configuration status; DONE is unconfirmed.',
                ),
            ]);
        }
        return result('succeeded', [
            diagnostic('info', 'programming', 'MACOS_PROGRAMMED_SRAM', 'FPGA configured (DONE=1). Volatile SRAM configuration: it is lost when the board is powered off.'),
        ]);
    }
}
