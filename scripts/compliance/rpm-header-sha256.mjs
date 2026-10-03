#!/usr/bin/env node
// Reads the SHA-256 of an RPM's main header (signature tag 273, RPMSIGTAG_SHA256)
// from the first bytes of an .rpm file, local or fetched by HTTP range request.
// Comparing it with the `sha256header` an RPM database records for an installed
// package proves that the installed package is that exact build. Build-time
// compliance evidence only (never shipped).
//
//   node scripts/compliance/rpm-header-sha256.mjs <file-or-https-url>...
import { readFileSync } from 'node:fs';

/** The main-header SHA-256 recorded in an RPM's signature header, or undefined. */
export function rpmHeaderSha256(buf) {
    if (buf.readUInt32BE(0) !== 0xedabeedb) throw new Error('not an RPM (lead magic)');
    const sig = 96;
    if (buf.readUInt32BE(sig) !== 0x8eade801) throw new Error('bad signature header magic');
    const il = buf.readUInt32BE(sig + 8);
    const store = sig + 16 + 16 * il;
    for (let i = 0; i < il; i++) {
        const e = sig + 16 + 16 * i;
        const [tag, type, off] = [buf.readUInt32BE(e), buf.readUInt32BE(e + 4), buf.readUInt32BE(e + 8)];
        if (tag === 273 && type === 6) {
            const start = store + off;
            return buf.toString('ascii', start, buf.indexOf(0, start));
        }
    }
    return undefined;
}

async function head(src) {
    if (!/^https:\/\//.test(src)) return readFileSync(src);
    const res = await fetch(src, { headers: { Range: 'bytes=0-65535' } });
    if (res.status !== 206 && res.status !== 200) throw new Error(`${src}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/compliance/rpm-header-sha256.mjs')) {
    for (const src of process.argv.slice(2)) console.log(`${rpmHeaderSha256(await head(src)) ?? '-'}  ${src}`);
}
