import { createHash } from 'node:crypto';
import { realpath } from 'node:fs';
import { lstat, mkdir, symlink } from 'node:fs/promises';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { apioPathProblem, type PathAlias } from '../../core';
import { type EnvironmentVariables, getEnv } from './host-environment';

/** Filesystem operations used by the alias (injected in tests). */
export interface AliasFileSystem {
    /** Canonical target of a path (follows junctions), or undefined if it does not exist. */
    realpath(path: string): Promise<string | undefined>;
    exists(path: string): Promise<boolean>;
    mkdirp(path: string): Promise<void>;
    junction(target: string, path: string): Promise<void>;
}

const realpathNative = promisify(realpath.native);

export const nodeAliasFileSystem: AliasFileSystem = {
    async realpath(path) {
        try {
            // realpath.native: resolves junctions and returns the on-disk spelling.
            return await realpathNative(path);
        } catch {
            return undefined;
        }
    },
    async exists(path) {
        try {
            await lstat(path);
            return true;
        } catch {
            return false;
        }
    },
    async mkdirp(path) {
        await mkdir(path, { recursive: true });
    },
    async junction(target, path) {
        await symlink(target, path, 'junction');
    },
};

/** Where the aliases live: a NexysVHDL-owned folder under %ProgramData% (machine-wide, ASCII on every Windows edition). */
export function aliasFolder(env: EnvironmentVariables): string | undefined {
    const programData = getEnv(env, 'ProgramData') ?? getEnv(env, 'ALLUSERSPROFILE');
    return programData ? win32.join(programData, 'NexysVHDL', 'links') : undefined;
}

const same = (a: string, b: string) => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();

/**
 * An ASCII, space-free path for `target`: a directory junction
 * `%ProgramData%\NexysVHDL\links\<hash>` -> target.
 *
 * Why: Apio refuses APIO_HOME/APIO_PACKAGES paths outside ASCII 33-127
 * (apio/utils/util.py), so a toolchain under a profile such as "José García" would
 * otherwise disable Build. The files stay in the user's own folder; only the
 * path handed to the tools changes.
 *
 * - Junctions need no administrator rights or Developer Mode, and Users may
 *   create folders in %ProgramData% (they own what they create).
 * - The name is a hash of the target, so each user/version gets its own
 *   alias; an existing entry is used only if it already resolves to the
 *   target. Anything else under that name (another user's folder, a planted
 *   junction) is never used: the next name is tried.
 * - Not 8.3 short names (they can be disabled per volume).
 */
export async function windowsPathAlias(target: string, env: EnvironmentVariables, fs: AliasFileSystem = nodeAliasFileSystem): Promise<PathAlias> {
    const folder = aliasFolder(env);
    if (!folder) return { problem: 'ProgramData is not set' };
    const bad = apioPathProblem(folder);
    if (bad) return { problem: `the alias folder ${folder} contains ${bad}` };
    const real = await fs.realpath(target);
    if (!real) return { problem: `${target} does not exist` };
    const id = createHash('sha256').update(real.toLowerCase()).digest('hex').slice(0, 16);
    try {
        await fs.mkdirp(folder);
    } catch (err) {
        return { problem: `cannot create ${folder}: ${(err as Error).message}` };
    }
    for (let n = 0; n < 8; n++) {
        const link = win32.join(folder, n === 0 ? id : `${id}-${n}`);
        if (await fs.exists(link)) {
            const points = await fs.realpath(link);
            if (points && same(points, real)) return { path: link };
            continue; // someone else's entry: never used
        }
        try {
            await fs.junction(real, link);
        } catch (err) {
            // A concurrent NexysVHDL window may have created it a moment ago.
            if (!(await fs.exists(link))) return { problem: `cannot create the junction ${link}: ${(err as Error).message}` };
        }
        const points = await fs.realpath(link);
        if (points && same(points, real)) return { path: link };
    }
    return { problem: `no usable alias name under ${folder}` };
}
