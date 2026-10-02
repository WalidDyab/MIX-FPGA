import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, stat, utimes } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

/**
 * Minimal POSIX tar (ustar + pax path records) for the NexysVHDL toolchain
 * archive. Written here instead of depending on a tar package: the writer is
 * deterministic (sorted entries, no owner names) and the reader only accepts
 * regular files and directories with safe relative paths, so a damaged or
 * hostile archive can never write outside the target folder or create links.
 */

const BLOCK = 512;

/** One file of a content inventory. */
export interface InventoryEntry {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
}

/**
 * Tree hash over "<path>\0<size>\0<sha256>\n" lines in sorted path order.
 * Identical to scripts/toolchain/lib.mjs inventory(): timestamps and modes do
 * not matter, content and names do.
 */
export function treeHash(entries: readonly InventoryEntry[]): string {
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const h = createHash('sha256');
    for (const e of sorted) h.update(`${e.path}\0${e.size}\0${e.sha256}\n`);
    return h.digest('hex');
}

async function sha256File(path: string): Promise<string> {
    const h = createHash('sha256');
    for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
    return h.digest('hex');
}

/** Inventory of every regular file under `dir` (POSIX relative paths). Symbolic links are refused. */
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
            } else throw new Error(`unexpected non-regular file: ${full}`);
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

function header(name: string, size: number, mode: number, mtime: number, type: string): Buffer {
    const b = Buffer.alloc(BLOCK);
    b.write(name, 0, 100, 'utf8');
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

/** A pax "path" record; its length prefix counts itself. */
function paxPath(path: string): Buffer {
    const body = ` path=${path}\n`;
    let len = Buffer.byteLength(body) + 1;
    for (;;) {
        const record = `${len}${body}`;
        const actual = Buffer.byteLength(record);
        if (actual === len) return Buffer.from(record, 'utf8');
        len = actual;
    }
}

function* entryHeader(name: string, size: number, mode: number, mtime: number, type: string): Generator<Buffer> {
    if (Buffer.byteLength(name) > 99 || /[^\x20-\x7e]/.test(name)) {
        const record = paxPath(name);
        yield header('PaxHeader', record.length, 0o644, mtime, 'x');
        yield record;
        yield pad(record.length);
        yield header(name.slice(0, 99).replace(/[^\x20-\x7e]/g, '_'), size, mode, mtime, type);
    } else yield header(name, size, mode, mtime, type);
}

/**
 * Writes `dir` as a gzip-compressed tar: entries sorted by path, uid/gid 0,
 * no user names, modes reduced to 755/644, the files' own modification times.
 */
export async function writeTarGz(dir: string, outFile: string, onProgress?: (bytes: number) => void): Promise<void> {
    const items: Array<{ rel: string; full: string; directory: boolean }> = [];
    const walk = async (d: string): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true })) {
            const full = join(d, e.name);
            const rel = relative(dir, full).split(sep).join('/');
            if (e.isDirectory()) {
                items.push({ rel: `${rel}/`, full, directory: true });
                await walk(full);
            } else if (e.isFile()) items.push({ rel, full, directory: false });
            else throw new Error(`cannot archive non-regular file ${full}`);
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
 * the content inventory computed while writing. Only regular files and
 * directories are accepted; any other entry type, unsafe path, duplicate or
 * malformed header aborts the extraction.
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
        const target = join(dest, ...rel.split('/'));
        const mtime = parseOctal(h, 136, 12);

        if (type === '5') {
            await mkdir(target, { recursive: true });
            continue;
        }
        if (type !== '0' && type !== '\0' && type !== '7') throw new ArchiveError(`unsupported entry type "${type}" for ${rel} (links are not allowed)`);

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
    return { entries, treeSha256: treeHash(entries) };
}
