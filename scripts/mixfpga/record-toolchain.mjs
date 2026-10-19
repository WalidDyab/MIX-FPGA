#!/usr/bin/env node
// Records MIX-FPGA Toolchain 1.0 (macOS) from the validated tools: writes the committed manifest
// toolchains/mixfpga/toolchain-1.0-macos-arm64.json (every file's hash, size, executable bit; every symlink)
// from the notices folder built by build-notices.mjs (run that first).
//   node scripts/mixfpga/record-toolchain.mjs [--tools <folder with ghdl-6.0.0, yosys-0.63, ...>]
// Needs `npm run build` first. Reads the tools; never modifies them.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { inventoryTree, treeDigest, treeBytes } = require(join(repo, 'dist', 'core', 'install', 'tree.js'));
const { DEV_TOOL_FOLDERS } = require(join(repo, 'dist', 'platform', 'macos', 'install', 'dev-payload.js'));

const i = process.argv.indexOf('--tools');
const toolsRoot = i > 0 ? resolve(process.argv[i + 1]) : join(repo, 'toolchains', 'experimental');
// --bundle 1.1: records the Toolchain 1.1 candidate (notices/macos-arm64-1.1 -> toolchain-1.1-macos-arm64.json). Default 1.0, unchanged.
const bi = process.argv.indexOf('--bundle');
const bundle = bi > 0 ? process.argv[bi + 1] : '1.0';
const suffix = bundle === '1.0' ? '' : `-${bundle}`;
const engineDir = join(repo, 'platform', 'macos', 'lima');
const noticesDir = join(repo, 'toolchains', 'mixfpga', 'notices', `macos-arm64${suffix}`);
const owned = JSON.parse(await readFile(join(repo, 'toolchains', 'mixfpga', 'macos-arm64.json'), 'utf8'));

// 1. The notices folder is produced by build-notices.mjs from the third-party inventory; this script only records it.

// 2. Units.
const meta = Object.fromEntries(owned.components.map((c) => [c.id, c]));
const units = [];
const unit = async (u, path) => {
  const inv = await inventoryTree(path);
  units.push({ ...u, files: inv.files, links: inv.links, treeSha256: treeDigest(inv), bytes: treeBytes(inv) });
};
for (const [id, folder] of Object.entries(DEV_TOOL_FOLDERS)) {
  const m = meta[id];
  await unit({ id, kind: 'tool', name: m.name, version: m.version, path: id, executable: m.executable.split('/').slice(1).join('/'), license: m.license, source: m.source }, join(toolsRoot, folder));
}
await unit({ id: 'engine', kind: 'support', name: 'FPGA engine scripts', path: 'engine', license: 'Apache-2.0', source: 'this repository' }, engineDir);
await unit({ id: 'licenses', kind: 'support', name: 'Licence texts', path: 'LICENSES' }, join(noticesDir, 'LICENSES'));
await unit({ id: 'notices', kind: 'support', name: 'Third-party notices', path: 'THIRD_PARTY_NOTICES.txt' }, join(noticesDir, 'THIRD_PARTY_NOTICES.txt'));

const manifest = { schemaVersion: 1, product: 'MIX-FPGA', toolchainVersion: bundle, target: 'macos-arm64', units };
await writeFile(join(repo, 'toolchains', 'mixfpga', `toolchain-${bundle}-macos-arm64.json`), `${JSON.stringify(manifest, null, 1)}\n`);
console.log(units.map((u) => `${u.id.padEnd(15)} ${String(u.files.length).padStart(4)} files ${String(u.links.length).padStart(2)} links ${(u.bytes / 1e6).toFixed(1).padStart(7)} MB ${u.treeSha256.slice(0, 16)}`).join('\n'));
