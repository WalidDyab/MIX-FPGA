#!/usr/bin/env node
// Drives the REAL Windows Setup controller (the one the extension uses) without VS Code, against an isolated MIX-FPGA root.
//   MIXFPGA_HOME=D:\MFW\r2 node scripts/validation/p4c-setup-cli.mjs <status|verify|repair|damage-de10|damage-nexys|sizes>
// Refuses to run unless MIXFPGA_HOME is set and is not the real %LOCALAPPDATA%\MIX-FPGA. Dialogs are answered by script: Continue to
// the confirmation, nothing else (Altera files and licence are never scripted here).
import { chmod, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const home = process.env.MIXFPGA_HOME;
if (!home || /AppData[\\/]Local[\\/]MIX-FPGA$/i.test(home)) throw new Error('refusing to run: MIXFPGA_HOME must point at an isolated root');
const { createSetupController } = require(join(repo, 'dist', 'runtime', 'setup.js'));
const controller = await createSetupController({ extensionPath: repo, hardware: () => ({ state: 'not-checked', word: 'Not checked' }) });
const ui = {
  chooseBoards: async () => undefined,
  askNexysArchive: async () => undefined,
  confirmInstall: async (s) => { console.log('  confirm:', JSON.stringify(s)); return true; },
  askRosettaConsent: async () => undefined,
  askQuartusFiles: async () => undefined,
  showLicense: async () => false,
  progress: () => undefined,
  log: (l) => console.log('  log:', l),
};
const show = (view) => console.log(JSON.stringify({ headline: view.headline, boards: view.boards.map((b) => `${b.name}=${b.word}`), rows: view.rows.map((r) => `${r.label}=${r.word}`) }));
const dirSize = async (d) => { let n = 0, c = 0; for (const e of await readdir(d, { withFileTypes: true, recursive: true }).catch(() => [])) if (e.isFile()) { n += (await stat(join(e.parentPath, e.name))).size; c++; } return { bytes: n, files: c }; };
const cmd = process.argv[2];
const t0 = Date.now();
if (cmd === 'status') show((await controller.status()).view);
else if (cmd === 'verify') {
  const v = await controller.verify();
  console.log(JSON.stringify({ ok: v.ok, steps: v.steps.map((s) => `${s.ok ? 'OK  ' : 'FAIL'} ${s.label}${s.detail ? ` (${s.detail})` : ''}`) }, null, 1));
} else if (cmd === 'repair') {
  const r = await controller.repair(ui);
  console.log(JSON.stringify({ outcome: r.outcome, message: r.message }));
  show(r.view);
} else if (cmd === 'damage-de10') {
  const f = join(home, 'toolchains', '1.0', 'windows-x64', 'yosys', 'share', 'yosys', 'include', 'kernel', 'rtlil.h');
  const victim = (await readdir(join(home, 'toolchains', '1.0', 'windows-x64', 'yosys', 'share'), { recursive: true, withFileTypes: true })).find((e) => e.isFile());
  const path = join(victim.parentPath, victim.name);
  await chmod(path, 0o666);
  const size = (await stat(path)).size;
  await writeFile(path, Buffer.alloc(size, 0x41));
  console.log('damaged (same size, different bytes):', path.replace(home, '<root>'), f ? '' : '');
} else if (cmd === 'damage-nexys') {
  const path = join(home, 'support', 'nexys-a7', 'toolchains', 'win32-x64', '1.0', 'toolchain-manifest.json');
  await chmod(path, 0o666);
  const size = (await stat(path)).size;
  await writeFile(path, Buffer.alloc(size, 0x41));
  console.log('damaged:', path.replace(home, '<root>'));
} else if (cmd === 'sizes') {
  const out = {};
  for (const [label, rel] of [['nexys-a7-support', 'support'], ['de10-managed-tools', 'toolchains'], ['state', 'state'], ['staging', 'staging'], ['downloads', 'downloads'], ['payload-work', '.payload'], ['logs', 'logs']]) out[label] = await dirSize(join(home, rel));
  console.log(JSON.stringify(out));
} else throw new Error(`unknown command ${cmd}`);
console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
