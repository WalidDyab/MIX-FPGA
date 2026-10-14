import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type BoardConstraintFormat, PROJECT_FILE_NAME, PROJECT_FOLDERS, type ProjectFile, WORKSPACE_DIR_NAME } from '../../core';

/**
 * The Phase 4A project folder contract:
 *
 *   <Project>/nexysvhdl.json       project settings   (student-owned)
 *   <Project>/src/**\/*.vhd         RTL sources        (student-owned)
 *   <Project>/sim/**\/*.vhd         testbenches        (student-owned)
 *   <Project>/constraints/**\/*.xdc  XDC constraints    (student-owned)
 *   <Project>/.nexysvhdl/          everything NexysVHDL generates
 */
export const VHDL_FILE = /\.(vhd|vhdl)$/i;
export const XDC_FILE = /\.xdc$/i;
export const QSF_FILE = /\.qsf$/i;
export const SDC_FILE = /\.sdc$/i;

/** Constraint file name pattern for a board's constraint format (the Quartus format lists top-level files only). */
export const constraintPattern = (format: BoardConstraintFormat): RegExp => (format === 'qsf-sdc' ? /\.(qsf|sdc)$/i : XDC_FILE);

/** What a student sees in empty-folder hints, e.g. `.xdc` or `.qsf and .sdc`. */
export const constraintExtensionsText = (format: BoardConstraintFormat): string => (format === 'qsf-sdc' ? '.qsf and .sdc' : '.xdc');

export type ProjectFileKind = 'source' | 'simulation' | 'constraints' | 'settings';

/** Classifies a project-relative path (`/`-separated) by the folder contract. */
export function classifyProjectPath(rel: string, format: BoardConstraintFormat = 'xdc'): ProjectFileKind | undefined {
    const p = rel.replace(/\\/g, '/');
    if (p === PROJECT_FILE_NAME) return 'settings';
    if (p.startsWith(`${WORKSPACE_DIR_NAME}/`)) return undefined;
    if (p.startsWith(`${PROJECT_FOLDERS.sources}/`) && VHDL_FILE.test(p)) return 'source';
    if (p.startsWith(`${PROJECT_FOLDERS.simulation}/`) && VHDL_FILE.test(p)) return 'simulation';
    if (p.startsWith(`${PROJECT_FOLDERS.constraints}/`) && constraintPattern(format).test(p) && (format !== 'qsf-sdc' || !p.slice(PROJECT_FOLDERS.constraints.length + 1).includes('/'))) return 'constraints';
    return undefined;
}

export interface ScannedFiles {
    /** Project-relative paths, sorted. */
    readonly sources: readonly string[];
    readonly simulation: readonly string[];
    readonly constraints: readonly string[];
}

async function listRecursive(root: string, dir: string, accept: RegExp, recursive = true): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
        return [];
    }
    const out: string[] = [];
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) {
            if (recursive) out.push(...(await listRecursive(root, rel, accept, recursive)));
        }
        else if (e.isFile() && accept.test(e.name)) out.push(rel);
    }
    return out;
}

/** Lists the project's VHDL and XDC files by the folder contract. Never looks inside `.nexysvhdl/`. */
export async function scanProjectFiles(root: string, format: BoardConstraintFormat = 'xdc'): Promise<ScannedFiles> {
    const sort = (a: string[]) => a.sort((x, y) => x.localeCompare(y));
    return {
        sources: sort(await listRecursive(root, PROJECT_FOLDERS.sources, VHDL_FILE)),
        simulation: sort(await listRecursive(root, PROJECT_FOLDERS.simulation, VHDL_FILE)),
        constraints: sort(await listRecursive(root, PROJECT_FOLDERS.constraints, constraintPattern(format), format !== 'qsf-sdc')),
    };
}

export interface ProjectFileEntry {
    readonly path: string;
    /** File name. */
    readonly name: string;
    /** Folder below the group folder, e.g. `display/` for `src/display/mux.vhd`; empty at top level. */
    readonly folder: string;
    /** Listed in nexysvhdl.json but outside the standard folder. */
    readonly outside?: boolean;
    /** Listed in nexysvhdl.json (or selected) but not found on disk. */
    readonly missing?: boolean;
    /** Contains the configured top entity. */
    readonly top?: boolean;
    /** Contains the configured testbench. */
    readonly testbench?: boolean;
    /** The constraints file the project uses. */
    readonly inUse?: boolean;
}

export interface ProjectFilesModel {
    readonly sources: readonly ProjectFileEntry[];
    readonly simulation: readonly ProjectFileEntry[];
    readonly constraints: readonly ProjectFileEntry[];
    /** The project generates its XDC from `pins` instead of using a file. */
    readonly generatedConstraints: boolean;
    /** Constraint file types of the board, for hints: `.xdc` or `.qsf and .sdc`. */
    readonly constraintExtensions: string;
}

function entry(path: string, group: string, found: boolean, flags: Partial<ProjectFileEntry>): ProjectFileEntry {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const inside = path.startsWith(`${group}/`);
    const inner = inside ? path.slice(group.length + 1) : path;
    const folder = inner.includes('/') ? inner.slice(0, inner.lastIndexOf('/') + 1) : '';
    return { path, name, folder, ...(inside ? {} : { outside: true }), ...(inside && !found ? { missing: true } : {}), ...flags };
}

/**
 * The logical Project Files view: Sources / Simulation / Constraints.
 * `topFiles` / `testbenchFiles` name the files declaring the top entity and
 * the testbench (from the design index). Files listed in nexysvhdl.json
 * outside the standard folders are still shown, so nothing is hidden.
 */
export function buildProjectFilesModel(
    scanned: ScannedFiles,
    config: Pick<ProjectFile, 'sources' | 'simulation' | 'constraints' | 'pins'>,
    topFiles: ReadonlySet<string> = new Set(),
    testbenchFiles: ReadonlySet<string> = new Set(),
    format: BoardConstraintFormat = 'xdc',
): ProjectFilesModel {
    const merge = (found: readonly string[], listed: readonly string[] | undefined) => {
        const set = new Set(found);
        const extra = (listed ?? []).filter((p) => typeof p === 'string' && !set.has(p));
        return [...found.map((p) => ({ p, found: true })), ...extra.map((p) => ({ p, found: false }))];
    };
    const sources = merge(scanned.sources, config.sources).map(({ p, found }) => entry(p, PROJECT_FOLDERS.sources, found, topFiles.has(p) ? { top: true } : {}));
    const simulation = merge(scanned.simulation, config.simulation?.sources).map(({ p, found }) =>
        entry(p, PROJECT_FOLDERS.simulation, found, testbenchFiles.has(p) ? { testbench: true } : {}),
    );
    const used = config.constraints;
    const constraintPaths = used !== undefined && !scanned.constraints.includes(used) ? [...scanned.constraints, used] : scanned.constraints;
    // Quartus boards use every .qsf/.sdc of constraints/; the Nexys flow uses the one XDC the project names (or its pin mapping).
    const constraints = constraintPaths.map((p) => entry(p, PROJECT_FOLDERS.constraints, scanned.constraints.includes(p), { inUse: format === 'qsf-sdc' ? true : p === used }));
    return { sources, simulation, constraints, generatedConstraints: format !== 'qsf-sdc' && used === undefined && config.pins !== undefined, constraintExtensions: constraintExtensionsText(format) };
}
