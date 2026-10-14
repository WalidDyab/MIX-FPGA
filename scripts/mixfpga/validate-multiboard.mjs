#!/usr/bin/env node
// Real-tool validation of the multi-board backend (NOT part of `npm test`: needs the MIX-FPGA toolchain, the Linux
// engine and, for --program, a connected board). Run `npm run build` first.
//   node scripts/mixfpga/validate-multiboard.mjs <work folder> [--program] [--stop-vm] [--tool-output]
// Creates a DE10-Lite starter project with the real New Project code, then makes the same calls the VS Code extension
// makes: Check, Simulate, RTL, Build (cold with --stop-vm, then warm), Detect and (with --program) Program.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { loadProject } = require(join(dist, 'core'));
const { createProject } = require(join(dist, 'extension', 'project', 'scaffold.js'));
const { CoreBackend } = require(join(dist, 'extension', 'services', 'backend.js'));
const { MixFpgaBackend } = require(join(dist, 'extension', 'services', 'multiboard-backend.js'));

const [work, ...flags] = process.argv.slice(2);
if (!work) {
  console.error('usage: validate-multiboard <work folder> [--program] [--stop-vm] [--tool-output]');
  process.exit(2);
}
const log = (s) => process.stdout.write(`${s}\n`);

mkdirSync(resolve(work), { recursive: true });
const backend = new MixFpgaBackend(new CoreBackend({ onToolOutput: (t) => (flags.includes('--tool-output') ? process.stdout.write(t) : undefined) }));
const boards = await backend.boards();
const board = boards.get('de10-lite');
log(`supportsBoard(de10-lite) = ${backend.supportsBoard(board)}`);
const created = await createProject({ parentDir: resolve(work), name: `De10Starter${Date.now() % 100000}`, board, template: 'starter' });
if (!created.ok) throw new Error(created.message);
log(`created ${created.root}: ${created.files.join(', ')}`);
const loaded = await loadProject(created.root);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
const project = loaded.project;
const v = await backend.validate(project);
log(`validate: ${v.valid ? 'valid' : 'INVALID'} ${v.diagnostics.map((d) => d.code).join(',')}`);

let t = Date.now();
const check = await backend.check(project);
log(`check: ${check.status} (${Date.now() - t} ms)`);
t = Date.now();
const sim = await backend.simulate(project, 'top_tb');
log(`simulate: ${sim.status} passed=${sim.passed} stoppedAt=${sim.stoppedAt} waveform=${sim.waveform ? 'yes' : 'no'} (${Date.now() - t} ms)`);
t = Date.now();
const rtl = await backend.rtl(project);
log(`rtl: ${rtl.status} netlist=${rtl.netlist ? `${rtl.netlist.sizeBytes} B` : 'none'} (${Date.now() - t} ms)`);

if (flags.includes('--stop-vm')) {
  const flows = await backend.core.flows();
  await flows.engineFor(flows.profileOf('de10-lite')).shutdown();
  log('engine stopped for a cold build');
}
for (const label of ['build #1', 'build #2 (warm)']) {
  t = Date.now();
  const status = [];
  const r = await backend.build(project, () => undefined, undefined, (m) => status.push(m));
  log(`${label}: success=${r.success} ${((Date.now() - t) / 1000).toFixed(1)} s  status=[${status.join(' | ')}]`);
  const n = r.normalized;
  if (n) {
    log(`  device ${n.device}; timing ${n.timingStatus}; ${Object.values(n.resources).map((m) => `${m.label} ${m.used}`).join(', ')}`);
    log(`  clocks ${n.clocks.map((c) => `${c.name} target ${c.targetMHz} Fmax ${c.fmaxMHz} setup ${c.worstSetupSlackNs} hold ${c.worstHoldSlackNs}`).join('; ')}`);
    log(`  artifact ${n.programmingArtifact?.path} ${n.programmingArtifact?.sizeBytes} B`);
  }
  if (!r.success) {
    log(`  FAILED: ${r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join(' / ')}`);
    process.exit(1);
  }
}
const det = await backend.detectBoards(project);
log(`detect: configured=${det.configured} boards=${det.boards.map((b) => `${b.productName} ${b.serialNumber}`).join(',') || 'none'}`);
if (flags.includes('--program')) {
  const pr = await backend.program(project, undefined);
  log(`program: ${pr.status} ${pr.diagnostics.map((d) => `${d.severity}:${d.code}`).join(' / ')}`);
  process.exit(pr.status === 'succeeded' ? 0 : 1);
}
log(`project: ${created.root}`);
