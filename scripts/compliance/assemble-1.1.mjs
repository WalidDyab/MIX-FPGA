#!/usr/bin/env node
// Builds the two corresponding-source packages of Toolchain 1.1 (macOS), Phase 5C, one per support archive:
//
//   MIX-FPGA-Nexys-A7-Support-1.1-Sources.zip      for nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz
//   MIX-FPGA-DE10-Lite-Support-1.1-Sources.zip     for mixfpga-de10-lite-support-1.1-macos-arm64.tar.gz
//
//   node scripts/compliance/assemble-1.1.mjs [--store <NexysVHDL-Toolchain-1.0-Sources.zip>] [--out <dir>]
//
// The third-party sources are the verified archives of the Toolchain 1.0 source package (its manifest and
// toolchains/compliance/sources-1.0.lock.json pin each file by SHA-256; MIX-FPGA modifies no third-party source, so the sources of the 1.1
// binaries are the same revisions), plus the exact Go module archive of the one MPL-2.0 module compiled into Lima, which is
// fetched once into .artifacts/sources-1.1/extra and checked against the hash recorded in go-licenses.json. Each package
// holds: the sources, the licence texts and notices of its archive, the MIX-FPGA build recipe and the one MIX-FPGA tool that
// changes upstream content (the GHDL library prune), a binary-to-source mapping, and a SHA-256 manifest. Reproducible: sorted
// stored entries with fixed timestamps (scripts/compliance/zip.mjs). Needs the Toolchain 1.1 candidates built first.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { listFiles, parseArgs, REPO_ROOT, sha256File } from '../toolchain/lib.mjs';
import { writeZip } from './zip.mjs';

const args = parseArgs(process.argv.slice(2));
const WORK = join(REPO_ROOT, '.artifacts', 'sources-1.1');
const OUT = args.out ? join(REPO_ROOT, args.out) : join(REPO_ROOT, '.artifacts', 'candidates-1.1', 'sources');
const STORE_ZIP = args.store ?? join(homedir(), 'WSClaude', 'NexysVHDL-repo', '.artifacts', 'compliance', 'NexysVHDL-Toolchain-1.0-Sources.zip');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- inputs
const store = join(WORK, 'store');
if (!existsSync(join(store, 'manifest.json'))) {
    if (!existsSync(STORE_ZIP)) die(`source store ${STORE_ZIP} not found (pass --store)`);
    mkdirSync(store, { recursive: true });
    const r = spawnSync('/usr/bin/unzip', ['-q', '-o', STORE_ZIP, '-d', store], { stdio: 'inherit' });
    if (r.status !== 0) die('unzip of the source store failed');
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

const nexysCompliance = read(join(REPO_ROOT, 'toolchains', 'compliance', 'toolchain-1.0.json')).targets['darwin-arm64'];
const nexysManifestFile = join(REPO_ROOT, 'toolchain', 'darwin-arm64-1.1', 'toolchain-manifest.json');
const nexysTree = join(REPO_ROOT, 'toolchain', 'darwin-arm64-1.1');
const de10Inventory = read(join(REPO_ROOT, 'toolchains', 'mixfpga', 'compliance', 'macos-arm64-1.1.inventory.json'));
const de10Manifest = read(join(REPO_ROOT, 'toolchains', 'mixfpga', 'toolchain-1.1-macos-arm64.json'));
const pins = read(join(REPO_ROOT, 'toolchains', 'mixfpga', 'payloads-1.1.json')).payloads;
const goDoc = read(join(REPO_ROOT, 'toolchains', 'mixfpga', 'compliance', 'go-licenses.json'));
const hcl = goDoc.modules.find((m) => m.module === 'github.com/hashicorp/hcl/v2');
const hclFile = join(WORK, 'extra', 'github.com_hashicorp_hcl_v2@v2.24.0.zip');
if (!existsSync(hclFile)) die(`missing ${relative(REPO_ROOT, hclFile)} (fetch ${hcl.url})`);
if ((await sha256File(hclFile)) !== hcl.zipSha256) die('the hcl module archive does not match the hash recorded in go-licenses.json');

// ---------------------------------------------------------------- which sources belong to which archive
const winOnly = /win32|mingw|fedora|apio-1\.6\.0/;
const nexysDarwinText = JSON.stringify(nexysCompliance);
const nexysIds = storeManifest.sources
    .map((s) => s.id)
    .filter((id) => nexysDarwinText.includes(JSON.stringify(id)))
    .filter((id) => !winOnly.test(id) && !(sourceInfo[id].platforms && !sourceInfo[id].platforms.includes('darwin-arm64')));
// DE10 inventory source ids that name a MacPorts distfile/port differently from the store.
const ALIAS = { 'readline-8.2': 'macports-distfile-readline-8.2.tar.gz', readline82001: 'macports-distfile-readline82-001', 'readline82-001': 'macports-distfile-readline82-001', 'macports-port-readline': 'macports-port-readline-556ec864a7d9', 'libusb-1.0.26': 'macports-distfile-libusb-1.0.26.tar.gz', 'macports-port-libusb': 'macports-port-libusb-6b3c05d3a37d', 'libftdi1-1.5': 'macports-distfile-libftdi1-1.5.tar.bz2', 'macports-port-libftdi': 'macports-port-libftdi-3bdf7f45e366' };
const de10Ids = [...new Set(['yosyshq-oss-cad-suite-build-2026-03-24', ...de10Inventory.components.flatMap((c) => c.sources.map((s) => ALIAS[s.id] ?? s.id)).filter((id) => archives[id])])].sort();
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
    for (const x of spec.extraSources ?? []) {
        cpSync(x.from, join(stage, x.file));
        sourceRows.push(x.row);
    }
    copyTree(spec.licenses, 'licenses');
    put('THIRD_PARTY_NOTICES.md', readFileSync(spec.notices));
    for (const [rel, from] of Object.entries(spec.buildFiles)) { mkdirSync(join(stage, rel, '..'), { recursive: true }); cpSync(from, join(stage, rel)); }
    put('mix-fpga/LICENSE', readFileSync(join(REPO_ROOT, 'LICENSE')));
    put('mix-fpga/NOTICE', readFileSync(join(REPO_ROOT, 'NOTICE')));
    put('patches/README.md', `# Modifications made by MIX-FPGA\n\nMIX-FPGA modifies no third-party source code, patches nothing and rebuilds no third-party program: the binaries are the official upstream releases. The only changes to upstream content are the omissions and regenerations that ${spec.name.replace('-Sources', '')} lists in its notices (\`THIRD_PARTY_NOTICES\`) and in \`binary-to-source.json\` under "modifications"; the tool that applies them is \`mix-fpga-build/ghdl-prune.mjs\`, with the recipe in \`mix-fpga-build/\`.\n`);
    put('binary-to-source.json', `${JSON.stringify(spec.mapping(sourceRows), null, 1)}\n`);
    put('README.md', spec.readme(sourceRows));

    // manifest: every file of the package with its SHA-256 (the manifest itself excepted)
    const files = [];
    for (const f of await listFiles(stage)) files.push({ path: f, sha256: await sha256File(join(stage, f)), size: statSync(join(stage, f)).size });
    put('manifest.json', `${JSON.stringify({ schemaVersion: 1, package: spec.name, forArchive: spec.archive, generatedBy: 'scripts/compliance/assemble-1.1.mjs', sources: sourceRows, files }, null, 1)}\n`);

    mkdirSync(OUT, { recursive: true });
    const zip = join(OUT, `${spec.name}.zip`);
    const count = await writeZip(stage, zip);
    const zsha = await sha256File(zip);
    writeFileSync(`${zip}.sha256`, `${zsha}  ${spec.name}.zip\n`);
    console.log(`${spec.name}.zip: ${count} files, ${(statSync(zip).size / 2 ** 20).toFixed(1)} MiB, ${sourceRows.length} source archives, sha256 ${zsha}`);
}

const recipe = read(join(REPO_ROOT, 'toolchains', 'bundle', 'darwin-arm64-1.1.json'));
const nexysManifest = read(nexysManifestFile);
const requirement = read(join(REPO_ROOT, 'toolchains', 'bundle', 'requirement-1.1.json')).targets['darwin-arm64'];
const common = (t) => `Corresponding source of ${t.archive.file}\n\nThis package accompanies the binary archive named above, at the same place and time. It holds the exact upstream sources of every component whose licence requires source (GNU GPL, GNU LGPL, MPL, EPL, EUPL), the licence texts and notices of the archive, the MIX-FPGA build recipe, a mapping from every binary to its source (\`binary-to-source.json\`) and a SHA-256 manifest of every file (\`manifest.json\`). To check a file: \`shasum -a 256 <file>\` and compare with \`manifest.json\`.\n\nMIX-FPGA is the project of Walid Dyab (an EMXplore project); its own code is Apache-2.0 (\`mix-fpga/LICENSE\`), which does not apply to the third-party components.\n\nReplacing components: see "Your right to modify and replace components" in \`THIRD_PARTY_NOTICES\`. Legal conclusions in the notices are an engineering assessment; counsel review is pending for the items the notices list as open.\n`;

await build({
    name: 'MIX-FPGA-Nexys-A7-Support-1.1-Sources',
    archive: { file: 'nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz', sha256: pins['nexys-a7-100t'].sha256, bytes: pins['nexys-a7-100t'].bytes, treeSha256: requirement.treeSha256 },
    sourceIds: nexysIds,
    licenses: join(nexysTree, 'licenses'),
    notices: join(nexysTree, 'THIRD_PARTY_NOTICES.md'),
    buildFiles: {
        'mix-fpga-build/darwin-arm64-1.1.json': join(REPO_ROOT, 'toolchains', 'bundle', 'darwin-arm64-1.1.json'),
        'mix-fpga-build/ghdl-prune.mjs': join(REPO_ROOT, 'scripts', 'toolchain', 'ghdl-prune.mjs'),
        'mix-fpga-build/toolchain-manifest.json': nexysManifestFile,
        'mix-fpga-build/compliance-toolchain-1.0.json': join(REPO_ROOT, 'toolchains', 'compliance', 'toolchain-1.0.json'),
    },
    mapping: (rows) => ({
        schemaVersion: 1,
        archive: { file: 'nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz', sha256: pins['nexys-a7-100t'].sha256, treeSha256: requirement.treeSha256, files: requirement.files },
        note: 'Components, tools and libraries are those of the reviewed Toolchain 1.0 (toolchains/compliance/toolchain-1.0.json, darwin-arm64); the 1.1 archive differs only by the modifications below.',
        modifications: nexysManifest.modifications,
        components: nexysCompliance.components.map((c) => ({ id: c.id, name: c.name, version: c.version, path: c.path, license: c.license, binaryArchive: c.binaryArchive, upstreamSource: c.upstreamSource })),
        ossCadSuiteTools: nexysCompliance.ossCadSuiteTools.map((t) => ({ tool: t.name, licenses: t.licenses, sourceRequired: t.sourceRequired, sources: t.sources })),
        nativeLibraries: nexysCompliance.nativeLibraryInventory.map((e) => ({ id: e.id, version: e.version, files: e.files, licenses: e.licenses, usageClass: e.usage?.class, linking: e.linking, sources: (e.sources ?? []).map((id) => ({ id, files: archives[id]?.map((a) => a.file) ?? [] })) })),
        sourceArchives: rows.map((r) => ({ id: r.id, file: r.file, sha256: r.sha256 })),
    }),
    readme: (rows) => `# MIX-FPGA Nexys A7 support 1.1 (macOS): corresponding source\n\n${common({ archive: { file: 'nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz' } })}\nArchive SHA-256 \`${pins['nexys-a7-100t'].sha256}\`, content (tree) hash \`${requirement.treeSha256}\`, ${requirement.files} files.\n\n## What is in \`sources/\` (${rows.length} archives)\n\nOne \`.tar.gz\` per pinned source: git sources are \`git archive\` of the exact commit (submodules at the commits recorded by the parent tree); archives are the upstream release files by hash. \`manifest.json\` lists each with its upstream repository, revision and SHA-256.\n\n## Changes made by MIX-FPGA\n\n${nexysManifest.modifications.map((m) => `- ${m.component}: ${m.reason} (${m.removedFiles} files removed)`).join('\n')}\n`,
});

const de10Pin = pins['de10-lite'];
await build({
    name: 'MIX-FPGA-DE10-Lite-Support-1.1-Sources',
    archive: { file: de10Pin.file, sha256: de10Pin.sha256, bytes: de10Pin.bytes, manifestSha256: sha(readFileSync(join(REPO_ROOT, 'toolchains', 'mixfpga', 'toolchain-1.1-macos-arm64.json'))) },
    sourceIds: de10Ids,
    extraSources: [{ from: hclFile, file: 'sources/github.com_hashicorp_hcl_v2@v2.24.0.zip', row: { id: 'hashicorp-hcl-v2.24.0', upstream: hcl.url, revision: hcl.version, file: 'sources/github.com_hashicorp_hcl_v2@v2.24.0.zip', sha256: hcl.zipSha256, size: statSync(hclFile).size, license: 'MPL-2.0', note: `compiled into ${hcl.programs.join(', ')}; go.sum ${hcl.goSum}` } }],
    licenses: join(REPO_ROOT, '.artifacts', 'toolchain-1.1', 'macos-arm64', 'LICENSES'),
    notices: join(REPO_ROOT, '.artifacts', 'toolchain-1.1', 'macos-arm64', 'THIRD_PARTY_NOTICES.txt'),
    buildFiles: {
        'mix-fpga-build/toolchain-1.1-macos-arm64.json': join(REPO_ROOT, 'toolchains', 'mixfpga', 'toolchain-1.1-macos-arm64.json'),
        'mix-fpga-build/macos-arm64-1.1.inventory.json': join(REPO_ROOT, 'toolchains', 'mixfpga', 'compliance', 'macos-arm64-1.1.inventory.json'),
        'mix-fpga-build/ghdl-prune.mjs': join(REPO_ROOT, 'scripts', 'toolchain', 'ghdl-prune.mjs'),
        'mix-fpga-build/assemble-1.1.mjs': join(REPO_ROOT, 'scripts', 'mixfpga', 'assemble-1.1.mjs'),
        'mix-fpga-build/go-licenses.json': join(REPO_ROOT, 'toolchains', 'mixfpga', 'compliance', 'go-licenses.json'),
    },
    mapping: (rows) => ({
        schemaVersion: 1,
        archive: { file: de10Pin.file, sha256: de10Pin.sha256, bytes: de10Pin.bytes },
        modifications: de10Inventory.modifications,
        note: 'Per component: the shipped files (claims) and the source archives they were built from. Permissive components (openFPGALoader, Lima, LLVM, zlib, zstd, hidapi, libffi, Tcl, ncurses) need no source; their upstream revisions are recorded for provenance.',
        components: de10Inventory.components.map((c) => ({ id: c.id, unit: c.unit, name: c.name, version: c.version, license: c.license, files: c.claims, sourceObligation: c.obligation?.source, sources: c.sources.map((s) => ({ ...s, storeId: ALIAS[s.id] ?? s.id, archives: (archives[ALIAS[s.id] ?? s.id] ?? []).map((a) => ({ file: a.file, sha256: a.sha256 })) })) })),
        goMplModule: { module: hcl.module, version: hcl.version, license: hcl.license, archive: 'sources/github.com_hashicorp_hcl_v2@v2.24.0.zip', sha256: hcl.zipSha256, programs: hcl.programs },
        sourceArchives: rows.map((r) => ({ id: r.id, file: r.file, sha256: r.sha256 })),
    }),
    readme: (rows) => `# MIX-FPGA DE10-Lite support 1.1 (macOS): corresponding source\n\n${common({ archive: { file: de10Pin.file } })}\nArchive SHA-256 \`${de10Pin.sha256}\`, ${de10Pin.bytes} bytes.\n\n## What is in \`sources/\` (${rows.length} archives)\n\n- GHDL 6.0.0 (with its libraries, scripts and the CI build recipe \`.github/workflows/Build-MacOS.yml\`)\n- Yosys at the pinned commit with its \`abc\` and \`cxxopts\` submodules, and the YosysHQ build recipe (oss-cad-suite-build)\n- GNU readline 8.2 with patch 001 and the MacPorts port recipe\n- libusb 1.0.26 and libftdi1 1.5 with their MacPorts port recipes (so the LGPL libraries can be rebuilt and replaced)\n- the Go module archive of github.com/hashicorp/hcl/v2 v2.24.0 (MPL-2.0), compiled into Lima\n\nNot included because their licences require no source: openFPGALoader (Apache-2.0), Lima (Apache-2.0, its NOTICE is in \`licenses/lima/\`), LLVM, zlib, zstd, hidapi, libffi, Tcl, ncurses; \`binary-to-source.json\` records their upstream revisions.\n\n## Changes made by MIX-FPGA\n\n${de10Inventory.modifications.map((m) => `- ${m}`).join('\n')}\n`,
});
void readdirSync;
void homedir;
