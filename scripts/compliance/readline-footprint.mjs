#!/usr/bin/env node
// Which Windows programs and libraries of a toolchain tree load GNU Readline (or the GPL libraries it pulls in)? Reads the import
// tables of EVERY file that is a PE image, whatever its extension (.exe .dll .pyd .vpi .tgt .so ...). Compliance evidence only.
//
//   node scripts/compliance/readline-footprint.mjs <tree> [--out footprint.json] [--label "..."]
import { closeSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { peImports } from './pe-imports.mjs';

const argv = process.argv.slice(2);
const tree = resolve(argv[0] ?? '');
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const FAMILY = /readline|libhistory|termcap|libtextstyle/i;
const rows = [];
let total = 0;
let images = 0;
const kinds = new Map();
(function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.isFile()) continue;
        total++;
        const fd = openSync(p, 'r');
        const b = Buffer.alloc(2);
        readSync(fd, b, 0, 2, 0);
        closeSync(fd);
        if (b[0] !== 0x4d || b[1] !== 0x5a) continue;
        const data = readFileSync(p);
        const imports = peImports(data);
        if (!imports) continue;
        images++;
        const ext = (e.name.match(/\.[^.]+$/) ?? ['(none)'])[0].toLowerCase();
        kinds.set(ext, (kinds.get(ext) ?? 0) + 1);
        const hit = imports.filter((i) => FAMILY.test(i));
        if (hit.length > 0) rows.push({ file: relative(tree, p).split(sep).join('/'), sha256: createHash('sha256').update(data).digest('hex'), imports: hit });
    }
})(tree);
const named = [];
(function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/readline|libhistory|termcap/i.test(e.name)) named.push({ file: relative(tree, p).split(sep).join('/'), sha256: createHash('sha256').update(readFileSync(p)).digest('hex') });
    }
})(tree);
const result = {
    method: 'Import tables (normal and delay-load) of every file whose first bytes are a PE image, any extension.',
    label: opt('--label') ?? tree,
    files: total,
    peImages: images,
    byExtension: Object.fromEntries([...kinds].sort()),
    importersOfReadlineFamily: rows.sort((a, b) => a.file.localeCompare(b.file)),
    filesNamedReadlineHistoryOrTermcap: named.sort((a, b) => a.file.localeCompare(b.file)),
    conclusion: 'See docs/phase5h-windows-compliance.md.',
};
if (opt('--out')) writeFileSync(opt('--out'), `${JSON.stringify(result, null, 1)}\n`);
console.log(JSON.stringify({ files: total, peImages: images, importers: rows.map((r) => `${r.file} -> ${r.imports.join(',')}`) }, null, 1));
