import { createHash } from 'node:crypto';
import { lstat, mkdir, readlink, realpath, symlink, unlink } from 'node:fs/promises';
import { posix } from 'node:path';
import { apioPathProblem, type PathAlias } from '../../core';

/** What the alias needs to know about an entry, without following a final symlink. */
export interface EntryInfo {
    readonly isDirectory: boolean;
    readonly isSymbolicLink: boolean;
    readonly uid: number;
    readonly mode: number;
}

/** Filesystem operations used by the alias (injected in tests). */
export interface MacosAliasFileSystem {
    /** The current user's uid. */
    uid(): number;
    /** Entry information (lstat: a symlink is reported as such), or undefined if absent. */
    entry(path: string): Promise<EntryInfo | undefined>;
    /** Canonical path (symlinks followed), or undefined if it does not exist. */
    realpath(path: string): Promise<string | undefined>;
    readlink(path: string): Promise<string | undefined>;
    /** Creates one directory (not recursive) with the given mode. */
    mkdir(path: string, mode: number): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
    unlink(path: string): Promise<void>;
}

export const nodeMacosAliasFileSystem: MacosAliasFileSystem = {
    uid: () => process.getuid?.() ?? -1,
    async entry(path) {
        try {
            const s = await lstat(path);
            return { isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink(), uid: s.uid, mode: s.mode };
        } catch {
            return undefined;
        }
    },
    async realpath(path) {
        try {
            return await realpath(path);
        } catch {
            return undefined;
        }
    },
    async readlink(path) {
        try {
            return await readlink(path);
        } catch {
            return undefined;
        }
    },
    async mkdir(path, mode) {
        await mkdir(path, { mode });
    },
    async symlink(target, path) {
        await symlink(target, path);
    },
    async unlink(path) {
        await unlink(path);
    },
};

export const MACOS_ALIAS_FOLDER = 'NexysVHDL-links';

/** No write access for group or others. */
const privateMode = (mode: number) => (mode & 0o022) === 0;

/**
 * An ASCII, space-free path for `target`: a symbolic link
 * `$TMPDIR/NexysVHDL-links/<hash>` -> target.
 *
 * Why: Apio refuses APIO_HOME/APIO_PACKAGES paths outside ASCII 33-127, so a
 * toolchain under a home folder such as "/Volumes/Home Drive/José García" (a moved or
 * network home; macOS short names themselves cannot contain spaces) would
 * otherwise disable Build and the RTL Schematic. The files stay in the real
 * ~/Library/NexysVHDL store; only the path handed to the tools changes.
 *
 * - `$TMPDIR` is the per-user Darwin temporary folder that launchd gives every
 *   app (/var/folders/<..>/T/): plain ASCII, owned by the user, mode 0700, so
 *   no other account can see or plant entries in it. It must be ASCII, owned by
 *   the user and not writable by group/others; otherwise no alias is made.
 * - The alias folder is created 0700 and must be a real directory (not a link)
 *   owned by the user and not writable by group/others.
 * - The name is a hash of the canonical target. An existing entry is used only
 *   if it is the user's own symbolic link to exactly that target. The user's
 *   own dangling link of that name (e.g. after the target moved) is replaced;
 *   anything else is never used and the next name is tried.
 * - macOS may purge old files from $TMPDIR; the alias is checked and recreated
 *   every time the toolchain is loaded. No administrator rights, no change to
 *   HOME, no ~/.apio.
 */
export async function macosPathAlias(target: string, env: Readonly<Record<string, string | undefined>>, fs: MacosAliasFileSystem = nodeMacosAliasFileSystem): Promise<PathAlias> {
    const tmp = env['TMPDIR']?.replace(/\/+$/, '');
    if (!tmp || !posix.isAbsolute(tmp)) return { problem: 'TMPDIR is not set to an absolute folder' };
    const folder = posix.join(tmp, MACOS_ALIAS_FOLDER);
    const bad = apioPathProblem(folder);
    if (bad) return { problem: `the alias folder ${folder} contains ${bad}` };
    const uid = fs.uid();

    const tmpReal = await fs.realpath(tmp);
    const tmpInfo = tmpReal ? await fs.entry(tmpReal) : undefined;
    if (!tmpInfo?.isDirectory) return { problem: `${tmp} is not a folder` };
    if (tmpInfo.uid !== uid || !privateMode(tmpInfo.mode)) return { problem: `${tmp} is not a private folder of this user` };

    let info = await fs.entry(folder);
    if (!info) {
        try {
            await fs.mkdir(folder, 0o700);
        } catch (err) {
            // A concurrent NexysVHDL window may have created it a moment ago.
            if (!(await fs.entry(folder))) return { problem: `cannot create ${folder}: ${(err as Error).message}` };
        }
        info = await fs.entry(folder);
    }
    if (!info?.isDirectory || info.isSymbolicLink || info.uid !== uid || !privateMode(info.mode)) {
        return { problem: `${folder} is not a private folder of this user; it is not used` };
    }

    const real = await fs.realpath(target);
    if (!real) return { problem: `${target} does not exist` };
    const id = createHash('sha256').update(real).digest('hex').slice(0, 16);
    const ours = async (link: string) => {
        const e = await fs.entry(link);
        return e?.isSymbolicLink === true && e.uid === uid && (await fs.readlink(link)) === real && (await fs.realpath(link)) === real;
    };
    for (let n = 0; n < 8; n++) {
        const link = posix.join(folder, n === 0 ? id : `${id}-${n}`);
        const e = await fs.entry(link);
        if (e) {
            if (await ours(link)) return { path: link };
            // Only the user's own dangling link of this name is replaced; anything else is never used.
            if (!(e.isSymbolicLink && e.uid === uid && (await fs.realpath(link)) === undefined)) continue;
            try {
                await fs.unlink(link);
            } catch {
                continue;
            }
        }
        try {
            await fs.symlink(real, link);
        } catch (err) {
            if (!(await fs.entry(link))) return { problem: `cannot create the link ${link}: ${(err as Error).message}` };
        }
        if (await ours(link)) return { path: link };
    }
    return { problem: `no usable alias name under ${folder}` };
}
