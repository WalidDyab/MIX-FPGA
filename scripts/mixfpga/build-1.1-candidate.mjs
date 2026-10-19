#!/usr/bin/env node
// Builds a Toolchain 1.1 CANDIDATE of the extension for validation (Phase 5C), without touching the repository's Toolchain 1.0
// records: the sources are copied to .artifacts/candidate-1.1-src, the few places that name Toolchain 1.0 are switched to 1.1
// there, and that copy is built and packaged. The repository itself keeps requiring Toolchain 1.0 until the owner adopts 1.1.
//
//   node scripts/mixfpga/build-1.1-candidate.mjs
//
// Needs the Toolchain 1.1 candidates (scripts/toolchain/assemble.mjs --recipe darwin-arm64-1.1 + pack, scripts/mixfpga/assemble-1.1.mjs).
// Output: .artifacts/candidates-1.1/vsix/nexysvhdl-<version>-darwin-arm64.vsix (+ .sha256) and the overlay folder.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = join(repo, '.artifacts', 'candidate-1.1-src');
const out = join(repo, '.artifacts', 'candidates-1.1');
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };
const sh = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: process.env }); if (r.status !== 0) die(`${cmd} ${args.join(' ')} failed`); };

const nexysArchive = join(out, 'nexys', 'nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz');
if (!existsSync(nexysArchive)) die('build the Nexys 1.1 candidate first (scripts/toolchain/pack.mjs --recipe darwin-arm64-1.1 --out-dir .artifacts/candidates-1.1/nexys)');

// 1. copy the sources (tracked and new, not ignored files)
rmSync(src, { recursive: true, force: true });
mkdirSync(src, { recursive: true });
const list = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 }).stdout.split('\0').filter(Boolean);
for (const f of list) {
    if (!existsSync(join(repo, f))) continue;
    mkdirSync(dirname(join(src, f)), { recursive: true });
    copyFileSync(join(repo, f), join(src, f));
}
symlinkSync(join(repo, 'node_modules'), join(src, 'node_modules'));

// 2. switch the macOS places that name Toolchain 1.0 to 1.1 (each must match exactly once)
const edit = (file, pairs) => {
    let s = readFileSync(join(src, file), 'utf8');
    for (const [a, b] of pairs) {
        if (s.split(a).length !== 2) die(`${file}: expected exactly one "${a}"`);
        s = s.replace(a, b);
    }
    writeFileSync(join(src, file), s);
};
edit('platform/macos/install/layout.ts', [["TOOLCHAIN_VERSION = '1.0'", "TOOLCHAIN_VERSION = '1.1'"]]);
edit('runtime/setup.ts', [
    ["'nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz'", "'nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz'"],
    ["'toolchain-1.0-macos-arm64.json'", "'toolchain-1.1-macos-arm64.json'"],
    ["'payloads-1.0.json'", "'payloads-1.1.json'"],
]);
edit('runtime/multiboard.ts', [["'toolchain-1.0-macos-arm64.json'", "'toolchain-1.1-macos-arm64.json'"]]);
edit('tests/integration/multiboard-suite.ts', [["'toolchains', '1.0', 'macos-arm64'", "'toolchains', '1.1', 'macos-arm64'"]]);
edit('.vscodeignore', [['!toolchains/mixfpga/toolchain-1.0-macos-arm64.json', '!toolchains/mixfpga/toolchain-1.1-macos-arm64.json'], ['!toolchains/mixfpga/payloads-1.0.json', '!toolchains/mixfpga/payloads-1.1.json']]);
edit('scripts/package.mjs', [["want.status !== 'validated'", "!['validated', 'candidate'].includes(want.status)"]]);
// The extension only knows "validated" or "pending" targets; the candidate overlay says "validated" and carries the truth in `candidate`.
const req = JSON.parse(readFileSync(join(src, 'toolchains', 'bundle', 'requirement-1.1.json'), 'utf8'));
for (const t of Object.values(req.targets)) { if (t.status === 'candidate') { t.status = 'validated'; t.candidate = true; } }
writeFileSync(join(src, 'toolchains', 'bundle', 'requirement.json'), `${JSON.stringify(req, null, 2)}\n`);

// 3. the toolchain archive the packaging checks, then build and package the candidate extension
const dist = join(src, '.artifacts', 'dist');
mkdirSync(dist, { recursive: true });
copyFileSync(nexysArchive, join(dist, 'nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz'));
copyFileSync(`${nexysArchive}.sha256`, join(dist, 'nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz.sha256'));
sh('node', ['scripts/package.mjs', '--target', 'darwin-arm64', '--skip-zip'], src);

// 4. publish the candidate VSIX
const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version;
const vsix = join(dist, `nexysvhdl-${version}-darwin-arm64.vsix`);
mkdirSync(join(out, 'vsix'), { recursive: true });
const target = join(out, 'vsix', `nexysvhdl-${version}-darwin-arm64.vsix`);
copyFileSync(vsix, target);
const sha = createHash('sha256').update(readFileSync(target)).digest('hex');
writeFileSync(`${target}.sha256`, `${sha}  nexysvhdl-${version}-darwin-arm64.vsix\n`);
console.log(`candidate VSIX ${target}\n  sha256 ${sha}`);
void cpSync;
