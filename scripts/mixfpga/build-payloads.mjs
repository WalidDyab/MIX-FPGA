#!/usr/bin/env node
// Builds the internal Phase 4 validation payloads into .artifacts/payloads (outside git). NOT for public distribution
// while the licence questions L1, L3 and L9 are open.
//   mixfpga-de10-lite-support-1.0-macos-arm64.tar.gz  the MIX-FPGA Toolchain 1.0 (macOS) units, byte-reproducible
//   nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz        the validated NexysVHDL Toolchain 1.0 archive, unchanged (hard link)
//   payloads.json                                      sizes and sha256
//   node scripts/mixfpga/build-payloads.mjs [--from <installed toolchain dir>] [--nexys <NexysVHDL toolchain archive>]
// The DE10 units are read from the sealed installed toolchain and every file is checked against the committed manifest first.
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { writeTarEntriesGz } = require(join(repo, 'dist', 'core', 'toolchain', 'tar.js'));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? resolve(process.argv[i + 1]) : undefined; };
// --bundle 1.1: builds the Toolchain 1.1 candidate payloads from an assembled unit root (scripts/mixfpga/assemble-1.1.mjs).
const bundle = process.argv.includes('--bundle') ? process.argv[process.argv.indexOf('--bundle') + 1] : '1.0';
const is10 = bundle === '1.0';
const from = arg('--from') ?? (is10 ? join(homedir(), 'Library', 'MIX-FPGA', 'toolchains', '1.0', 'macos-arm64') : join(repo, '.artifacts', `toolchain-${bundle}`, 'macos-arm64'));
const nexys = arg('--nexys') ?? (is10 ? join(repo, '..', 'NexysVHDL-repo', '.artifacts', 'dist', 'nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz') : join(repo, '.artifacts', `candidates-${bundle}`, 'nexys', `nexysvhdl-toolchain-${bundle}-darwin-arm64.tar.gz`));
const out = arg('--out') ?? (is10 ? join(repo, '.artifacts', 'payloads') : join(repo, '.artifacts', `candidates-${bundle}`, 'payloads'));
const manifestText = await readFile(join(repo, 'toolchains', 'mixfpga', `toolchain-${bundle}-macos-arm64.json`), 'utf8');
const manifest = JSON.parse(manifestText);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const shaFile = async (p) => sha(await readFile(p));

// 1. DE10-Lite support: every unit of the manifest, verified file by file, plus the manifest itself.
const entries = [];
const dirs = new Set();
const addDirs = (path) => { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`); };
for (const u of manifest.units) {
  for (const f of u.files) {
    const rel = f.path === '' ? u.path : `${u.path}/${f.path}`;
    const data = await readFile(join(from, rel));
    if (sha(data) !== f.sha256 || data.length !== f.size) throw new Error(`${rel} differs from the manifest; payload not built`);
    addDirs(rel);
    entries.push({ name: rel, type: 'file', mode: f.exec ? 0o755 : 0o644, data });
  }
  for (const l of u.links) {
    const rel = `${u.path}/${l.path}`;
    if ((await readlink(join(from, rel))) !== l.target) throw new Error(`${rel} link differs from the manifest`);
    addDirs(rel);
    entries.push({ name: rel, type: 'symlink', mode: 0o755, linkname: l.target });
  }
}
entries.push({ name: 'manifest.json', type: 'file', mode: 0o644, data: Buffer.from(manifestText) });
for (const d of dirs) entries.push({ name: d, type: 'directory', mode: 0o755 });
await mkdir(out, { recursive: true });
const de10 = join(out, `mixfpga-de10-lite-support-${bundle}-macos-arm64.tar.gz`);
await writeTarEntriesGz(entries, de10, { mtime: Date.UTC(2026, 9, 1) / 1000, comment: is10 ? 'MIX-FPGA DE10-Lite support 1.0 (macOS arm64): internal Phase 4 validation payload' : `MIX-FPGA DE10-Lite support ${bundle} (macOS arm64): candidate, counsel review pending` });

// 2. Nexys A7 support: the validated archive itself (hard link, no copy).
const nexysOut = join(out, `nexysvhdl-toolchain-${bundle}-darwin-arm64.tar.gz`);
await rm(nexysOut, { force: true });
await link(nexys, nexysOut).catch(async () => { throw new Error(`cannot link ${nexys}`); });

const describe = async (p, extra) => ({ file: p.split('/').pop(), bytes: (await stat(p)).size, sha256: await shaFile(p), ...extra });
const index = {
  schemaVersion: 1,
  note: is10 ? 'Internal Phase 4 validation payloads. Not for public distribution while L1, L3 and L9 are unresolved.' : `Toolchain ${bundle} candidate payloads (Phase 5C). Not for public distribution until counsel review of L3, L4, L8 and L9 is closed.`,
  payloads: [
    await describe(nexysOut, { id: 'nexys-a7-100t', target: 'darwin-arm64', content: is10 ? 'NexysVHDL Toolchain 1.0 (unchanged)' : `MIX-FPGA Nexys A7 support, Toolchain ${bundle}` }),
    await describe(de10, { id: 'de10-lite', target: 'macos-arm64', content: `MIX-FPGA Toolchain ${bundle}: GHDL, Yosys, openFPGALoader, Lima, engine scripts, notices`, units: manifest.units.length }),
  ],
};
if (!is10) {
  // The pins the extension reads (same shape as toolchains/mixfpga/payloads-1.0.json).
  const pin = (p, content) => ({ file: p.file, bytes: p.bytes, sha256: p.sha256, content });
  const pins = { schemaVersion: 1, note: index.note, payloads: { 'nexys-a7-100t': pin(index.payloads[0], 'MIX-FPGA Nexys A7 support (Toolchain 1.1)'), 'de10-lite': pin(index.payloads[1], 'MIX-FPGA Toolchain 1.1 (macos-arm64), byte-reproducible') } };
  await writeFile(join(repo, 'toolchains', 'mixfpga', `payloads-${bundle}.json`), `${JSON.stringify(pins, null, 2)}\n`);
}
await writeFile(join(out, 'payloads.json'), `${JSON.stringify(index, null, 2)}\n`);
for (const p of index.payloads) console.log(`${p.file.padEnd(52)} ${(p.bytes / 1e6).toFixed(1).padStart(8)} MB  ${p.sha256}`);
void lstat;
