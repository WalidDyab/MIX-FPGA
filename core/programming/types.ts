import type { BoardDefinition } from '../board/types';
import type { BuildArtifact } from '../results/artifact';
import type { Diagnostic } from '../results/diagnostic';
import type { OperationResult } from '../results/operation';

/** A physical board found by a programmer provider. */
export interface DetectedBoard {
    /** Provider-specific target string used to address this board (opaque to the core). */
    readonly selector: string;
    readonly serialNumber?: string;
    readonly productName?: string;
    /** Board definition id if the provider recognised the board (e.g. `nexys-a7-100t`). */
    readonly boardId?: string;
    readonly transport?: string;
}

export interface BoardDetectionResult {
    readonly boards: readonly DetectedBoard[];
    readonly diagnostics: readonly Diagnostic[];
}

/**
 * The file actually sent to the board. Always a separate object from the
 * canonical bitstream; may share its path only when `transformation` is `none`.
 */
export interface ProgrammingArtifact {
    readonly path: string;
    /** The canonical hardware.bit this was derived from. */
    readonly source: BuildArtifact;
    /** `none` = canonical file used unchanged; otherwise a short description. */
    readonly transformation: 'none' | (string & {});
}

/** Only volatile (SRAM) configuration is supported for now. */
export type ProgrammingDestination = 'volatile';

export interface ProgrammerAvailability {
    readonly available: boolean;
    /** Why not, or what backend/version is in use. */
    readonly detail: string;
}

export interface PrepareRequest {
    readonly canonical: BuildArtifact;
    readonly board: BoardDefinition;
    /** Directory for derived files (never the canonical bitstream's directory). */
    readonly outputDir: string;
}

export interface ProgramRequest {
    readonly artifact: ProgrammingArtifact;
    readonly target: DetectedBoard;
    readonly board: BoardDefinition;
    readonly destination: ProgrammingDestination;
    readonly signal?: AbortSignal;
}

export interface ProgrammingResult extends OperationResult {
    readonly destination: ProgrammingDestination;
    readonly target?: DetectedBoard;
    readonly artifact?: ProgrammingArtifact;
}

/**
 * Platform programming backend (ADR-002). Implemented per platform in
 * Phase 3B; the core only depends on this contract.
 */
export interface ProgrammerProvider {
    readonly id: string;
    readonly displayName: string;
    availability(): Promise<ProgrammerAvailability>;
    detectBoards(board: BoardDefinition): Promise<BoardDetectionResult>;
    prepareArtifact(request: PrepareRequest): Promise<ProgrammingArtifact>;
    program(request: ProgramRequest): Promise<ProgrammingResult>;
}
