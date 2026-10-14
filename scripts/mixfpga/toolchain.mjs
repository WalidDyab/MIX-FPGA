#!/usr/bin/env node
// MIX-FPGA toolchain: record or verify the hashes of the components MIX-FPGA owns.
//   node scripts/mixfpga/toolchain.mjs record [macos-arm64|windows-x64]   -> rewrites the sha256 (and treeSha256) fields of toolchains/mixfpga/<target>.json
//   node scripts/mixfpga/toolchain.mjs verify [macos-arm64|windows-x64]   -> checks the installed components against the manifest (exit 1 on mismatch)
// The toolchain root is toolchains/experimental (git-ignored) or $MIXFPGA_TOOLCHAIN_ROOT. The target defaults to macos-arm64.
// A component with a `dir` also gets a `treeSha256`: the hash of every file under it (sorted relative paths and file hashes).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mode = process.argv[2];
const target = process.argv[3] ?? 'macos-arm64';
const manifestPath = join(repo, 'toolchains', 'mixfpga', `${target}.json`);
const root = process.env.MIXFPGA_TOOLCHAIN_ROOT ?? join(repo, 'toolchains', 'experimental');
const sha = (p) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(p).on('data', (c) => h.update(c)).on('error', rej).on('end', () => res(h.digest('hex'))); });

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Hash of a whole component folder: path and content hash of every file, in sorted order. */
export async function treeHash(dir) {
  const files = (await walk(dir)).map((p) => relative(dir, p).split('\\').join('/')).sort();
  const h = createHash('sha256');
  for (const rel of files) h.update(`${await sha(join(dir, ...rel.split('/')))}  ${rel}\n`);
  return { sha256: h.digest('hex'), files: files.length };
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
let bad = 0;
for (const c of manifest.components) {
  if (c.ownership !== 'owned' || !c.executable) continue;
  const p = join(root, c.executable);
  const have = await stat(p).then((s) => s.isFile(), () => false);
  if (!have) { console.log(`MISSING  ${c.id} ${c.version}  ${p}`); bad++; continue; }
  const actual = await sha(p);
  let tree;
  if (c.dir) tree = await treeHash(join(root, c.dir));
  if (mode === 'record') {
    c.sha256 = actual;
    if (tree) { c.treeSha256 = tree.sha256; c.fileCount = tree.files; }
    console.log(`recorded ${c.id} ${c.version} ${actual.slice(0, 16)}…${tree ? ` tree ${tree.sha256.slice(0, 16)}… (${tree.files} files)` : ''}`);
  } else if (actual !== c.sha256) { console.log(`MISMATCH ${c.id} ${c.version}  expected ${String(c.sha256).slice(0, 16)}… got ${actual.slice(0, 16)}…`); bad++; }
  else if (tree && tree.sha256 !== c.treeSha256) { console.log(`MISMATCH ${c.id} ${c.version}  folder differs from the recorded tree hash`); bad++; }
  else console.log(`OK       ${c.id} ${c.version}`);
}
if (mode === 'record') await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
process.exit(bad ? 1 : 0);
