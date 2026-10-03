#!/usr/bin/env node
// Packs an assembled toolchain (toolchain/<target>/) into the distributable,
// separately versioned toolchain archive:
//
//   .artifacts/dist/nexysvhdl-toolchain-<bundleVersion>-<target>.tar.gz (+ .sha256)
//
//   node scripts/toolchain/pack.mjs [--target win32-x64] [--update-requirement]
//
// --update-requirement records the archive's content hash in
// toolchains/bundle/requirement.json: the toolchain version the extension
// requires. Requires `npm run build` (uses the compiled tar writer).
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fail, hostTarget, loadRecipe, MANIFEST_NAME, parseArgs, RECIPE_DIR, REPO_ROOT, sha256File, TOOLCHAIN_DIR } from './lib.mjs';

const require = createRequire(import.meta.url);
const distTar = join(REPO_ROOT, 'dist', 'core', 'toolchain', 'tar.js');
if (!existsSync(distTar)) fail('run `npm run build` first (dist/core/toolchain/tar.js is missing)');
const { inventoryDirectory, writeTarGz } = require(distTar);

const args = parseArgs(process.argv.slice(2));
const target = args.target ?? hostTarget();
const recipe = loadRecipe(target);
const dir = join(TOOLCHAIN_DIR, target);
const manifestFile = join(dir, MANIFEST_NAME);
if (!existsSync(manifestFile)) fail(`no assembled toolchain at ${relative(REPO_ROOT, dir)} (run scripts/toolchain/assemble.mjs)`);
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
if (manifest.target !== target || manifest.bundleVersion !== recipe.bundleVersion) fail(`assembled toolchain is ${manifest.target} ${manifest.bundleVersion}; recipe is ${target} ${recipe.bundleVersion}: assemble again`);
if (manifest.recipeSha256 !== (await sha256File(join(RECIPE_DIR, `${target}.json`)))) fail('the recipe changed since the toolchain was assembled: assemble again');

const outDir = join(REPO_ROOT, '.artifacts', 'dist');
await mkdir(outDir, { recursive: true });
const name = `nexysvhdl-toolchain-${recipe.bundleVersion}-${target}.tar.gz`;
const out = join(outDir, name);

console.log(`Inventory of ${relative(REPO_ROOT, dir)} ...`);
const inv = await inventoryDirectory(dir);
console.log(`  ${inv.entries.length} files, ${(inv.bytes / 2 ** 20).toFixed(1)} MiB, tree ${inv.treeSha256}`);
console.log(`Writing ${relative(REPO_ROOT, out)} ...`);
let last = 0;
await writeTarGz(dir, `${out}.part`, (bytes) => {
    if (bytes - last > 256 * 2 ** 20) {
        last = bytes;
        process.stdout.write(`  ${Math.round((100 * bytes) / inv.bytes)}%\r`);
    }
});
await rename(`${out}.part`, out);
const archiveSha = await sha256File(out);
const size = (await stat(out)).size;
await writeFile(`${out}.sha256`, `${archiveSha}  ${name}\n`);
console.log(`  ${name}: ${(size / 2 ** 20).toFixed(1)} MiB, sha256 ${archiveSha}`);

if (args['update-requirement']) {
    const reqFile = join(RECIPE_DIR, 'requirement.json');
    const req = existsSync(reqFile) ? JSON.parse(readFileSync(reqFile, 'utf8')) : { schemaVersion: 1, bundleVersion: recipe.bundleVersion, targets: {} };
    if (req.bundleVersion !== recipe.bundleVersion) fail(`requirement.json requires toolchain ${req.bundleVersion}; change it deliberately before packing ${recipe.bundleVersion}`);
    const previous = req.targets[target];
    if (previous?.status === 'validated' && previous.treeSha256 !== inv.treeSha256) {
        // ADR-007 lifecycle: immutable from release freeze; a pre-release candidate is replaced only by a deliberate, re-validated edit of requirement.json.
        fail(`toolchain ${recipe.bundleVersion} for ${target} was already validated with content ${previous.treeSha256}. After release a payload change needs a new bundleVersion; before the first external release, replace the candidate deliberately (re-validate, then edit requirement.json).`);
    }
    req.targets[target] = { status: 'validated', treeSha256: inv.treeSha256, files: inv.entries.length, bytes: inv.bytes, archive: name };
    await writeFile(reqFile, `${JSON.stringify(req, null, 2)}\n`);
    console.log(`Updated ${relative(REPO_ROOT, reqFile)} (${target} -> ${inv.treeSha256})`);
}
