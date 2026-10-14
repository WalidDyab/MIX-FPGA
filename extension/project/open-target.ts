import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isNvprojPath, PROJECT_FILE_NAME, resolveNvproj } from '../../core';

/** What Open Project was pointed at, resolved to the project folder. */
export type OpenTarget =
    | { readonly ok: true; readonly root: string; readonly via: 'folder' | 'project-file'; /** The `.nvproj` it was opened through. */ readonly projectFile?: string }
    | { readonly ok: false; readonly message: string };

/**
 * Open Project accepts a project folder (containing nexysvhdl.json), a `.nvproj` project file, or
 * the nexysvhdl.json itself. Old projects without a `.nvproj` open exactly as before. Free of
 * the VS Code API so it can be unit-tested.
 */
export async function resolveOpenTarget(path: string): Promise<OpenTarget> {
    const abs = resolve(path);
    let info;
    try {
        info = await stat(abs);
    } catch {
        return { ok: false, message: `${abs} does not exist.` };
    }
    if (info.isDirectory()) {
        try {
            if ((await stat(join(abs, PROJECT_FILE_NAME))).isFile()) return { ok: true, root: abs, via: 'folder' };
        } catch {
            /* fall through */
        }
        return { ok: false, message: `${abs} has no ${PROJECT_FILE_NAME}. Choose a MIX-FPGA project folder or its .nvproj file, or use Create Project.` };
    }
    if (isNvprojPath(abs)) {
        const r = await resolveNvproj(abs);
        return r.ok ? { ok: true, root: r.root, via: 'project-file', projectFile: r.file } : { ok: false, message: r.message };
    }
    if (basename(abs).toLowerCase() === PROJECT_FILE_NAME) return { ok: true, root: dirname(abs), via: 'folder' };
    return { ok: false, message: `${basename(abs)} is not a MIX-FPGA project. Choose a project folder or a .nvproj file.` };
}
