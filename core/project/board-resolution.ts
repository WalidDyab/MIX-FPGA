import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Diagnostic, errorDiag } from '../results/diagnostic';

/** The board every NexysVHDL 0.x project was written for. */
export const LEGACY_BOARD_ID = 'nexys-a7-100t';

export type BoardResolution =
    | { readonly ok: true; readonly board: string; /** True when `board` was absent and the legacy default was applied (in memory only; the file is not rewritten). */ readonly legacyDefault: boolean }
    | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

const hasXdcConstraints = (data: Record<string, unknown>): boolean =>
    (typeof data['constraints'] === 'string' && /\.xdc$/i.test(data['constraints'])) ||
    // A "pins" mapping (even an empty one) exists only in the original XDC-generating Nexys A7 project format.
    (typeof data['pins'] === 'object' && data['pins'] !== null && !Array.isArray(data['pins']));

/**
 * Which board a project file is for.
 *
 *  - `board` is a non-empty string: used as is (an unknown id is reported later, by validation).
 *  - `board` is present but not a string, or empty: the file is malformed -> error, never guessed.
 *  - `board` is absent: only a project that is unambiguously an original NexysVHDL project (it names an XDC
 *    file or pin mapping) and holds no Quartus constraint files (*.qsf, *.sdc) is read as the Nexys A7-100T.
 *    Anything else is ambiguous -> error asking for a board. Pure in memory: nothing is written to the project.
 */
export async function resolveProjectBoard(data: Record<string, unknown>, root: string, file?: string): Promise<BoardResolution> {
    const loc = file ? { file } : undefined;
    const board = data['board'];
    if (board !== undefined) {
        if (typeof board !== 'string' || board.trim() === '') {
            return { ok: false, diagnostics: [errorDiag('project', 'PROJECT_BOARD_INVALID', 'The "board" setting must be the id of a supported board, for example "nexys-a7-100t" or "de10-lite".', loc)] };
        }
        return { ok: true, board, legacyDefault: false };
    }
    let quartusFiles = false;
    try {
        quartusFiles = (await readdir(join(root, 'constraints'))).some((n) => /\.(qsf|sdc)$/i.test(n));
    } catch {
        /* no constraints folder */
    }
    if (hasXdcConstraints(data) && !quartusFiles) return { ok: true, board: LEGACY_BOARD_ID, legacyDefault: true };
    return {
        ok: false,
        diagnostics: [
            errorDiag(
                'project',
                'PROJECT_BOARD_MISSING',
                'This project does not say which board it is for. Add a "board" setting ("nexys-a7-100t" or "de10-lite") to nexysvhdl.json.',
                loc,
            ),
        ],
    };
}
