import { isAbsolute, join } from 'node:path';
import { type Diagnostic, type DiagnosticSeverity, PROJECT_FILE_NAME } from '../../core';

/**
 * Which operation produced a set of diagnostics. Each category is replaced
 * as a whole when its operation runs again, so fixed problems disappear.
 * Check, Simulate and Build all analyse the VHDL, so they share `vhdl`.
 */
export type ProblemCategory = 'project' | 'vhdl' | 'build';

/** A diagnostic placed in a file, 0-based line/column as editors use them. */
export interface ProblemEntry {
    readonly severity: DiagnosticSeverity;
    readonly message: string;
    readonly code: string;
    readonly source: string;
    readonly line: number;
    /** Start column, if the tool reported one. */
    readonly column?: number;
}

/** Diagnostic codes that are progress notes, not problems (testbench `report` lines). */
const NOT_PROBLEMS = new Set(['GHDL_REPORT_NOTE']);

/**
 * Maps structured Phase 3 diagnostics to files for the Problems panel.
 * Located diagnostics go to their file (project-relative paths resolved
 * against the project root); unlocated errors/warnings are project-level
 * and go to nexysvhdl.json. Duplicates are merged. Pure.
 */
export function collectProblems(root: string, categories: ReadonlyMap<ProblemCategory, readonly Diagnostic[]>): Map<string, ProblemEntry[]> {
    const byFile = new Map<string, ProblemEntry[]>();
    const seen = new Set<string>();
    for (const [, diagnostics] of categories) {
        for (const d of diagnostics) {
            if (NOT_PROBLEMS.has(d.code)) continue;
            if (!d.location && d.severity === 'info') continue;
            const file = d.location ? (isAbsolute(d.location.file) ? d.location.file : join(root, ...d.location.file.split('/'))) : join(root, PROJECT_FILE_NAME);
            const line = Math.max(0, (d.location?.line ?? 1) - 1);
            const entry: ProblemEntry = {
                severity: d.severity,
                message: d.message,
                code: d.code,
                source: `MIX-FPGA (${d.source})`,
                line,
                ...(d.location?.column !== undefined ? { column: Math.max(0, d.location.column - 1) } : {}),
            };
            const key = `${file}\0${line}\0${entry.column ?? ''}\0${d.severity}\0${d.message}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const list = byFile.get(file);
            if (list) list.push(entry);
            else byFile.set(file, [entry]);
        }
    }
    return byFile;
}

/**
 * End column for a squiggle starting at `column` on `lineText`: the end of
 * the identifier/number there, or one character. Pure.
 */
export function squiggleEnd(lineText: string, column: number): number {
    let end = column;
    while (end < lineText.length && /[A-Za-z0-9_]/.test(lineText[end]!)) end++;
    return end > column ? end : Math.min(lineText.length, column + 1) || column + 1;
}
