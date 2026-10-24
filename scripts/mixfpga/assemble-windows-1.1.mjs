#!/usr/bin/env node
// Assembles the MIX-FPGA DE10-Lite support archive of Toolchain 1.1 for Windows (Phase 5H).
//
//   node scripts/mixfpga/assemble-windows-1.1.mjs [--nexys <nexysvhdl-toolchain-1.1-win32-x64.tar.gz>] [--tree <assembled Nexys 1.1 tree>]
//
// 1. copies GHDL and Yosys (with its DLL closure) out of the assembled Nexys A7 support 1.1 tree (toolchain/win32-x64-1.1, built by
//    scripts/toolchain/assemble.mjs from the official upstream archives with the Phase 5B/5C compliance changes already applied), so
//    the DE10-Lite tools are byte-identical to the verified Nexys tools and nothing comes from a developer installation;
// 2. builds the 1.1 notices from toolchains/mixfpga/compliance/windows-x64-1.1.inventory.json, checks that every shipped file is
//    claimed by exactly one inventory component, and records the manifest toolchains/mixfpga/toolchain-1.1-windows-x64.json;
// 3. packs .artifacts/windows-1.1/payloads and the pins toolchains/mixfpga/payloads-1.1-windows-x64.json.
// Needs `npm run build` first. The toolchain 1.0 files are never modified.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? resolve(argv[i + 1]) : undefined; };
const tree = opt('--tree') ?? join(repo, 'toolchain', 'win32-x64-1.1');
const tools = join(repo, '.artifacts', 'tools-1.1-windows');
const run = (script, args) => {
    const r = spawnSync(process.execPath, [join(repo, script), ...args], { stdio: 'inherit', cwd: repo });
    if (r.status !== 0) { console.error(`${script} failed`); process.exit(1); }
};
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const files = (d) => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));

// 1. tools, from the verified Nexys tree
run('scripts/mixfpga/assemble-windows.mjs', ['--source', tree, '--dest', tools]);
// every DLL of the yosys closure must be the very file of the oss-cad-suite package
const lib = join(tree, 'apio', 'packages', 'oss-cad-suite', 'lib');
const bin = join(tree, 'apio', 'packages', 'oss-cad-suite', 'bin');
for (const f of readdirSync(join(tools, 'yosys-0.63', 'bin'))) {
    const from = [join(lib, f), join(bin, f)].find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
    if (!from || sha(from) !== sha(join(tools, 'yosys-0.63', 'bin', f))) { console.error(`yosys/bin/${f} is not byte-identical to the oss-cad-suite file`); process.exit(1); }
}
console.log('yosys closure: every file byte-identical to the oss-cad-suite package of the Nexys tree');
for (const f of files(join(tools, 'ghdl-6.0.0'))) {
    const rel = f.slice(join(tools, 'ghdl-6.0.0').length + 1);
    const orig = join(tree, 'ghdl', rel);
    if (sha(f) !== sha(orig)) { console.error(`ghdl/${rel} differs from the Nexys tree`); process.exit(1); }
}
console.log('ghdl: every file byte-identical to the ghdl folder of the Nexys tree');

// 2. notices, coverage, manifest
run('scripts/mixfpga/build-notices-windows.mjs', ['--tools', tools]);
run('scripts/mixfpga/record-toolchain-windows.mjs', ['--bundle', '1.1', '--tools', tools]);
const { loadNoticeInventory, checkCoverage } = require(join(repo, 'dist', 'platform', 'macos', 'install', 'notice-inventory.js'));
const inventory = await loadNoticeInventory(join(repo, 'toolchains', 'mixfpga', 'compliance', 'windows-x64-1.1.inventory.json'));
const manifest = JSON.parse(readFileSync(join(repo, 'toolchains', 'mixfpga', 'toolchain-1.1-windows-x64.json'), 'utf8'));
const cov = checkCoverage(inventory, manifest.units, ['ghdl', 'yosys']);
if (cov.unclaimed.length || cov.multiple.length || cov.deadClaims.length) {
    console.error(JSON.stringify(cov, null, 1));
    process.exit(1);
}
console.log('inventory coverage: every shipped file of ghdl and yosys belongs to exactly one component');

// 3. payload and pins
const payloadArgs = ['--bundle', '1.1', '--pins'];
if (opt('--nexys')) payloadArgs.push('--nexys', opt('--nexys'));
run('scripts/mixfpga/build-payloads-windows.mjs', payloadArgs);
void rmSync;
