#!/usr/bin/env node
// Windows runtime-library evidence for a toolchain package (build time only;
// never shipped): every DLL directly in <package>/lib and <package>/bin, its
// SHA-256, and its usage class from the PE import graph of the package:
//   A = in the load closure of an executable NexysVHDL runs (--used),
//   B = imported only by other bundled programs or libraries,
//   C = imported by nothing in the package (loaded dynamically, or unused).
//
//   node scripts/compliance/pe-closure.mjs <toolchain dir> <package dir> --used a.exe,b.pyd [--json out.json]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { parseArgs } from '../toolchain/lib.mjs';
import { peImports } from './pe-imports.mjs';

/** Usage classes of the libraries in `libs` (lower-case name -> path) given every PE file's imports. */
export function classify(imports, libs, used) {
    const byName = new Map([...libs].map(([name, path]) => [name, path]));
    const closure = new Set();
    const visit = (file) => {
        for (const dll of imports.get(file) ?? []) {
            const path = byName.get(dll);
            if (path && !closure.has(path)) {
                closure.add(path);
                visit(path);
            }
        }
    };
    for (const u of used) visit(u);
    const importedBy = new Map();
    for (const [file, list] of imports) {
        for (const dll of list) {
            const path = byName.get(dll);
            if (path && path !== file) importedBy.set(path, [...(importedBy.get(path) ?? []), file]);
        }
    }
    const out = {};
    for (const path of byName.values()) out[path] = { usage: closure.has(path) ? 'A' : importedBy.has(path) ? 'B' : 'C', importedBy: (importedBy.get(path) ?? []).sort() };
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const [root, pkg] = args._;
    const imports = new Map();
    const libs = new Map();
    for (const e of await readdir(join(root, pkg), { recursive: true, withFileTypes: true })) {
        if (!e.isFile() || !/\.(exe|dll|pyd)$/i.test(e.name)) continue;
        const full = join(e.parentPath, e.name);
        const rel = relative(root, full).split(sep).join('/');
        const list = peImports(readFileSync(full));
        if (list) imports.set(rel, list);
        // Libraries resolvable by the loader for these programs: the package's bin/ and lib/ folders.
        if (/\.dll$/i.test(e.name) && /^(bin|lib)$/.test(basename(e.parentPath))) libs.set(e.name.toLowerCase(), rel);
    }
    const used = String(args.used ?? '').split(',').filter(Boolean);
    const classes = classify(imports, libs, used);
    const result = {};
    for (const [path, c] of Object.entries(classes).sort(([a], [b]) => a.localeCompare(b))) {
        result[path] = { sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), ...c, imports: imports.get(path) ?? [] };
    }
    const text = `${JSON.stringify({ used, libraries: result }, null, 1)}\n`;
    if (args.json) writeFileSync(args.json, text);
    else process.stdout.write(text);
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/compliance/pe-closure.mjs')) await main();
