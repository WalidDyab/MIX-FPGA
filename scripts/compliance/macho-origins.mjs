#!/usr/bin/env node
// Maps every Mach-O file (thin arm64/x86_64) of a toolchain folder to the build
// input it came from, for the Toolchain 1.0 compliance audit: a payload file and
// an input file match when their __TEXT,__text sections are byte-identical
// (install-name rewriting and re-signing, as done by bundlers, do not change
// that section). The macOS counterpart of pe-imports.mjs. Build time only;
// never shipped.
//
//   node scripts/compliance/macho-origins.mjs <payload dir> <input dir>... [--out origins.json]
//
// Input dirs are extracted build inputs, one sub-folder per input (e.g. each
// MacPorts binary archive unpacked into its own folder, or a Qt build tree).
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parseArgs } from '../toolchain/lib.mjs';

const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;

/** SHA-256 of the __TEXT,__text section of a thin 64-bit Mach-O, or undefined. */
export function textSectionHash(buf) {
    if (buf.length < 32 || buf.readUInt32LE(0) !== MH_MAGIC_64) return undefined;
    const ncmds = buf.readUInt32LE(16);
    let off = 32;
    for (let i = 0; i < ncmds && off + 8 <= buf.length; i++) {
        const cmd = buf.readUInt32LE(off);
        const size = buf.readUInt32LE(off + 4);
        if (cmd === LC_SEGMENT_64) {
            const nsects = buf.readUInt32LE(off + 64);
            for (let s = 0, p = off + 72; s < nsects; s++, p += 80) {
                const sect = buf.toString('latin1', p, p + 16).replace(/\0.*$/, '');
                const seg = buf.toString('latin1', p + 16, p + 32).replace(/\0.*$/, '');
                if (seg === '__TEXT' && sect === '__text') {
                    const sz = Number(buf.readBigUInt64LE(p + 40));
                    const fileOff = buf.readUInt32LE(p + 48);
                    return sz ? createHash('sha256').update(buf.subarray(fileOff, fileOff + sz)).digest('hex') : undefined;
                }
            }
        }
        off += size;
    }
    return undefined;
}

async function machOFiles(root) {
    const out = [];
    for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (!e.isFile()) continue;
        const full = join(e.parentPath, e.name);
        const buf = readFileSync(full);
        if (buf.length >= 4 && buf.readUInt32LE(0) === MH_MAGIC_64) out.push({ rel: relative(root, full).split(sep).join('/'), hash: textSectionHash(buf) });
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const [payload, ...inputs] = args._;
    if (!payload || !inputs.length) {
        console.error('usage: macho-origins.mjs <payload dir> <input dir>... [--out origins.json]');
        process.exit(2);
    }
    const index = new Map();
    for (const dir of inputs) {
        for (const input of (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() || (e.isSymbolicLink() && statSync(join(dir, e.name)).isDirectory()))) {
            for (const f of await machOFiles(join(dir, input.name))) {
                if (!f.hash) continue;
                if (!index.has(f.hash)) index.set(f.hash, []);
                index.get(f.hash).push({ input: input.name, path: f.rel });
            }
        }
    }
    const files = (await machOFiles(payload)).map((f) => ({ file: f.rel, text: f.hash ?? null, matches: f.hash ? (index.get(f.hash) ?? []) : [] }));
    const result = { payload, inputs, machO: files.length, matched: files.filter((f) => f.matches.length).length, files };
    if (args.out) writeFileSync(args.out, `${JSON.stringify(result, null, 1)}\n`);
    console.log(`${files.length} Mach-O files, ${result.matched} matched to an input`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).join('/').split('/').pop())) await main();
