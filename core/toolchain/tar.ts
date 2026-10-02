import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, lutimes, mkdir, open, readdir, readlink, stat, symlink, utimes } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

/**
 * Minimal POSIX tar (ustar + pax path records) for the NexysVHDL toolchain
 * archive. Written here instead of depending on a tar package: the writer is
 * deterministic (sorted entries, no owner names) and the reader only accepts
 * regular files, directories and relative symbolic links that stay inside the
 * archive (macOS framework layouts and dylib aliases need them; see
 * safeLinkTarget). Links are created only after every file has been written and
 * nothing is ever written through one, so a damaged or hostile archive can never
 * write outside the target folder.
 */

const BLOCK = 512;

/** One file (or symbolic link) of a content inventory. */
export interface InventoryEntry {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    /** Symbolic links only: the relative link target (size 0, no sha256). */
    readonly link?: string;
}

/**
 * Tree hash over "<path>\0<size>\0<sha256>\n" lines (a symbolic link:
 * "<path>\0->\0<target>\n") in sorted path order. Identical to
 * scripts/toolchain/lib.mjs inventory(): timestamps and modes do not matter,
 * content, names and link targets do. A tree without links hashes exactly as
 * before links were supported.
 */
export function treeHash(entries: readonly InventoryEntry[]): string {
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const h = createHash('sha256');
    for (const e of sorted) h.update(e.link !== undefined ? `${e.path}\0->\0${e.link}\n` : `${e.path}\0${e.size}\0${e.sha256}\n`);
    return h.digest('hex');
}

/**
 * A symbolic-link target that provably stays inside the tree: relative,
 * `../` only as a prefix and never above the tree root, then plain names.
 * Because entries are never written through links and every link obeys this
 * rule, resolving any chain of links ends inside the tree.
 */
export function safeLinkTarget(linkPath: string, target: string): string | undefined {
    if (target === '' || target.startsWith('/') || target.includes('\\') || target.includes(':') || target.includes('\0')) return undefined;
    const parts = target.split('/');
    let up = 0;
    while (parts[up] === '..') up++;
    const rest = parts.slice(up);
    if (rest.length === 0 || rest.some((s) => s === '' || s === '.' || s === '..' || /[<>"|?*\x00-\x1f]/.test(s))) return undefined;
    return up <= linkPath.split('/').length - 1 ? target : undefined;
}

async function sha256File(path: string): Promise<string> {
    const h = createHash('sha256');
    for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
    return h.digest('hex');
}

/** Inventory of every regular file and symbolic link under `dir` (POSIX relative paths; links are not followed). */
export async function inventoryDirectory(dir: string, options: { exclude?: readonly string[]; onFile?: (path: string) => void } = {}): Promise<{ entries: InventoryEntry[]; bytes: number; treeSha256: string }> {
    const entries: InventoryEntry[] = [];
    const walk = async (d: string): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true })) {
            const full = join(d, e.name);
            const rel = relative(dir, full).split(sep).join('/');
            if (options.exclude?.some((x) => rel === x || rel.startsWith(`${x}/`))) continue;
            if (e.isDirectory()) await walk(full);
            else if (e.isFile()) {
                options.onFile?.(rel);
                entries.push({ path: rel, size: (await stat(full)).size, sha256: await sha256File(full) });
            } else if (e.isSymbolicLink()) entries.push({ path: rel, size: 0, sha256: '', link: await readlink(full) });
            else throw new Error(`unexpected non-regular file: ${full}`);
        }
    };
    await walk(dir);
    return { entries, bytes: entries.reduce((n, e) => n + e.size, 0), treeSha256: treeHash(entries) };
}

// ---------------------------------------------------------------- writer

function octal(value: number, width: number): string {
    const s = value.toString(8);
    if (s.length > width - 1) throw new Error(`value ${value} does not fit a ${width}-byte tar field`);
    return `${s.padStart(width - 1, '0')}\0`;
}

function header(name: string, size: number, mode: number, mtime: number, type: string, linkname = ''): Buffer {
    const b = Buffer.alloc(BLOCK);
    b.write(name, 0, 100, 'utf8');
    b.write(linkname, 157, 100, 'utf8');
    b.write(octal(mode, 8), 100, 'ascii');
    b.write(octal(0, 8), 108, 'ascii');
    b.write(octal(0, 8), 116, 'ascii');
    b.write(octal(size, 12), 124, 'ascii');
    b.write(octal(mtime, 12), 136, 'ascii');
    b.write('        ', 148, 'ascii');
    b.write(type, 156, 'ascii');
    b.write('ustar\0', 257, 'ascii');
    b.write('00', 263, 'ascii');
    let sum = 0;
    for (const byte of b) sum += byte;
    b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    return b;
}

function pad(size: number): Buffer {
    const rest = size % BLOCK;
    return Buffer.alloc(rest === 0 ? 0 : BLOCK - rest);
}

/** A pax record ("path" or "linkpath"); its length prefix counts itself. */
function paxRecord(key: string, value: string): Buffer {
    const body = ` ${key}=${value}\n`;
    let len = Buffer.byteLength(body) + 1;
    for (;;) {
        const record = `${len}${body}`;
        const actual = Buffer.byteLength(record);
        if (actual === len) return Buffer.from(record, 'utf8');
        len = actual;
    }
}

const needsPax = (s: string) => Buffer.byteLength(s) > 99 || /[^\x20-\x7e]/.test(s);
const shortName = (s: string) => s.slice(0, 99).replace(/[^\x20-\x7e]/g, '_');

function* entryHeader(name: string, size: number, mode: number, mtime: number, type: string, linkname = ''): Generator<Buffer> {
    const longName = needsPax(name);
    const longLink = needsPax(linkname);
    if (longName || longLink) {
        const record = Buffer.concat([...(longName ? [paxRecord('path', name)] : []), ...(longLink ? [paxRecord('linkpath', linkname)] : [])]);
        yield header('PaxHeader', record.length, 0o644, mtime, 'x');
        yield record;
        yield pad(record.length);
        yield header(longName ? shortName(name) : name, size, mode, mtime, type, longLink ? shortName(linkname) : linkname);
    } else yield header(name, size, mode, mtime, type, linkname);
}

/**
 * Writes `dir` as a gzip-compressed tar: entries sorted by path, uid/gid 0,
 * no user names, modes reduced to 755/644, the files' own modification times.
 * Symbolic links are stored as links (never followed) and must satisfy
 * safeLinkTarget.
 */
export async function writeTarGz(dir: string, outFile: string, onProgress?: (bytes: number) => void): Promise<void> {
    const items: Array<{ rel: string; full: string; directory: boolean; link?: string }> = [];
    const walk = async (d: string): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true })) {
            const full = join(d, e.name);
            const rel = relative(dir, full).split(sep).join('/');
            if (e.isDirectory()) {
                items.push({ rel: `${rel}/`, full, directory: true });
                await walk(full);
            } else if (e.isFile()) items.push({ rel, full, directory: false });
            else if (e.isSymbolicLink()) {
                const link = await readlink(full);
                if (!safeLinkTarget(rel, link)) throw new Error(`cannot archive symbolic link ${full} -> ${link}: the target must be relative and inside the folder`);
                items.push({ rel, full, directory: false, link });
            } else throw new Error(`cannot archive non-regular file ${full}`);
        }
    };
    await walk(dir);
    items.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

    let written = 0;
    async function* blocks(): AsyncGenerator<Buffer> {
        for (const item of items) {
            const st = await lstat(item.full);
            const mtime = Math.floor(st.mtimeMs / 1000);
            if (item.directory) {
                yield* entryHeader(item.rel, 0, 0o755, mtime, '5');
                continue;
            }
            if (item.link !== undefined) {
                yield* entryHeader(item.rel, 0, 0o755, mtime, '2', item.link);
                continue;
            }
            yield* entryHeader(item.rel, st.size, st.mode & 0o111 ? 0o755 : 0o644, mtime, '0');
            for await (const chunk of createReadStream(item.full, { highWaterMark: 1 << 20 })) {
                written += (chunk as Buffer).length;
                onProgress?.(written);
                yield chunk as Buffer;
            }
            yield pad(st.size);
        }
        yield Buffer.alloc(BLOCK * 2);
    }
    await pipeline(Readable.from(blocks()), createGzip({ level: 6 }), createWriteStream(outFile));
}

// ---------------------------------------------------------------- reader

export class ArchiveError extends Error {}

/** A relative POSIX path that stays inside the extraction folder on every OS. */
export function safeArchivePath(name: string): string | undefined {
    const p = name.replace(/\/+$/, '');
    if (p === '' || p.startsWith('/') || p.includes('\\') || p.includes(':') || p.includes('\0')) return undefined;
    const parts = p.split('/');
    if (parts.some((s) => s === '' || s === '.' || s === '..' || /[<>"|?*\x00-\x1f]/.test(s) || /[ .]$/.test(s))) return undefined;
    return p;
}

function field(b: Buffer, offset: number, length: number): string {
    const raw = b.subarray(offset, offset + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? length : end).toString('utf8');
}

function parseOctal(b: Buffer, offset: number, length: number): number {
    const s = field(b, offset, length).trim();
    if (!/^[0-7]*$/.test(s)) throw new ArchiveError('malformed tar header (numeric field)');
    return s === '' ? 0 : parseInt(s, 8);
}

function checksumOk(b: Buffer): boolean {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : b[i]!;
    return sum === parseOctal(b, 148, 8);
}

function parsePax(data: Buffer): Record<string, string> {
    const out: Record<string, string> = {};
    let i = 0;
    while (i < data.length) {
        const space = data.indexOf(0x20, i);
        if (space < 0) break;
        const len = parseInt(data.subarray(i, space).toString('ascii'), 10);
        if (!Number.isFinite(len) || len <= 0) throw new ArchiveError('malformed pax header');
        const record = data.subarray(space + 1, i + len - 1).toString('utf8');
        const eq = record.indexOf('=');
        if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
        i += len;
    }
    return out;
}

export interface ExtractProgress {
    readonly compressedBytes: number;
    readonly files: number;
}

/**
 * Extracts a .tar.gz into `dest` (which must exist and be empty), returning
 * the content inventory computed while writing. Only regular files,
 * directories and safe relative symbolic links (safeLinkTarget) are accepted;
 * any other entry type, unsafe path or link target, entry below a link,
 * duplicate or malformed header aborts the extraction. Links are created last.
 */
export async function extractTarGz(
    archive: string,
    dest: string,
    options: { onProgress?: (p: ExtractProgress) => void; signal?: AbortSignal } = {},
): Promise<{ entries: InventoryEntry[]; treeSha256: string }> {
    const entries: InventoryEntry[] = [];
    const seen = new Set<string>();
    let compressed = 0;
    const input = createReadStream(archive);
    input.on('data', (c) => (compressed += (c as Buffer).length));
    const gunzip = input.pipe(createGunzip({ chunkSize: 1 << 20 }));
    input.on('error', (e) => gunzip.destroy(e));

    let buf: Buffer = Buffer.alloc(0);
    let ended = false;
    const iterator = gunzip[Symbol.asyncIterator]();
    /** Ensures at least `n` bytes are buffered (or the stream ended). */
    const fill = async (n: number) => {
        while (buf.length < n && !ended) {
            if (options.signal?.aborted) throw new ArchiveError('cancelled');
            const next = await iterator.next();
            if (next.done) ended = true;
            else buf = buf.length === 0 ? (next.value as Buffer) : Buffer.concat([buf, next.value as Buffer]);
        }
        return buf.length >= n;
    };
    const take = (n: number) => {
        const out = buf.subarray(0, n);
        buf = buf.subarray(n);
        return out;
    };

    const links: Array<{ rel: string; target: string; mtime: number }> = [];
    const linkPaths = new Set<string>();
    const throughLink = (rel: string) => {
        const parts = rel.split('/');
        for (let i = 1; i < parts.length; i++) if (linkPaths.has(parts.slice(0, i).join('/'))) return true;
        return false;
    };
    let pax: Record<string, string> = {};
    for (;;) {
        if (!(await fill(BLOCK))) throw new ArchiveError('archive is truncated');
        const h = Buffer.from(take(BLOCK));
        if (h.every((x) => x === 0)) break;
        if (!checksumOk(h)) throw new ArchiveError('tar header checksum mismatch (damaged archive)');
        const type = String.fromCharCode(h[156]!) || '0';
        const size = parseOctal(h, 124, 12);
        const padded = Math.ceil(size / BLOCK) * BLOCK;
        const prefix = field(h, 345, 155);
        const name = pax['path'] ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
        const linkname = pax['linkpath'] ?? field(h, 157, 100);

        if (type === 'x' || type === 'g') {
            if (size > 1 << 20) throw new ArchiveError('oversized pax header');
            if (!(await fill(padded))) throw new ArchiveError('archive is truncated');
            const data = parsePax(Buffer.from(take(padded).subarray(0, size)));
            if (type === 'x') pax = data;
            continue;
        }
        pax = {};
        const rel = safeArchivePath(name);
        if (!rel) throw new ArchiveError(`unsafe path in archive: ${JSON.stringify(name)}`);
        if (seen.has(rel)) throw new ArchiveError(`duplicate entry in archive: ${rel}`);
        seen.add(rel);
        if (throughLink(rel)) throw new ArchiveError(`entry below a symbolic link in archive: ${rel}`);
        const target = join(dest, ...rel.split('/'));
        const mtime = parseOctal(h, 136, 12);

        if (type === '5') {
            await mkdir(target, { recursive: true });
            continue;
        }
        if (type === '2') {
            if (size !== 0) throw new ArchiveError(`malformed symbolic link entry: ${rel}`);
            if (!safeLinkTarget(rel, linkname)) throw new ArchiveError(`unsafe symbolic link in archive: ${rel} -> ${JSON.stringify(linkname)}`);
            links.push({ rel, target: linkname, mtime });
            linkPaths.add(rel);
            entries.push({ path: rel, size: 0, sha256: '', link: linkname });
            continue;
        }
        if (type !== '0' && type !== '\0' && type !== '7') throw new ArchiveError(`unsupported entry type "${type}" for ${rel} (hard links and special files are not allowed)`);

        await mkdir(join(target, '..'), { recursive: true });
        const fh = await open(target, 'wx');
        const hash = createHash('sha256');
        try {
            let remaining = size;
            while (remaining > 0) {
                if (!(await fill(1))) throw new ArchiveError('archive is truncated');
                const chunk = take(Math.min(remaining, buf.length));
                hash.update(chunk);
                await fh.write(chunk);
                remaining -= chunk.length;
            }
        } finally {
            await fh.close();
        }
        if (!(await fill(padded - size))) throw new ArchiveError('archive is truncated');
        take(padded - size);
        await utimes(target, mtime, mtime);
        // Executable bit for POSIX hosts; on Windows this only keeps the file writable.
        await chmod(target, parseOctal(h, 100, 8) & 0o111 ? 0o755 : 0o644);
        entries.push({ path: rel, size, sha256: hash.digest('hex') });
        options.onProgress?.({ compressedBytes: compressed, files: entries.length });
    }
    input.destroy();
    // A link may not take the place of a folder that already received entries.
    for (const rel of seen) if (throughLink(rel)) throw new ArchiveError(`entry below a symbolic link in archive: ${rel}`);
    for (const l of links) {
        const path = join(dest, ...l.rel.split('/'));
        await mkdir(join(path, '..'), { recursive: true });
        try {
            await symlink(l.target, path);
        } catch (err) {
            throw new ArchiveError(`cannot create symbolic link ${l.rel}: ${(err as Error).message}`);
        }
        await lutimes(path, l.mtime, l.mtime).catch(() => undefined);
    }
    return { entries, treeSha256: treeHash(entries) };
}
