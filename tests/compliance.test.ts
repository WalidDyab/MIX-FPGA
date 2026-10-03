// Toolchain 1.0 redistribution/compliance data: the curated review
// (toolchains/compliance/curation.json), the generated compliance manifest
// (toolchain-1.0.json), the source lock, the notices generator and the
// guarantees the compliance changes must keep (macOS content unchanged,
// nothing from Digilent, unused Windows packages not redistributed).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { REPO } from './helpers';

interface Source { id: string; kind: string; url: string; revision?: string; sha256?: string; size?: number; license: string }
interface Unresolved { id: string; platform: string; component: string; missing: string; resolution: string; blocking?: boolean }
interface Review { spdx: string; sources: string[]; status: string; usage: string; unresolved?: string[] }
interface Curation {
    toolchainVersion: string;
    statement: string;
    nexysvhdl: { license: string; copyright: string; project: string };
    licenseClasses: Record<string, { kind: string; action: string }>;
    sources: Source[];
    unresolved: Unresolved[];
    components: Record<string, Record<string, Review>>;
    apioPythonPackages: Record<string, { packages: Array<{ name: string; version: string; license: string }> }>;
    digilent: { policy: string };
}
interface Recipe { components: Array<{ id: string; license: string; licenseEvidence: string; archive?: { url: string }; placeholder?: { reason: string; evidence: string[] }; licenseFiles: string[]; dest: string; notRedistributed?: unknown; apioPackage?: { name: string } }>; compliance?: { manifest: string; sourcePackage: string } }

const TARGETS = ['win32-x64', 'darwin-arm64'] as const;
const json = async <T>(...p: string[]): Promise<T> => JSON.parse(await readFile(join(REPO, ...p), 'utf8')) as T;
const curation = () => json<Curation>('toolchains', 'compliance', 'curation.json');
const recipe = (t: string) => json<Recipe>('toolchains', 'bundle', `${t}.json`);
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const COPYLEFT = /\b(A?GPL|LGPL|EUPL|EPL|MPL|Artistic)-/;

describe('Toolchain 1.0 compliance review (curation.json)', () => {
    it('reviews every component of both recipes, with a license, usage, status and known sources', async () => {
        const c = await curation();
        const ids = new Set(c.sources.map((s) => s.id));
        const open = new Set(c.unresolved.map((u) => u.id));
        for (const t of TARGETS) {
            const r = await recipe(t);
            assert.deepEqual(Object.keys(c.components[t]!).sort(), r.components.map((x) => x.id).sort(), `${t}: one review per component`);
            for (const x of r.components) {
                const v = c.components[t]![x.id]!;
                assert.ok(v.spdx && v.usage, `${t}/${x.id}: license and usage`);
                assert.ok(['ready', 'unresolved', 'not-redistributed'].includes(v.status), `${t}/${x.id}: status ${v.status}`);
                for (const s of v.sources) assert.ok(ids.has(s), `${t}/${x.id}: source ${s}`);
                for (const u of v.unresolved ?? []) assert.ok(open.has(u), `${t}/${x.id}: open item ${u}`);
                if (v.status === 'unresolved') assert.ok(v.unresolved?.length, `${t}/${x.id}: unresolved names its open items`);
                if (x.placeholder) assert.equal(v.status, 'not-redistributed');
                // A component under a source-requiring license has a pinned source.
                if (COPYLEFT.test(v.spdx.replace(/GPL-3\.0-or-later WITH GCC-exception-3\.1/g, ''))) assert.ok(v.sources.length > 0, `${t}/${x.id}: copyleft component without a pinned source`);
            }
        }
    });

    it('pins every source exactly: git commits (40 hex), PyPI sdists by https URL, SHA-256 and size', async () => {
        const c = await curation();
        assert.equal(new Set(c.sources.map((s) => s.id)).size, c.sources.length, 'unique ids');
        for (const s of c.sources) {
            assert.ok(s.license, `${s.id}: license`);
            if (s.kind === 'git') {
                assert.match(s.revision ?? '', /^[0-9a-f]{40}$/, `${s.id}: full commit, never a branch, tag or "latest"`);
                assert.match(s.url, /^(https|git):\/\//, s.id);
            } else {
                assert.equal(s.kind, 'pypi-sdist', s.id);
                assert.match(s.url, /^https:\/\/files\.pythonhosted\.org\/packages\/.+\.tar\.gz$/, s.id);
                assert.match(s.sha256 ?? '', /^[0-9a-f]{64}$/, s.id);
                assert.ok(Number.isInteger(s.size) && s.size! > 0, s.id);
            }
        }
        // The copyleft programs NexysVHDL runs or ships have their exact upstream revision.
        const rev = (id: string) => c.sources.find((s) => s.id === id)?.revision;
        assert.equal(rev('ghdl-6.0.0'), 'e589c698c351369ac5bcfe7abe1f1152ac5d4727', 'GHDL v6.0.0');
        assert.equal(rev('apio-1.6.0'), '9fbb279c2bd793bb94e83d9b1523a420ed219f93', 'Apio 1.6.0 (Windows bundle build-info)');
        assert.equal(rev('apio-1.7.0'), 'ccede3ecb88f809d1c5a6063a274ba1852bdc519', 'Apio 1.7.0 (macOS bundle build-info)');
        assert.equal(rev('mcfgthread-1.6-ga.1'), '40263a6e2095ccba83071454191e09f14e9ee232', 'mcfgthread v1.6-ga.1');
    });

    it('classifies every license class with its redistribution action', async () => {
        const c = await curation();
        for (const id of ['GPL-2.0', 'GPL-2.0-or-later', 'GPL-3.0', 'GPL-3.0-or-later', 'LGPL-2.1', 'LGPL-3.0', 'GPL-3.0-or-later WITH GCC-exception-3.1', 'Apache-2.0', 'Apache-2.0 WITH LLVM-exception', 'ISC', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'PSF-2.0', 'EPL-1.0', 'EUPL-1.2', 'MPL-2.0', 'CC0-1.0']) {
            assert.ok(c.licenseClasses[id]?.action, `license class ${id}`);
        }
        for (const t of TARGETS) for (const x of c.apioPythonPackages[t]!.packages) assert.ok(x.license && x.version, `Python package ${x.name}`);
    });

    it('records every open item with what is missing and how to resolve it', async () => {
        const c = await curation();
        for (const u of c.unresolved) {
            assert.ok(u.platform && u.component && u.missing && u.resolution, u.id);
        }
    });
});

describe('Toolchain 1.0 compliance manifest (toolchain-1.0.json)', () => {
    it('is generated from the current recipes, requirement and curation', async () => {
        const c = await curation();
        const m = await json<{ toolchainVersion: string; sources: Source[]; unresolved: Unresolved[]; targets: Record<string, { components: Array<{ id: string; license: string; status: string; binaryArchive?: { sha256: string }; redistributed: boolean }>; payload: { treeSha256: string }; ossCadSuiteTools: Array<{ name: string; licenses: string[]; sourceRequired: boolean; sources: Array<{ source: string | null }> }> }> }>('toolchains', 'compliance', 'toolchain-1.0.json');
        const req = await json<{ targets: Record<string, { treeSha256: string }> }>('toolchains', 'bundle', 'requirement.json');
        assert.equal(m.toolchainVersion, '1.0');
        assert.deepEqual(m.sources, c.sources, 'manifest sources are the curated pins (run npm run compliance:manifest)');
        assert.deepEqual(m.unresolved.map((u) => u.id), c.unresolved.map((u) => u.id));
        for (const t of TARGETS) {
            const r = await recipe(t);
            const tm = m.targets[t]!;
            assert.equal(tm.payload.treeSha256, req.targets[t]!.treeSha256, `${t}: manifest describes the required payload`);
            assert.deepEqual(tm.components.map((x) => x.id), r.components.map((x) => x.id), `${t}: components`);
            for (const x of tm.components) {
                assert.equal(x.license, c.components[t]![x.id]!.spdx);
                assert.equal(x.redistributed, x.status !== 'not-redistributed');
            }
            // oss-cad-suite: every tool under a source-requiring license maps to a pinned source.
            assert.ok(tm.ossCadSuiteTools.length >= 40, `${t}: oss-cad-suite tools inventoried`);
            for (const tool of tm.ossCadSuiteTools) {
                assert.ok(tool.licenses.length, `${t}: ${tool.name} has an identified license`);
                if (tool.sourceRequired) assert.ok(tool.sources.some((s) => s.source), `${t}: ${tool.name} source pinned`);
            }
        }
    });

    it('keeps NexysVHDL (Apache-2.0) separate from the toolchain aggregation', async () => {
        const c = await curation();
        assert.match(c.statement, /aggregation/);
        assert.match(c.statement, /NOT licensed under NexysVHDL's Apache License 2\.0/);
        assert.equal(c.nexysvhdl.license, 'Apache-2.0');
        assert.equal(c.nexysvhdl.copyright, 'Copyright 2026 Walid Dyab');
        assert.equal(c.nexysvhdl.project, 'NexysVHDL is an EMXplore project');
        for (const t of TARGETS) for (const v of Object.values(c.components[t]!)) assert.doesNotMatch(v.spdx, /NexysVHDL(?!-aggregate)/);
        const license = await readFile(join(REPO, 'LICENSE'), 'utf8');
        assert.match(license, /Apache License\s+Version 2\.0/);
    });

    it('the redistribution readiness stated in the docs follows the open items', async () => {
        const c = await curation();
        const doc = await readFile(join(REPO, 'docs', 'toolchain-1.0-redistribution.md'), 'utf8');
        const blocking = c.unresolved.filter((u) => u.blocking !== false);
        if (blocking.length) {
            assert.match(doc, /Redistribution\/license: \*\*NOT READY\*\*/);
            for (const u of blocking) assert.ok(doc.includes(u.id), `docs list open item ${u.id}`);
        } else {
            assert.match(doc, /Redistribution\/license: \*\*READY\*\*/);
        }
    });
});

describe('Toolchain 1.0 corresponding-source lock', () => {
    it('records one SHA-256 per source archive, at the pinned commits', async (t) => {
        const file = join(REPO, 'toolchains', 'compliance', 'sources-1.0.lock.json');
        if (!existsSync(file)) return t.skip('no lock recorded yet');
        const c = await curation();
        const lock = await json<{ sources: Record<string, Array<{ path: string; commit?: string; file: string; sha256: string; size: number }>> }>('toolchains', 'compliance', 'sources-1.0.lock.json');
        assert.deepEqual(Object.keys(lock.sources).sort(), c.sources.map((s) => s.id).sort());
        for (const s of c.sources) {
            const archives = lock.sources[s.id]!;
            assert.ok(archives.length >= 1, s.id);
            for (const a of archives) {
                assert.match(a.sha256, /^[0-9a-f]{64}$/);
                assert.ok(a.size > 0);
                assert.match(a.file, /^sources\/[A-Za-z0-9._-]+\.tar\.gz$/);
            }
            if (s.kind === 'git') assert.equal(archives[0]!.commit, s.revision, `${s.id}: top-level archive is the pinned commit`);
            else assert.equal(archives[0]!.sha256, s.sha256, `${s.id}: the original sdist`);
        }
    });

    it('the compliance assembler refuses to build a releasable package while blocking items are open', async () => {
        const c = await curation();
        if (!c.unresolved.some((u) => u.blocking !== false)) return;
        const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'compliance', 'assemble.mjs'), '--offline'], { cwd: REPO, encoding: 'utf8' });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /blocking open item/);
    });
});

describe('deterministic source package zip', () => {
    it('the same tree gives the same bytes, readable by a standard unzip', async () => {
        const { writeZip } = (await import(pathToFileURL(join(REPO, 'scripts', 'compliance', 'zip.mjs')).href)) as { writeZip(root: string, out: string): Promise<number> };
        const dir = await mkdtemp(join(tmpdir(), 'nxv-zip-'));
        try {
            const root = join(dir, 'pkg');
            await mkdir(join(root, 'sources'), { recursive: true });
            await writeFile(join(root, 'README.md'), '# test\n');
            await writeFile(join(root, 'sources', 'a.tar.gz'), Buffer.from([1, 2, 3, 0, 255]));
            assert.equal(await writeZip(root, join(dir, 'one.zip')), 2);
            await writeZip(root, join(dir, 'two.zip'));
            const one = await readFile(join(dir, 'one.zip'));
            assert.equal(sha256(one), sha256(await readFile(join(dir, 'two.zip'))));
            const list = spawnSync('tar', ['-tf', join(dir, 'one.zip')], { encoding: 'utf8' });
            if (list.status === 0) assert.deepEqual(list.stdout.trim().split(/\r?\n/), ['README.md', 'sources/a.tar.gz']);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('compliance changes keep the guarantees of the released toolchains', () => {
    it('the macOS recipe and the license texts it ships are unchanged (validated darwin-arm64 content)', async () => {
        const mac = await readFile(join(REPO, 'toolchains', 'bundle', 'darwin-arm64.json'));
        assert.equal(sha256(mac), 'df2688233c91dc5426ed01e88558844b8d27d7c1a22097a666f1991a06f4ee27', 'the Mac payload records this recipe hash; changing it needs a Mac re-validation');
        // The Mac payload's licenses/ = shared texts + licenses-darwin-arm64/, exactly as validated.
        const shipped: Record<string, string> = {};
        for (const d of ['licenses', 'licenses-darwin-arm64']) {
            for (const f of await readdir(join(REPO, 'toolchains', 'bundle', d))) shipped[f] = sha256(await readFile(join(REPO, 'toolchains', 'bundle', d, f)));
        }
        assert.deepEqual(shipped, {
            'GCC-RUNTIME-EXCEPTION-3.1.txt': '9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74',
            'GHDL-COPYING.md': 'aef8b4222b79d0dbf6bf17cfff71c90a6a6bb8917a4162abe417b469ed22da2e',
            'GPL-2.0.txt': 'edaef632cbb643e4e7a221717a6c441a4c1a7c918e6e4d56debc3d8739b233f6',
            'GPL-3.0.txt': '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986',
            'LGPL-2.1.txt': '20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95',
            'LGPL-3.0.txt': 'e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118',
            'LLVM-LICENSE.txt': '8d85c1057d742e597985c7d4e6320b015a9139385cff4cbae06ffc0ebe89afee',
            'PSF-2.0-Python-3.11.txt': '3b2f81fe21d181c499c59a256c8e1968455d6689d269aa85373bfb6af41da3bf',
            'PSF-2.0-Python-3.14.txt': 'b0e25a78cffb43f4d92de8b61ccfa1f1f98ecbc22330b54b5251e7b6ba010231',
            'graphviz-LICENSE.txt': '0becf16567beb77fa252b7664631dd177c8f9a1889e48995b45379c7130e5303',
            'libwdi-COPYING.txt': '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
            'nextpnr-xilinx-COPYING.txt': '4f50c7ce03bde12deeb5796517f6e4d7f1a8c63473608bc34b86e26d80c0de2d',
            'prjxray-LICENSE.txt': '5deafaceb3bbf26250d46e421a3e0f8b34950fb709b76c68361762d968fd53a4',
            'prjxray-db-LICENSE.txt': 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499',
            'verible-LICENSE.txt': '2cf0a64c57f5e72fc377e2db383e89658785686a0fcde9c24b0c6a4f405934e1',
            'yosys-COPYING.txt': '6998b5724d4cb3f459d1c12b6bd0cdbfa9c949ef14d0fb6d7d97d97404e5b5f3',
            'zlib-LICENSE.txt': 'e32ff4e00d9d94930537635291da39e7e612703334bf6fde8c7f1686fe8a45a2',
        });
        // Windows no longer ships the Graphviz and libwdi texts (their packages are not redistributed).
        for (const f of ['graphviz-LICENSE.txt', 'libwdi-COPYING.txt']) assert.ok(!existsSync(join(REPO, 'toolchains', 'bundle', 'licenses', f)), f);
    });

    it('the notices generator keeps the original format for a recipe without compliance data (macOS)', async () => {
        const { renderNotices } = (await import(pathToFileURL(join(REPO, 'scripts', 'toolchain', 'notices.mjs')).href)) as { renderNotices(m: unknown): string };
        const mac = await recipe('darwin-arm64');
        assert.equal(mac.compliance, undefined);
        const manifest = { ...mac, components: mac.components.map((c) => ({ ...c, path: c.dest, content: { files: 1, bytes: 1 } })) };
        const text = renderNotices(manifest);
        assert.match(text, /^# Third-party software in the NexysVHDL FPGA toolchain \(macOS/);
        assert.match(text, /NexysVHDL toolchain bundle 1\.0 for darwin-arm64\. /);
        assert.match(text, /The NexysVHDL release process must also make the corresponding source available/);
        assert.doesNotMatch(text, /aggregation/);
    });

    it('the Windows notices state the aggregation, the source package and the placeholders', async () => {
        const { renderNotices } = (await import(pathToFileURL(join(REPO, 'scripts', 'toolchain', 'notices.mjs')).href)) as { renderNotices(m: unknown): string };
        const win = await recipe('win32-x64');
        assert.deepEqual(win.compliance && { manifest: win.compliance.manifest, sourcePackage: win.compliance.sourcePackage }, { manifest: 'toolchains/compliance/toolchain-1.0.json', sourcePackage: 'NexysVHDL-Toolchain-1.0-Sources.zip' });
        const manifest = { ...win, components: win.components.map((c) => ({ ...c, path: c.dest, content: { files: 1, bytes: 1 } })) };
        const text = renderNotices(manifest);
        assert.match(text, /aggregation of separate programs/);
        assert.match(text, /It is \*\*not\*\* licensed under the NexysVHDL license/);
        assert.match(text, /NexysVHDL-Toolchain-1\.0-Sources\.zip/);
        assert.match(text, /## Not included: unused Apio packages/);
        assert.match(text, /Apio drivers package — not included/);
        assert.match(text, /Apio graphviz package — not included/);
        assert.match(text, /## Not included: board programmer\n\nDigilent Adept/);
        assert.match(text, /Apio — 1\.6\.0[\s\S]*?License: GPL-3\.0-or-later/);
    });

    it('Windows: the unused drivers and graphviz packages are placeholders; serial_install.exe and Graphviz are not redistributed', async () => {
        const lib = (await import(pathToFileURL(join(REPO, 'scripts', 'toolchain', 'lib.mjs')).href)) as { validateRecipe(r: unknown, t: string): string[]; apioInstalledPackages(r: unknown): Record<string, { 'loaded-from': string; version: string }> };
        const win = await recipe('win32-x64');
        assert.deepEqual(lib.validateRecipe(win, 'win32-x64'), []);
        for (const id of ['apio-drivers', 'apio-graphviz']) {
            const c = win.components.find((x) => x.id === id)!;
            assert.ok(c.placeholder, id);
            assert.equal(c.archive, undefined, `${id}: no archive is extracted`);
            assert.deepEqual(c.licenseFiles, []);
            assert.ok(c.placeholder.evidence.length >= 4, `${id}: evidence recorded`);
            assert.ok(c.notRedistributed, `${id}: the upstream package is still identified`);
        }
        assert.match(JSON.stringify(win.components.find((x) => x.id === 'apio-drivers')), /serial_install\.exe is PJRC/);
        // Apio's package check still sees both packages, at the pinned release, from a NexysVHDL placeholder.
        const installed = lib.apioInstalledPackages(win);
        assert.match(installed['drivers']!['loaded-from'], /^nexysvhdl-placeholder:apio-drivers-windows-amd64-20260915\.tgz/);
        assert.match(installed['graphviz']!['loaded-from'], /^nexysvhdl-placeholder:apio-graphviz-windows-amd64-20260915\.tgz/);
        assert.equal(installed['drivers']!.version, '2026.09.15');
        // A placeholder must never carry an archive.
        const bad = structuredClone(win) as Recipe;
        bad.components.find((x) => x.id === 'apio-drivers')!.archive = { url: 'https://example.invalid/x.tgz' };
        assert.ok(lib.validateRecipe(bad, 'win32-x64').some((p) => /placeholder must not have an archive/.test(p)));
    });

    it('nothing from Digilent is redistributed or mirrored on either platform', async () => {
        const c = await curation();
        assert.match(c.digilent.policy, /^Not redistributed/);
        for (const t of TARGETS) {
            const r = await recipe(t);
            for (const x of r.components) assert.doesNotMatch(x.archive?.url ?? '', /digilent/i);
            assert.ok(!JSON.stringify(r).match(/digilent\.com\/[^"\s]*\.(exe|msi|zip|dmg|pkg)/i), `${t}: no Digilent installer`);
        }
        for (const s of c.sources) assert.doesNotMatch(s.url, /digilent/i);
    });
});
