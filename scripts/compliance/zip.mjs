// Minimal deterministic zip writer for release packages (build time only).
// Stored entries (the payload is already compressed), sorted paths, a fixed
// timestamp and fixed attributes, so the same tree always gives the same bytes.
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { listFiles } from '../toolchain/lib.mjs';

const ZIP_TIME = { date: ((2026 - 1980) << 9) | (1 << 5) | 1, time: 0 }; // 2026-01-01 00:00

/** Minimal deterministic zip (stored entries, fixed timestamp, sorted paths). */
export async function writeZip(root, out) {
    const files = await listFiles(root);
    const ws = createWriteStream(out);
    let offset = 0;
    const central = [];
    const write = (buf) => new Promise((resolve, reject) => ws.write(buf, (e) => (e ? reject(e) : resolve())));
    for (const f of files) {
        const full = join(root, ...f.split('/'));
        const size = (await stat(full)).size;
        let crc = 0;
        for await (const chunk of createReadStream(full)) crc = crc32(chunk, crc);
        const name = Buffer.from(f, 'utf8');
        if (offset + size > 0xffffffff - 1e6) throw new Error('zip exceeds 4 GiB (zip64 is not implemented)');
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0);
        head.writeUInt16LE(20, 4);
        head.writeUInt16LE(0x0800, 6); // UTF-8 names
        head.writeUInt16LE(0, 8); // stored
        head.writeUInt16LE(ZIP_TIME.time, 10);
        head.writeUInt16LE(ZIP_TIME.date, 12);
        head.writeUInt32LE(crc, 14);
        head.writeUInt32LE(size, 18);
        head.writeUInt32LE(size, 22);
        head.writeUInt16LE(name.length, 26);
        await write(Buffer.concat([head, name]));
        for await (const chunk of createReadStream(full)) await write(chunk);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(0x031e, 4); // made by: Unix, 3.0
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(0x0800, 8);
        c.writeUInt16LE(0, 10);
        c.writeUInt16LE(ZIP_TIME.time, 12);
        c.writeUInt16LE(ZIP_TIME.date, 14);
        c.writeUInt32LE(crc, 16);
        c.writeUInt32LE(size, 20);
        c.writeUInt32LE(size, 24);
        c.writeUInt16LE(name.length, 28);
        c.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
        c.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([c, name]));
        offset += 30 + name.length + size;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    await write(Buffer.concat([cd, end]));
    await new Promise((resolve, reject) => ws.end((e) => (e ? reject(e) : resolve())));
    return files.length;
}
