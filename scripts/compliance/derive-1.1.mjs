#!/usr/bin/env node
// Derives the Toolchain 1.1 compliance manifest for macOS from the committed 1.0 manifest (Phase 5C):
//   toolchains/compliance/toolchain-1.0.json  ->  toolchains/compliance/toolchain-1.1.json
// The 1.0 file is never modified. Run after packing the Nexys 1.1 candidate (it reads requirement-1.1.json and the assembled
// toolchain manifest).  node scripts/compliance/derive-1.1.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => JSON.parse(readFileSync(join(repo, p), 'utf8'));
const m10 = read('toolchains/compliance/toolchain-1.0.json');
const d = JSON.parse(JSON.stringify(m10.targets['darwin-arm64']));
const req = read('toolchains/bundle/requirement-1.1.json').targets['darwin-arm64'];
const built = read('toolchain/darwin-arm64-1.1/toolchain-manifest.json');
const recipe = read('toolchains/bundle/darwin-arm64-1.1.json');

d.bundleVersion = '1.1';
d.recipe = 'toolchains/bundle/darwin-arm64-1.1.json';
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
d.licenseCorrections = [
    'Apio 1.7.0: GPL-3.0-or-later (Toolchain 1.0 notices said GPL-2.0; the bundled LICENSE is the GPLv3 text).',
    'Apio definitions 2026.09.17: GPL-3.0-only (Toolchain 1.0 notices said GPL-2.0).',
    'Graphviz in the oss-cad-suite is EPL-1.0: the EPL-2.0 text of Toolchain 1.0 is dropped; the EPL-1.0 text is the package\'s own license/LICENSE.graphviz.',
    'libwdi text dropped (Windows only).',
    'The licence texts of the bundled native libraries now ship inside the toolchain (licenses/compliance/).',
];
const out = {
    schemaVersion: 1,
    toolchainVersion: '1.1',
    status: 'CANDIDATE',
    statusReason: recipe.compliance.status,
    derivedFrom: 'toolchains/compliance/toolchain-1.0.json (darwin-arm64 target; the Windows target is not part of the 1.1 macOS candidate)',
    statement: m10.statement,
    licenseClasses: m10.licenseClasses,
    targets: { 'darwin-arm64': d },
    sources: m10.sources,
    unresolved: m10.unresolved.filter((u) => !u.platform || u.platform === 'darwin-arm64'),
    resolved: m10.resolved,
};
writeFileSync(join(repo, 'toolchains', 'compliance', 'toolchain-1.1.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`toolchain-1.1.json: ${d.components.length} components, ${d.nativeLibraryInventory.length} library groups, ${out.unresolved.length} unresolved`);
