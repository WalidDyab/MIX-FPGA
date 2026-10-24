#!/usr/bin/env node
// Records MIX-FPGA Toolchain 1.0 (Windows x64) from the validated tools: writes the committed manifest
// toolchains/mixfpga/toolchain-1.0-windows-x64.json (every file's hash and size) from the tools folder, the support scripts and the
// notices folder.
//   node scripts/mixfpga/record-toolchain-windows.mjs [--tools <folder with ghdl-6.0.0, yosys-0.63>] [--bundle 1.1]
// --bundle 1.1 records Toolchain 1.1 (notices/windows-x64-1.1 -> toolchain-1.1-windows-x64.json; tools default to .artifacts/tools-1.1-windows).
// Needs `npm run build` first. Reads the tools; never modifies them.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { inventoryTree, treeDigest, treeBytes } = require(join(repo, 'dist', 'core', 'install', 'tree.js'));
const { WINDOWS_DEV_TOOL_FOLDERS } = require(join(repo, 'dist', 'platform', 'windows', 'install', 'dev-payload.js'));

const i = process.argv.indexOf('--tools');
const bi = process.argv.indexOf('--bundle');
const bundle = bi > 0 ? process.argv[bi + 1] : '1.0';
const suffix = bundle === '1.0' ? '' : `-${bundle}`;
const toolsRoot = i > 0 ? resolve(process.argv[i + 1]) : bundle === '1.0' ? join(repo, 'toolchains', 'experimental') : join(repo, '.artifacts', `tools-${bundle}-windows`);
const scriptsDir = join(repo, 'platform', 'windows', 'scripts');
const noticesDir = join(repo, 'toolchains', 'mixfpga', 'notices', `windows-x64${suffix}`);
const owned = JSON.parse(await readFile(join(repo, 'toolchains', 'mixfpga', 'windows-x64.json'), 'utf8'));

const meta = Object.fromEntries(owned.components.map((c) => [c.id, c]));
// 1.1: the licence of a tool unit is the set of licences of its inventory components (the 1.0 text predates the review).
const inventory = bundle === '1.0' ? undefined : JSON.parse(await readFile(join(repo, 'toolchains', 'mixfpga', 'compliance', `windows-x64${suffix}.inventory.json`), 'utf8'));
const licenceOf = (id) => (inventory ? [...new Set(inventory.components.filter((c) => c.unit === id).map((c) => c.license))].join('; ') : meta[id].license);
const units = [];
const unit = async (u, path) => {
  const inv = await inventoryTree(path);
  units.push({ ...u, files: inv.files, links: inv.links, treeSha256: treeDigest(inv), bytes: treeBytes(inv) });
};
for (const [id, folder] of Object.entries(WINDOWS_DEV_TOOL_FOLDERS)) {
  const m = meta[id];
  await unit({ id, kind: 'tool', name: m.name, version: m.version, path: id, executable: m.executable.split('/').slice(1).join('/'), license: licenceOf(id), source: m.source }, join(toolsRoot, folder));
}
await unit({ id: 'scripts', kind: 'support', name: 'MIX-FPGA support scripts', path: 'scripts', license: 'Apache-2.0', source: 'this repository' }, scriptsDir);
await unit({ id: 'licenses', kind: 'support', name: 'Licence texts', path: 'LICENSES' }, join(noticesDir, 'LICENSES'));
await unit({ id: 'notices', kind: 'support', name: 'Third-party notices', path: 'THIRD_PARTY_NOTICES.txt' }, join(noticesDir, 'THIRD_PARTY_NOTICES.txt'));

const manifest = { schemaVersion: 1, product: 'MIX-FPGA', toolchainVersion: bundle, target: 'windows-x64', units };
await writeFile(join(repo, 'toolchains', 'mixfpga', `toolchain-${bundle}-windows-x64.json`), `${JSON.stringify(manifest, null, 1)}\n`);
console.log(units.map((u) => `${u.id.padEnd(10)} ${String(u.files.length).padStart(4)} files ${(u.bytes / 1e6).toFixed(1).padStart(7)} MB ${u.treeSha256.slice(0, 16)}`).join('\n'));
