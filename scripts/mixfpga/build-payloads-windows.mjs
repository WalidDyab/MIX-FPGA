#!/usr/bin/env node
// Builds the internal Phase 4 validation payloads for Windows into .artifacts/payloads (outside git). NOT for public distribution
// while the licence questions L1, L3 and L9 are open.
//   mixfpga-de10-lite-support-1.0-windows-x64.tar.gz   the MIX-FPGA Toolchain 1.0 (Windows) units, byte-reproducible
//   nexysvhdl-toolchain-1.0-win32-x64.tar.gz           the validated NexysVHDL Toolchain 1.0 archive, unchanged (hard link or copy)
//   payloads.json                                      sizes and sha256
//   node scripts/mixfpga/build-payloads-windows.mjs [--tools <folder with ghdl-6.0.0, yosys-0.63>] [--nexys <NexysVHDL toolchain archive>] [--pins]
// `--pins` also rewrites the committed pins file toolchains/mixfpga/payloads-1.0-windows-x64.json.
// Every file of the DE10 payload is checked against the committed manifest first. Needs `npm run build` first.
import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { writeTarEntriesGz } = require(join(repo, 'dist', 'core', 'toolchain', 'tar.js'));
const { WINDOWS_DEV_TOOL_FOLDERS } = require(join(repo, 'dist', 'platform', 'windows', 'install', 'dev-payload.js'));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? resolve(process.argv[i + 1]) : undefined; };
const toolsRoot = arg('--tools') ?? join(repo, 'toolchains', 'experimental');
const nexys = arg('--nexys') ?? 'D:\\WSClaude\\NexysVHDL\\.artifacts\\dist\\nexysvhdl-toolchain-1.0-win32-x64.tar.gz';
const out = join(repo, '.artifacts', 'payloads');
const manifestText = await readFile(join(repo, 'toolchains', 'mixfpga', 'toolchain-1.0-windows-x64.json'), 'utf8');
const manifest = JSON.parse(manifestText);
const sha = (b) => createHash('sha256').update(b).digest('hex');

// Where each unit comes from on disk (the same sources the installer-development folder payload uses).
const source = {
  ...Object.fromEntries(Object.entries(WINDOWS_DEV_TOOL_FOLDERS).map(([id, folder]) => [id, join(toolsRoot, folder)])),
  scripts: join(repo, 'platform', 'windows', 'scripts'),
  licenses: join(repo, 'toolchains', 'mixfpga', 'notices', 'windows-x64', 'LICENSES'),
  notices: join(repo, 'toolchains', 'mixfpga', 'notices', 'windows-x64', 'THIRD_PARTY_NOTICES.txt'),
};

const entries = [];
const dirs = new Set();
const addDirs = (path) => { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`); };
for (const u of manifest.units) {
  for (const f of u.files) {
    const rel = f.path === '' ? u.path : `${u.path}/${f.path}`;
    const abs = f.path === '' ? source[u.id] : join(source[u.id], ...f.path.split('/'));
    const data = await readFile(abs);
    if (sha(data) !== f.sha256 || data.length !== f.size) throw new Error(`${rel} differs from the manifest; payload not built`);
    addDirs(rel);
    entries.push({ name: rel, type: 'file', mode: 0o644, data });
  }
}
entries.push({ name: 'manifest.json', type: 'file', mode: 0o644, data: Buffer.from(manifestText) });
for (const d of dirs) entries.push({ name: d, type: 'directory', mode: 0o755 });
await mkdir(out, { recursive: true });
const de10 = join(out, 'mixfpga-de10-lite-support-1.0-windows-x64.tar.gz');
await writeTarEntriesGz(entries, de10, { mtime: Date.UTC(2026, 9, 1) / 1000, comment: 'MIX-FPGA DE10-Lite support 1.0 (Windows x64): internal Phase 4 validation payload' });

// Nexys A7 support: the validated archive itself (hard link when the volume allows it, else a copy; the original is never modified).
const nexysOut = join(out, 'nexysvhdl-toolchain-1.0-win32-x64.tar.gz');
await rm(nexysOut, { force: true });
await link(nexys, nexysOut).catch(() => copyFile(nexys, nexysOut));

const describe = async (p, extra) => ({ file: p.split(/[\\/]/).pop(), bytes: (await stat(p)).size, sha256: sha(await readFile(p)), ...extra });
const payloads = [
  await describe(nexysOut, { id: 'nexys-a7-100t', target: 'win32-x64', content: 'NexysVHDL Toolchain 1.0 (win32-x64), unchanged' }),
  await describe(de10, { id: 'de10-lite', target: 'windows-x64', content: 'MIX-FPGA Toolchain 1.0 (windows-x64): GHDL, Yosys, support scripts, notices', units: manifest.units.length }),
];
await writeFile(join(out, 'payloads.json'), `${JSON.stringify({ schemaVersion: 1, note: 'Internal Phase 4 validation payloads. Not for public distribution while L1, L3 and L9 are unresolved.', payloads }, null, 2)}\n`);
for (const p of payloads) console.log(`${p.file.padEnd(52)} ${(p.bytes / 1e6).toFixed(1).padStart(8)} MB  ${p.sha256}`);
if (process.argv.includes('--pins')) {
  const pins = { schemaVersion: 1, note: 'Internal Phase 4 validation payloads for Windows (built outside git into .artifacts/payloads by scripts/mixfpga/build-payloads-windows.mjs). Not for public distribution while L1, L3 and L9 are unresolved.', payloads: Object.fromEntries(payloads.map((p) => [p.id, { file: p.file, bytes: p.bytes, sha256: p.sha256, content: p.content }])) };
  await writeFile(join(repo, 'toolchains', 'mixfpga', 'payloads-1.0-windows-x64.json'), `${JSON.stringify(pins, null, 2)}\n`);
  console.log('pins written');
}
