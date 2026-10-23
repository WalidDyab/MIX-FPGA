#!/usr/bin/env node
// Assembles the unsigned macOS release-candidate distribution set (Phase 5E) from already-built, verified artifacts:
//
//   node scripts/release/macos-rc.mjs --payloads <dir with the two support archives> --sources <dir with the two source packages> [--out <dir>]
//
// The extension is .artifacts/dist/nexysvhdl-<version>-darwin-arm64.vsix (scripts/package.mjs). Every archive is checked against the
// committed pins (toolchains/mixfpga/payloads-1.1.json, requirement.json) and every source package against the hash recorded in
// its own manifest. The binary archives and their source packages are placed side by side as companions; there is no written
// offer. Nothing is signed, notarized or published.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fail, parseArgs, REPO_ROOT, sha256File } from '../toolchain/lib.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.payloads || !args.sources) fail('usage: --payloads <dir> --sources <dir> [--out <dir>]');
const read = (p) => JSON.parse(readFileSync(join(REPO_ROOT, p), 'utf8'));
const pkg = read('package.json');
const pins = read('toolchains/mixfpga/payloads-1.1.json').payloads;
const requirement = read('toolchains/bundle/requirement.json');
const want = requirement.targets['darwin-arm64'];
const name = `MIX-FPGA-${pkg.version}-macOS-arm64-RC`;
const out = resolve(args.out ?? join(REPO_ROOT, '.artifacts', 'release-rc', name));
const git = (...a) => execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
if (git('status', '--porcelain') !== '') fail('the working tree has uncommitted changes: commit first so the manifest names the exact source');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const put = (from, to) => { try { linkSync(from, join(out, to)); } catch { copyFileSync(from, join(out, to)); } };
const files = [];

const vsixName = `nexysvhdl-${pkg.version}-darwin-arm64.vsix`;
const vsix = join(REPO_ROOT, '.artifacts', 'dist', vsixName);
if (!existsSync(vsix)) fail(`${vsixName} is missing (node scripts/package.mjs --target darwin-arm64 --skip-zip)`);
put(vsix, vsixName);
files.push({ role: 'extension', file: vsixName });

const companions = [
    { role: 'nexys-a7-support', pin: pins['nexys-a7-100t'], src: 'MIX-FPGA-Nexys-A7-Support-1.1-Sources.zip' },
    { role: 'de10-lite-support', pin: pins['de10-lite'], src: 'MIX-FPGA-DE10-Lite-Support-1.1-Sources.zip' },
];
for (const c of companions) {
    const bin = join(resolve(args.payloads), c.pin.file);
    if ((await sha256File(bin)) !== c.pin.sha256 || statSync(bin).size !== c.pin.bytes) fail(`${c.pin.file} does not match payloads-1.1.json`);
    put(bin, c.pin.file);
    files.push({ role: c.role, file: c.pin.file });
    const src = join(resolve(args.sources), c.src);
    if (!existsSync(src)) fail(`${c.src} is missing`);
    put(src, c.src);
    files.push({ role: `${c.role}-corresponding-source`, file: c.src, accompanies: c.pin.file });
}
const nexysPin = pins['nexys-a7-100t'];
if (!nexysPin.sha256 || (await sha256File(join(out, nexysPin.file))) === '') fail('nexys archive');

// documents
copyFileSync(join(REPO_ROOT, 'docs', 'student-install-macos.md'), join(out, 'INSTALL.md'));
copyFileSync(join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md'), join(out, 'THIRD_PARTY_NOTICES.md'));
copyFileSync(join(REPO_ROOT, 'toolchains', 'mixfpga', 'notices', 'macos-arm64-1.1', 'THIRD_PARTY_NOTICES.txt'), join(out, 'THIRD_PARTY_NOTICES-DE10-Lite-Support.txt'));
copyFileSync(join(REPO_ROOT, 'toolchain', 'darwin-arm64-1.1', 'THIRD_PARTY_NOTICES.md'), join(out, 'THIRD_PARTY_NOTICES-Nexys-A7-Support.md'));
copyFileSync(join(REPO_ROOT, 'LICENSE'), join(out, 'LICENSE'));
for (const f of ['INSTALL.md', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES-DE10-Lite-Support.txt', 'THIRD_PARTY_NOTICES-Nexys-A7-Support.md', 'LICENSE']) files.push({ role: 'document', file: f });

const rows = [];
for (const f of files) rows.push({ ...f, bytes: statSync(join(out, f.file)).size, sha256: await sha256File(join(out, f.file)) });
writeFileSync(join(out, 'SHA256SUMS'), rows.map((r) => `${r.sha256}  ${r.file}`).join('\n') + '\n');
writeFileSync(join(out, 'RELEASE-MANIFEST.json'), `${JSON.stringify({
    product: 'MIX-FPGA', version: pkg.version, platform: 'macOS Apple silicon (darwin-arm64)', status: 'RELEASE CANDIDATE (unsigned, not notarized, not published)',
    commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    toolchain: { version: requirement.bundleVersion, nexysTreeSha256: want.treeSha256, nexysFiles: want.files },
    sourceDelivery: 'one corresponding-source package accompanies each support archive, in the same place; no written offer',
    files: rows,
}, null, 2)}\n`);
console.log(`${out}\n${rows.map((r) => `${String(r.bytes).padStart(11)}  ${r.sha256}  ${r.file}`).join('\n')}`);
