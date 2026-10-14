#!/usr/bin/env node
// Builds the NexysVHDL classroom packages for one platform:
//
//   .artifacts/dist/nexysvhdl-<version>-<target>.vsix             extension only (small; every update)
//   .artifacts/dist/nexysvhdl-toolchain-<tc>-<target>.tar.gz      FPGA toolchain (separate version; from toolchain:pack)
//   .artifacts/dist/NexysVHDL-<version>-<target>/                 classroom distribution: both + install notes + SHA256SUMS
//   .artifacts/dist/NexysVHDL-<version>-<target>.zip              the same folder as one download
//
//   node scripts/package.mjs --target win32-x64 [--skip-zip]
//
// Fails if typecheck/build fails, the toolchain requirement or archive is
// missing or inconsistent, required runtime resources or notices are
// missing, the VSIX contains excluded content, or a privacy check fails.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fail, hostTarget, parseArgs, REPO_ROOT, sha256File, SUPPORTED_TARGETS } from './toolchain/lib.mjs';

const args = parseArgs(process.argv.slice(2));
const target = args.target ?? hostTarget();
if (!SUPPORTED_TARGETS.includes(target)) fail(`unsupported target ${target}`);
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const dist = join(REPO_ROOT, '.artifacts', 'dist');
const report = { target, version: pkg.version, checks: [] };
const ok = (what) => {
    report.checks.push(what);
    console.log(`  ok  ${what}`);
};

function run(cmd, cmdArgs) {
    console.log(`> ${cmd} ${cmdArgs.join(' ')}`);
    // npm/npx are .cmd files on Windows and need a shell there; the arguments are fixed strings.
    const r = spawnSync(process.platform === 'win32' ? [cmd, ...cmdArgs].map((a) => (/\s/.test(a) ?`"${a}"` : a)).join(' ') : cmd, process.platform === 'win32' ? [] : cmdArgs, { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) fail(`${cmd} ${cmdArgs.join(' ')} failed (${r.status})`);
}

function listZip(file) {
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const r = spawnSync(tar, ['-tf', file], { encoding: 'utf8', maxBuffer: 64 << 20 });
    if (r.status !== 0) fail(`cannot list ${file}`);
    return r.stdout.split(/\r?\n/).filter(Boolean);
}

async function walk(dir) {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(join(e.parentPath, e.name));
    return out;
}

// 1. Toolchain requirement and archive (the separately versioned artifact).
const requirement = JSON.parse(readFileSync(join(REPO_ROOT, 'toolchains', 'bundle', 'requirement.json'), 'utf8'));
const want = requirement.targets?.[target];
if (!want || want.status !== 'validated' || !/^[0-9a-f]{64}$/.test(want.treeSha256 ?? '')) fail(`toolchains/bundle/requirement.json has no validated toolchain ${requirement.bundleVersion} for ${target}`);
ok(`requirement: toolchain ${requirement.bundleVersion} for ${target}, content ${want.treeSha256.slice(0, 16)}…`);
const archive = join(dist, want.archive);
if (!existsSync(archive) || !existsSync(`${archive}.sha256`)) fail(`toolchain archive ${want.archive} is missing (npm run toolchain:assemble && npm run toolchain:pack)`);
const archiveSha = await sha256File(archive);
if (readFileSync(`${archive}.sha256`, 'utf8').split(/\s+/)[0] !== archiveSha) fail(`${want.archive} does not match its .sha256 file`);
const assembled = join(REPO_ROOT, 'toolchain', target, 'toolchain-manifest.json');
if (existsSync(assembled)) {
    const m = JSON.parse(readFileSync(assembled, 'utf8'));
    if (m.bundleVersion !== requirement.bundleVersion || m.target !== target) fail('assembled toolchain does not match the requirement');
    for (const f of ['THIRD_PARTY_NOTICES.md', 'licenses']) if (!existsSync(join(REPO_ROOT, 'toolchain', target, f))) fail(`toolchain notices missing: ${f}`);
    const inventory = JSON.parse(readFileSync(join(REPO_ROOT, 'toolchain', `${target}.inventory.json`), 'utf8'));
    if (inventory.treeSha256 !== want.treeSha256) fail(`assembled toolchain content ${inventory.treeSha256} differs from the requirement ${want.treeSha256}`);
    ok('assembled toolchain matches the requirement; notices and license texts present');
}
ok(`toolchain archive ${want.archive} (${((await stat(archive)).size / 2 ** 20).toFixed(1)} MiB, sha256 ${archiveSha.slice(0, 16)}…)`);

// 2. Typecheck and production build.
run('npm', ['run', 'typecheck']);
run('npm', ['run', 'build']);
ok('typecheck and build');

// 3. Required runtime resources.
const required = [
    pkg.main,
    'dist/extension/waveform/wave-render.js',
    'resources/nexysvhdl.svg',
    ...pkg.contributes.languages.map((l) => l.configuration),
    ...pkg.contributes.grammars.map((g) => g.path),
    ...pkg.contributes.walkthroughs.flatMap((w) => w.steps.map((s) => s.media.markdown)),
    'boards/nexys-a7-100t/board.json',
    'boards/de10-lite/board.json',
    'toolchains/bundle/requirement.json',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'CHANGELOG.md',
    'docs/student-install-windows.md',
    'docs/student-install-macos.md',
    'docs/student-quick-start.md',
    'docs/vsix-readme.md',
].map((p) => p.replace(/^\.\//, ''));
for (const p of required) if (!existsSync(join(REPO_ROOT, p))) fail(`required resource missing: ${p}`);
ok(`${required.length} required resources present`);

// 4. VSIX (extension only).
await mkdir(dist, { recursive: true });
const vsix = join(dist, `nexysvhdl-${pkg.version}-${target}.vsix`);
await rm(vsix, { force: true });
run('npx', ['vsce', 'package', '--target', target, '--no-dependencies', '--allow-missing-repository', '--readme-path', 'docs/vsix-readme.md', '--out', vsix]);

// 5. Content audit (the equivalent of `vsce ls` on the actual file).
const entries = listZip(vsix).filter((e) => e.startsWith('extension/') && !e.endsWith('/')).map((e) => e.slice('extension/'.length));
const forbidden = [/\.ts$/, /\.map$/, /^dist\/tests\//, /^dist\/cli\//, /^tests\//, /^node_modules\//, /^toolchain\//, /^tools\//, /^experiments\//, /^notes\//, /^examples\//, /\.nexysvhdl\//, /\.(vcd|ghw|bit|tar\.gz|zip|exe|dll)$/i, /^docs\/(images|phase|decisions)/, /^\.artifacts\//, /^scripts\//, /^\.git/];
const bad = entries.filter((e) => forbidden.some((r) => r.test(e)));
if (bad.length) fail(`VSIX contains excluded content:\n  ${bad.join('\n  ')}`);
const lower = new Set(entries.map((e) => e.toLowerCase()));
// vsce stores the license file as LICENSE.txt.
for (const p of required.filter((x) => x !== 'docs/vsix-readme.md')) if (!lower.has(p.toLowerCase()) && !(p === 'LICENSE' && lower.has('license.txt'))) fail(`VSIX is missing ${p}`);
if (!lower.has('readme.md')) fail('VSIX is missing its README');
ok(`VSIX content audit: ${entries.length} files, no tests/sources/maps/toolchain/scratch`);

// 6. Privacy audit of every text file in the VSIX and of NexysVHDL-generated toolchain files.
const privacy = [/[A-Za-z]:\\Users\\/i, /[A-Za-z]:\/Users\//i, /\/Users\/[a-z]/, /D:\\WSClaude|D:\/WSClaude|WSClaude/i, /wmdyab|@gmail\.com/i, /AppData\\Local\\Temp/i, /ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY/];
const scratch = join(dist, '.vsix-audit');
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
spawnSync(process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-xf', vsix, '-C', scratch]);
const textFiles = [...(await walk(scratch)).filter((f) => /\.(js|json|md|txt|xml|vsixmanifest|svg)$/i.test(f))];
const generated = ['toolchain-manifest.json', 'THIRD_PARTY_NOTICES.md', 'shims', 'apio/remote-config', 'apio/packages/installed_packages.json'].map((p) => join(REPO_ROOT, 'toolchain', target, p)).filter(existsSync);
for (const g of generated) textFiles.push(...((await stat(g)).isDirectory() ? await walk(g) : [g]));
const leaks = [];
for (const f of textFiles) {
    const text = await readFile(f, 'utf8');
    for (const r of privacy) if (r.test(text)) leaks.push(`${relative(REPO_ROOT, f)}: ${r}`);
}
const shippedLicense = ['LICENSE.txt', 'LICENSE'].map((n) => join(scratch, 'extension', n)).find(existsSync);
if (!shippedLicense || (await sha256File(shippedLicense)) !== (await sha256File(join(REPO_ROOT, 'LICENSE')))) fail('the VSIX license file is not the repository LICENSE (Apache-2.0)');
ok('VSIX license: Apache-2.0 text identical to LICENSE; NOTICE present');
await rm(scratch, { recursive: true, force: true });
if (leaks.length) fail(`privacy audit failed:\n  ${leaks.join('\n  ')}`);
ok(`privacy audit: ${textFiles.length} text files (VSIX + generated toolchain files), no local paths, user names or secrets`);

// 7. Classroom distribution folder (+ zip): VSIX + toolchain + install notes + checksums.
const bundleName = `NexysVHDL-${pkg.version}-${target}`;
const folder = join(dist, bundleName);
await rm(folder, { recursive: true, force: true });
await mkdir(folder);
await copyFile(vsix, join(folder, relative(dist, vsix)));
await link(archive, join(folder, want.archive)).catch(() => copyFile(archive, join(folder, want.archive)));
const guide = target.startsWith('win32') ? 'student-install-windows.md' : 'student-install-macos.md';
await copyFile(join(REPO_ROOT, 'docs', guide), join(folder, 'INSTALL.md'));
await copyFile(join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md'), join(folder, 'THIRD_PARTY_NOTICES.md'));
await copyFile(join(REPO_ROOT, 'LICENSE'), join(folder, 'LICENSE'));
await copyFile(join(REPO_ROOT, 'NOTICE'), join(folder, 'NOTICE'));
const sums = [];
for (const f of (await readdir(folder)).sort()) sums.push(`${await sha256File(join(folder, f))}  ${f}`);
await writeFile(join(folder, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
ok(`distribution folder ${relative(REPO_ROOT, folder)}`);
if (!args['skip-zip']) {
    const zip = `${folder}.zip`;
    await rm(zip, { force: true });
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const r = spawnSync(tar, ['-a', '-cf', zip, '-C', dist, bundleName], { stdio: 'inherit' });
    if (r.status !== 0) fail('creating the distribution zip failed');
    ok(`distribution zip ${relative(REPO_ROOT, zip)} (${((await stat(zip)).size / 2 ** 20).toFixed(1)} MiB)`);
}

report.vsix = { file: relative(REPO_ROOT, vsix), bytes: (await stat(vsix)).size, sha256: await sha256File(vsix), files: entries.length };
report.toolchain = { file: want.archive, bytes: (await stat(archive)).size, sha256: archiveSha, version: requirement.bundleVersion, treeSha256: want.treeSha256, installedBytes: want.bytes, installedFiles: want.files };
report.entries = entries;
await writeFile(join(dist, `${bundleName}.package-report.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nVSIX ${relative(REPO_ROOT, vsix)}: ${(report.vsix.bytes / 1024).toFixed(1)} KiB, ${entries.length} files`);
