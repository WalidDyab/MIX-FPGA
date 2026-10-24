#!/usr/bin/env node
// Builds the UNSIGNED Windows classroom distribution folder (Phase 5H):
//
//   MIX-FPGA-0.7.0-Windows-x64-Classroom/
//     MIX-FPGA-0.7.0-Windows-x64-Setup.exe                       the installer (primary route)
//     MIX-FPGA-0.7.0-Windows-x64-Fresh.zip                       manual route, both boards
//     MIX-FPGA-0.7.0-Windows-x64-Upgrade-from-NexysVHDL.zip      manual route, Nexys A7 only
//     nexysvhdl-0.7.0-win32-x64.vsix, the two support archives, the two corresponding-source packages (side by side)
//     README-FIRST.txt, INSTALL-FRESH-Windows.md, INSTALL-UPGRADE-from-NexysVHDL.md, notices, LICENSE, SHA256SUMS, RELEASE-MANIFEST.json
//
//   node scripts/release/windows-classroom.mjs [--out <folder>] [--payloads <dir>] [--sources <dir>] [--installer <dir>]
//
// Every binary is checked against the committed pins (toolchains/mixfpga/payloads-1.1-windows-x64.json, requirement.json) and every source
// package against its own .sha256 before it is copied, and again in the folder and inside both ZIPs. The archives are copied byte for byte,
// never unpacked or repacked. Nothing is signed, uploaded or published.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from '../compliance/zip.mjs';
import { sha256File } from '../toolchain/lib.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? resolve(argv[argv.indexOf(k) + 1]) : d);
const fail = (m) => { console.error(`classroom release failed: ${m}`); process.exit(1); };
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const pkg = read('package.json');
const V = pkg.version;
const payloads = opt('--payloads', join(root, '.artifacts', 'windows-1.1', 'payloads'));
const sources = opt('--sources', join(root, '.artifacts', 'windows-1.1', 'sources'));
const installerDir = opt('--installer', join(root, '.artifacts', 'installer-windows'));
const outParent = opt('--out', join(root, '.artifacts', 'classroom-windows'));
const top = `MIX-FPGA-${V}-Windows-x64-Classroom`;
const out = join(outParent, top);

const pins = read('toolchains/mixfpga/payloads-1.1-windows-x64.json').payloads;
const requirement = read('toolchains/bundle/requirement.json').targets['win32-x64'];
const VSIX = `nexysvhdl-${V}-win32-x64.vsix`;
const NEXYS = pins['nexys-a7-100t'].file, DE10 = pins['de10-lite'].file;
const NEXYS_SRC = 'MIX-FPGA-Nexys-A7-Support-1.1-Windows-x64-Sources.zip', DE10_SRC = 'MIX-FPGA-DE10-Lite-Support-1.1-Windows-x64-Sources.zip';
const SETUP = `MIX-FPGA-${V}-Windows-x64-Setup.exe`;
if (pins['nexys-a7-100t'].sha256 === undefined || requirement.archive !== NEXYS) fail('the committed pins and requirement.json disagree about the Nexys A7 archive');

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
if (git('status', '--porcelain') !== '') fail('the working tree has uncommitted changes: commit first so the manifest names the exact source');
const commit = git('rev-parse', 'HEAD');

// ---- inputs, checked
const src = {
    [VSIX]: join(root, '.artifacts', 'dist', VSIX),
    [NEXYS]: join(payloads, NEXYS),
    [DE10]: join(payloads, DE10),
    [NEXYS_SRC]: join(sources, NEXYS_SRC),
    [DE10_SRC]: join(sources, DE10_SRC),
    [SETUP]: join(installerDir, SETUP),
};
for (const [n, p] of Object.entries(src)) if (!existsSync(p)) fail(`${n} is missing (${p})`);
for (const [n, pin] of [[NEXYS, pins['nexys-a7-100t']], [DE10, pins['de10-lite']]]) {
    if (statSync(src[n]).size !== pin.bytes || (await sha256File(src[n])) !== pin.sha256) fail(`${n} does not match payloads-1.1-windows-x64.json`);
}
for (const n of [NEXYS_SRC, DE10_SRC]) {
    const want = readFileSync(`${src[n]}.sha256`, 'utf8').trim().split(/\s+/)[0];
    if ((await sha256File(src[n])) !== want) fail(`${n} does not match its .sha256`);
}
// The installer was built with exactly these files: the SHA-256 of each is a string constant inside it (UTF-16 in the .NET metadata).
const installerBytes = readFileSync(src[SETUP]);
for (const [n, p] of [[VSIX, src[VSIX]], [NEXYS, src[NEXYS]], [DE10, src[DE10]]]) {
    if (!installerBytes.includes(Buffer.from(await sha256File(p), 'utf16le'))) fail(`the installer was not built with this ${n}: rebuild it (node scripts/installer/build-installer-windows.mjs)`);
}

rmSync(outParent, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const put = (from, to) => { mkdirSync(join(to, '..'), { recursive: true }); copyFileSync(from, to); };
const docs = join(root, 'installer', 'windows');
const nexysNotices = join(root, 'toolchain', 'win32-x64-1.1', 'THIRD_PARTY_NOTICES.md');
const de10Notices = join(root, 'toolchains', 'mixfpga', 'notices', 'windows-x64-1.1', 'THIRD_PARTY_NOTICES.txt');
const NOTICES_ROOT = 'THIRD_PARTY_NOTICES.md', NOTICES_NEXYS = 'THIRD_PARTY_NOTICES-Nexys-A7-Support.md', NOTICES_DE10 = 'THIRD_PARTY_NOTICES-DE10-Lite-Support.txt';

async function sums(dir, names) {
    const rows = [];
    for (const n of names) rows.push({ file: n, bytes: statSync(join(dir, n)).size, sha256: await sha256File(join(dir, n)) });
    return rows;
}
const manifest = (rows, extra) => `${JSON.stringify({
    product: 'MIX-FPGA', version: V, platform: 'Windows 10/11 x64 (win32-x64)', status: 'UNSIGNED: direct classroom distribution, not published',
    sourceCommit: commit, toolchain: { version: requirement.bundleVersion ?? '1.1', nexysTreeSha256: requirement.treeSha256, nexysFiles: requirement.files },
    sourceDelivery: 'each support archive is accompanied by its corresponding-source package, in the same place; no written offer',
    ...extra, files: rows,
}, null, 2)}\n`;

// ---- the folder
for (const n of [SETUP, VSIX, NEXYS, DE10, NEXYS_SRC, DE10_SRC]) put(src[n], join(out, n));
put(join(docs, 'README-FIRST.txt'), join(out, 'README-FIRST.txt'));
put(join(docs, 'INSTALL-FRESH-Windows.md'), join(out, 'INSTALL-FRESH-Windows.md'));
put(join(docs, 'INSTALL-UPGRADE-from-NexysVHDL.md'), join(out, 'INSTALL-UPGRADE-from-NexysVHDL.md'));
put(join(root, 'THIRD_PARTY_NOTICES.md'), join(out, NOTICES_ROOT));
put(nexysNotices, join(out, NOTICES_NEXYS));
put(de10Notices, join(out, NOTICES_DE10));
put(join(root, 'LICENSE'), join(out, 'LICENSE'));

// ---- the two ZIPs
// writeZip zips a whole folder tree, so each package is staged under its own parent (stored entries, fixed timestamps, one top folder).
async function zipOne(name, folder, binaries, guide, notices) {
    const parent = join(outParent, 'zip-one', folder);
    rmSync(parent, { recursive: true, force: true });
    const stage = join(parent, folder);
    mkdirSync(stage, { recursive: true });
    for (const n of binaries) put(src[n], join(stage, n));
    put(join(docs, guide), join(stage, guide));
    put(join(root, 'THIRD_PARTY_NOTICES.md'), join(stage, NOTICES_ROOT));
    const nn = [];
    for (const [from, to] of notices) { put(from, join(stage, to)); nn.push(to); }
    put(join(root, 'LICENSE'), join(stage, 'LICENSE'));
    const names = [...binaries, guide, NOTICES_ROOT, ...nn, 'LICENSE'];
    const rows = await sums(stage, names);
    writeFileSync(join(stage, 'SHA256SUMS'), rows.map((r) => `${r.sha256}  ${r.file}`).join('\n') + '\n');
    writeFileSync(join(stage, 'RELEASE-MANIFEST.json'), manifest(rows, { package: name }));
    await writeZip(parent, join(out, name));
    return rows;
}
const FRESH = `MIX-FPGA-${V}-Windows-x64-Fresh.zip`, UPGRADE = `MIX-FPGA-${V}-Windows-x64-Upgrade-from-NexysVHDL.zip`;
const freshRows = await zipOne(FRESH, `MIX-FPGA-${V}-Windows-x64-Fresh`, [VSIX, NEXYS, DE10, NEXYS_SRC, DE10_SRC], 'INSTALL-FRESH-Windows.md', [[nexysNotices, NOTICES_NEXYS], [de10Notices, NOTICES_DE10]]);
const upgradeRows = await zipOne(UPGRADE, `MIX-FPGA-${V}-Windows-x64-Upgrade-from-NexysVHDL`, [VSIX, NEXYS, NEXYS_SRC], 'INSTALL-UPGRADE-from-NexysVHDL.md', [[nexysNotices, NOTICES_NEXYS]]);
rmSync(join(outParent, 'zip-one'), { recursive: true, force: true });

// ---- sums and manifest of the folder
const names = [SETUP, FRESH, UPGRADE, VSIX, NEXYS, DE10, NEXYS_SRC, DE10_SRC, 'README-FIRST.txt', 'INSTALL-FRESH-Windows.md', 'INSTALL-UPGRADE-from-NexysVHDL.md', NOTICES_ROOT, NOTICES_NEXYS, NOTICES_DE10, 'LICENSE'];
const rows = await sums(out, names);
writeFileSync(join(out, 'SHA256SUMS'), rows.map((r) => `${r.sha256}  ${r.file}`).join('\n') + '\n');
writeFileSync(join(out, 'RELEASE-MANIFEST.json'), manifest(rows, { package: top, zips: { [FRESH]: freshRows.map((r) => r.file), [UPGRADE]: upgradeRows.map((r) => r.file) } }));

// the accepted binaries are still exactly the pinned ones, in the folder
for (const [n, pin] of [[NEXYS, pins['nexys-a7-100t']], [DE10, pins['de10-lite']]]) if ((await sha256File(join(out, n))) !== pin.sha256) fail(`${n} changed while copying`);
console.log(`${out}\n${rows.map((r) => `${String(r.bytes).padStart(12)}  ${r.sha256}  ${r.file}`).join('\n')}`);
