#!/usr/bin/env node
// Lists the DLL imports (normal + delay-load) of every PE file (.exe/.dll/.pyd)
// under a folder. Compliance/dependency evidence only (build time; never shipped).
//
//   node scripts/compliance/pe-imports.mjs <folder> [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

function rvaToOffset(sections, rva) {
    for (const s of sections) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.raw;
    return undefined;
}

function cstr(buf, off) {
    let end = off;
    while (end < buf.length && buf[end] !== 0) end++;
    return buf.toString('latin1', off, end);
}

/** DLL names imported by a PE image, or undefined if it is not a PE file. */
export function peImports(buf) {
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return undefined;
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x4550) return undefined;
    const nsec = buf.readUInt16LE(pe + 6);
    const optSize = buf.readUInt16LE(pe + 20);
    const opt = pe + 24;
    const magic = buf.readUInt16LE(opt);
    const dd = opt + (magic === 0x20b ? 112 : 96);
    const sections = [];
    for (let i = 0, s = opt + optSize; i < nsec; i++, s += 40) {
        sections.push({ vsize: buf.readUInt32LE(s + 8), va: buf.readUInt32LE(s + 12), rawSize: buf.readUInt32LE(s + 16), raw: buf.readUInt32LE(s + 20) });
    }
    const names = new Set();
    const walk = (dirIndex, entrySize, nameOffset) => {
        const rva = buf.readUInt32LE(dd + dirIndex * 8);
        if (!rva) return;
        let off = rvaToOffset(sections, rva);
        for (let n = 0; off !== undefined && n < 512; n++, off += entrySize) {
            const nameRva = buf.readUInt32LE(off + nameOffset);
            if (!nameRva) break;
            const no = rvaToOffset(sections, nameRva);
            if (no !== undefined) names.add(cstr(buf, no).toLowerCase());
        }
    };
    walk(1, 20, 12); // import directory: IMAGE_IMPORT_DESCRIPTOR.Name at +12
    walk(13, 32, 4); // delay-load directory: ImgDelayDescr.rvaDLLName at +4
    return [...names].sort();
}

async function main() {
    const [root, flag, out] = process.argv.slice(2);
    const result = {};
    for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (!e.isFile() || !/\.(exe|dll|pyd)$/i.test(e.name)) continue;
        const full = join(e.parentPath, e.name);
        const imports = peImports(readFileSync(full));
        if (imports) result[relative(root, full).split(sep).join('/')] = imports;
    }
    if (flag === '--json' && out) writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
    else console.log(JSON.stringify(result, null, 1));
}

if (import.meta.url === `file:///${process.argv[1].replaceAll('\\', '/')}` || import.meta.url.endsWith(process.argv[1].split(sep).join('/'))) await main();
