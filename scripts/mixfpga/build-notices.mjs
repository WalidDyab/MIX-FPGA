#!/usr/bin/env node
// Builds the notices shipped with MIX-FPGA Toolchain 1.0 (macOS) from the third-party inventory:
//   toolchains/mixfpga/notices/macos-arm64/LICENSES/...            licence texts, byte for byte from their sources
//   toolchains/mixfpga/notices/macos-arm64/THIRD_PARTY_NOTICES.txt generated index (marked DRAFT while anything is open)
//   node scripts/mixfpga/build-notices.mjs [--tools <folder with ghdl-6.0.0, yosys-0.63, ...>]
// Then run scripts/mixfpga/record-toolchain.mjs to re-record the manifest. Needs `npm run build` first.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { loadNoticeInventory, isDraft } = require(join(repo, 'dist', 'platform', 'macos', 'install', 'notice-inventory.js'));
const { DEV_TOOL_FOLDERS } = require(join(repo, 'dist', 'platform', 'macos', 'install', 'dev-payload.js'));

const i = process.argv.indexOf('--tools');
const toolsRoot = i > 0 ? resolve(process.argv[i + 1]) : join(repo, 'toolchains', 'experimental');
// --bundle 1.1: the Toolchain 1.1 candidate (macos-arm64-1.1.inventory.json -> notices/macos-arm64-1.1). Default: 1.0, unchanged.
const bi = process.argv.indexOf('--bundle');
const bundle = bi > 0 ? process.argv[bi + 1] : '1.0';
const suffix = bundle === '1.0' ? '' : `-${bundle}`;
const dir = join(repo, 'toolchains', 'mixfpga', 'compliance');
const out = join(repo, 'toolchains', 'mixfpga', 'notices', `macos-arm64${suffix}`);
const inv = await loadNoticeInventory(join(dir, `macos-arm64${suffix}.inventory.json`));
const sha = (b) => createHash('sha256').update(b).digest('hex');

const UNIT_ROOT = { ghdl: DEV_TOOL_FOLDERS.ghdl, yosys: DEV_TOOL_FOLDERS.yosys, openfpgaloader: DEV_TOOL_FOLDERS.openfpgaloader, lima: DEV_TOOL_FOLDERS.lima };
async function resolveText(from) {
  const [kind, rest] = [from.slice(0, from.indexOf(':')), from.slice(from.indexOf(':') + 1)];
  if (kind === 'repo') return readFile(join(repo, rest));
  if (kind === 'payload') {
    const [unit, ...p] = rest.split('/');
    return readFile(join(toolsRoot, UNIT_ROOT[unit], ...p));
  }
  if (kind === 'extract') {
    const [path, range] = rest.split('#');
    const [unit, ...p] = path.split('/');
    const [a, b] = range.split('-').map(Number);
    const lines = (await readFile(join(toolsRoot, UNIT_ROOT[unit], ...p), 'latin1')).split('\n').slice(a - 1, b);
    return Buffer.from(`${lines.join('\n')}\n`, 'latin1');
  }
  throw new Error(`unknown licence source ${from}`);
}

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'LICENSES'), { recursive: true });
const written = new Map();
const goDoc = JSON.parse(await readFile(join(dir, 'go-licenses.json'), 'utf8'));
const goTexts = [
  ...goDoc.modules.flatMap((m) => m.files.map((f) => ({ dest: `lima-go/${m.module}@${m.version}/${f.name}`, from: `repo:toolchains/mixfpga/compliance/go-licenses/${m.module}@${m.version}/${f.name}` }))),
  ...goDoc.stdlib.files.map((f) => ({ dest: `lima-go/_stdlib@${goDoc.stdlib.version}/${f.name}`, from: `repo:toolchains/mixfpga/compliance/go-licenses/${goDoc.stdlib.dir}/${f.name}` })),
];
for (const c of inv.components) {
  for (const t of [...c.licenseTexts, ...(c.licenseCollection ? goTexts : [])]) {
    const bytes = await resolveText(t.from);
    const prev = written.get(t.dest);
    if (prev) {
      if (!prev.bytes.equals(bytes)) throw new Error(`${t.dest} is listed twice with different content`);
      continue;
    }
    written.set(t.dest, { bytes, from: t.from, by: [c.id] });
    await mkdir(dirname(join(out, 'LICENSES', t.dest)), { recursive: true });
    await writeFile(join(out, 'LICENSES', t.dest), bytes);
  }
}

const draft = isDraft(inv);
const L = [];
const rule = '='.repeat(78);
if (draft) L.push(rule, 'DRAFT - NOT FOR REDISTRIBUTION', inv.statusReason, rule, '');
else if (inv.status === 'CANDIDATE') L.push(rule, 'CANDIDATE - COUNSEL REVIEW PENDING (not final)', inv.statusReason, rule, '');
L.push(`MIX-FPGA Toolchain ${inv.toolchainVersion} for macOS (Apple silicon): third-party notices`, '');
L.push('MIX-FPGA Toolchain is an aggregation of separate programs and data. Each part is under its own licence,', 'listed below; the licence texts are in the LICENSES folder next to this file, unchanged from their sources.', 'MIX-FPGA\'s own code (Apache-2.0) covers only the MIX-FPGA-authored parts (the engine scripts in engine/).', '');
L.push('Not part of this toolchain and not redistributed by MIX-FPGA (section 3): Altera Quartus Prime Lite and the MAX 10 package,', 'Apple Rosetta and macOS, Ubuntu. They belong to their owners and are used under the student\'s own acceptance of their licences.', '');
if (inv.modifications?.length) {
  L.push('CHANGES MADE BY MIX-FPGA TO UPSTREAM CONTENT', '', 'MIX-FPGA patches and rebuilds no third-party program. The only changes to the official release content are:', '');
  for (const m of inv.modifications) L.push(`  - ${m}`);
  L.push('');
}
L.push('1. COMPONENTS WE REDISTRIBUTE', '');
const units = ['ghdl', 'yosys', 'openfpgaloader', 'lima', 'engine'];
const unitName = { ghdl: 'ghdl/', yosys: 'yosys/', openfpgaloader: 'openfpgaloader/', lima: 'lima/', engine: 'engine/' };
for (const u of units) {
  L.push(`--- ${unitName[u]} ---`, '');
  for (const c of inv.components.filter((x) => x.unit === u)) {
    L.push(`${c.name} ${c.version}`);
    L.push(`  licence:    ${c.license}`);
    if (c.election) L.push(`  election:   ${c.election}`);
    if (c.embeddedIn) L.push(`  compiled into: ${c.embeddedIn.join(', ')}`);
    if (c.claims?.length) L.push(`  files:      ${c.claims.join(', ')}`);
    if (c.usage) L.push(`  use:        ${c.usage}`);
    if (c.licenseTexts.length) L.push(`  texts:      ${c.licenseTexts.map((t) => `LICENSES/${t.dest}`).join(', ')}`);
    L.push(`  source:     ${c.obligation.source}${c.obligation.note ? ` - ${c.obligation.note}` : ''}`);
    for (const s of c.sources) L.push(`    - ${s.id}${s.url ? `  ${s.url}` : ''}${s.revision ? `  @${s.revision}` : ''}${s.sha256 ? `  sha256 ${s.sha256}` : ''}`);
    L.push(`  status:     ${c.status}${c.flags.length ? `   open questions: ${c.flags.join(' ')}` : ''}`);
    for (const o of c.openItems ?? []) L.push(`  OPEN:       ${o}`);
    L.push('');
  }
}
L.push('2. LICENCE TEXTS (sha256 of the shipped file; Go module texts are listed in appendix A and in go-licenses.json)', '');
for (const [dest, w] of [...written.entries()].sort().filter(([d]) => !d.startsWith('lima-go/'))) L.push(`  LICENSES/${dest}  ${sha(w.bytes)}`);
L.push('', '3. NOT REDISTRIBUTED', '');
for (const n of inv.notRedistributed) L.push(`${n.name}`, `  owner: ${n.owner}`, `  ${n.treatment}`, '');
L.push('4. SOURCE CODE', '', `Status: ${inv.sourceOffer.status}`, '', bundle === '1.0' ? 'For a release, MIX-FPGA must provide (alongside the download or by written offer):' : 'The corresponding-source package contains, for this toolchain:');
for (const s of inv.sourceOffer.mustProvideForRelease) L.push(`  - ${s}`);
L.push('', `No source is required for: ${inv.sourceOffer.notRequired.join(' ')}`, '');
L.push('5. OPEN QUESTIONS', '');
for (const f of inv.legalFlags) {
  if (f.status === 'resolved') L.push(`${f.id} [resolved] ${f.title}`, `    RESOLUTION: ${f.resolution}`, '');
  else L.push(`${f.id} [${f.severity}] ${f.title}`, `    ${f.detail}`, '');
}
L.push(`APPENDIX A. GO MODULES COMPILED INTO LIMA (${goDoc.modules.length}) and the Go standard library`, '', goDoc.method, '');
L.push(`  Go standard library ${goDoc.stdlib.version}  ${goDoc.stdlib.license}  ${goDoc.stdlib.source}`);
for (const m of goDoc.modules) L.push(`  ${m.module} ${m.version}  ${m.license}  [${m.files.map((f) => f.name).join(', ')}]${m.sumVerified ? '' : '  HASH NOT VERIFIED'}`);
L.push('', 'Texts: LICENSES/lima-go/<module>@<version>/. Source URL of each module: https://proxy.golang.org/<module>/@v/<version>.zip', '');
await writeFile(join(out, 'THIRD_PARTY_NOTICES.txt'), L.join('\n'));
console.log(`${draft ? 'DRAFT' : inv.status === 'CANDIDATE' ? 'CANDIDATE' : 'FINAL'}: ${written.size} licence texts, ${inv.components.length} components, ${inv.legalFlags.length} open questions`);
