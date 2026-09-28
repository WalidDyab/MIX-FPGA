import type { Diagnostic, OperationStatus } from '../core';

/** Process exit codes used by every command. */
export const EXIT = { ok: 0, failed: 1, usage: 2, notConfigured: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface Output {
    line(text?: string): void;
    error(text: string): void;
}

export const consoleOutput: Output = {
    line: (text = '') => process.stdout.write(`${text}\n`),
    error: (text) => process.stderr.write(`${text}\n`),
};

/** Collects output in memory (tests). */
export class BufferedOutput implements Output {
    readonly lines: string[] = [];
    readonly errors: string[] = [];
    line(text = ''): void {
        this.lines.push(text);
    }
    error(text: string): void {
        this.errors.push(text);
    }
    text(): string {
        return [...this.lines, ...this.errors].join('\n');
    }
}

export function formatDiagnostic(d: Diagnostic): string {
    const where = d.location ? `${d.location.file}${d.location.line !== undefined ? `:${d.location.line}` : ''}${d.location.column !== undefined ? `:${d.location.column}` : ''}: ` : '';
    return `  ${d.severity.padEnd(7)} ${where}${d.message}  [${d.code}]`;
}

export function printDiagnostics(out: Output, diagnostics: readonly Diagnostic[], includeInfo = false): void {
    for (const d of diagnostics) {
        if (d.severity === 'info' && !includeInfo) continue;
        out.line(formatDiagnostic(d));
    }
}

export function statusExit(status: OperationStatus): ExitCode {
    switch (status) {
        case 'succeeded':
        case 'skipped':
            return EXIT.ok;
        case 'not-configured':
            return EXIT.notConfigured;
        default:
            return EXIT.failed;
    }
}

export const STATUS_LABEL: Record<OperationStatus, string> = {
    succeeded: 'OK',
    failed: 'FAILED',
    skipped: 'skipped',
    'not-configured': 'NOT CONFIGURED',
};
