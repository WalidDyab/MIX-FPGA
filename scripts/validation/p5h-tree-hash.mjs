#!/usr/bin/env node
// Phase 5H evidence helper: the content hash of a folder tree (the same hash the product uses), with file count and size.
//   node scripts/validation/p5h-tree-hash.mjs <folder> [<folder> ...]
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { inventoryDirectory } = createRequire(import.meta.url)(join(repo, 'dist', 'core', 'toolchain', 'tar.js'));
for (const dir of process.argv.slice(2)) {
    const inv = await inventoryDirectory(resolve(dir), { exclude: ['.nexysvhdl-installed.json'] }).catch((e) => ({ error: String(e.message) }));
    console.log(inv.error ? `${dir}: ${inv.error}` : `${dir}: ${inv.entries.length} files ${inv.bytes} bytes tree ${inv.treeSha256}`);
}
