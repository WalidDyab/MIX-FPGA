#!/usr/bin/env node
// Builds the two corresponding-source packages of Toolchain 1.1 for Windows (Phase 5H), one per support archive:
//
//   MIX-FPGA-Nexys-A7-Support-1.1-Windows-x64-Sources.zip      for nexysvhdl-toolchain-1.1-win32-x64.tar.gz
//   MIX-FPGA-DE10-Lite-Support-1.1-Windows-x64-Sources.zip     for mixfpga-de10-lite-support-1.1-windows-x64.tar.gz
//
//   node scripts/compliance/assemble-1.1-windows.mjs [--store <NexysVHDL-Toolchain-1.0-Sources.zip>] [--out <dir>]
//
// The third-party sources are the verified archives of the Toolchain 1.0 source package (its manifest and
// toolchains/compliance/sources-1.0.lock.json pin each file by SHA-256; MIX-FPGA modifies no third-party source, so the sources of the 1.1
// binaries are the same revisions). Each package holds: the sources, the licence texts and notices of its archive, the MIX-FPGA build
// recipe and the one MIX-FPGA tool that changes upstream content (the GHDL library prune), a binary-to-source mapping, the Readline
// footprint evidence, and a SHA-256 manifest. Reproducible: sorted stored entries with fixed timestamps (scripts/compliance/zip.mjs).
// Needs the Toolchain 1.1 archives built first (scripts/toolchain/assemble.mjs + pack.mjs, scripts/mixfpga/assemble-windows-1.1.mjs).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { listFiles, parseArgs, REPO_ROOT, sha256File } from '../toolchain/lib.mjs';
import { writeZip } from './zip.mjs';

const args = parseArgs(process.argv.slice(2));
const WORK = join(REPO_ROOT, '.artifacts', 'sources-1.1-win');
const OUT = args.out ? join(REPO_ROOT, args.out) : join(REPO_ROOT, '.artifacts', 'windows-1.1', 'sources');
const STORE_ZIP = args.store ?? 'D:\\WSClaude\\NexysVHDL\\.artifacts\\compliance\\NexysVHDL-Toolchain-1.0-Sources.zip';
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- inputs
const store = join(WORK, 'store');
if (!existsSync(join(store, 'manifest.json'))) {
    if (!existsSync(STORE_ZIP)) die(`source store ${STORE_ZIP} not found (pass --store)`);
    const want = readFileSync(`${STORE_ZIP}.sha256`, 'utf8').trim().split(/\s+/)[0];
    if ((await sha256File(STORE_ZIP)) !== want) die('the source store does not match its recorded SHA-256');
    mkdirSync(store, { recursive: true });
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const r = spawnSync(tar, ['-xf', STORE_ZIP, '-C', store], { stdio: 'inherit' });
    if (r.status !== 0) die('extracting the source store failed');
}
const storeManifest = read(join(store, 'manifest.json'));
const archives = storeManifest.sourcePackage.archives; // id -> [{path, commit, file, sha256, size}]
const lock = read(join(REPO_ROOT, 'toolchains', 'compliance', 'sources-1.0.lock.json')).sources;
const sourceInfo = Object.fromEntries(storeManifest.sources.map((s) => [s.id, s]));

async function verifyStore(ids) {
    for (const id of ids) {
        const entries = archives[id];
        if (!entries?.length) die(`source ${id} is not in the store`);
        for (const e of entries) {
            const file = join(store, e.file);
            const locked = (lock[id] ?? []).find((x) => x.file === e.file);
            if (!locked || locked.sha256 !== e.sha256) die(`${id}: ${e.file} is not pinned by sources-1.0.lock.json`);
            if (statSync(file).size !== e.size || (await sha256File(file)) !== e.sha256) die(`${id}: ${e.file} does not match its recorded SHA-256`);
        }
    }
}

const winCompliance = read(join(REPO_ROOT, 'toolchains', 'compliance', 'toolchain-1.1-windows.json')).targets['win32-x64'];
const nexysTree = join(REPO_ROOT, 'toolchain', 'win32-x64-1.1');
const nexysManifestFile = join(nexysTree, 'toolchain-manifest.json');
const nexysManifest = read(nexysManifestFile);
const de10Inventory = read(join(REPO_ROOT, 'toolchains', 'mixfpga', 'compliance', 'windows-x64-1.1.inventory.json'));
const de10Manifest = read(join(REPO_ROOT, 'toolchains', 'mixfpga', 'toolchain-1.1-windows-x64.json'));
const pins = read(join(REPO_ROOT, 'toolchains', 'mixfpga', 'payloads-1.1-windows-x64.json')).payloads;
const requirement = read(join(REPO_ROOT, 'toolchains', 'bundle', 'requirement-1.1.json')).targets['win32-x64'];
const footprint = read(join(REPO_ROOT, 'toolchains', 'compliance', 'windows-1.1-readline-footprint.json'));

// ---------------------------------------------------------------- which sources belong to which archive
const winText = JSON.stringify(winCompliance);
const nexysIds = storeManifest.sources
    .map((s) => s.id)
    .filter((id) => winText.includes(JSON.stringify(id)))
    .filter((id) => !(sourceInfo[id].platforms && !sourceInfo[id].platforms.includes('win32-x64')));
const de10Ids = [...new Set(de10Inventory.components.flatMap((c) => c.sources.map((s) => s.id)).filter((id) => archives[id]).concat(['yosyshq-oss-cad-suite-build-2026-03-24']))].sort();
await verifyStore([...new Set([...nexysIds, ...de10Ids])]);

// ---------------------------------------------------------------- package builder
async function build(spec) {
    const stage = join(WORK, 'stage', spec.name);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(join(stage, 'sources'), { recursive: true });
    const put = (rel, data) => { mkdirSync(join(stage, rel, '..'), { recursive: true }); writeFileSync(join(stage, rel), data); };
    const copyTree = (from, rel) => cpSync(from, join(stage, rel), { recursive: true, verbatimSymlinks: true });

    const sourceRows = [];
    for (const id of spec.sourceIds) {
        for (const e of archives[id]) {
            cpSync(join(store, e.file), join(stage, e.file));
            sourceRows.push({ id, upstream: sourceInfo[id]?.url, revision: e.commit ?? sourceInfo[id]?.revision, path: e.path, file: e.file, sha256: e.sha256, size: e.size, license: sourceInfo[id]?.license });
        }
    }
    copyTree(spec.licenses, 'licenses');
    put('THIRD_PARTY_NOTICES' + spec.noticesExt, readFileSync(spec.notices));
    for (const [rel, from] of Object.entries(spec.buildFiles)) { mkdirSync(join(stage, rel, '..'), { recursive: true }); cpSync(from, join(stage, rel)); }
    put('mix-fpga/LICENSE', readFileSync(join(REPO_ROOT, 'LICENSE')));
    put('mix-fpga/NOTICE', readFileSync(join(REPO_ROOT, 'NOTICE')));
    put('patches/README.md', `# Modifications made by MIX-FPGA\n\nMIX-FPGA modifies no third-party source code, patches nothing and rebuilds no third-party program: the binaries are the official upstream releases. The only changes to upstream content are the omissions and regenerations that ${spec.name.replace('-Sources', '')} lists in its notices (\`THIRD_PARTY_NOTICES\`) and in \`binary-to-source.json\` under "modifications"; the tool that applies them is \`mix-fpga-build/ghdl-prune.mjs\`, with the recipe in \`mix-fpga-build/\`.\n`);
    put('binary-to-source.json', `${JSON.stringify(spec.mapping(sourceRows), null, 1)}\n`);
    put('README.md', spec.readme(sourceRows));

    const files = [];
    for (const f of await listFiles(stage)) files.push({ path: f, sha256: await sha256File(join(stage, f)), size: statSync(join(stage, f)).size });
    put('manifest.json', `${JSON.stringify({ schemaVersion: 1, package: spec.name, forArchive: spec.archive, generatedBy: 'scripts/compliance/assemble-1.1-windows.mjs', sources: sourceRows, files }, null, 1)}\n`);

    mkdirSync(OUT, { recursive: true });
    const zip = join(OUT, `${spec.name}.zip`);
    const count = await writeZip(stage, zip);
    const zsha = await sha256File(zip);
    writeFileSync(`${zip}.sha256`, `${zsha}  ${spec.name}.zip\n`);
    console.log(`${spec.name}.zip: ${count} files, ${(statSync(zip).size / 2 ** 20).toFixed(1)} MiB, ${sourceRows.length} source archives, sha256 ${zsha}`);
}

const common = (t) => `Corresponding source of ${t.archive.file}\n\nThis package accompanies the binary archive named above, at the same place and time. It holds the exact upstream sources of every component whose licence requires source (GNU GPL, GNU LGPL, MPL, EPL, EUPL), the licence texts and notices of the archive, the MIX-FPGA build recipe, a mapping from every binary to its source (\`binary-to-source.json\`), the evidence of which programs load GNU Readline (\`mix-fpga-build/readline-footprint.json\`) and a SHA-256 manifest of every file (\`manifest.json\`). To check a file: \`certutil -hashfile <file> SHA256\` (or \`Get-FileHash <file>\` in PowerShell) and compare with \`manifest.json\`.\n\nMIX-FPGA is the project of Walid Dyab (an EMXplore project); its own code is Apache-2.0 (\`mix-fpga/LICENSE\`), which does not apply to the third-party components.\n\nReplacing components: see "Your right to modify and replace components" in \`THIRD_PARTY_NOTICES\`. The licence conclusions in the notices are the project's technical review, not a legal opinion. There is no written offer: this package is the source offer, distributed at the same place and time as the binary archive.\n`;

// Which source archives each Readline-linked / copyleft program of the Nexys archive was built from (file hashes are of the shipped files).
async function copyleftMap(treeRoot, prefix, rows) {
    const out = [];
    for (const r of rows) {
        const f = join(treeRoot, ...`${prefix}${r.file}`.split('/'));
        out.push({ file: `${prefix}${r.file}`, sha256: existsSync(f) ? await sha256File(f) : undefined, licence: r.licence, sources: r.sources.map((id) => ({ id, files: (archives[id] ?? []).map((a) => a.file) })), ...(r.note ? { note: r.note } : {}) });
    }
    return out;
}
const YOSYS = ['oss-yosys', 'fedora-srpm-mingw-readline-8.2-3.fc39', 'fedora-srpm-mingw-termcap-1.3.1-34.fc39', 'yosyshq-oss-cad-suite-build-2026-03-24'];
const RL = 'Imports libreadline8.dll (GPL-3.0-or-later, which imports libtermcap-0.dll, GPL-2.0-or-later); distributed with them under GPL version 3.';
const ICARUS = ['oss-iverilog', 'fedora-srpm-mingw-readline-8.2-3.fc39', 'fedora-srpm-mingw-termcap-1.3.1-34.fc39', 'yosyshq-oss-cad-suite-build-2026-03-24'];
const nexysPrograms = await copyleftMap(nexysTree, 'apio/packages/oss-cad-suite/', [
    { file: 'bin/yosys.exe', licence: 'ISC (+ GPLv3 as combined with Readline)', sources: YOSYS, note: RL },
    { file: 'bin/vvp.exe', licence: 'GPL-2.0-or-later (distributed with Readline under GPL version 3)', sources: ICARUS, note: `Icarus Verilog 14.0 at revision 6767a079560f4528f4beeae82fb33361eb4bc92a; the recipe applies a local revert of 964878382d3f (Makefile.in only), which explains the version string s20251012-140-gf5a178d47-dirty. ${RL}` },
    { file: 'bin/yosys-abc.exe', licence: 'Berkeley (ABC)', sources: ['oss-yosys', 'yosyshq-oss-cad-suite-build-2026-03-24'], note: 'Does not import Readline (import table); ABC source is the oss-yosys--abc.tar.gz submodule archive.' },
    { file: 'bin/yosys-filterlib.exe', licence: 'ISC', sources: YOSYS, note: 'Does not import Readline (import table).' },
    { file: 'lib/libreadline8.dll', licence: 'GPL-3.0-or-later', sources: ['fedora-srpm-mingw-readline-8.2-3.fc39'], note: 'GNU Readline 8.2 as built by Fedora (mingw64-readline 8.2-3.fc39); imports libtermcap-0.dll.' },
    { file: 'lib/libhistory8.dll', licence: 'GPL-3.0-or-later', sources: ['fedora-srpm-mingw-readline-8.2-3.fc39'], note: 'GNU Readline\'s history library from the same package; no program imports it.' },
    { file: 'lib/libtermcap-0.dll', licence: 'GPL-2.0-or-later', sources: ['fedora-srpm-mingw-termcap-1.3.1-34.fc39'], note: 'GNU termcap 1.3.1 as built by Fedora (mingw64-termcap 1.3.1-34.fc39).' },
]);
const nexysArchive = { file: pins['nexys-a7-100t'].file, sha256: pins['nexys-a7-100t'].sha256, bytes: pins['nexys-a7-100t'].bytes, treeSha256: requirement.treeSha256 };
await build({
    name: 'MIX-FPGA-Nexys-A7-Support-1.1-Windows-x64-Sources',
    archive: nexysArchive,
    sourceIds: nexysIds,
    licenses: join(nexysTree, 'licenses'),
    notices: join(nexysTree, 'THIRD_PARTY_NOTICES.md'),
    noticesExt: '.md',
    buildFiles: {
        'mix-fpga-build/win32-x64-1.1.json': join(REPO_ROOT, 'toolchains', 'bundle', 'win32-x64-1.1.json'),
        'mix-fpga-build/ghdl-prune.mjs': join(REPO_ROOT, 'scripts', 'toolchain', 'ghdl-prune.mjs'),
        'mix-fpga-build/assemble.mjs': join(REPO_ROOT, 'scripts', 'toolchain', 'assemble.mjs'),
        'mix-fpga-build/lib.mjs': join(REPO_ROOT, 'scripts', 'toolchain', 'lib.mjs'),
        'mix-fpga-build/notices.mjs': join(REPO_ROOT, 'scripts', 'toolchain', 'notices.mjs'),
        'mix-fpga-build/pack.mjs': join(REPO_ROOT, 'scripts', 'toolchain', 'pack.mjs'),
        'mix-fpga-build/toolchain-manifest.json': nexysManifestFile,
        'mix-fpga-build/compliance-toolchain-1.0.json': join(REPO_ROOT, 'toolchains', 'compliance', 'toolchain-1.0.json'),
        'mix-fpga-build/compliance-toolchain-1.1-windows.json': join(REPO_ROOT, 'toolchains', 'compliance', 'toolchain-1.1-windows.json'),
        'mix-fpga-build/readline-footprint.json': join(REPO_ROOT, 'toolchains', 'compliance', 'windows-1.1-readline-footprint.json'),
        'mix-fpga-build/readline-footprint.mjs': join(REPO_ROOT, 'scripts', 'compliance', 'readline-footprint.mjs'),
        'mix-fpga-build/pe-imports.mjs': join(REPO_ROOT, 'scripts', 'compliance', 'pe-imports.mjs'),
        'mix-fpga-build/phase5h-windows-compliance.md': join(REPO_ROOT, 'docs', 'phase5h-windows-compliance.md'),
        'mix-fpga-build/yosys-rebuild-evidence.md': join(REPO_ROOT, 'docs', 'phase5c-l4-yosys-rebuild.md'),
    },
    mapping: (rows) => ({
        schemaVersion: 1,
        archive: { ...nexysArchive, files: requirement.files },
        note: 'Components, tools and libraries are those of the reviewed Windows Toolchain 1.0 (toolchains/compliance/toolchain-1.0.json, win32-x64) as recorded in toolchains/compliance/toolchain-1.1-windows.json; the 1.1 archive differs only by the modifications below, the licence texts added under licenses/compliance/ and the final notices.',
        modifications: nexysManifest.modifications,
        readlineFootprint: footprint,
        copyleftPrograms: nexysPrograms,
        components: winCompliance.components.map((c) => ({ id: c.id, name: c.name, version: c.version, path: c.path, license: c.license, binaryArchive: c.binaryArchive, upstreamSource: c.upstreamSource })),
        ossCadSuiteTools: winCompliance.ossCadSuiteTools.map((t) => ({ tool: t.name, licenses: t.licenses, sourceRequired: t.sourceRequired, sources: t.sources })),
        nativeLibraries: winCompliance.nativeLibraryInventory.map((e) => ({ id: e.id, version: e.version, files: e.files, licenses: e.licenses, usageClass: e.usage?.class, linking: e.linking, sources: (e.sources ?? []).map((id) => ({ id, files: archives[id]?.map((a) => a.file) ?? [] })) })),
        sourceArchives: rows.map((r) => ({ id: r.id, file: r.file, sha256: r.sha256 })),
    }),
    readme: (rows) => `# MIX-FPGA Nexys A7 support 1.1 (Windows x64): corresponding source\n\n${common({ archive: nexysArchive })}\nArchive SHA-256 \`${nexysArchive.sha256}\`, content (tree) hash \`${requirement.treeSha256}\`, ${requirement.files} files.\n\n## What is in \`sources/\` (${rows.length} archives)\n\nOne file per pinned source: git sources are \`git archive\` of the exact commit (submodules at the commits recorded by the parent tree); source packages (Fedora \`.src.rpm\`) and release archives are the upstream files, identified by hash. \`manifest.json\` lists each with its upstream repository, revision and SHA-256.\n\n## Changes made by MIX-FPGA\n\n${nexysManifest.modifications.map((m) => `- ${m.component}: ${m.reason} (${m.removedFiles} files removed)`).join('\n')}\n`,
});

const de10Pin = pins['de10-lite'];
const de10Programs = await copyleftMap(join(REPO_ROOT, '.artifacts', 'tools-1.1-windows', 'yosys-0.63'), '', [
    { file: 'bin/yosys.exe', licence: 'ISC (+ GPLv3 as combined with Readline)', sources: YOSYS, note: RL },
    { file: 'bin/libreadline8.dll', licence: 'GPL-3.0-or-later', sources: ['fedora-srpm-mingw-readline-8.2-3.fc39'], note: 'GNU Readline 8.2 (mingw64-readline 8.2-3.fc39); byte-identical to the file of the Nexys A7 archive.' },
    { file: 'bin/libtermcap-0.dll', licence: 'GPL-2.0-or-later', sources: ['fedora-srpm-mingw-termcap-1.3.1-34.fc39'], note: 'GNU termcap 1.3.1 (mingw64-termcap 1.3.1-34.fc39); byte-identical to the file of the Nexys A7 archive.' },
]);
const de10Archive = { file: de10Pin.file, sha256: de10Pin.sha256, bytes: de10Pin.bytes, manifestSha256: sha(readFileSync(join(REPO_ROOT, 'toolchains', 'mixfpga', 'toolchain-1.1-windows-x64.json'))) };
await build({
    name: 'MIX-FPGA-DE10-Lite-Support-1.1-Windows-x64-Sources',
    archive: de10Archive,
    sourceIds: de10Ids,
    licenses: join(REPO_ROOT, 'toolchains', 'mixfpga', 'notices', 'windows-x64-1.1', 'LICENSES'),
    notices: join(REPO_ROOT, 'toolchains', 'mixfpga', 'notices', 'windows-x64-1.1', 'THIRD_PARTY_NOTICES.txt'),
    noticesExt: '.txt',
    buildFiles: {
        'mix-fpga-build/toolchain-1.1-windows-x64.json': join(REPO_ROOT, 'toolchains', 'mixfpga', 'toolchain-1.1-windows-x64.json'),
        'mix-fpga-build/windows-x64-1.1.inventory.json': join(REPO_ROOT, 'toolchains', 'mixfpga', 'compliance', 'windows-x64-1.1.inventory.json'),
        'mix-fpga-build/ghdl-prune.mjs': join(REPO_ROOT, 'scripts', 'toolchain', 'ghdl-prune.mjs'),
        'mix-fpga-build/assemble-windows-1.1.mjs': join(REPO_ROOT, 'scripts', 'mixfpga', 'assemble-windows-1.1.mjs'),
        'mix-fpga-build/assemble-windows.mjs': join(REPO_ROOT, 'scripts', 'mixfpga', 'assemble-windows.mjs'),
        'mix-fpga-build/readline-footprint.json': join(REPO_ROOT, 'toolchains', 'compliance', 'windows-1.1-readline-footprint.json'),
        'mix-fpga-build/phase5h-windows-compliance.md': join(REPO_ROOT, 'docs', 'phase5h-windows-compliance.md'),
        'mix-fpga-build/yosys-rebuild-evidence.md': join(REPO_ROOT, 'docs', 'phase5c-l4-yosys-rebuild.md'),
    },
    mapping: (rows) => ({
        schemaVersion: 1,
        archive: de10Archive,
        modifications: de10Inventory.modifications,
        readlineFootprint: footprint,
        copyleftPrograms: de10Programs,
        note: 'Per component: the shipped files (claims) and the source archives they were built from. Permissive components (libffi, Tcl, zlib, winpthreads, the IEEE 2008 packages) need no source; the GCC runtime libraries are covered by the GCC Runtime Library Exception.',
        components: de10Inventory.components.map((c) => ({ id: c.id, unit: c.unit, name: c.name, version: c.version, license: c.license, files: c.claims, sourceObligation: c.obligation?.source, sources: c.sources.map((s) => ({ ...s, archives: (archives[s.id] ?? []).map((a) => ({ file: a.file, sha256: a.sha256 })) })) })),
        sourceArchives: rows.map((r) => ({ id: r.id, file: r.file, sha256: r.sha256 })),
    }),
    readme: (rows) => `# MIX-FPGA DE10-Lite support 1.1 (Windows x64): corresponding source\n\n${common({ archive: de10Archive })}\nArchive SHA-256 \`${de10Pin.sha256}\`, ${de10Pin.bytes} bytes.\n\n## What is in \`sources/\` (${rows.length} archives)\n\n- GHDL 6.0.0 (with its libraries and scripts)\n- Yosys at the pinned commit with its \`abc\` and \`cxxopts\` submodules, and the YosysHQ build recipe (oss-cad-suite-build)\n- the Fedora source packages of mingw64-readline 8.2-3.fc39 (GNU Readline) and mingw64-termcap 1.3.1-34.fc39 (GNU termcap), so the GPL libraries can be rebuilt and replaced\n\nNot included because their licences require no source: libffi, Tcl, zlib, winpthreads, the IEEE 2008 packages; the GCC runtime libraries are covered by the GCC Runtime Library Exception. \`binary-to-source.json\` records the provenance of each.\n\n## Changes made by MIX-FPGA\n\n${de10Inventory.modifications.map((m) => `- ${m}`).join('\n')}\n`,
});
void relative;
void de10Manifest;
