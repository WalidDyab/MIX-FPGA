import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { Project } from '../project/types';
import { type Diagnostic, errorDiag } from '../results/diagnostic';

/** Default workspace folder name inside a project root. */
export const WORKSPACE_DIR_NAME = '.nexysvhdl';

/** Paths of one project's build workspace. All absolute. */
export interface WorkspacePaths {
    readonly root: string;
    /** GHDL library + waveforms for simulation. */
    readonly sim: string;
    /** GHDL library + generated Verilog for synthesis. */
    readonly synth: string;
    /** Implementation staging: the ONLY directory the implementation backend sees. */
    readonly impl: string;
    /** Prepared programming artifacts (never the canonical bitstream). */
    readonly program: string;
    readonly logs: string;
}

/** A file to place in the implementation staging directory. */
export type StagedFile =
    | { readonly name: string; readonly content: string }
    | { readonly name: string; readonly sourcePath: string };

export interface StagedImplementation {
    readonly dir: string;
    /** Absolute paths of exactly the files staged, in the order given. */
    readonly files: readonly string[];
}

function isInside(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function listFilesRecursive(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await listFilesRecursive(p)));
        else out.push(p);
    }
    return out;
}

/**
 * Checks that a workspace root is isolated from a project's sources:
 * it must not be the project root and must not contain any listed source.
 */
export function checkIsolation(project: Project, workspaceRoot: string): Diagnostic[] {
    const problems: Diagnostic[] = [];
    const root = resolve(workspaceRoot);
    if (resolve(project.root) === root) {
        problems.push(errorDiag('workspace', 'WORKSPACE_IS_PROJECT_ROOT', 'The build workspace cannot be the project folder itself.'));
    }
    const sources = [...(project.config.sources ?? []), ...(project.config.simulation?.sources ?? [])];
    for (const s of sources) {
        const abs = resolve(project.root, s);
        if (isInside(root, abs)) {
            problems.push(errorDiag('workspace', 'WORKSPACE_CONTAINS_SOURCE', `Source "${s}" is inside the build workspace ${root}.`));
        }
    }
    return problems;
}

/**
 * One project's build workspace. Implementation tools only ever run inside
 * `paths.impl`, which stageImplementation() rebuilds from scratch each time,
 * so stray files in the student's tree can never reach them (ADR-001).
 */
export class BuildWorkspace {
    constructor(readonly paths: WorkspacePaths) {}

    static pathsFor(root: string): WorkspacePaths {
        const r = resolve(root);
        return { root: r, sim: join(r, 'sim'), synth: join(r, 'synth'), impl: join(r, 'impl'), program: join(r, 'program'), logs: join(r, 'logs') };
    }

    async ensureDirectories(): Promise<void> {
        const { root, ...dirs } = this.paths;
        await mkdir(root, { recursive: true });
        for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });
    }

    /**
     * Replaces the staging directory with exactly `files`, then verifies the
     * directory holds nothing else. File names must be plain names (no folders).
     */
    async stageImplementation(files: readonly StagedFile[]): Promise<StagedImplementation> {
        const names = files.map((f) => f.name);
        for (const n of names) {
            if (n !== basename(n) || n === '' || n === '.' || n === '..') {
                throw new Error(`staged file name must be a plain file name: "${n}"`);
            }
        }
        if (new Set(names).size !== names.length) throw new Error('duplicate staged file names');

        const dir = this.paths.impl;
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });

        const written: string[] = [];
        for (const f of files) {
            const target = join(dir, f.name);
            if ('content' in f) await writeFile(target, f.content, 'utf8');
            else await copyFile(f.sourcePath, target);
            written.push(target);
        }

        const present = (await listFilesRecursive(dir)).map((p) => resolve(p)).sort();
        const expected = written.map((p) => resolve(p)).sort();
        if (present.length !== expected.length || present.some((p, i) => p !== expected[i])) {
            throw new Error(`staging directory ${dir} does not contain exactly the staged files`);
        }
        return { dir, files: written };
    }

    /** Lists every file currently in the staging directory (for isolation checks). */
    async listStaged(): Promise<string[]> {
        try {
            return await listFilesRecursive(this.paths.impl);
        } catch {
            return [];
        }
    }
}

export interface WorkspaceOpenResult {
    readonly workspace?: BuildWorkspace;
    readonly diagnostics: readonly Diagnostic[];
}

/** Creates BuildWorkspaces. The root location is injectable (tests, temp dirs). */
export class WorkspaceManager {
    constructor(private readonly rootFor: (project: Project) => string = (p) => join(p.root, WORKSPACE_DIR_NAME)) {}

    async open(project: Project): Promise<WorkspaceOpenResult> {
        const root = this.rootFor(project);
        const diagnostics = checkIsolation(project, root);
        if (diagnostics.length > 0) return { diagnostics };
        const workspace = new BuildWorkspace(BuildWorkspace.pathsFor(root));
        await workspace.ensureDirectories();
        return { workspace, diagnostics };
    }
}
