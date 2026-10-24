#!/usr/bin/env node
// Derives the Toolchain 1.1 compliance manifest for Windows from the committed 1.0 manifest (Phase 5H):
//   toolchains/compliance/toolchain-1.0.json (target win32-x64)  ->  toolchains/compliance/toolchain-1.1-windows.json
// The 1.0 file and the macOS 1.1 file are never modified. Run after packing the Windows Nexys 1.1 archive (it reads
// requirement-1.1.json and the assembled toolchain manifest).  node scripts/compliance/derive-1.1-windows.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => JSON.parse(readFileSync(join(repo, p), 'utf8'));
const m10 = read('toolchains/compliance/toolchain-1.0.json');
const d = JSON.parse(JSON.stringify(m10.targets['win32-x64']));
const req = read('toolchains/bundle/requirement-1.1.json').targets['win32-x64'];
const built = read('toolchain/win32-x64-1.1/toolchain-manifest.json');
const recipe = read('toolchains/bundle/win32-x64-1.1.json');
const pe = read('toolchains/compliance/windows-1.1-readline-footprint.json');

d.bundleVersion = '1.1';
d.recipe = 'toolchains/bundle/win32-x64-1.1.json';
d.payload = { treeSha256: req.treeSha256, files: req.files, bytes: req.bytes, archive: req.archive };
d.modifications = built.modifications;
for (const c of d.components) {
    const r = recipe.components.find((x) => x.id === c.id);
    if (!r) continue;
    c.licenseAsRecorded = r.license;
    c.licenseEvidence = r.licenseEvidence;
    c.licenseFiles = r.licenseFiles;
}
for (const c of d.components) if (['ghdl', 'apio-oss-cad-suite'].includes(c.id)) c.modifications = built.modifications.filter((x) => x.component === c.id);
const tool = (name) => d.ossCadSuiteTools.find((t) => t.name === name) ?? (() => { throw new Error(`no tool ${name}`); })();
tool('iverilog').licenses = ['GPL-2.0-or-later'];
tool('iverilog').licenseNote = 'Phase 5D/5H: the file headers of the pinned source (oss-iverilog.tar.gz, revision 6767a079) grant "either version 2 of the License, or (at your option) any later version"; vvp.exe loads GNU Readline (GPLv3) and is distributed with it under GPL version 3. The Windows build reports s20251012-140-gf5a178d47-dirty (a local revert commit made by the YosysHQ recipe; the macOS build of the same recipe reports another hash).';
for (const n of ['yosys']) {
    const t = d.ossCadSuiteTools.find((x) => x.name === n);
    if (t) { t.sourceRequired = true; t.licenseNote = 'Loads GNU Readline 8.2 (GPL-3.0-or-later, which loads GPL-2.0-or-later termcap); distributed with it under GPL version 3 (the source is in the source package).'; }
}
// What the PE import tables of every Windows program and library of the toolchain say about Readline.
d.readlineFootprint = pe;
const sources = m10.sources.map((s) => (s.id === 'oss-iverilog' ? { ...s, license: 'GPL-2.0-or-later' } : s));
d.licenseCorrections = [
    'Icarus Verilog (oss-iverilog, revision 6767a079): GPL-2.0-or-later (Toolchain 1.0 recorded GPL-2.0; the file headers of the pinned source grant any later version).',
    'GNU termcap 1.3.1 (libtermcap-0.dll, mingw64-termcap 1.3.1-34.fc39) is GPL-2.0-or-later; the Windows Toolchain 1.0 DE10-Lite notices called it "MIT-style".',
    'The licence texts the Windows Toolchain 1.0 DE10-Lite notices marked MISSING (libffi, termcap, libwinpthread) are shipped now.',
    'The licence texts of the bundled native libraries now ship inside the toolchain (licenses/compliance/).',
];
const out = {
    schemaVersion: 1,
    toolchainVersion: '1.1',
    status: 'FINAL',
    statusReason: 'Toolchain 1.1 for Windows: final redistribution inventory (Phase 5H). The technical review is complete (Readline footprint, source delivery, modification rights); this is not a legal opinion.',
    derivedFrom: 'toolchains/compliance/toolchain-1.0.json (win32-x64 target; the macOS 1.1 inventory toolchain-1.1.json is a separate file and is not changed)',
    statement: m10.statement,
    licenseClasses: m10.licenseClasses,
    targets: { 'win32-x64': d },
    sources,
    unresolved: m10.unresolved.filter((u) => !u.platform || /win32/.test(u.platform)),
    resolved: m10.resolved,
};
writeFileSync(join(repo, 'toolchains', 'compliance', 'toolchain-1.1-windows.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`toolchain-1.1-windows.json: ${d.components.length} components, ${d.nativeLibraryInventory.length} library groups, ${out.unresolved.length} unresolved`);
