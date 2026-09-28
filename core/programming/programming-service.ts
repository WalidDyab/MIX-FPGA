import { resolve } from 'node:path';
import type { BoardDefinition } from '../board/types';
import type { BuildArtifact } from '../results/artifact';
import { type Diagnostic, errorDiag } from '../results/diagnostic';
import { notConfigured } from '../results/operation';
import { sha256File } from '../util/hash';
import type { BoardDetectionResult, DetectedBoard, ProgrammerProvider, ProgrammingResult } from './types';

export interface ProgramOptions {
    /** Serial number of the board to program; required when several boards match. */
    readonly serialNumber?: string;
    readonly signal?: AbortSignal;
}

function failed(started: number, diagnostics: Diagnostic[], extra: Partial<ProgrammingResult> = {}): ProgrammingResult {
    return { status: 'failed', destination: 'volatile', diagnostics, logs: [], durationMs: Date.now() - started, ...extra };
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
 * and that a transformed artifact never replaces it.
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
        return { configured: true, ...(await this.provider.detectBoards(board)) };
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

        const availability = await provider.availability();
        if (!availability.available) {
            return failed(started, [errorDiag('programming', 'PROGRAMMER_UNAVAILABLE', `${provider.displayName}: ${availability.detail}`)]);
        }

        const detection = await provider.detectBoards(board);
        const { target, diagnostic } = selectTarget(detection.boards, board, options.serialNumber);
        if (!target) return failed(started, [...detection.diagnostics, diagnostic!]);

        const before = await sha256File(canonical.path);
        const artifact = await provider.prepareArtifact({ canonical, board, outputDir });
        const after = await sha256File(canonical.path);

        const problems: Diagnostic[] = [];
        if (before !== after) {
            problems.push(errorDiag('programming', 'PROGRAM_CANONICAL_MODIFIED', `${provider.displayName} modified the canonical bitstream ${canonical.path}.`));
        }
        if (artifact.transformation !== 'none' && resolve(artifact.path) === resolve(canonical.path)) {
            problems.push(errorDiag('programming', 'PROGRAM_ARTIFACT_OVERWRITES_CANONICAL', 'A transformed programming artifact must not use the canonical bitstream path.'));
        }
        if (problems.length > 0) return failed(started, problems, { target, artifact });

        return provider.program({
            artifact,
            target,
            board,
            destination: 'volatile',
            ...(options.signal ? { signal: options.signal } : {}),
        });
    }
}
