import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { type Diagnostic, errorDiag } from '../results/diagnostic';
import { resolveProjectBoard } from './board-resolution';
import { PROJECT_DEFAULTS, PROJECT_FILE_NAME, type Project, type ProjectFile } from './types';

export type ProjectLoadResult =
    | { readonly ok: true; readonly project: Project }
    | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * Reads nexysvhdl.json from a project directory (or an explicit file path).
 * Only parses and applies defaults; semantic checks live in validateProject().
 */
export async function loadProject(dirOrFile: string): Promise<ProjectLoadResult> {
    const abs = resolve(dirOrFile);
    const file = abs.toLowerCase().endsWith('.json') ? abs : resolve(abs, PROJECT_FILE_NAME);

    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch {
        return {
            ok: false,
            diagnostics: [errorDiag('project', 'PROJECT_FILE_NOT_FOUND', `No ${PROJECT_FILE_NAME} found at ${file}.`)],
        };
    }

    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (err) {
        return {
            ok: false,
            diagnostics: [errorDiag('project', 'PROJECT_FILE_INVALID_JSON', `${file} is not valid JSON: ${(err as Error).message}`, { file })],
        };
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return { ok: false, diagnostics: [errorDiag('project', 'PROJECT_FILE_INVALID_JSON', `${file} must contain a JSON object.`, { file })] };
    }

    const root = dirname(file);
    // Never reinterpret a malformed project: the board is resolved explicitly (see resolveProjectBoard).
    const board = await resolveProjectBoard(data as Record<string, unknown>, root, file);
    if (!board.ok) return { ok: false, diagnostics: board.diagnostics };
    const { board: _ignored, ...rest } = PROJECT_DEFAULTS as Record<string, unknown>;
    void _ignored;
    const config = { ...rest, ...(data as Partial<ProjectFile>), board: board.board } as ProjectFile;
    return { ok: true, project: { root, file, config, ...(board.legacyDefault ? { legacyBoardDefault: true } : {}) } };
}
