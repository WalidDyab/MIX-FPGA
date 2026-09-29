import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
    sha256File,
    type ToolLocator,
    type ToolRunner,
    type ToolRunResult,
    warningDiag,
} from '../../../core';
import type { WindowsHostEnvironment } from '../host-environment';
import { describeAdept, inspectAdept } from './adept-environment';
import { type NormalizeDetails, normalizeForDigilent, parseBitHeader, fieldText, digilentPartName } from './bit-header';
import {
    classifyDjtgcfgError,
    type DigilentDevice,
    errorLines,
    parseEnumOutput,
    parseInitOutput,
    programmingSucceeded,
    type ScanChain,
} from './djtgcfg-output';

/** File name of the prepared copy inside the workspace `program/` folder. */
export const PREPARED_BITSTREAM_NAME = 'hardware-digilent.bit';
export const PROGRAM_LOG_NAME = 'djtgcfg-program.log';

const ENUM_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 30_000;
const PROG_TIMEOUT_MS = 180_000;

export interface DigilentProgrammerOptions {
    /**
     * Run `djtgcfg init` on each recognised board during detection to check that
     * its JTAG chain answers (board powered). Default true.
     */
    readonly probeJtagOnDetect?: boolean;
}

/** Thrown by prepareArtifact(): the shared contract has no structured failure result for preparation. */
export class DigilentArtifactError extends Error {
    constructor(readonly diagnostics: readonly Diagnostic[]) {
        super(diagnostics.map((d) => d.message).join(' '));
        this.name = 'DigilentArtifactError';
    }
}

export type PrepareOutcome =
    | { readonly ok: true; readonly path: string; readonly details: NormalizeDetails; readonly sha256: string }
    | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * Writes the Digilent-compatible copy of `canonicalPath` into `outputDir`
 * (never over the canonical file). Structured, non-throwing.
 */
export async function prepareDigilentBitstream(canonicalPath: string, outputDir: string, board: BoardDefinition): Promise<PrepareOutcome> {
    const fail = (code: string, message: string): PrepareOutcome => ({ ok: false, diagnostics: [errorDiag('programming', code, message)] });
    const target = join(outputDir, PREPARED_BITSTREAM_NAME);
    if (resolve(target) === resolve(canonicalPath)) {
        return fail('DIGILENT_PREPARE_WOULD_OVERWRITE', `The prepared bitstream path ${target} is the canonical bitstream.`);
    }

    let source: Buffer;
    try {
        source = await readFile(canonicalPath);
    } catch (err) {
        return fail('DIGILENT_BIT_UNREADABLE', `Cannot read ${canonicalPath}: ${(err as Error).message}`);
    }
    const normalized = normalizeForDigilent(source, board.fpga.part);
    if (!normalized.ok) return { ok: false, diagnostics: normalized.diagnostics };

    // Write atomically: a half-written file must never be picked up by djtgcfg.
    const temp = `${target}.${process.pid}.tmp`;
    try {
        await mkdir(outputDir, { recursive: true });
        await writeFile(temp, normalized.output);
        await rename(temp, target);
    } catch (err) {
        await rm(temp, { force: true });
        return fail('DIGILENT_PREPARE_WRITE_FAILED', `Cannot write ${target}: ${(err as Error).message}`);
    }

    // Verify what is on disk, not just what was in memory.
    const written = await readFile(target);
    if (!written.equals(normalized.output)) return fail('DIGILENT_BIT_VERIFY_FAILED', `${target} does not contain the prepared bytes.`);
    return { ok: true, path: target, details: normalized.details, sha256: await sha256File(target) };
}

/** `XC7A100T-1CSG324C` -> `XC7A100T`: the name djtgcfg prints for the chain device. */
function expectedChainDevice(board: BoardDefinition): string {
    return board.fpga.device.split('-')[0]!.toUpperCase();
}

function matchesBoard(device: DigilentDevice, board: BoardDefinition): boolean {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const product = norm(device.productName ?? '');
    return (board.identification?.productNames ?? []).some((n) => product.includes(norm(n)));
}

function outputOf(run: ToolRunResult): string {
    return [run.stdout, run.stderr].filter((s) => s.trim()).join('\n').trim();
}

function describeRun(run: ToolRunResult): string {
    const err = errorLines(outputOf(run));
    const status = run.outcome === 'exited' ? `exit code ${String(run.exitCode)}` : run.outcome;
    return `${status}${err.length ? `: ${err.join(' ')}` : ''}`;
}

/** Diagnostic for a failed `init`/`prog` on a board that enumeration did find. */
function jtagFailure(run: ToolRunResult, board: BoardDefinition, serial: string | undefined, stage: 'init' | 'prog'): Diagnostic {
    const who = `${board.name}${serial ? ` (serial ${serial})` : ''}`;
    if (run.outcome === 'timed-out') return errorDiag('programming', 'DIGILENT_TIMEOUT', `djtgcfg ${stage} timed out on ${who}.`);
    if (run.outcome === 'cancelled') return errorDiag('programming', 'DIGILENT_CANCELLED', `djtgcfg ${stage} was cancelled.`);
    if (run.outcome === 'spawn-failed') return errorDiag('programming', 'DIGILENT_NOT_STARTED', `djtgcfg could not be started: ${run.errorMessage ?? 'unknown error'}.`);
    switch (classifyDjtgcfgError(outputOf(run))) {
        case 'scan-chain':
            return errorDiag(
                'programming',
                'DIGILENT_JTAG_UNAVAILABLE',
                `${who} is connected by USB but the FPGA/JTAG chain is unavailable. Check that the board power switch is ON.`,
            );
        case 'open-device':
            return errorDiag(
                'programming',
                'DIGILENT_DEVICE_OPEN_FAILED',
                `${who} could not be opened. It may have been unplugged, or another program (e.g. an open Vivado Hardware Manager target) is using it.`,
            );
        case 'file-rejected':
            return errorDiag('programming', 'DIGILENT_FILE_REJECTED', `djtgcfg rejected the bitstream file (${describeRun(run)}).`);
        case 'file-unreadable':
            return errorDiag('programming', 'DIGILENT_FILE_UNREADABLE', `djtgcfg could not read the bitstream file (${describeRun(run)}).`);
        case 'programming-failed':
            return errorDiag('programming', 'DIGILENT_PROGRAM_FAILED', `Programming ${who} failed (${describeRun(run)}).`);
        default:
            return errorDiag('programming', stage === 'init' ? 'DIGILENT_INIT_FAILED' : 'DIGILENT_PROGRAM_FAILED', `djtgcfg ${stage} failed on ${who} (${describeRun(run)}).`);
    }
}

function logSection(title: string, run: ToolRunResult): string {
    return [
        `$ ${JSON.stringify([run.invocation.executable, ...run.invocation.args])}`,
        `# ${title}: outcome=${run.outcome} exitCode=${String(run.exitCode)} durationMs=${run.durationMs}${run.errorMessage ? ` error=${run.errorMessage}` : ''}`,
        '[stdout]',
        run.stdout.trimEnd(),
        '[stderr]',
        run.stderr.trimEnd(),
        '',
    ].join('\n');
}

/**
 * ProgrammerProvider for Windows through Digilent Adept (`djtgcfg`), keeping the
 * standard FTDI/Digilent driver Vivado also uses. FPGA SRAM only; never flash,
 * never Vivado, never a driver change. See docs/phase3b-windows.md.
 */
export class DigilentProgrammer implements ProgrammerProvider {
    readonly id = 'digilent-adept';
    readonly displayName = 'Digilent Adept (djtgcfg)';
    private readonly probeJtagOnDetect: boolean;

    constructor(
        private readonly locator: ToolLocator,
        private readonly runner: ToolRunner,
        private readonly host: WindowsHostEnvironment,
        options: DigilentProgrammerOptions = {},
    ) {
        this.probeJtagOnDetect = options.probeJtagOnDetect ?? true;
    }

    async availability(): Promise<ProgrammerAvailability> {
        const adept = await inspectAdept(this.locator, this.runner, this.host);
        return { available: adept.usable, detail: describeAdept(adept) };
    }

    async detectBoards(board: BoardDefinition): Promise<BoardDetectionResult> {
        const djtgcfg = await this.locator.locate('programmer');
        if (!djtgcfg) {
            return { boards: [], diagnostics: [errorDiag('programming', 'DIGILENT_DJTGCFG_MISSING', 'djtgcfg.exe (Digilent Adept Utilities) was not found.')] };
        }
        const run = await this.runner.run({ executable: djtgcfg.path, args: ['enum'], timeoutMs: ENUM_TIMEOUT_MS });
        if (run.outcome !== 'exited' || run.exitCode !== 0) {
            return { boards: [], diagnostics: [errorDiag('programming', 'DIGILENT_ENUM_FAILED', `djtgcfg enum failed (${describeRun(run)}).`)] };
        }
        const parsed = parseEnumOutput(outputOf(run));
        if (!parsed.ok) {
            return { boards: [], diagnostics: [errorDiag('programming', 'DIGILENT_ENUM_UNRECOGNIZED', `Unrecognised djtgcfg enum output (${parsed.reason}).`)] };
        }

        const diagnostics: Diagnostic[] = [];
        if (parsed.reportedCount !== parsed.devices.length) {
            diagnostics.push(warningDiag('programming', 'DIGILENT_ENUM_COUNT_MISMATCH', `djtgcfg reported ${parsed.reportedCount} device(s) but ${parsed.devices.length} were parsed.`));
        }
        const recognisable = (board.identification?.productNames ?? []).length > 0;
        if (!recognisable) {
            diagnostics.push(warningDiag('programming', 'DIGILENT_BOARD_UNIDENTIFIABLE', `${board.name} has no product names to match; every Digilent device is listed.`));
        }

        const boards: DetectedBoard[] = [];
        const seen = new Set<string>();
        for (const device of parsed.devices) {
            if (recognisable && !matchesBoard(device, board)) {
                diagnostics.push(
                    diagnostic('info', 'programming', 'DIGILENT_OTHER_DEVICE', `Ignoring Digilent device "${device.productName ?? device.name}"${device.serialNumber ? ` (serial ${device.serialNumber})` : ''}: not a ${board.name}.`),
                );
                continue;
            }
            if (device.serialNumber && seen.has(device.serialNumber)) continue;
            if (device.serialNumber) seen.add(device.serialNumber);
            else diagnostics.push(warningDiag('programming', 'DIGILENT_NO_SERIAL', `Device "${device.name}" reports no serial number; it is addressed by name.`));

            boards.push({
                selector: device.serialNumber ? `SN:${device.serialNumber}` : device.name,
                ...(device.serialNumber ? { serialNumber: device.serialNumber } : {}),
                ...(device.productName ? { productName: device.productName } : {}),
                ...(recognisable ? { boardId: board.id } : {}),
                transport: device.transport ?? 'USB',
            });
        }

        if (this.probeJtagOnDetect) {
            for (const b of boards) {
                const init = await this.runner.run({ executable: djtgcfg.path, args: ['init', '-d', b.selector], timeoutMs: INIT_TIMEOUT_MS });
                if (init.outcome !== 'exited' || init.exitCode !== 0) {
                    const d = jtagFailure(init, board, b.serialNumber, 'init');
                    diagnostics.push({ ...d, severity: 'warning' });
                }
            }
        }
        return { boards, diagnostics };
    }

    async prepareArtifact(request: PrepareRequest): Promise<ProgrammingArtifact> {
        const outcome = await prepareDigilentBitstream(request.canonical.path, request.outputDir, request.board);
        if (!outcome.ok) throw new DigilentArtifactError(outcome.diagnostics);
        const { details } = outcome;
        return {
            path: outcome.path,
            source: request.canonical,
            transformation:
                details.outcome === 'already-compatible'
                    ? 'none'
                    : `bit header part name "${details.sourcePart}" -> "${details.targetPart}" (payload ${details.payloadLength} bytes verified identical)`,
        };
    }

    async program(request: ProgramRequest): Promise<ProgrammingResult> {
        const started = Date.now();
        const { artifact, target, board } = request;
        const diagnostics: Diagnostic[] = [];
        const logs: LogRef[] = [];
        const runs: Array<[string, ToolRunResult]> = [];
        const finish = async (status: 'succeeded' | 'failed'): Promise<ProgrammingResult> => {
            if (runs.length > 0) {
                const path = join(dirname(artifact.path), PROGRAM_LOG_NAME);
                try {
                    await writeFile(path, runs.map(([title, run]) => logSection(title, run)).join('\n'), 'utf8');
                    logs.push({ label: 'djtgcfg-program', path });
                } catch {
                    /* the log is a convenience; the result still carries the diagnostics */
                }
            }
            return { status, destination: 'volatile', target, artifact, diagnostics, logs, durationMs: Date.now() - started };
        };
        const failWith = (d: Diagnostic) => (diagnostics.push(d), finish('failed'));

        if (request.destination !== 'volatile') {
            return failWith(errorDiag('programming', 'DIGILENT_DESTINATION_UNSUPPORTED', 'Only volatile (FPGA SRAM) programming is supported.'));
        }

        // Safety net: never hand djtgcfg a file it would reject or one built for another part.
        let header: ReturnType<typeof parseBitHeader>;
        try {
            header = parseBitHeader(await readFile(artifact.path));
        } catch (err) {
            return failWith(errorDiag('programming', 'DIGILENT_ARTIFACT_UNREADABLE', `Cannot read ${artifact.path}: ${(err as Error).message}`));
        }
        if (!header.ok) return failWith(errorDiag('programming', 'DIGILENT_BIT_MALFORMED', `${artifact.path} is not a valid bitstream: ${header.reason}.`));
        const part = fieldText(header.header.fields.b);
        if (part !== digilentPartName(board.fpga.part)) {
            return failWith(errorDiag('programming', 'DIGILENT_ARTIFACT_NOT_PREPARED', `${artifact.path} has header part "${part}"; djtgcfg needs "${digilentPartName(board.fpga.part) ?? '?'}". Use prepareArtifact() first.`));
        }

        const djtgcfg = await this.locator.locate('programmer');
        if (!djtgcfg) return failWith(errorDiag('programming', 'DIGILENT_DJTGCFG_MISSING', 'djtgcfg.exe (Digilent Adept Utilities) was not found.'));
        const signal = request.signal ? { signal: request.signal } : {};

        // 1. The scan chain must answer and hold the board's FPGA at index 0.
        const init = await this.runner.run({ executable: djtgcfg.path, args: ['init', '-d', target.selector], timeoutMs: INIT_TIMEOUT_MS, ...signal });
        runs.push(['init', init]);
        if (init.outcome !== 'exited' || init.exitCode !== 0) return failWith(jtagFailure(init, board, target.serialNumber, 'init'));
        const chain: ScanChain | undefined = parseInitOutput(outputOf(init));
        const expected = expectedChainDevice(board);
        if (!chain || chain.devices[0] === undefined) {
            return failWith(errorDiag('programming', 'DIGILENT_INIT_UNRECOGNIZED', `djtgcfg init output did not list the scan chain devices.`));
        }
        if (chain.devices[0].toUpperCase() !== expected) {
            return failWith(errorDiag('programming', 'DIGILENT_DEVICE_MISMATCH', `JTAG chain device 0 is ${chain.devices[0]}, expected ${expected} for ${board.name}.`));
        }

        // 2. Program FPGA SRAM (index 0). Arguments are an array; no shell.
        const prog = await this.runner.run({
            executable: djtgcfg.path,
            args: ['prog', '-d', target.selector, '-index', '0', '-file', artifact.path],
            timeoutMs: PROG_TIMEOUT_MS,
            ...signal,
        });
        runs.push(['prog', prog]);
        if (prog.outcome !== 'exited' || prog.exitCode !== 0) return failWith(jtagFailure(prog, board, target.serialNumber, 'prog'));
        if (!programmingSucceeded(outputOf(prog))) {
            diagnostics.push(warningDiag('programming', 'DIGILENT_SUCCESS_UNCONFIRMED', 'djtgcfg exited with code 0 but did not print "Programming succeeded."'));
        }
        diagnostics.push(diagnostic('info', 'programming', 'DIGILENT_PROGRAMMED', `Programmed ${board.name} (${target.selector}) FPGA SRAM with ${artifact.path} in ${(prog.durationMs / 1000).toFixed(1)} s.`));
        return finish('succeeded');
    }
}
