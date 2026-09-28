import type { Diagnostic, LogRef, OperationStatus } from './diagnostic';

/** Fields every operation result carries. */
export interface OperationResult {
    readonly status: OperationStatus;
    readonly diagnostics: readonly Diagnostic[];
    /** Raw tool logs for advanced/debug views. */
    readonly logs: readonly LogRef[];
    readonly durationMs: number;
}

/** Result for a capability with no provider on this host. Never a success. */
export function notConfigured<T extends OperationResult>(
    capability: string,
    code: string,
    extra: Omit<T, keyof OperationResult>,
): T {
    const base: OperationResult = {
        status: 'not-configured',
        diagnostics: [{ severity: 'error', source: 'workflow', code, message: `${capability} provider is not configured for this platform.` }],
        logs: [],
        durationMs: 0,
    };
    // Sound: T = OperationResult fields (supplied here) + the remaining fields (supplied by `extra`).
    return { ...base, ...extra } as unknown as T;
}
