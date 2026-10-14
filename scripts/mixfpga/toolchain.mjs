#!/usr/bin/env node
// MIX-FPGA macOS toolchain: record or verify the hashes of the components MIX-FPGA owns.
//   node scripts/mixfpga/toolchain.mjs record   -> rewrites the sha256 fields of toolchains/mixfpga/macos-arm64.json
//   node scripts/mixfpga/toolchain.mjs verify   -> checks the installed components against the manifest (exit 1 on mismatch)
// The toolchain root is toolchains/experimental (git-ignored) or $MIXFPGA_TOOLCHAIN_ROOT.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = join(repo, 'toolchains', 'mixfpga', 'macos-arm64.json');
const root = process.env.MIXFPGA_TOOLCHAIN_ROOT ?? join(repo, 'toolchains', 'experimental');
const sha = (p) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(p).on('data', (c) => h.update(c)).on('error', rej).on('end', () => res(h.digest('hex'))); });

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const mode = process.argv[2];
let bad = 0;
for (const c of manifest.components) {
  if (c.ownership !== 'owned' || !c.executable) continue;
  const p = join(root, c.executable);
  const have = await stat(p).then((s) => s.isFile(), () => false);
  if (!have) { console.log(`MISSING  ${c.id} ${c.version}  ${p}`); bad++; continue; }
  const actual = await sha(p);
  if (mode === 'record') { c.sha256 = actual; console.log(`recorded ${c.id} ${c.version} ${actual.slice(0, 16)}…`); }
  else if (actual === c.sha256) console.log(`OK       ${c.id} ${c.version}`);
  else { console.log(`MISMATCH ${c.id} ${c.version}  expected ${String(c.sha256).slice(0, 16)}… got ${actual.slice(0, 16)}…`); bad++; }
}
if (mode === 'record') await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
process.exit(bad ? 1 : 0);
