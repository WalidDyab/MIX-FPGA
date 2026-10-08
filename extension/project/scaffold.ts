import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { type BoardDefinition, BuildWorkspace, formatNvproj, formatProjectFile, nvprojNameFor, PROJECT_FILE_NAME, PROJECT_FOLDERS, WORKSPACE_DIR_NAME } from '../../core';
import { starterGitignore, starterPaths, starterProjectFile, starterTestbenchVhdl, starterTopVhdl, starterXdc } from './templates';

/** Project (and folder) names: a letter, then letters, digits, `_` or `-`. */
export const PROJECT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function validateProjectName(name: string): string | undefined {
    if (name.trim() === '') return 'Enter a project name.';
    if (!PROJECT_NAME.test(name)) return 'Use a letter first, then letters, digits, "_" or "-" (no spaces, at most 64 characters).';
    return undefined;
}

/**
 * What a new project starts with. `starter`: a small working example (design, testbench, pins).
 * `empty`: only the standard folders (src/, sim/ and constraints/ with a blank pin file)
 * and the project file; the first source added with "+ Add File" becomes the top entity.
 */
export type ProjectTemplate = 'starter' | 'empty';

/** The templates the New Project dialog offers, in order. A normal project starts empty. */
export const PROJECT_TEMPLATES: ReadonlyArray<{ readonly template: ProjectTemplate; readonly label: string; readonly description: string; readonly recommended: boolean }> = [
    { template: 'empty', label: 'Empty project (recommended)', description: 'empty src/ and sim/ folders: add your own files with Add File', recommended: true },
    { template: 'starter', label: 'Starter project', description: 'a blinking-LED example with its testbench and pin constraints', recommended: false },
];

/** What the New Project command creates unless asked otherwise. */
export const DEFAULT_TEMPLATE: ProjectTemplate = 'empty';

export interface CreateProjectRequest {
    /** Existing folder in which the new project folder is created. */
    readonly parentDir: string;
    readonly name: string;
    readonly board: BoardDefinition;
    /** Default: `starter`. */
    readonly template?: ProjectTemplate;
}

export type CreateProjectResult =
    | { readonly ok: true; readonly root: string; readonly files: readonly string[] }
    | { readonly ok: false; readonly code: 'INVALID_NAME' | 'PARENT_MISSING' | 'ALREADY_EXISTS' | 'WRITE_FAILED'; readonly message: string };

/**
 * Creates `<parentDir>/<name>/` with the standard structure, the `<name>.nvproj` project
 * file and starter files. Writes nothing outside that new folder, never reuses an existing
 * folder, and removes the folder again if creation fails part-way.
 */
export async function createProject(req: CreateProjectRequest): Promise<CreateProjectResult> {
    const invalid = validateProjectName(req.name);
    if (invalid) return { ok: false, code: 'INVALID_NAME', message: invalid };

    const parent = resolve(req.parentDir);
    try {
        if (!(await stat(parent)).isDirectory()) throw new Error('not a folder');
    } catch {
        return { ok: false, code: 'PARENT_MISSING', message: `The folder ${parent} does not exist.` };
    }

    const paths = starterPaths(req.board);
    let files: Record<string, string>;
    try {
        files =
            req.template === 'empty'
                ? {
                      [nvprojNameFor(req.name)]: formatNvproj(),
                      [PROJECT_FILE_NAME]: formatProjectFile({
                          name: req.name, board: req.board.id, language: 'vhdl', standard: '2008', top: '', sources: [],
                          simulation: { sources: [] }, constraints: paths.constraints,
                      }),
                      [paths.constraints]: starterXdc(req.name, req.board, { starterPorts: false }),
                      '.gitignore': starterGitignore(),
                  }
                : {
                      [nvprojNameFor(req.name)]: formatNvproj(),
                      [PROJECT_FILE_NAME]: formatProjectFile(starterProjectFile(req.name, req.board)),
                      [paths.top]: starterTopVhdl(req.name, req.board),
                      [paths.testbench]: starterTestbenchVhdl(),
                      [paths.constraints]: starterXdc(req.name, req.board),
                      '.gitignore': starterGitignore(),
                  };
    } catch (err) {
        return { ok: false, code: 'WRITE_FAILED', message: (err as Error).message };
    }

    const root = join(parent, req.name);
    try {
        await mkdir(root); // not recursive: fails if the folder (or a file) already exists
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') return { ok: false, code: 'ALREADY_EXISTS', message: `${root} already exists. Choose another project name or folder.` };
        return { ok: false, code: 'WRITE_FAILED', message: `Cannot create ${root}: ${(err as Error).message}` };
    }

    try {
        for (const folder of Object.values(PROJECT_FOLDERS)) await mkdir(join(root, folder));
        for (const [rel, content] of Object.entries(files)) {
            const target = join(root, ...rel.split('/'));
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
        }
        // The generated-files area, laid out by the shared BuildWorkspace (ADR-001).
        await new BuildWorkspace(BuildWorkspace.pathsFor(join(root, WORKSPACE_DIR_NAME))).ensureDirectories();
    } catch (err) {
        await rm(root, { recursive: true, force: true });
        return { ok: false, code: 'WRITE_FAILED', message: `Creating the project failed: ${(err as Error).message}` };
    }
    return { ok: true, root, files: Object.keys(files) };
}
