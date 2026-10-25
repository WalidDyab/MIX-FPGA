#!/usr/bin/env node
// Phase 5H: builds a REAL NexysVHDL 0.6.0 baseline for the upgrade acceptance, in an isolated root (never the developer's own profile):
//   <root>\ext         the real NexysVHDL 0.6.0 extension, installed by VS Code's own CLI from the released 0.6.0 VSIX
//   <root>\ud          a VS Code profile with the student's settings
//   <root>\Local       a private %LOCALAPPDATA% holding the NexysVHDL Toolchain 1.0 store (the real validated tree, `NexysVHDL\toolchains\win32-x64\1.0`)
//   <root>\ws          a project with its nexysvhdl.json and .nvproj, plus a student file with a recognisable name
//   <root>\baseline.json  hashes of everything that must still be there, byte for byte, after the upgrade
//
//   node scripts/validation/p5h-baseline-060.mjs <root> [--store <folder of an existing NexysVHDL Toolchain 1.0 install>] [--vsix <0.6.0 vsix>]
// Needs `npm run build` first (it uses the product's own tree hash).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const root = resolve(argv[0] ?? '');
if (!argv[0]) { console.error('usage: p5h-baseline-060.mjs <root>'); process.exit(2); }
const opt = (k, d) => (argv.includes(k) ? resolve(argv[argv.indexOf(k) + 1]) : d);
const vsix = opt('--vsix', 'D:\\WSClaude\\NexysVHDL\\.artifacts\\release\\NexysVHDL-0.6.0-win32-x64\\nexysvhdl-0.6.0-win32-x64.vsix');
const store = opt('--store', 'D:\\MFW\\upg\\Local\\NexysVHDL');
const project = opt('--project', 'D:\\MFW\\upg\\ws\\nexys-a7-counter');
const code = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');
const require = createRequire(import.meta.url);
const { inventoryDirectory } = require(join(repo, 'dist', 'core', 'toolchain', 'tar.js'));
const { formatNvproj } = require(join(repo, 'dist', 'core', 'project', 'nvproj.js'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tree = (dir) => Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => { const f = join(e.parentPath, e.name); return [f.slice(dir.length + 1).replaceAll('\\', '/'), sha(readFileSync(f))]; }));

for (const p of [vsix, store, project, code]) if (!existsSync(p)) { console.error(`missing ${p}`); process.exit(1); }
rmSync(root, { recursive: true, force: true });
for (const d of ['ext', 'ud\\User', 'Local', 'ws']) mkdirSync(join(root, d), { recursive: true });

// the real 0.6.0 extension, installed by VS Code itself
// (a .cmd file is started through cmd.exe, as Windows itself does)
const q = (a) => `"${a}"`;
const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${[q(code), '--user-data-dir', q(join(root, 'ud')), '--extensions-dir', q(join(root, 'ext')), '--install-extension', q(vsix), '--force'].join(' ')}"`], { encoding: 'utf8', windowsVerbatimArguments: true });
if (r.status !== 0) { console.error(`${r.stdout}${r.stderr}${r.error ?? ''}`); process.exit(1); }

// the Toolchain 1.0 store, verified before and after the copy
cpSync(store, join(root, 'Local', 'NexysVHDL'), { recursive: true });
const t1 = join(root, 'Local', 'NexysVHDL', 'toolchains', 'win32-x64', '1.0');
const inv = await inventoryDirectory(t1, { exclude: ['.nexysvhdl-installed.json'] });
if (inv.treeSha256 !== '57f0f0da89e6565d6e46d20780fa57af86f8ac36d45a78b750203fc8f381820b') { console.error(`the Toolchain 1.0 copy is not the validated tree (${inv.treeSha256})`); process.exit(1); }

// the student's settings (keys of the 0.6.0 extension) and project
writeFileSync(join(root, 'ud', 'User', 'settings.json'), JSON.stringify({ 'nexysvhdl.checkOnSave': false, 'nexysvhdl.detectBoardsOnOpen': false, 'nexysvhdl.promptForClassroomAppearance': false, 'editor.fontSize': 15 }, null, 2));
const proj = join(root, 'ws', 'nexys-a7-counter');
cpSync(project, proj, { recursive: true });
writeFileSync(join(proj, 'nexys-a7-counter.nvproj'), formatNvproj('nexysvhdl.json'));
writeFileSync(join(proj, 'notes-from-the-student.txt'), 'My own notes: do not lose me.\n');

const baseline = {
    extension: { folder: readdirSync(join(root, 'ext')).filter((n) => n.startsWith('emxplore.nexysvhdl-')), version: '0.6.0' },
    toolchain10: { files: inv.entries.length, treeSha256: inv.treeSha256 },
    project: tree(proj),
    settings: sha(readFileSync(join(root, 'ud', 'User', 'settings.json'))),
};
writeFileSync(join(root, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);
console.log(JSON.stringify({ extension: baseline.extension, toolchain10: baseline.toolchain10, projectFiles: Object.keys(baseline.project).length, settings: baseline.settings }, null, 1));
