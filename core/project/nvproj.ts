import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { PROJECT_FILE_NAME } from './types';

/**
 * The NexysVHDL project file (`<Project>.nvproj`), analogous to Vivado's `.xpr`: the file a
 * student double-clicks. It is a small versioned LAUNCH DESCRIPTOR, not a copy of the project
 * settings: `nexysvhdl.json` stays the only place where the top entity, testbench, constraints
 * and source lists live.
 *
 *   { "format": "nexysvhdl-project", "version": 1, "config": "nexysvhdl.json" }
 *
 * `config` is a path relative to the `.nvproj` file (so a project folder can be moved or copied
 * whole). It is never absolute and never leaves the folder. Unknown extra fields are ignored,
 * so a later NexysVHDL can add some without breaking this reader. The same rules are
 * implemented by launcher/core/ProjectCheck (C#); tests/nvproj.test.ts keeps them in step.
 */
export const NVPROJ_EXTENSION = '.nvproj';
export const NVPROJ_FORMAT = 'nexysvhdl-project';
export const NVPROJ_VERSION = 1;

export type NvprojProblem = 'NOT_FOUND' | 'UNREADABLE' | 'INVALID_JSON' | 'WRONG_FORMAT' | 'NEWER_VERSION' | 'INVALID_VERSION' | 'INVALID_CONFIG' | 'CONFIG_MISSING';

export type NvprojParse = { readonly ok: true; readonly config: string } | { readonly ok: false; readonly code: NvprojProblem; readonly message: string };

export type NvprojResolution =
    | { readonly ok: true; readonly file: string; /** The project root: the folder holding nexysvhdl.json. */ readonly root: string; readonly configFile: string }
    | { readonly ok: false; readonly code: NvprojProblem; readonly message: string };

/** The text of a new `.nvproj`. */
export function formatNvproj(config: string = PROJECT_FILE_NAME): string {
    return JSON.stringify({ format: NVPROJ_FORMAT, version: NVPROJ_VERSION, config }, null, 2) + '\n';
}

export function isNvprojPath(path: string): boolean {
    return path.toLowerCase().endsWith(NVPROJ_EXTENSION);
}

/** A safe relative `config` path (forward slashes), or a reason it is not. */
export function normalizeConfigPath(value: unknown): { readonly ok: true; readonly path: string } | { readonly ok: false } {
    if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) return { ok: false };
    const path = value.replace(/\\/g, '/');
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return { ok: false };
    const parts = path.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) return { ok: false };
    if (parts[parts.length - 1]!.toLowerCase() !== PROJECT_FILE_NAME) return { ok: false };
    return { ok: true, path: parts.join('/') };
}

/** Parses the text of a `.nvproj`. Pure. */
export function parseNvproj(text: string): NvprojParse {
    let data: unknown;
    try {
        data = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
        return { ok: false, code: 'INVALID_JSON', message: 'This NexysVHDL project file is damaged: it is not valid JSON.' };
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return { ok: false, code: 'INVALID_JSON', message: 'This NexysVHDL project file is damaged: it does not contain a JSON object.' };
    }
    const d = data as { format?: unknown; version?: unknown; config?: unknown };
    if (d.format !== NVPROJ_FORMAT) return { ok: false, code: 'WRONG_FORMAT', message: `This is not a NexysVHDL project file (its "format" is not "${NVPROJ_FORMAT}").` };
    if (typeof d.version !== 'number' || !Number.isInteger(d.version) || d.version < 1) {
        return { ok: false, code: 'INVALID_VERSION', message: 'This NexysVHDL project file has an invalid "version".' };
    }
    if (d.version > NVPROJ_VERSION) {
        return { ok: false, code: 'NEWER_VERSION', message: `This project file was made by a newer NexysVHDL (file version ${d.version}; this one understands ${NVPROJ_VERSION}). Update NexysVHDL to open it.` };
    }
    const config = normalizeConfigPath(d.config);
    if (!config.ok) {
        return { ok: false, code: 'INVALID_CONFIG', message: `This NexysVHDL project file points at an unusable settings file. "config" must be a relative path inside the project folder that ends in ${PROJECT_FILE_NAME}.` };
    }
    return { ok: true, config: config.path };
}

/** Reads a `.nvproj`, checks it and finds the project it launches. Never reads outside the folder it names. */
export async function resolveNvproj(file: string): Promise<NvprojResolution> {
    const abs = resolve(file);
    const name = basename(abs);
    let text: string;
    try {
        text = await readFile(abs, 'utf8');
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ENOTDIR'
            ? { ok: false, code: 'NOT_FOUND', message: `The project file ${name} does not exist any more.` }
            : { ok: false, code: 'UNREADABLE', message: `The project file ${name} could not be read: ${(err as Error).message}` };
    }
    const parsed = parseNvproj(text);
    if (!parsed.ok) return parsed;
    const configFile = resolve(dirname(abs), ...parsed.config.split('/'));
    try {
        if (!(await stat(configFile)).isFile()) throw new Error('not a file');
    } catch {
        return { ok: false, code: 'CONFIG_MISSING', message: `${name} points at ${parsed.config}, which was not found next to it. Was the project folder copied without it?` };
    }
    return { ok: true, file: abs, root: dirname(configFile), configFile };
}

/** `.nvproj` files directly inside a project folder (not recursive), by name. */
export async function findNvprojFiles(root: string): Promise<string[]> {
    try {
        return (await readdir(root, { withFileTypes: true }))
            .filter((e) => e.isFile() && isNvprojPath(e.name))
            .map((e) => join(root, e.name))
            .sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

/** File-name-safe project file name for a folder, e.g. `MyProject` -> `MyProject.nvproj`. */
export function nvprojNameFor(folderName: string): string {
    // eslint-disable-next-line no-control-regex
    const safe = folderName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
    return `${safe === '' ? 'Project' : safe}${NVPROJ_EXTENSION}`;
}

/**
 * Adds `<folder name>.nvproj` to an existing project folder. Never overwrites a file and never
 * touches anything else in the project. Returns the file, and whether it was created now.
 */
export async function createNvprojFile(root: string): Promise<{ readonly file: string; readonly created: boolean }> {
    const file = join(root, nvprojNameFor(basename(resolve(root))));
    try {
        await writeFile(file, formatNvproj(), { encoding: 'utf8', flag: 'wx' });
        return { file, created: true };
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { file, created: false };
        throw err;
    }
}
