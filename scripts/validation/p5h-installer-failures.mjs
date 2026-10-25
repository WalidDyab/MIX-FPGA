#!/usr/bin/env node
// Phase 5H failure paths of the Windows installer, against a REAL NexysVHDL 0.6.0 baseline (built by p5h-baseline-060.mjs): none of them may
// change the existing installation, and an interrupted install must finish when run again.
//
//   node scripts/validation/p5h-installer-failures.mjs <baseline root> <classroom folder> <installer exe> <report.json>
//
// Everything runs in the isolated profile/extensions folder/LocalAppData of the baseline root; the real VS Code profile is never touched.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [rootArg, classroomArg, exeArg, reportArg] = process.argv.slice(2);
if (!reportArg) { console.error('usage: p5h-installer-failures.mjs <baseline root> <classroom folder> <installer exe> <report.json>'); process.exit(2); }
const root = resolve(rootArg), classroom = resolve(classroomArg), exe = resolve(exeArg), report = resolve(reportArg);
const code = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
const require = createRequire(import.meta.url);
const { inventoryDirectory } = require(join(repo, 'dist', 'core', 'toolchain', 'tar.js'));
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const files = {
    vsix: 'nexysvhdl-0.7.0-win32-x64.vsix',
    nexys: 'nexysvhdl-toolchain-1.1-win32-x64.tar.gz',
    de10: 'mixfpga-de10-lite-support-1.1-windows-x64.tar.gz',
};
const work = join(dirname(root), 'failures');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

/** A support folder: hard links to the genuine files (no copy of 740 MB), except what a case replaces. */
function support(name, replace = {}, omit = []) {
    const dir = join(work, name);
    mkdirSync(dir, { recursive: true });
    for (const f of [...Object.values(files), 'SHA256SUMS']) {
        if (omit.includes(f)) continue;
        const target = join(dir, f);
        if (replace[f]) replace[f](target);
        else linkSync(join(classroom, f), target);
    }
    return dir;
}
function flipped(src) { return (dest) => { const b = readFileSync(src); b[Math.floor(b.length / 2)] ^= 0xff; writeFileSync(dest, b); }; }
const flipNexys = join(work, 'nexys-flipped.bin');
{ const b = readFileSync(join(classroom, files.nexys)); b[Math.floor(b.length / 2)] ^= 0xff; writeFileSync(flipNexys, b); }

const env = () => ({ ...process.env, LOCALAPPDATA: join(root, 'Local'), MIXFPGA_HOME: '' });
function run(support_, extra = [], opts = {}) {
    const args = ['--auto', '--boards', opts.boards ?? 'nexys', '--support', support_, '--code', opts.code ?? code, '--user-data-dir', join(root, 'ud'), '--extensions-dir', join(root, 'ext'), '--log', join(work, 'setup.log'), ...extra];
    const r = spawnSync(exe, args, { env: env(), encoding: 'utf8', timeout: opts.timeout ?? 1_200_000 });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
async function snapshot() {
    const ext = readdirSync(join(root, 'ext')).filter((n) => n.startsWith('emxplore.')).sort();
    const t10 = await inventoryDirectory(join(root, 'Local', 'NexysVHDL', 'toolchains', 'win32-x64', '1.0'), { exclude: ['.nexysvhdl-installed.json'] });
    return { extensionFolders: ext, mixfpgaRootExists: existsSync(join(root, 'Local', 'MIX-FPGA')), toolchain10: t10.treeSha256, settings: sha(join(root, 'ud', 'User', 'settings.json')) };
}

const results = [];
const before = await snapshot();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function failing(name, sup, expect, extra = [], opts = {}) {
    const r = run(sup, extra, opts);
    const after = await snapshot();
    const ok = r.status !== 0 && expect.test(r.out) && same(before, after);
    results.push({ case: name, exit: r.status, ok, expected: String(expect), changedSomething: !same(before, after), message: r.out.split(/\r?\n/).filter((l) => /RESULT|PROBLEM|damaged|not the file|not next|checksum|NOT FOUND|older/i.test(l)).slice(0, 3) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

console.log('baseline:', JSON.stringify(before));
await failing('VS Code missing', support('ok-support'), /Visual Studio Code: NOT FOUND/, [], { code: 'D:\\does-not-exist\\Code.exe' });
await failing('corrupted Nexys A7 support archive', support('corrupt-nexys', { [files.nexys]: (d) => copyFileSync(flipNexys, d) }), /damaged or is not the file of this release/);
await failing('wrong support archive (the DE10-Lite archive under the Nexys A7 name)', support('wrong-nexys', { [files.nexys]: (d) => linkSync(join(classroom, files.de10), d) }), /damaged or is not the file of this release/);
await failing('wrong version (Toolchain 1.0 archive under the 1.1 name)', support('old-nexys', { [files.nexys]: (d) => linkSync('D:\\WSClaude\\NexysVHDL\\.artifacts\\dist\\nexysvhdl-toolchain-1.0-win32-x64.tar.gz', d) }), /damaged or is not the file of this release/);
await failing('missing support archive', support('missing-nexys', {}, [files.nexys]), /is not next to the installer/);
await failing('corrupted extension (VSIX)', support('corrupt-vsix', { [files.vsix]: flipped(join(classroom, files.vsix)) }), /damaged or is not the file of this release/);
await failing('checksum list disagrees with a file', support('bad-sums', { SHA256SUMS: (d) => writeFileSync(d, `${'0'.repeat(64)}  ${files.vsix}\n`) }), /does not match the checksum list|damaged/);
await failing('truncated Nexys A7 archive', support('truncated', { [files.nexys]: (d) => { const b = readFileSync(join(classroom, files.vsix)); writeFileSync(d, b); } }), /damaged or is not the file of this release/);

// ---- interrupted install: the installer's Setup step is killed midway, then the installer is run again.
console.log('interrupt: starting an install and killing its Setup step midway');
{
    const sup = join(classroom);
    const args = ['--auto', '--boards', 'nexys', '--support', sup, '--code', code, '--user-data-dir', join(root, 'ud'), '--extensions-dir', join(root, 'ext'), '--log', join(work, 'interrupt.log')];
    const child = spawn(exe, args, { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let killed = false;
    child.stdout.on('data', (d) => { text += d; });
    const t0 = Date.now();
    while (child.exitCode === null && Date.now() - t0 < 600_000) {
        await new Promise((r) => setTimeout(r, 500));
        if (!killed && /Installing Nexys A7 support/.test(text)) {
            await new Promise((r) => setTimeout(r, 4000));
            // the bridge is Code.exe running bridge.js; end that process tree
            const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*bridge.js*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null; $_.ProcessId }"], { encoding: 'utf8' });
            killed = ps.stdout.trim().length > 0;
        }
    }
    await new Promise((r) => child.exitCode !== null ? r() : child.on('exit', r));
    const mid = await snapshot();
    const staged = existsSync(join(root, 'Local', 'MIX-FPGA', 'support', 'nexys-a7', 'toolchains', 'win32-x64', '1.1', 'toolchain-manifest.json'));
    results.push({ case: 'interrupted install (Setup step killed midway)', killed, exit: child.exitCode, midState: { extensionFolders: mid.extensionFolders, nexys11Published: staged, toolchain10Untouched: mid.toolchain10 === before.toolchain10, settingsUntouched: mid.settings === before.settings }, ok: killed && child.exitCode !== 0 && mid.toolchain10 === before.toolchain10 && mid.settings === before.settings && !staged });
    console.log(`${results.at(-1).ok ? 'PASS' : 'FAIL'}  interrupted install: killed=${killed} exit=${child.exitCode} published=${staged}`);
    const again = run(sup);
    const done = await snapshot();
    const verified = /Verify: every installed file checked: OK/.test(again.out) && again.status === 0;
    results.push({ case: 'the next run finishes the interrupted install and verifies it', exit: again.status, ok: verified && done.toolchain10 === before.toolchain10, tail: again.out.split(/\r?\n/).slice(-6).filter(Boolean) });
    console.log(`${results.at(-1).ok ? 'PASS' : 'FAIL'}  re-run after the interruption: exit=${again.status}`);
}

writeFileSync(report, `${JSON.stringify({ baseline: before, results }, null, 2)}\n`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; report ${report}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
void cpSync;
void statSync;
