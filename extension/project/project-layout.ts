import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_FILE_NAME, PROJECT_FOLDERS, type ProjectFile, WORKSPACE_DIR_NAME } from '../../core';

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

export type ProjectFileKind = 'source' | 'simulation' | 'constraints' | 'settings';

/** Classifies a project-relative path (`/`-separated) by the folder contract. */
export function classifyProjectPath(rel: string): ProjectFileKind | undefined {
    const p = rel.replace(/\\/g, '/');
    if (p === PROJECT_FILE_NAME) return 'settings';
    if (p.startsWith(`${WORKSPACE_DIR_NAME}/`)) return undefined;
    if (p.startsWith(`${PROJECT_FOLDERS.sources}/`) && VHDL_FILE.test(p)) return 'source';
    if (p.startsWith(`${PROJECT_FOLDERS.simulation}/`) && VHDL_FILE.test(p)) return 'simulation';
    if (p.startsWith(`${PROJECT_FOLDERS.constraints}/`) && XDC_FILE.test(p)) return 'constraints';
    return undefined;
}

export interface ScannedFiles {
    /** Project-relative paths, sorted. */
    readonly sources: readonly string[];
    readonly simulation: readonly string[];
    readonly constraints: readonly string[];
}

async function listRecursive(root: string, dir: string, accept: RegExp): Promise<string[]> {
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
        if (e.isDirectory()) out.push(...(await listRecursive(root, rel, accept)));
        else if (e.isFile() && accept.test(e.name)) out.push(rel);
    }
    return out;
}

/** Lists the project's VHDL and XDC files by the folder contract. Never looks inside `.nexysvhdl/`. */
export async function scanProjectFiles(root: string): Promise<ScannedFiles> {
    const sort = (a: string[]) => a.sort((x, y) => x.localeCompare(y));
    return {
        sources: sort(await listRecursive(root, PROJECT_FOLDERS.sources, VHDL_FILE)),
        simulation: sort(await listRecursive(root, PROJECT_FOLDERS.simulation, VHDL_FILE)),
        constraints: sort(await listRecursive(root, PROJECT_FOLDERS.constraints, XDC_FILE)),
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
    const constraints = constraintPaths.map((p) => entry(p, PROJECT_FOLDERS.constraints, scanned.constraints.includes(p), { inUse: p === used }));
    return { sources, simulation, constraints, generatedConstraints: used === undefined && config.pins !== undefined };
}
