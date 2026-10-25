#!/usr/bin/env node
// Phase 5H: after the upgrade, is everything of the NexysVHDL 0.6.0 baseline still there, byte for byte?
//   node scripts/validation/p5h-compare-baseline.mjs <root of p5h-baseline-060.mjs>
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = resolve(process.argv[2] ?? '');
const { inventoryDirectory } = createRequire(import.meta.url)(join(repo, 'dist', 'core', 'toolchain', 'tar.js'));
const base = JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8'));
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const proj = join(root, 'ws', 'nexys-a7-counter');
const now = {};
for (const e of readdirSync(proj, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const f = join(e.parentPath, e.name);
    now[f.slice(proj.length + 1).replaceAll('\\', '/')] = sha(f);
}
// generated output (.nexysvhdl/, .mix-fpga/) is not the student's
const own = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.split('/').some((p) => p.startsWith('.') && p !== '.nvproj')));
const t10 = await inventoryDirectory(join(root, 'Local', 'NexysVHDL', 'toolchains', 'win32-x64', '1.0'), { exclude: ['.nexysvhdl-installed.json'] });
const result = {
    projectIdentical: JSON.stringify(own(now)) === JSON.stringify(own(base.project)),
    projectFiles: Object.keys(own(base.project)).length,
    nvprojPresent: 'nexys-a7-counter.nvproj' in now,
    nexysvhdlJsonPresent: 'nexysvhdl.json' in now,
    studentNotesPresent: 'notes-from-the-student.txt' in now,
    settingsIdentical: sha(join(root, 'ud', 'User', 'settings.json')) === base.settings,
    toolchain10Untouched: t10.treeSha256 === base.toolchain10.treeSha256 && t10.entries.length === base.toolchain10.files,
    toolchain10: { files: t10.entries.length, treeSha256: t10.treeSha256 },
};
console.log(JSON.stringify(result, null, 1));
process.exit(Object.entries(result).every(([k, v]) => typeof v !== 'boolean' || v) ? 0 : 1);
