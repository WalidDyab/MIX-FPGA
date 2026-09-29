import { resolve } from 'node:path';
import type { BoardDefinition } from '../board/types';
import type { BuildArtifact } from '../results/artifact';
import { type Diagnostic, errorDiag } from '../results/diagnostic';
import { notConfigured } from '../results/operation';
import { sha256File } from '../util/hash';
import { type BoardDetectionResult, type DetectedBoard, type ProgrammerProvider, type ProgrammingArtifact, ProgrammingError, type ProgrammingResult } from './types';

export interface ProgramOptions {
    /** Serial number of the board to program; required when several boards match. */
    readonly serialNumber?: string;
    readonly signal?: AbortSignal;
}

function failed(started: number, diagnostics: Diagnostic[], extra: Partial<ProgrammingResult> = {}): ProgrammingResult {
    return { status: 'failed', destination: 'volatile', diagnostics, logs: [], durationMs: Date.now() - started, ...extra };
}

function isDiagnostic(x: unknown): x is Diagnostic {
    const d = x as Partial<Diagnostic> | null;
    return typeof d === 'object' && d !== null && typeof d.code === 'string' && typeof d.message === 'string' && typeof d.severity === 'string';
}

/**
 * Structured diagnostics for an exception thrown by a provider: its own
 * diagnostics if it carries them (ProgrammingError or compatible), otherwise
 * one error with the exception message. Never a stack trace.
 */
export function diagnosticsFromError(err: unknown, code: string, context: string): Diagnostic[] {
    const carried = err instanceof ProgrammingError ? err.diagnostics : (err as { diagnostics?: unknown } | null)?.diagnostics;
    if (Array.isArray(carried) && carried.length > 0 && carried.every(isDiagnostic)) return [...carried];
    const message = err instanceof Error ? err.message : String(err);
    return [errorDiag('programming', code, `${context}: ${message}`)];
}

/** Chooses the target board: by serial if given, else the single matching board. */
export function selectTarget(
    detected: readonly DetectedBoard[],
    board: BoardDefinition,
    serialNumber?: string,
): { target?: DetectedBoard; diagnostic?: Diagnostic } {
    if (serialNumber !== undefined) {
        const target = detected.find((b) => b.serialNumber === serialNumber);
        return target
            ? { target }
            : { diagnostic: errorDiag('programming', 'PROGRAM_SERIAL_NOT_FOUND', `No connected board has serial number ${serialNumber}.`) };
    }
    const candidates = detected.filter((b) => b.boardId === undefined || b.boardId === board.id);
    if (candidates.length === 0) {
        return { diagnostic: errorDiag('programming', 'PROGRAM_NO_BOARD', `No ${board.name} was detected. Check the USB cable and that the board is switched on.`) };
    }
    if (candidates.length > 1) {
        const serials = candidates.map((c) => c.serialNumber ?? '?').join(', ');
        return { diagnostic: errorDiag('programming', 'PROGRAM_MULTIPLE_BOARDS', `Several boards are connected (${serials}); choose one by serial number.`) };
    }
    return { target: candidates[0]! };
}

/**
 * Programs a canonical bitstream through a platform ProgrammerProvider.
 * Guarantees the canonical file is unchanged (hash before/after preparation)
 * and that a transformed artifact never replaces it. Provider exceptions
 * (e.g. an unusable bitstream in prepareArtifact) become a failed
 * ProgrammingResult with structured diagnostics; they never escape.
 */
export class ProgrammingService {
    constructor(private readonly provider: ProgrammerProvider | undefined) {}

    get configured(): boolean {
        return this.provider !== undefined;
    }

    async detectBoards(board: BoardDefinition): Promise<BoardDetectionResult & { configured: boolean }> {
        if (!this.provider) {
            return { configured: false, boards: [], diagnostics: notConfigured('Programming', 'PROGRAMMER_NOT_CONFIGURED', {}).diagnostics };
        }
        try {
            return { configured: true, ...(await this.provider.detectBoards(board)) };
        } catch (err) {
            return { configured: true, boards: [], diagnostics: diagnosticsFromError(err, 'PROGRAM_DETECT_FAILED', `${this.provider.displayName} board detection failed`) };
        }
    }

    async program(
        canonical: BuildArtifact,
        board: BoardDefinition,
        outputDir: string,
        options: ProgramOptions = {},
    ): Promise<ProgrammingResult> {
        const started = Date.now();
        const provider = this.provider;
        if (!provider) {
            return notConfigured<ProgrammingResult>('Programming', 'PROGRAMMER_NOT_CONFIGURED', { destination: 'volatile' });
        }
        if (!canonical.canonical || canonical.kind !== 'bitstream') {
            return failed(started, [errorDiag('programming', 'PROGRAM_NOT_CANONICAL', 'Programming requires the canonical bitstream artifact.')]);
        }

        const name = provider.displayName;
        try {
            const availability = await provider.availability();
            if (!availability.available) {
                return failed(started, [errorDiag('programming', 'PROGRAMMER_UNAVAILABLE', `${name}: ${availability.detail}`)]);
            }
        } catch (err) {
            return failed(started, diagnosticsFromError(err, 'PROGRAMMER_UNAVAILABLE', `${name} availability check failed`));
        }

        let detection: BoardDetectionResult;
        try {
            detection = await provider.detectBoards(board);
        } catch (err) {
            return failed(started, diagnosticsFromError(err, 'PROGRAM_DETECT_FAILED', `${name} board detection failed`));
        }
        const { target, diagnostic } = selectTarget(detection.boards, board, options.serialNumber);
        if (!target) return failed(started, [...detection.diagnostics, diagnostic!]);

        let before: string;
        try {
            before = await sha256File(canonical.path);
        } catch {
            return failed(started, [errorDiag('programming', 'PROGRAM_CANONICAL_UNREADABLE', `Cannot read the canonical bitstream ${canonical.path}.`)], { target });
        }

        let artifact: ProgrammingArtifact;
        try {
            artifact = await provider.prepareArtifact({ canonical, board, outputDir });
        } catch (err) {
            const problems = diagnosticsFromError(err, 'PROGRAM_PREPARE_FAILED', `${name} could not prepare ${canonical.path}`);
            // Even a failed preparation must not have touched the canonical file.
            const after = await sha256File(canonical.path).catch(() => undefined);
            if (after !== before) problems.push(errorDiag('programming', 'PROGRAM_CANONICAL_MODIFIED', `${name} modified the canonical bitstream ${canonical.path}.`));
            return failed(started, problems, { target });
        }
        const after = await sha256File(canonical.path).catch(() => undefined);

        const problems: Diagnostic[] = [];
        if (before !== after) {
            problems.push(errorDiag('programming', 'PROGRAM_CANONICAL_MODIFIED', `${name} modified the canonical bitstream ${canonical.path}.`));
        }
        if (artifact.transformation !== 'none' && resolve(artifact.path) === resolve(canonical.path)) {
            problems.push(errorDiag('programming', 'PROGRAM_ARTIFACT_OVERWRITES_CANONICAL', 'A transformed programming artifact must not use the canonical bitstream path.'));
        }
        if (problems.length > 0) return failed(started, problems, { target, artifact });

        try {
            return await provider.program({
                artifact,
                target,
                board,
                destination: 'volatile',
                ...(options.signal ? { signal: options.signal } : {}),
            });
        } catch (err) {
            return failed(started, diagnosticsFromError(err, 'PROGRAM_FAILED', `${name} programming failed`), { target, artifact });
        }
    }
}
