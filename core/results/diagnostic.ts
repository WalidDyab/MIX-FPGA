/**
 * Structured diagnostics shared by every layer. UIs render these instead of
 * parsing raw tool output; raw output stays reachable through LogRef.
 */

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** Where a diagnostic came from: a NexysVHDL layer or an external tool. */
export type DiagnosticSource =
    | 'project'
    | 'board'
    | 'toolchain'
    | 'workspace'
    | 'workflow'
    | 'vhdl'
    | 'implementation'
    | 'programming'
    | 'process';

export interface SourceLocation {
    /** Path as reported (usually project-relative). */
    readonly file: string;
    readonly line?: number;
    readonly column?: number;
}

export interface Diagnostic {
    readonly severity: DiagnosticSeverity;
    /** Stable machine-readable code, e.g. `PROJECT_MISSING_TOP`. */
    readonly code: string;
    readonly message: string;
    readonly source: DiagnosticSource;
    readonly location?: SourceLocation;
}

/** Reference to a raw log kept for advanced/debug views. */
export interface LogRef {
    /** Short label, e.g. `ghdl-analyze`, `apio-build`. */
    readonly label: string;
    readonly path: string;
}

/**
 * Outcome of one operation.
 * `not-configured` means no provider exists for this capability on this host;
 * it is never reported as success.
 */
export type OperationStatus = 'succeeded' | 'failed' | 'skipped' | 'not-configured';

export function diagnostic(
    severity: DiagnosticSeverity,
    source: DiagnosticSource,
    code: string,
    message: string,
    location?: SourceLocation,
): Diagnostic {
    return location === undefined
        ? { severity, source, code, message }
        : { severity, source, code, message, location };
}

export const errorDiag = (source: DiagnosticSource, code: string, message: string, location?: SourceLocation) =>
    diagnostic('error', source, code, message, location);

export const warningDiag = (source: DiagnosticSource, code: string, message: string, location?: SourceLocation) =>
    diagnostic('warning', source, code, message, location);

export const infoDiag = (source: DiagnosticSource, code: string, message: string, location?: SourceLocation) =>
    diagnostic('info', source, code, message, location);

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
    return diagnostics.some((d) => d.severity === 'error');
}

export function countBySeverity(diagnostics: readonly Diagnostic[]): Record<DiagnosticSeverity, number> {
    const counts: Record<DiagnosticSeverity, number> = { error: 0, warning: 0, info: 0 };
    for (const d of diagnostics) counts[d.severity]++;
    return counts;
}
