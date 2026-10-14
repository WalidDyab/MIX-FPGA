import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readdir, readlink, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256File } from '../util/hash';

/**
 * Exact description of a folder tree: every file (hash, size, executable bit) and every
 * symbolic link (verbatim target). Empty folders and modification times are deliberately not
 * part of the description. Used to record what a validated install is and to prove an installed
 * copy still is that.
 */
export interface TreeFile {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
    readonly exec: boolean;
}
export interface TreeLink {
    readonly path: string;
    readonly target: string;
}
export interface TreeInventory {
    readonly files: readonly TreeFile[];
    readonly links: readonly TreeLink[];
}

const posix = (p: string): string => p.split('\\').join('/');
const isExec = (mode: number): boolean => (mode & 0o111) !== 0;

async function walk(root: string, rel: string, out: { dirs: string[]; files: string[]; links: string[] }): Promise<void> {
    for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
        const r = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isSymbolicLink()) out.links.push(r);
        else if (e.isDirectory()) {
            out.dirs.push(r);
            await walk(root, r, out);
        } else if (e.isFile()) out.files.push(r);
    }
}

/** Inventory of a folder, or of a single file (path ''). `hash: false` skips content hashing (quick checks). */
export async function inventoryTree(root: string, opts: { hash?: boolean } = {}): Promise<TreeInventory> {
    const hash = opts.hash ?? true;
    const top = await lstat(root);
    if (top.isFile()) {
        return { files: [{ path: '', sha256: hash ? await sha256File(root) : '', size: top.size, exec: isExec(top.mode) }], links: [] };
    }
    const found = { dirs: [] as string[], files: [] as string[], links: [] as string[] };
    await walk(root, '', found);
    const files: TreeFile[] = [];
    for (const r of found.files.sort()) {
        const s = await stat(join(root, r));
        files.push({ path: posix(r), sha256: hash ? await sha256File(join(root, r)) : '', size: s.size, exec: isExec(s.mode) });
    }
    const links: TreeLink[] = [];
    for (const r of found.links.sort()) links.push({ path: posix(r), target: await readlink(join(root, r)) });
    return { files, links };
}

/** One hash for a whole tree (what a manifest records). */
export function treeDigest(inv: TreeInventory): string {
    const lines = [...inv.files.map((f) => ({ k: f.path, t: `F ${f.sha256} ${f.exec ? 'x' : '-'} ${f.path}` })), ...inv.links.map((l) => ({ k: l.path, t: `L ${l.target} ${l.path}` }))];
    lines.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    const h = createHash('sha256');
    for (const l of lines) h.update(`${l.t}\n`);
    return h.digest('hex');
}

export function treeBytes(inv: TreeInventory): number {
    return inv.files.reduce((n, f) => n + f.size, 0);
}

export interface TreeDifference {
    readonly missing: readonly string[];
    /** Present but not in the expected inventory. */
    readonly extra: readonly string[];
    /** Content differs (hash, or size when hashes were not computed). */
    readonly modified: readonly string[];
    /** Executable bit differs. */
    readonly modeChanged: readonly string[];
    readonly linkChanged: readonly string[];
}

export const treeIsIdentical = (d: TreeDifference): boolean => d.missing.length + d.extra.length + d.modified.length + d.modeChanged.length + d.linkChanged.length === 0;

/** `quick`: compare sizes and modes only for files not listed in `hashPaths`; those are always content-hashed. */
export function compareTree(expected: TreeInventory, actual: TreeInventory, opts: { quick?: boolean; hashPaths?: ReadonlySet<string> } = {}): TreeDifference {
    const missing: string[] = [];
    const extra: string[] = [];
    const modified: string[] = [];
    const modeChanged: string[] = [];
    const linkChanged: string[] = [];
    const have = new Map(actual.files.map((f) => [f.path, f]));
    for (const e of expected.files) {
        const a = have.get(e.path);
        if (!a) {
            missing.push(e.path);
            continue;
        }
        have.delete(e.path);
        const contentChecked = !opts.quick || (opts.hashPaths?.has(e.path) ?? false);
        if (a.size !== e.size || (contentChecked && a.sha256 !== e.sha256)) modified.push(e.path);
        else if (a.exec !== e.exec) modeChanged.push(e.path);
    }
    extra.push(...have.keys());
    const links = new Map(actual.links.map((l) => [l.path, l]));
    for (const e of expected.links) {
        const a = links.get(e.path);
        if (!a) missing.push(e.path);
        else {
            links.delete(e.path);
            if (a.target !== e.target) linkChanged.push(e.path);
        }
    }
    extra.push(...links.keys());
    return { missing, extra, modified, modeChanged, linkChanged };
}

export function describeDifference(d: TreeDifference): string {
    const part = (n: number, w: string) => (n > 0 ? [`${n} ${w}`] : []);
    return [...part(d.missing.length, 'missing'), ...part(d.modified.length, 'changed'), ...part(d.modeChanged.length, 'with changed permissions'), ...part(d.linkChanged.length, 'with changed links'), ...part(d.extra.length, 'unexpected')].join(', ');
}

/** Copy a file or folder, keeping the executable bit and symbolic links exactly as they are. Never follows links. */
export async function copyTree(src: string, dest: string): Promise<void> {
    const s = await lstat(src);
    if (s.isSymbolicLink()) await symlink(await readlink(src), dest);
    else if (s.isDirectory()) {
        await mkdir(dest, { recursive: true });
        for (const name of (await readdir(src)).sort()) await copyTree(join(src, name), join(dest, name));
    } else if (s.isFile()) {
        await copyFile(src, dest);
        await chmod(dest, s.mode & 0o777);
    }
}

async function chmodTree(root: string, change: (mode: number, isDir: boolean) => number): Promise<void> {
    const s = await lstat(root);
    if (s.isSymbolicLink()) return;
    if (s.isDirectory()) {
        // Make the folder itself writable first when opening it up, and last when closing it.
        const open = change(s.mode & 0o777, true);
        if (open & 0o200) await chmod(root, open);
        for (const name of await readdir(root)) await chmodTree(join(root, name), change);
        if (!(open & 0o200)) await chmod(root, open);
    } else await chmod(root, change(s.mode & 0o777, false));
}

/** Installed toolchain files are read-only: a stray edit or tool write cannot silently change what was verified. */
export const makeReadOnly = (root: string): Promise<void> => chmodTree(root, (m) => m & ~0o222);
export const makeWritable = (root: string): Promise<void> => chmodTree(root, (m, isDir) => m | (isDir ? 0o700 : 0o600));
