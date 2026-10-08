import type { Diagnostic } from '../../core';
import type { ProjectFile } from '../../core';
import type { ScannedFiles } from './project-layout';

/**
 * An Empty project (the recommended template) is a valid starting state: no sources, no top entity, no
 * testbench yet. The editor must not report that as errors the moment the project is created. Build and
 * Simulate are unaffected: the shared core validates on its own and still refuses to run without a top
 * entity, sources or testbench; this only decides what the Problems panel and the project views show.
 */
export const EMPTY_PROJECT_MESSAGE = 'Add a VHDL source file to begin.';

/** Diagnostics that merely say "nothing has been added yet" in an empty project. */
const EMPTY_STATE_CODES = new Set(['PROJECT_MISSING_TOP', 'PROJECT_NO_SOURCES']);

/** True while the project has no VHDL at all (nothing in src/ or sim/, nothing listed) and no top entity chosen. Pure. */
export function isEmptyProject(config: Pick<ProjectFile, 'top' | 'sources' | 'simulation'>, scanned: ScannedFiles): boolean {
    const listed = [...(Array.isArray(config.sources) ? config.sources : []), ...(Array.isArray(config.simulation?.sources) ? config.simulation!.sources : [])];
    const topBlank = typeof config.top !== 'string' || config.top.trim() === '';
    return topBlank && scanned.sources.length === 0 && scanned.simulation.length === 0 && listed.length === 0;
}

/** What to show for an empty project: the validation without the "not added yet" errors. Everything else still applies. */
export function withoutEmptyStateErrors(diagnostics: readonly Diagnostic[]): Diagnostic[] {
    return diagnostics.filter((d) => !EMPTY_STATE_CODES.has(d.code));
}
