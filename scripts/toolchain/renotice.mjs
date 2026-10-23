#!/usr/bin/env node
// Re-renders the notices and the recorded recipe of an ASSEMBLED toolchain without re-assembling it (Phase 5E):
//
//   node scripts/toolchain/renotice.mjs --recipe darwin-arm64-1.1 [--target darwin-arm64]
//
// The assembled tree toolchain/<recipe>/ is the frozen Phase 5C content (every component archive was verified when it was
// assembled). This script changes only the two files that the recipe's `compliance` block and the notices renderer produce:
// toolchain-manifest.json (recipe hash and compliance block) and THIRD_PARTY_NOTICES.md. Nothing else in the tree is touched,
// so the only payload differences against the frozen candidate are the final notices. Run `pack.mjs` afterwards.
import { readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostTarget, inventory, loadRecipe, MANIFEST_NAME, NOTICES_NAME, parseArgs, RECIPE_DIR, sha256File, TOOLCHAIN_DIR, fail } from './lib.mjs';
import { renderNotices } from './notices.mjs';

const GENERATED_MTIME = new Date('2026-09-26T00:00:00Z'); // the same fixed time assemble.mjs gives generated files
const args = parseArgs(process.argv.slice(2));
const target = args.target ?? hostTarget();
const recipeName = args.recipe ?? target;
const recipe = loadRecipe(target, recipeName);
const tree = join(TOOLCHAIN_DIR, recipeName);

const manifest = JSON.parse(await readFile(join(tree, MANIFEST_NAME), 'utf8'));
if (manifest.bundleVersion !== recipe.bundleVersion || manifest.target !== target) fail(`${tree} is not an assembled ${recipeName} toolchain`);
manifest.recipeSha256 = await sha256File(join(RECIPE_DIR, `${recipeName}.json`));
if (recipe.compliance) manifest.compliance = recipe.compliance;
else delete manifest.compliance;

await writeFile(join(tree, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(tree, NOTICES_NAME), renderNotices(manifest));
for (const f of [MANIFEST_NAME, NOTICES_NAME, '.']) await utimes(join(tree, f), GENERATED_MTIME, GENERATED_MTIME);
const total = await inventory(tree);
console.log(`Done: ${tree} — ${total.files} files, ${total.bytes} bytes, tree ${total.treeSha256}`);
await writeFile(join(TOOLCHAIN_DIR, `${recipeName}.inventory.json`), `${JSON.stringify({ target, files: total.files, bytes: total.bytes, treeSha256: total.treeSha256 }, null, 2)}\n`);
