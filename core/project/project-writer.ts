import { readFile } from 'node:fs/promises';
import { serializeFileJob, writeFileAtomic } from '../util/atomic-write';
import type { ProjectFile } from './types';

/** Fields of nexysvhdl.json a tool may change; `undefined` removes the field. */
export type ProjectFilePatch = { -readonly [K in keyof ProjectFile]?: ProjectFile[K] | undefined };

/** The canonical text of a project file (2-space JSON, trailing newline). */
export function formatProjectFile(config: ProjectFile | Record<string, unknown>): string {
    return JSON.stringify(config, null, 2) + '\n';
}

/**
 * Applies a patch to nexysvhdl.json in place. Fields not in the patch,
 * including ones this version does not know, are kept in their original
 * order. Returns true if the file changed.
 */
export function updateProjectFile(file: string, patch: ProjectFilePatch): Promise<boolean> {
    // Serialized per file and written atomically: simultaneous updates never lose each other and a crash never truncates the project.
    return serializeFileJob(file, () => applyPatch(file, patch));
}

async function applyPatch(file: string, patch: ProjectFilePatch): Promise<boolean> {
    const before = await readFile(file, 'utf8');
    const data = JSON.parse(before) as unknown;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`${file} must contain a JSON object.`);
    const next: Record<string, unknown> = { ...(data as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
    }
    // Compare content, not formatting: an unchanged project keeps its file untouched.
    if (JSON.stringify(next) === JSON.stringify(data)) return false;
    await writeFileAtomic(file, formatProjectFile(next));
    return true;
}
