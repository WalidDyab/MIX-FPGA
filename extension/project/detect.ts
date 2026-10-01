import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_FILE_NAME } from '../../core';

/** First folder (in order) that holds a nexysvhdl.json at its root. */
export async function findProjectRoot(folders: readonly string[]): Promise<string | undefined> {
    for (const folder of folders) {
        try {
            if ((await stat(join(folder, PROJECT_FILE_NAME))).isFile()) return folder;
        } catch {
            /* not a project folder */
        }
    }
    return undefined;
}
