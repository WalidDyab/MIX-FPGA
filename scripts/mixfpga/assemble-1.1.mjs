#!/usr/bin/env node
// Assembles the MIX-FPGA DE10-Lite support candidate of Toolchain 1.1 (macOS), Phase 5C.
//
//   node scripts/mixfpga/assemble-1.1.mjs [--nexys <Nexys 1.1 archive>]
//
// 1. copies the validated 1.0 tool folders (toolchains/experimental, git-ignored) to .artifacts/tools-1.1 and applies the Phase 5B
//    compliance changes: the GHDL library prune (scripts/toolchain/ghdl-prune.mjs) and the removal of the openFPGALoader bridge
//    bitstreams and the three GHDL plugin-development headers (L8); Toolchain 1.0 and the sealed ~/Library/MIX-FPGA installation are only read, never modified;
// 2. builds the 1.1 notices from toolchains/mixfpga/compliance/macos-arm64-1.1.inventory.json and records the 1.1 manifest;
// 3. assembles the unit root .artifacts/toolchain-1.1/macos-arm64 and packs .artifacts/candidates-1.1/payloads (+ the pins
//    toolchains/mixfpga/payloads-1.1.json).
// Needs `npm run build` first.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const experimental = join(repo, 'toolchains', 'experimental');
const tools = join(repo, '.artifacts', 'tools-1.1');
const root = join(repo, '.artifacts', 'toolchain-1.1', 'macos-arm64');
const DEV = { ghdl: 'ghdl-6.0.0', yosys: 'yosys-0.63', openfpgaloader: 'openfpgaloader-1.1.1', lima: 'lima-2.2.1' };
const run = (script, args) => {
    const r = spawnSync(process.execPath, [join(repo, script), ...args], { stdio: 'inherit', cwd: repo });
    if (r.status !== 0) { console.error(`${script} failed`); process.exit(1); }
};
const writable = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) { chmodSync(p, 0o755); writable(p); } else chmodSync(p, e.mode ?? 0o644); } };

// 1. tools
rmSync(tools, { recursive: true, force: true });
mkdirSync(tools, { recursive: true });
for (const f of Object.values(DEV)) {
    if (!existsSync(join(experimental, f))) { console.error(`missing ${join(experimental, f)}`); process.exit(1); }
    cpSync(join(experimental, f), join(tools, f), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
}
const chmodAll = (dir) => { spawnSync('/bin/chmod', ['-R', 'u+w', dir]); };
chmodAll(tools);
run('scripts/toolchain/ghdl-prune.mjs', ['--lib', join(tools, DEV.ghdl, 'lib', 'ghdl'), '--ghdl', join(tools, DEV.ghdl, 'bin', 'ghdl')]);
const share = join(tools, DEV.openfpgaloader, 'share', 'openFPGALoader');
let removedBitstreams = 0;
for (const f of readdirSync(share)) if (/^(spi|bpi)OverJtag_/.test(f)) { rmSync(join(share, f)); removedBitstreams++; }
console.log(`removed ${removedBitstreams} openFPGALoader bridge bitstreams`);
for (const h of ['vpi_user.h', 'synth_gates.h', 'synth.h']) rmSync(join(tools, DEV.ghdl, 'include', 'ghdl', h));
console.log('removed the GHDL plugin-development headers vpi_user.h, synth_gates.h, synth.h');

// 2. notices and manifest
run('scripts/mixfpga/build-notices.mjs', ['--bundle', '1.1', '--tools', tools]);
run('scripts/mixfpga/record-toolchain.mjs', ['--bundle', '1.1', '--tools', tools]);

// 3. unit root and payloads
rmSync(join(repo, '.artifacts', 'toolchain-1.1'), { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const copy = (from, to) => cpSync(from, join(root, to), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
for (const [unit, folder] of Object.entries(DEV)) copy(join(tools, folder), unit);
copy(join(repo, 'platform', 'macos', 'lima'), 'engine');
const notices = join(repo, 'toolchains', 'mixfpga', 'notices', 'macos-arm64-1.1');
copy(join(notices, 'LICENSES'), 'LICENSES');
copy(join(notices, 'THIRD_PARTY_NOTICES.txt'), 'THIRD_PARTY_NOTICES.txt');
const payloadArgs = ['--bundle', '1.1'];
if (opt('--nexys')) payloadArgs.push('--nexys', resolve(opt('--nexys')));
if (opt('--out')) payloadArgs.push('--out', resolve(opt('--out')));
run('scripts/mixfpga/build-payloads.mjs', payloadArgs);
void writable;
