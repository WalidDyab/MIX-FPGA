#!/usr/bin/env node
// Builds the UNSIGNED classroom release set from the Phase 5F-accepted artifacts (Phase 5G):
//   MIX-FPGA-0.7.0-macOS-arm64.dmg                              MIX-FPGA Installer.app + README-FIRST + Support/ + Source/
//   MIX-FPGA-0.7.0-macOS-arm64-Fresh.zip                        manual route, both boards
//   MIX-FPGA-0.7.0-macOS-arm64-Upgrade-from-NexysVHDL.zip       manual route, Nexys A7 only
//   node scripts/release/macos-classroom.mjs [--rc <folder>] [--out <folder>]
// The accepted binary artifacts are copied byte for byte (never unpacked or repacked) and re-verified against the hashes of the Phase 5F
// report before and after; the installer, the DMG and the ZIPs are wrapper artifacts. Nothing is signed, notarized or published.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from '../toolchain/lib.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? resolve(argv[argv.indexOf(k) + 1]) : d);
const rc = opt('--rc', join(root, '.artifacts', 'release-rc', 'MIX-FPGA-0.7.0-macOS-arm64-RC'));
const out = opt('--out', join(root, '.artifacts', 'classroom'));
const fail = (m) => { console.error(`classroom release failed: ${m}`); process.exit(1); };
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const V = pkg.version;

// The Phase 5F-accepted binary artifacts (docs/phase5f-acceptance-report.md).
const ACCEPTED = {
    [`nexysvhdl-${V}-darwin-arm64.vsix`]: '53d4ce4ac847c4ca4837596550ca358550d85c2be021435a0e5526808b2bc7bc',
    'nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz': 'f84cedece009be5a04ad44a9c2ff1110fccc1c6725f483a20bb0e139c84f3a73',
    'MIX-FPGA-Nexys-A7-Support-1.1-Sources.zip': 'cf6b36b988065c2441cd5fbb9a86352a88778c44ef20933dc7fa4bb7f043efda',
    'mixfpga-de10-lite-support-1.1-macos-arm64.tar.gz': '19df1593f9266653a4fddbc18cebb4b019e78682271034e0893be264c2d38326',
    'MIX-FPGA-DE10-Lite-Support-1.1-Sources.zip': 'e85dbbff25f489dd212661671d842673c7f74455c0df9aae0fa3cc1adbd5715a',
};
async function checkAccepted(dir, names = Object.keys(ACCEPTED)) {
    for (const n of names) { const h = await sha256File(join(dir, n)); if (h !== ACCEPTED[n]) fail(`${n} differs from the Phase 5F-accepted artifact (${h})`); }
}
await checkAccepted(rc);
const vsix = `nexysvhdl-${V}-darwin-arm64.vsix`;
const NEXYS = 'nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz', NEXYS_SRC = 'MIX-FPGA-Nexys-A7-Support-1.1-Sources.zip';
const DE10 = 'mixfpga-de10-lite-support-1.1-macos-arm64.tar.gz', DE10_SRC = 'MIX-FPGA-DE10-Lite-Support-1.1-Sources.zip';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sh = (exe, args, cwd) => { const r = spawnSync(exe, args, { cwd, encoding: 'utf8' }); if (r.status !== 0) fail(`${exe} ${args.join(' ')}\n${r.stdout}${r.stderr}`); return r.stdout; };
const put = (from, to) => { mkdirSync(join(to, '..'), { recursive: true }); try { sh('/bin/cp', ['-c', from, to]); } catch { copyFileSync(from, to); } };

sh(process.execPath, [join(root, 'scripts', 'installer', 'build-installer.mjs'), '--out', join(out, 'installer')]);
const app = join(out, 'installer', 'MIX-FPGA Installer.app');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');

async function sums(dir, names) {
    const rows = [];
    for (const n of names) rows.push({ file: n, bytes: statSync(join(dir, n)).size, sha256: await sha256File(join(dir, n)) });
    return rows;
}
const docsDir = join(root, 'installer', 'macos');
const notices = join(root, 'THIRD_PARTY_NOTICES.md');
const licence = join(root, 'LICENSE');

// ---------------------------------------------------------------- DMG
const volume = `MIX-FPGA ${V}`;
const dmgStage = join(out, 'dmg-stage', volume);
mkdirSync(join(dmgStage, 'Support'), { recursive: true });
mkdirSync(join(dmgStage, 'Source'), { recursive: true });
cpSync(app, join(dmgStage, 'MIX-FPGA Installer.app'), { recursive: true, verbatimSymlinks: true });
for (const n of [vsix, NEXYS, DE10]) put(join(rc, n), join(dmgStage, 'Support', n));
for (const n of [NEXYS_SRC, DE10_SRC]) put(join(rc, n), join(dmgStage, 'Source', n));
copyFileSync(join(docsDir, 'README-FIRST.txt'), join(dmgStage, 'README-FIRST.txt'));
copyFileSync(notices, join(dmgStage, 'THIRD_PARTY_NOTICES.md'));
copyFileSync(licence, join(dmgStage, 'LICENSE'));
copyFileSync(join(rc, 'THIRD_PARTY_NOTICES-Nexys-A7-Support.md'), join(dmgStage, 'Support', 'THIRD_PARTY_NOTICES-Nexys-A7-Support.md'));
copyFileSync(join(rc, 'THIRD_PARTY_NOTICES-DE10-Lite-Support.txt'), join(dmgStage, 'Support', 'THIRD_PARTY_NOTICES-DE10-Lite-Support.txt'));
const supportRows = await sums(join(dmgStage, 'Support'), [vsix, NEXYS, DE10]);
writeFileSync(join(dmgStage, 'Support', 'SHA256SUMS'), supportRows.map((r) => `${r.sha256}  ${r.file}`).join('\n') + '\n');
const dmgName = `MIX-FPGA-${V}-macOS-arm64.dmg`;
const dmg = join(out, dmgName);
sh('/usr/bin/hdiutil', ['create', '-volname', volume, '-srcfolder', dmgStage, '-fs', 'HFS+', '-format', 'UDZO', '-imagekey', 'zlib-level=1', '-ov', dmg]);

// ---------------------------------------------------------------- ZIPs
async function makeZip(name, top, binaries, guide, extra) {
    const stage = join(out, 'zip-stage', top);
    mkdirSync(stage, { recursive: true });
    for (const n of binaries) put(join(rc, n), join(stage, n));
    copyFileSync(join(docsDir, guide.from), join(stage, guide.to));
    copyFileSync(notices, join(stage, 'THIRD_PARTY_NOTICES.md'));
    copyFileSync(licence, join(stage, 'LICENSE'));
    for (const [from, to] of extra) copyFileSync(from, join(stage, to));
    const names = [...binaries, guide.to, 'THIRD_PARTY_NOTICES.md', 'LICENSE', ...extra.map((e) => e[1])];
    const rows = await sums(stage, names);
    writeFileSync(join(stage, 'SHA256SUMS'), rows.map((r) => `${r.sha256}  ${r.file}`).join('\n') + '\n');
    writeFileSync(join(stage, 'RELEASE-MANIFEST.json'), `${JSON.stringify({ product: 'MIX-FPGA', version: V, platform: 'macOS Apple silicon (darwin-arm64)', package: name, status: 'UNSIGNED, NOT NOTARIZED: direct classroom distribution', sourceCommit: commit, sourceDelivery: 'each support archive is accompanied by its corresponding-source package; no written offer', files: rows }, null, 2)}\n`);
    sh('/usr/bin/zip', ['-X', '-r', '-1', join(out, name), top], join(out, 'zip-stage'));
}
await makeZip(`MIX-FPGA-${V}-macOS-arm64-Fresh.zip`, `MIX-FPGA-${V}-macOS-arm64-Fresh`, [vsix, NEXYS, DE10, NEXYS_SRC, DE10_SRC], { from: 'INSTALL-FRESH-macOS.md', to: 'INSTALL-FRESH-macOS.md' }, [[join(rc, 'THIRD_PARTY_NOTICES-Nexys-A7-Support.md'), 'THIRD_PARTY_NOTICES-Nexys-A7-Support.md'], [join(rc, 'THIRD_PARTY_NOTICES-DE10-Lite-Support.txt'), 'THIRD_PARTY_NOTICES-DE10-Lite-Support.txt']]);
await makeZip(`MIX-FPGA-${V}-macOS-arm64-Upgrade-from-NexysVHDL.zip`, `MIX-FPGA-${V}-macOS-arm64-Upgrade-from-NexysVHDL`, [vsix, NEXYS, NEXYS_SRC], { from: 'INSTALL-UPGRADE-from-NexysVHDL.md', to: 'INSTALL-UPGRADE-from-NexysVHDL.md' }, [[join(rc, 'THIRD_PARTY_NOTICES-Nexys-A7-Support.md'), 'THIRD_PARTY_NOTICES-Nexys-A7-Support.md']]);

// ---------------------------------------------------------------- final checks and sums
await checkAccepted(rc);
const final = await sums(out, [dmgName, `MIX-FPGA-${V}-macOS-arm64-Fresh.zip`, `MIX-FPGA-${V}-macOS-arm64-Upgrade-from-NexysVHDL.zip`]);
writeFileSync(join(out, 'SHA256SUMS'), final.map((r) => `${r.sha256}  ${r.file}`).join('\n') + '\n');
writeFileSync(join(out, 'CLASSROOM-MANIFEST.json'), `${JSON.stringify({ product: 'MIX-FPGA', version: V, status: 'UNSIGNED, NOT NOTARIZED', sourceCommit: commit, acceptedArtifacts: ACCEPTED, wrappers: final }, null, 2)}\n`);
console.log(final.map((r) => `${String(r.bytes).padStart(12)}  ${r.sha256}  ${r.file}`).join('\n'));
