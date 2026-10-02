#!/usr/bin/env node
// Compares an assembled toolchain folder with a reference installation
// (e.g. the validated Apio packages folder) file by file: path, size, SHA-256.
//
//   node scripts/toolchain/compare.mjs <assembled dir> <reference dir> [--ignore a,b]
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, listFiles, parseArgs, sha256File } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const [a, b] = args._;
if (!a || !b || !existsSync(a) || !existsSync(b)) fail('usage: compare.mjs <assembled dir> <reference dir> [--ignore name,...]');
const ignore = String(args.ignore ?? '').split(',').filter(Boolean);
const keep = (f) => !ignore.some((x) => f === x || f.startsWith(`${x}/`));

const fa = (await listFiles(a)).filter(keep);
const fb = (await listFiles(b)).filter(keep);
const sb = new Set(fb);
const sa = new Set(fa);
const onlyA = fa.filter((f) => !sb.has(f));
const onlyB = fb.filter((f) => !sa.has(f));
const differ = [];
let same = 0;
for (const f of fa.filter((x) => sb.has(x))) {
    const pa = join(a, ...f.split('/'));
    const pb = join(b, ...f.split('/'));
    const [za, zb] = [(await stat(pa)).size, (await stat(pb)).size];
    if (za !== zb || (await sha256File(pa)) !== (await sha256File(pb))) differ.push(`${f} (${za} vs ${zb} bytes)`);
    else same++;
}
console.log(JSON.stringify({ assembled: a, reference: b, ignored: ignore, identical: same, differ, onlyInAssembled: onlyA, onlyInReference: onlyB }, null, 2));
process.exit(differ.length || onlyA.length || onlyB.length ? 1 : 0);
