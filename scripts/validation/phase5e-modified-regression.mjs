#!/usr/bin/env node
// Phase 5E: modified-toolchain behaviour against the REAL final Toolchain 1.1 payloads installed in an isolated root
// (made by phase5e-isolated-setup.mjs). Modifies, verifies, declines/accepts Repair and checks the final hashes.
//   node scripts/validation/phase5e-modified-regression.mjs --home <isolated MIX-FPGA folder> --payloads <folder>
import { chmodSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const home = resolve(opt('--home') ?? ''); const payloads = resolve(opt('--payloads') ?? '');
if (!opt('--home') || !opt('--payloads') || home.startsWith(join(homedir(), 'Library', 'MIX-FPGA'))) { console.error('usage: --home <isolated folder> --payloads <folder>'); process.exit(2); }
process.env.MIXFPGA_HOME = home; process.env.MIXFPGA_DEV_PAYLOAD = payloads;
const { createSetupController } = require(join(repo, 'dist', 'runtime', 'setup.js'));
const ctl = await createSetupController({ extensionPath: repo, hardware: () => ({ state: 'not-connected', word: 'Not connected' }), runRosettaCommand: async () => ({ exitCode: 1, output: '' }) });
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`); if (!ok) fails++; };
const writable = (f) => { spawnSync('/bin/chmod', ['-R', 'u+w', f]); };
let confirm = true; const asked = [];
const ui = { async chooseBoards() { return ['nexys-a7-100t', 'de10-lite']; }, async askNexysArchive() { return undefined; }, async askDe10Archive() { return undefined; }, async confirmInstall(s) { asked.push(s); return confirm; }, async askRosettaConsent() { return undefined; }, async askQuartusFiles() { return undefined; }, async showLicense() { return false; }, progress() {}, log() {} };
const board = async (id) => (await ctl.status()).view.boards.find((b) => b.id === id);
const de10Dir = join(home, 'toolchains', '1.1', 'macos-arm64');
const nexysDir = join(home, 'support', 'nexys-a7', 'toolchains', 'darwin-arm64', '1.1');
const manifest = JSON.parse(readFileSync(join(repo, 'toolchains', 'mixfpga', 'toolchain-1.1-macos-arm64.json'), 'utf8'));
const entry = (unit, path) => manifest.units.find((u) => u.id === unit).files.find((f) => f.path === path);

console.log('--- clean installed 1.1');
let st = (await ctl.status()).view;
check('Nexys A7 Installed, clean', (await board('nexys-a7-100t')).word === 'Installed');
check('DE10-Lite toolchain parts Ready (Quartus is not part of this check)', st.rows.find((r) => r.id === 'vhdl-tools').word === 'Ready' && st.rows.find((r) => r.id === 'programmer').word === 'Ready');

console.log('--- DE10-Lite: modified file (a replaced library)');
const lib = join(de10Dir, 'openfpgaloader', 'lib', 'libftdi1.2.5.0.dylib');
const want = entry('openfpgaloader', 'lib/libftdi1.2.5.0.dylib');
check('the manifest names that library', !!want && sha(lib) === want.sha256);
writable(join(de10Dir, 'openfpgaloader')); appendFileSync(lib, Buffer.from('replaced-by-student'));
const modifiedSha = sha(lib);
st = (await ctl.status()).view;
check('support stays installed: VHDL Tools row says Modified, not Not installed', st.rows.find((r) => r.id === 'vhdl-tools').word === 'Modified' || st.rows.find((r) => r.id === 'programmer').word === 'Modified', JSON.stringify(st.rows.map((r) => `${r.id}=${r.word}`)));
// Quartus (the Altera download) is not installed in this isolated root, so the DE10-Lite BOARD is "incomplete" here; the board-level
// rules (New Project, Repair action) for a complete board are asserted in the Nexys section below and in tests/install.
const comp = async (id) => (await ctl.status()).statuses.find((x) => x.id === id)?.state;
check('components: openfpgaloader and toolchain are modified, ghdl and yosys ready', (await comp('openfpgaloader')) === 'modified' && (await comp('toolchain')) === 'modified' && (await comp('ghdl')) === 'ready' && (await comp('yosys')) === 'ready');
check('Nexys A7 unaffected', (await board('nexys-a7-100t')).word === 'Installed' && (await ctl.isBoardModified('nexys-a7-100t')) === false);
check('the Setup page row carries the modified wording and nothing says Not installed for VHDL Tools', /no longer the verified MIX-FPGA configuration/.test(st.rows.find((r) => r.id === 'vhdl-tools').hint ?? ''));
check('nothing restored by looking', sha(lib) === modifiedSha);
const v = await ctl.verify();
check('Verify reports the modification (the modified part is not a failure)', v.modified === true && v.steps.filter((s) => /modified/.test(s.detail ?? '')).every((s) => s.ok) && v.steps.some((s) => /modified/.test(s.detail ?? '')), `failed steps: ${v.steps.filter((s) => !s.ok).map((s) => s.label).join(',')}`);
check('Verify did not restore anything', sha(lib) === modifiedSha);
console.log('--- declining Repair');
confirm = false; asked.length = 0;
const declined = await ctl.repair(ui, undefined, ['de10-lite']);
check('declined: stopped, nothing changed', declined.outcome === 'stopped' && sha(lib) === modifiedSha && asked.length === 1 && asked[0].replacesChanges === true);
console.log('--- explicit Repair');
confirm = true;
const repaired = await ctl.repair(ui, undefined, ['de10-lite']);
check('Repair complete', repaired.outcome === 'complete', repaired.message);
check('the final 1.1 hash is back', sha(lib) === want.sha256);
check('state returns to verified', (await comp('openfpgaloader')) === 'ready' && (await comp('toolchain')) === 'ready' && (await ctl.status()).view.rows.find((r) => r.id === 'vhdl-tools').word === 'Ready');

console.log('--- DE10-Lite: missing file / missing tool');
writable(join(de10Dir, 'openfpgaloader')); rmSync(lib);
st = (await ctl.status()).view;
check('missing file: Needs repair (not Modified, not Installed)', ['vhdl-tools', 'programmer'].some((id) => st.rows.find((r) => r.id === id).word === 'Needs repair') && (await comp('openfpgaloader')) === 'repairable');
const r2 = await ctl.repair(ui, undefined, ['de10-lite']);
check('Repair restores the missing file to the final hash', r2.outcome === 'complete' && sha(lib) === want.sha256, r2.message);
writable(de10Dir); rmSync(join(de10Dir, 'yosys'), { recursive: true, force: true });
st = (await ctl.status()).view;
check('missing tool: Needs repair', st.rows.find((r) => r.id === 'vhdl-tools').word !== 'Ready' && st.rows.find((r) => r.id === 'vhdl-tools').word !== 'Modified', st.rows.find((r) => r.id === 'vhdl-tools').word);
const r3 = await ctl.repair(ui, undefined, ['de10-lite']);
check('Repair puts the tool back', r3.outcome === 'complete' && existsSync(join(de10Dir, 'yosys', 'libexec', 'yosys')), r3.message);

console.log('--- Nexys A7: modified file (replaced Readline library)');
const rl = join(nexysDir, 'apio', 'packages', 'oss-cad-suite', 'lib', 'libreadline.8.2.dylib');
const rlSha = sha(rl);
check('shipped Readline is the one in the evidence list', rlSha === 'be7552f0f9ce7cda5731faba2018b0e62db6af6a712ebe1ceeb7c400d9ac183a');
writable(nexysDir); appendFileSync(rl, Buffer.from('replaced'));
const nv = await ctl.verify();
check('Verify reports Nexys modified and usable', nv.modified === true && nv.steps.filter((s) => /Nexys|toolchain/i.test(s.label)).every((s) => s.ok), JSON.stringify(nv.steps.filter((s) => !s.ok).map((s) => s.label)));
check('Nexys A7 board is ready for New Project', (await ctl.isBoardReady('nexys-a7-100t')) === true);
const nr = await ctl.repair(ui, undefined, ['nexys-a7-100t']);
check('explicit Repair restores Readline to the final hash', nr.outcome === 'complete' && sha(rl) === rlSha, nr.message);
const req = JSON.parse(readFileSync(join(repo, 'toolchains', 'bundle', 'requirement.json'), 'utf8')).targets['darwin-arm64'];
const { inventoryDirectory } = require(join(repo, 'dist', 'core', 'toolchain', 'tar.js'));
check('whole Nexys tree equals the final 1.1 tree hash', (await inventoryDirectory(nexysDir, { exclude: ['.nexysvhdl-installed.json'] })).treeSha256 === req.treeSha256);
console.log('--- Nexys A7: missing tool');
const ghdl = join(nexysDir, 'ghdl', 'bin', 'ghdl');
writable(nexysDir); rmSync(ghdl);
const mv = await ctl.verify();
check('missing Nexys tool: Verify fails, not modified', mv.ok === false && mv.modified !== true);
const mr = await ctl.repair(ui, undefined, ['nexys-a7-100t']);
check('Repair restores it', mr.outcome === 'complete' && existsSync(ghdl), mr.message);
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
