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
import { gunzipSync } from 'node:zlib';
import { writeTarEntriesGz, type TarEntry } from '../core/toolchain/tar';
import { REPO } from './helpers';

interface Source { id: string; kind: string; url: string; revision?: string; sha256?: string; size?: number; md5?: string; paths?: string[]; cache?: string; file?: string; license: string }
interface LibraryEntry {
    id: string;
    component: string;
    files: string[];
    origin: { kind: string; nixpkgs?: string; storePath?: string; archive?: string; port?: string; version?: string; portfile?: { commit: string; path: string; gitBlob: string }; bottleSha256?: string; formulaCommit?: string; build?: string };
    version: string;
    licenses: string[];
    licenseElected?: string;
    licenseEvidence: string;
    licenseTexts: string[];
    usage: { class: 'A' | 'B' | 'C' };
    linking: string;
    sources: string[];
    evidence: string;
    redistributed?: boolean;
}
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
    nativeLibraryInventory: Record<string, LibraryEntry[]>;
    resolved: Array<{ id: string; platform: string; component: string; resolution: string }>;
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

    it('pins every source exactly: git commits (40 hex), PyPI sdists and release archives by https URL, SHA-256 and size', async () => {
        const c = await curation();
        assert.equal(new Set(c.sources.map((s) => s.id)).size, c.sources.length, 'unique ids');
        for (const s of c.sources) {
            assert.ok(s.license, `${s.id}: license`);
            if (s.kind === 'git') {
                assert.match(s.revision ?? '', /^[0-9a-f]{40}$/, `${s.id}: full commit, never a branch, tag or "latest"`);
                assert.match(s.url, /^(https|git):\/\//, s.id);
                for (const p of s.paths ?? []) assert.match(p, /^[A-Za-z0-9._+-]+(\/[A-Za-z0-9._+-]+)*$/, `${s.id}: relative path ${p}`);
            } else {
                assert.ok(['pypi-sdist', 'archive'].includes(s.kind), `${s.id}: kind ${s.kind}`);
                if (s.kind === 'pypi-sdist') assert.match(s.url, /^https:\/\/files\.pythonhosted\.org\/packages\/.+\.tar\.gz$/, s.id);
                else assert.match(s.url, /^https:\/\//, s.id);
                assert.doesNotMatch(s.url, /latest|\/HEAD\/|\/master\/|\/main\//i, `${s.id}: never a moving target`);
                assert.match(s.sha256 ?? '', /^[0-9a-f]{64}$/, s.id);
                assert.ok(Number.isInteger(s.size) && s.size! > 0, s.id);
                if (s.md5 !== undefined) assert.match(s.md5, /^[0-9a-f]{32}$/, s.id);
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
                assert.match(a.file, s.kind === 'git' ? /^sources\/[A-Za-z0-9._-]+\.tar\.gz$/ : /^sources\/[A-Za-z0-9._+-]+$/);
            }
            if (s.kind === 'git') assert.equal(archives[0]!.commit, s.revision, `${s.id}: top-level archive is the pinned commit`);
            else assert.equal(archives[0]!.sha256, s.sha256, `${s.id}: the original sdist`);
        }
    });

    it('git source archives are platform-independent: the gzip header OS byte is fixed to 255 ("unknown")', async (t) => {
        const dir = join(REPO, '.artifacts', 'compliance', 'package', 'NexysVHDL-Toolchain-1.0-Sources-DRAFT', 'sources');
        if (!existsSync(dir)) return t.skip('no built package here');
        const c = await curation();
        const lock = await json<{ sources: Record<string, Array<{ file: string }>> }>('toolchains', 'compliance', 'sources-1.0.lock.json');
        for (const s of c.sources.filter((x) => x.kind === 'git')) {
            for (const a of lock.sources[s.id]!) {
                const head = (await readFile(join(dir, a.file.slice('sources/'.length)))).subarray(0, 10);
                assert.equal(head[0], 0x1f, a.file);
                assert.equal(head[9], 0xff, `${a.file}: OS byte (zlib writes 10 on Windows, 19 on macOS)`);
            }
        }
        const script = await readFile(join(REPO, 'scripts', 'compliance', 'assemble.mjs'), 'utf8');
        assert.match(script, /normalizeGzipHeader/);
    });

    it('the compliance assembler refuses to build a releasable package while blocking items are open', async () => {
        const c = await curation();
        if (!c.unresolved.some((u) => u.blocking !== false)) return;
        const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'compliance', 'assemble.mjs'), '--offline'], { cwd: REPO, encoding: 'utf8' });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /blocking open item/);
    });
});

describe('deterministic path-limited source archives (no dependence on git archive)', () => {
    it('same bytes for any entry order; exact file bytes (LF and CRLF kept); normalized metadata; gzip OS byte 255', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nxv-gittar-'));
        try {
            const entries: TarEntry[] = [
                { name: 'src/', type: 'directory', mode: 0o755 },
                { name: 'src/port/', type: 'directory', mode: 0o755 },
                { name: 'src/port/Portfile', type: 'file', mode: 0o644, data: Buffer.from('line one\nline two\n') },
                { name: 'src/port/files/patch.diff', type: 'file', mode: 0o644, data: Buffer.from('a\r\nb\r\n') },
                { name: 'src/port/files/', type: 'directory', mode: 0o755 },
                { name: 'src/port/run.sh', type: 'file', mode: 0o755, data: Buffer.from('#!/bin/sh\n') },
                { name: 'src/port/link', type: 'symlink', mode: 0o755, linkname: 'Portfile' },
                { name: `src/port/${'long-name-'.repeat(12)}.txt`, type: 'file', mode: 0o644, data: Buffer.from('x') },
            ];
            await writeTarEntriesGz(entries, join(dir, 'a.tar.gz'), { mtime: 1657345000, comment: 'c'.repeat(40) });
            await writeTarEntriesGz([...entries].reverse(), join(dir, 'b.tar.gz'), { mtime: 1657345000, comment: 'c'.repeat(40) });
            const a = await readFile(join(dir, 'a.tar.gz'));
            assert.equal(sha256(a), sha256(await readFile(join(dir, 'b.tar.gz'))), 'entry order does not matter');
            assert.equal(a[9], 255, 'gzip OS byte');
            assert.equal(a.readUInt32LE(4), 0, 'no gzip timestamp');
            const tar = gunzipSync(a);
            const names: string[] = [];
            const contents: Record<string, Buffer> = {};
            for (let o = 0; o + 512 <= tar.length; ) {
                const h = tar.subarray(o, o + 512);
                if (h.every((x) => x === 0)) break;
                const size = parseInt(h.toString('latin1', 124, 136), 8);
                const type = String.fromCharCode(h[156]!);
                assert.equal(parseInt(h.toString('latin1', 108, 116), 8), 0, 'uid 0');
                assert.equal(parseInt(h.toString('latin1', 116, 124), 8), 0, 'gid 0');
                assert.equal(h.toString('latin1', 265, 329).replace(/\0/g, ''), '', 'no user or group names');
                assert.equal(parseInt(h.toString('latin1', 136, 148), 8), 1657345000, 'one fixed timestamp');
                const name = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
                if (type === '0') contents[name] = Buffer.from(tar.subarray(o + 512, o + 512 + size));
                if (type !== 'x' && type !== 'g') names.push(name);
                o += 512 + Math.ceil(size / 512) * 512;
            }
            assert.deepEqual(contents['src/port/Portfile'], Buffer.from('line one\nline two\n'), 'LF kept');
            assert.deepEqual(contents['src/port/files/patch.diff'], Buffer.from('a\r\nb\r\n'), 'CRLF kept');
            assert.deepEqual(names.slice(0, 4), ['src/', 'src/port/', 'src/port/Portfile', 'src/port/files/'], 'sorted by path bytes');
            await assert.rejects(writeTarEntriesGz([{ name: '../x', type: 'file', mode: 0o644 }], join(dir, 'c.tar.gz'), { mtime: 0 }));
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('the assembler archives path-limited git sources with that writer, and plain git archives with LF line endings everywhere', async () => {
        const script = await readFile(join(REPO, 'scripts', 'compliance', 'assemble.mjs'), 'utf8');
        assert.match(script, /if \(paths\.length\) await gitTreeArchive\(/);
        assert.match(script, /'ls-tree', '-r', '-z'/);
        assert.match(script, /'cat-file', '--batch'/);
        assert.match(script, /'core\.eol=lf', 'archive'/, 'text=auto files are never converted to CRLF by Git for Windows');
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

describe('macOS bundled native libraries (Mac compliance review)', () => {
    const MAC_TREE = 'f04022180f9bb746dc5dc467bc7d1d379512f302159763f8c4a8c0ed50b2aac7';
    const WIN_TREE = '57f0f0da89e6565d6e46d20780fa57af86f8ac36d45a78b750203fc8f381820b';
    const inventory = async () => (await curation()).nativeLibraryInventory['darwin-arm64']!;
    const source = async (id: string) => (await curation()).sources.find((s) => s.id === id)!;
    // As scripts/compliance/manifest.mjs requiresSource(): runtime-library exceptions do not require source.
    const elected = (e: LibraryEntry) => (e.licenseElected ? [e.licenseElected] : e.licenses).filter((l) => !/GCC-exception|LLVM-exception/.test(l));

    it('the Mac and Windows Toolchain 1.0 payloads are unchanged by the compliance work', async () => {
        const req = await json<{ targets: Record<string, { treeSha256: string; files: number }> }>('toolchains', 'bundle', 'requirement.json');
        assert.equal(req.targets['darwin-arm64']!.treeSha256, MAC_TREE);
        assert.equal(req.targets['darwin-arm64']!.files, 31699);
        assert.equal(req.targets['win32-x64']!.treeSha256, WIN_TREE);
        assert.equal(req.targets['win32-x64']!.files, 21208);
        // Compliance-only license texts live outside toolchains/bundle, so no payload picks them up.
        assert.ok(existsSync(join(REPO, 'toolchains', 'compliance', 'licenses', 'darwin-arm64', 'SOURCES.md')));
        assert.ok(!existsSync(join(REPO, 'toolchains', 'bundle', 'licenses-darwin-arm64', 'SOURCES.md')));
    });

    it('the three macOS blockers are resolved with evidence (and, since the Windows review, no blocker remains)', async () => {
        const c = await curation();
        const blocking = c.unresolved.filter((u) => u.blocking !== false).map((u) => u.id).sort();
        assert.deepEqual(blocking, []);
        const mac = c.resolved.filter((r) => r.platform === 'darwin-arm64');
        assert.deepEqual(mac.map((r) => r.id).sort(), ['darwin-apio-bundled-libraries', 'darwin-openxc7-nix-libraries', 'darwin-oss-cad-suite-bundled-libraries']);
        for (const r of mac) assert.ok(r.resolution.length > 100, r.id);
        for (const id of ['apio', 'apio-oss-cad-suite', 'apio-openxc7']) assert.equal(c.components['darwin-arm64']![id]!.status, 'ready', id);
        const m = await json<{ unresolved: Unresolved[]; resolved: Array<{ id: string }> }>('toolchains', 'compliance', 'toolchain-1.0.json');
        assert.deepEqual(m.unresolved.filter((u) => u.blocking !== false).map((u) => u.id).sort(), blocking);
        assert.equal(m.resolved.length, 6);
    });

    it('every copyleft macOS library has its exact source pinned; dual-licensed ones name the elected permissive option', async () => {
        const c = await curation();
        const ids = new Map(c.sources.map((s) => [s.id, s]));
        const inv = await inventory();
        assert.ok(inv.length >= 60, 'inventory entries');
        for (const e of inv) {
            for (const s of e.sources) assert.ok(ids.has(s), `${e.id}: source ${s}`);
            assert.ok(['A', 'B', 'C'].includes(e.usage.class), e.id);
            if (e.redistributed === false) continue;
            assert.ok(e.licenseTexts.length, `${e.id}: license texts`);
            if (elected(e).some((l) => COPYLEFT.test(l))) assert.ok(e.sources.length, `${e.id} (${e.licenses.join(', ')}) requires source`);
            if (e.licenseElected) assert.ok(e.licenses.includes(e.licenseElected) && !COPYLEFT.test(e.licenseElected), `${e.id}: elected option`);
        }
        // MacPorts builds: exact archive, port version/revision, and the macports-ports commit holding the exact Portfile.
        const mp = inv.filter((e) => e.origin.kind === 'macports-binary-archive' && e.origin.portfile);
        assert.equal(mp.length, 45);
        for (const e of mp) {
            assert.match(e.origin.portfile!.commit, /^[0-9a-f]{40}$/, e.id);
            assert.match(e.origin.portfile!.gitBlob, /^[0-9a-f]{40}$/, e.id);
            assert.match(e.origin.archive!, /\.darwin_\d+\.arm64\.tbz2$|\.noarch\.tbz2$/, e.id);
            if (e.sources.length) {
                const dist = e.sources.map((s) => ids.get(s)!).filter((s) => s.kind === 'archive');
                const recipe = e.sources.map((s) => ids.get(s)!).filter((s) => s.kind === 'git');
                assert.ok(dist.length >= 1 && dist.every((s) => s.url.startsWith('https://distfiles.macports.org/')), `${e.id}: upstream distfile from the MacPorts mirror`);
                assert.equal(recipe[0]!.revision, e.origin.portfile!.commit, `${e.id}: recipe at the Portfile commit`);
                assert.deepEqual(recipe[0]!.paths, [e.origin.portfile!.path.replace(/\/Portfile$/, '')], e.id);
            }
        }
    });

    it('the libraries NexysVHDL loads on macOS are classified A and resolved (Yosys, openFPGALoader, openXC7, Apio)', async () => {
        const inv = await inventory();
        const a = new Set(inv.filter((e) => e.usage.class === 'A').map((e) => e.id));
        for (const id of ['ocs-macports-readline', 'ocs-macports-libusb', 'ocs-macports-libftdi1', 'ocs-macports-hidapi', 'ocs-macports-libffi', 'ocs-macports-ncurses', 'ocs-macports-tcl', 'ocs-macports-zlib', 'ocs-macports-realpath', 'ox-libcxx', 'ox-boost', 'ox-apple-libiconv', 'ox-python-3.12', 'ox-eigen-compiled-in', 'apio-python-runtime']) {
            assert.ok(a.has(id), `${id} is loaded by a program NexysVHDL runs`);
        }
        const readline = inv.find((e) => e.id === 'ocs-macports-readline')!;
        assert.deepEqual(readline.licenses, ['GPL-3.0-or-later']);
        assert.equal(readline.version, '8.2.001');
        assert.ok(readline.sources.some((s) => s.includes('readline-8.2.tar.gz')) && readline.sources.some((s) => s.includes('readline82-001')), 'readline 8.2 and upstream patch 001');
        // Qt is linked only by tools NexysVHDL does not run.
        for (const id of ['ocs-qt-5.15.3', 'ocs-qt-5.15.3-gpl3-only-modules']) assert.notEqual(inv.find((e) => e.id === id)!.usage.class, 'A', id);
    });

    it('Qt 5.15.3: exact version, OpenSource build information and the official module sources (without the skipped modules)', async () => {
        const c = await curation();
        const inv = await inventory();
        const qt = inv.find((e) => e.id === 'ocs-qt-5.15.3')!;
        const gpl3 = inv.find((e) => e.id === 'ocs-qt-5.15.3-gpl3-only-modules')!;
        assert.equal(qt.version, '5.15.3');
        assert.match(qt.origin.build!, /OpenSource/);
        assert.deepEqual(qt.licenses, ['LGPL-3.0-only', 'GPL-2.0-only', 'GPL-3.0-only']);
        assert.deepEqual(gpl3.licenses, ['GPL-3.0-only']);
        assert.equal(qt.files.filter((f) => f.includes('/Frameworks/')).length + gpl3.files.filter((f) => f.includes('/Frameworks/')).length, 58, 'all 58 shipped Qt frameworks');
        for (const fw of ['QtCharts', 'QtDataVisualization', 'QtVirtualKeyboard', 'QtBodymovin', 'QtNetworkAuth']) assert.ok(gpl3.files.some((f) => f.includes(`/Frameworks/${fw}.framework/`)), fw);
        const mods = c.sources.filter((s) => s.id.startsWith('qt-5.15.3-'));
        assert.equal(mods.length, 45);
        for (const s of mods) {
            assert.match(s.url, /^https:\/\/download\.qt\.io\/archive\/qt\/5\.15\/5\.15\.3\/submodules\/[a-z0-9-]+-everywhere-opensource-src-5\.15\.3\.tar\.xz$/, s.id);
            assert.match(s.md5 ?? '', /^[0-9a-f]{32}$/, `${s.id}: MD5 as published by the Qt Project`);
            assert.ok(qt.sources.includes(s.id), s.id);
        }
        assert.ok(!mods.some((s) => /qtwebengine|qt3d-/.test(s.url)), 'the documented build skipped qtwebengine and qt3d');
        assert.equal((await source('mmicko-macos-resources-v3')).revision, '364d180c8b3a1727a78f3db6f7a9d9c8034fee1e');
    });

    it('openXC7: Nix provenance pinned to nixpkgs 574d1eac; Apple libiconv is BSD, not LGPL; Eigen (MPL-2.0) source pinned', async () => {
        const inv = await inventory();
        const ox = inv.filter((e) => e.component === 'apio-openxc7');
        assert.ok(ox.length >= 13);
        for (const e of ox) assert.match(e.origin.nixpkgs ?? '', /574d1eac1c200690e27b8eb4e24887f8df7ac27c/, e.id);
        const iconv = ox.find((e) => e.id === 'ox-apple-libiconv')!;
        assert.deepEqual(iconv.licenses, ['BSD-2-Clause', 'BSD-3-Clause']);
        assert.equal(iconv.origin.storePath, '/nix/store/mhliicfd4zgfypqwz1wkdfrfid3lvwmz-libiconv-99');
        assert.ok(!ox.filter((e) => e.redistributed !== false).some((e) => elected(e).some((l) => /LGPL|GPL-/.test(l))), 'no shipped openXC7 library is (L)GPL');
        const eigen = ox.find((e) => e.id === 'ox-eigen-compiled-in')!;
        assert.deepEqual(eigen.licenses, ['MPL-2.0']);
        assert.deepEqual(eigen.sources, ['eigen-3.4.0', 'eigen-commit-d0e3791b', 'nixpkgs-574d1eac-recipes']);
        assert.equal((await source('eigen-3.4.0')).revision, '3147391d946bb4b6c68edd901f2add6ac1f31f8c');
        const notShipped = ox.find((e) => e.id === 'ox-not-shipped')!;
        assert.equal(notShipped.redistributed, false);
        assert.deepEqual(notShipped.files, []);
    });

    it('Apio: libusb 1.0.30 from the Homebrew arm64_tahoe bottle, with the release tarball and the formula pinned', async () => {
        const inv = await inventory();
        const usb = inv.find((e) => e.id === 'apio-libusb')!;
        assert.equal(usb.version, '1.0.30');
        assert.deepEqual(usb.files, ['apio/bin/_internal/libusb-1.0.dylib']);
        assert.equal(usb.origin.bottleSha256, '184daaa6108f0a56eb72c58cc4124dbbb0b54a655632dffdf8334569d71e2a34');
        assert.equal(usb.origin.formulaCommit, 'c1f707f52ca844612e99e9174f2a917dc00181ee');
        assert.match(usb.evidence, /1\.0\.30\.12037/);
        const src = await source('libusb-1.0.30');
        assert.equal(src.url, 'https://github.com/libusb/libusb/releases/download/v1.0.30/libusb-1.0.30.tar.bz2');
        assert.equal(src.sha256, 'fea36f34f9156400209595e300840767ab1a385ede1dc7ee893015aea9c6dbaf');
        // The oss-cad-suite's own libusb is 1.0.26 (MacPorts), not the v1.0.24 its license file names (that revision is the Windows build's).
        const ocs = inv.find((e) => e.id === 'ocs-macports-libusb')!;
        assert.equal(ocs.version, '1.0.26');
    });

    it('no third-party component is labeled Apache-2.0 because NexysVHDL is: licenses come from the components\' own texts', async () => {
        const c = await curation();
        const nexysLicense = sha256(await readFile(join(REPO, 'LICENSE')));
        const claim = /NexysVHDL('s)? (license|Apache)|licensed (by|under) NexysVHDL|Copyright 2026 Walid Dyab/i;
        for (const t of TARGETS) {
            for (const e of c.nativeLibraryInventory[t]!) {
                for (const l of e.licenses) assert.doesNotMatch(l, /NexysVHDL/, e.id);
                assert.doesNotMatch(e.licenseEvidence, claim, e.id);
            }
        }
        for (const s of c.sources) assert.doesNotMatch(s.license, /NexysVHDL/, s.id);
        // Known copyleft libraries keep their copyleft license.
        const inv = await inventory();
        for (const [id, lic] of [['ocs-macports-readline', /^GPL-3\.0/], ['ocs-macports-libusb', /^LGPL-2\.1/], ['ocs-macports-gtk3', /^LGPL-2\.0/], ['ocs-qt-5.15.3', /^LGPL-3\.0/], ['apio-libusb', /^LGPL-2\.1/]] as const) {
            assert.match(inv.find((e) => e.id === id)!.licenses[0]!, lic, id);
        }
        // NexysVHDL's own LICENSE is never used as a third-party license text: a text identical to the
        // canonical Apache-2.0 file (e.g. fasm's LICENSE) must come from the component's upstream source.
        const root = join(REPO, 'toolchains', 'compliance', 'licenses');
        for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
            if (!e.isFile() || sha256(await readFile(join(e.parentPath, e.name))) !== nexysLicense) continue;
            const [platform, ...rest] = join(e.parentPath, e.name).slice(root.length + 1).split(/[\\/]/);
            const rel = rest.join('/');
            const origins = await readFile(join(root, platform!, 'SOURCES.md'), 'utf8');
            const row = origins.split('\n').find((l) => l.startsWith(`| ${rel} |`)) ?? '';
            assert.match(row, /https:\/\/(raw\.githubusercontent\.com|gitlab\.com|github\.com)\/(?!.*NexysVHDL)/, `${rel}: an upstream origin`);
        }
    });

    it('every compliance license text is referenced, present and recorded with its SHA-256 and origin', async () => {
        const inv = await inventory();
        const root = join(REPO, 'toolchains', 'compliance', 'licenses');
        const sources = await readFile(join(root, 'darwin-arm64', 'SOURCES.md'), 'utf8');
        const referenced = new Set<string>();
        for (const e of inv) {
            for (const t of e.licenseTexts) {
                if (t.startsWith('compliance:')) {
                    const rel = t.slice('compliance:'.length);
                    referenced.add(rel);
                    const data = await readFile(join(root, ...rel.split('/')));
                    assert.ok(sources.includes(`| ${rel.replace(/^darwin-arm64\//, '')} | \`${sha256(data).slice(0, 16)}…\``), `${rel} recorded in SOURCES.md`);
                } else {
                    assert.match(t, /^payload:(licenses\/|apio\/packages\/)/, `${e.id}: ${t}`);
                    if (t.startsWith('payload:licenses/')) {
                        const f = t.slice('payload:licenses/'.length);
                        assert.ok(existsSync(join(REPO, 'toolchains', 'bundle', 'licenses', f)) || existsSync(join(REPO, 'toolchains', 'bundle', 'licenses-darwin-arm64', f)), t);
                    }
                }
            }
        }
        for (const e of await readdir(join(root, 'darwin-arm64'), { recursive: true, withFileTypes: true })) {
            if (e.isFile() && e.name !== 'SOURCES.md') assert.ok(referenced.has(join(e.parentPath, e.name).slice(root.length + 1).split(/[\\/]/).join('/')), `${e.name} is referenced`);
        }
    });

    it('the Mach-O origin tool hashes exactly the __TEXT,__text section', async () => {
        const { textSectionHash } = (await import(pathToFileURL(join(REPO, 'scripts', 'compliance', 'macho-origins.mjs')).href)) as { textSectionHash(b: Buffer): string | undefined };
        // A minimal thin 64-bit Mach-O: header, one LC_SEGMENT_64 (__TEXT) with one section (__text) pointing at 8 code bytes.
        const code = Buffer.from([0xfd, 0x7b, 0xbf, 0xa9, 0xc0, 0x03, 0x5f, 0xd6]);
        const header = Buffer.alloc(32);
        header.writeUInt32LE(0xfeedfacf, 0);
        header.writeUInt32LE(1, 16);
        const seg = Buffer.alloc(72 + 80);
        seg.writeUInt32LE(0x19, 0);
        seg.writeUInt32LE(seg.length, 4);
        seg.write('__TEXT', 8);
        seg.writeUInt32LE(1, 64);
        seg.write('__text', 72);
        seg.write('__TEXT', 72 + 16);
        seg.writeBigUInt64LE(BigInt(code.length), 72 + 40);
        seg.writeUInt32LE(32 + seg.length, 72 + 48);
        const file = Buffer.concat([header, seg, code]);
        assert.equal(textSectionHash(file), sha256(code));
        // Install names and signatures (outside __text) do not change the hash.
        assert.equal(textSectionHash(Buffer.concat([file, Buffer.from('codesign-blob')])), sha256(code));
        assert.equal(textSectionHash(Buffer.from('not a mach-o file at all, nope')), undefined);
    });

    it('the manifest generator keeps a platform\'s evidence fields when its inventory is absent (evidence is gathered per platform)', async () => {
        const { buildManifest } = (await import(pathToFileURL(join(REPO, 'scripts', 'compliance', 'manifest.mjs')).href)) as { buildManifest(a: unknown): { manifest: { targets: Record<string, { ossCadSuiteTools: unknown; nativeLibraries: unknown }> }; problems: string[] } };
        const previous = await json<{ targets: Record<string, { ossCadSuiteTools: unknown; nativeLibraries: unknown }> }>('toolchains', 'compliance', 'toolchain-1.0.json');
        const recipes = { 'win32-x64': await recipe('win32-x64'), 'darwin-arm64': await recipe('darwin-arm64') };
        const requirement = await json('toolchains', 'bundle', 'requirement.json');
        const { manifest, problems } = buildManifest({ recipes, requirement, curation: await curation(), inventories: {}, previous });
        assert.deepEqual(problems, []);
        for (const t of TARGETS) {
            assert.deepEqual(manifest.targets[t]!.ossCadSuiteTools, previous.targets[t]!.ossCadSuiteTools, t);
            assert.equal(manifest.targets[t]!.nativeLibraries, previous.targets[t]!.nativeLibraries, t);
        }
        const none = buildManifest({ recipes, requirement, curation: await curation(), inventories: {} });
        assert.ok(none.problems.some((p) => /missing evidence inventory/.test(p)), 'without inventory or previous manifest it fails');
    });
});

describe('Windows bundled runtime libraries (Windows compliance review)', () => {
    const inventory = async () => (await curation()).nativeLibraryInventory['win32-x64']!;
    type WinEntry = LibraryEntry & {
        origin: LibraryEntry['origin'] & { image?: { repository: string; tag: string; layer: string }; rpm?: { nevra: string; sha256header: string; url: string }; srpm?: { file: string; url: string; sha256: string; size: number; shipped: boolean } };
        redistribution?: { permittedBy: string; conditionsForNexysVHDL: string[]; sourceObligation: string; evidence: string[] };
    };
    const winInventory = async () => (await inventory()) as WinEntry[];
    // As scripts/compliance/manifest.mjs requiresSource(): runtime-library exceptions do not require source.
    const needsSource = (e: LibraryEntry) => (e.licenseElected ? [e.licenseElected] : e.licenses).some((l) => COPYLEFT.test(l) && !/GCC-exception|LLVM-exception/.test(l));

    it('the three Windows blockers are resolved with evidence; no blocking item remains and both payloads are unchanged', async () => {
        const c = await curation();
        assert.deepEqual(c.unresolved.filter((u) => u.blocking !== false), []);
        const win = c.resolved.filter((r) => r.platform === 'win32-x64');
        assert.deepEqual(win.map((r) => r.id).sort(), ['win32-apio-microsoft-runtime', 'win32-openxc7-msys2-runtime', 'win32-oss-cad-suite-fedora-mingw-libraries']);
        for (const r of win) assert.ok(r.resolution.length > 300, r.id);
        for (const id of ['apio', 'apio-oss-cad-suite', 'apio-openxc7']) assert.equal(c.components['win32-x64']![id]!.status, 'ready', id);
        const req = await json<{ targets: Record<string, { treeSha256: string }> }>('toolchains', 'bundle', 'requirement.json');
        assert.equal(req.targets['win32-x64']!.treeSha256, '57f0f0da89e6565d6e46d20780fa57af86f8ac36d45a78b750203fc8f381820b');
        assert.equal(req.targets['darwin-arm64']!.treeSha256, 'f04022180f9bb746dc5dc467bc7d1d379512f302159763f8c4a8c0ed50b2aac7');
    });

    it('oss-cad-suite: every Fedora MinGW library is an exact Fedora 39 build (NEVRA, RPM header SHA-256, Koji URL, SRPM SHA-256) from the pinned build image', async () => {
        const inv = await winInventory();
        const fedora = inv.filter((e) => e.origin.kind === 'fedora-rpm');
        assert.equal(fedora.length, 46);
        let files = 0;
        for (const e of fedora) {
            files += e.files.length;
            assert.equal(e.origin.image!.repository, 'docker.io/yosyshq/cross-windows-x64', e.id);
            assert.match(e.origin.image!.layer, /^sha256:833898617f146dc44d1f319bc87603390a1a143e3776505411e0b2445bf9ca86 /, e.id);
            assert.match(e.origin.rpm!.nevra, /^mingw64-.+-[^-]+-[^-]+\.fc3[89]\.(noarch|x86_64)$/, e.id);
            assert.match(e.origin.rpm!.sha256header, /^[0-9a-f]{64}$/, e.id);
            assert.match(e.origin.rpm!.url, /^https:\/\/kojipkgs\.fedoraproject\.org\/packages\/.+\.(noarch|x86_64)\.rpm$/, e.id);
            assert.match(e.origin.srpm!.url, /^https:\/\/kojipkgs\.fedoraproject\.org\/packages\/.+\/src\/.+\.fc3[89]\.src\.rpm$/, e.id);
            assert.match(e.origin.srpm!.sha256, /^[0-9a-f]{64}$/, e.id);
            for (const f of e.files) assert.match(f, /^apio\/packages\/oss-cad-suite\/(lib|bin)\/[^/]+\.dll$/, `${e.id}: ${f}`);
        }
        // 159 Fedora DLLs + the 2 YosysHQ builds = every DLL of the package's lib/ and bin/.
        assert.equal(files, 159);
        assert.deepEqual(inv.find((e) => e.id === 'ocs-yosyshq-libyices')!.files, ['apio/packages/oss-cad-suite/bin/libyices.dll']);
        assert.ok(inv.find((e) => e.id === 'ocs-yosyshq-python-3.11.6')!.files.includes('apio/packages/oss-cad-suite/lib/libpython3.11.dll'));
    });

    it('every copyleft Windows library (Fedora, static GMP, openXC7 runtime) ships its exact source; GCC runtime libraries rely on the GCC exception', async () => {
        const c = await curation();
        const ids = new Map(c.sources.map((s) => [s.id, s]));
        for (const e of await winInventory()) {
            for (const s of e.sources) assert.ok(ids.has(s), `${e.id}: source ${s}`);
            assert.ok(['A', 'B', 'C'].includes(e.usage.class), e.id);
            if (needsSource(e)) assert.ok(e.sources.length, `${e.id} (${e.licenses.join(', ')}) requires source`);
        }
        const inv = await winInventory();
        // Fedora: a copyleft package ships its exact SRPM (Koji URL, SHA-256, size), named after the NEVRA.
        for (const e of inv.filter((x) => x.origin.kind === 'fedora-rpm' && x.origin.srpm!.shipped)) {
            const s = ids.get(e.sources[0]!)!;
            assert.equal(s.kind, 'archive');
            assert.equal(s.url, e.origin.srpm!.url, e.id);
            assert.equal(s.sha256, e.origin.srpm!.sha256, e.id);
            assert.equal(s.file, `fedora39--${e.origin.srpm!.file}`, e.id);
        }
        for (const id of ['ocs-fedora-readline', 'ocs-fedora-termcap', 'ocs-fedora-gettext', 'ocs-fedora-glib2', 'ocs-fedora-gtk3', 'ocs-fedora-qt5-qtbase', 'ocs-fedora-libusbx', 'ocs-fedora-libftdi', 'ocs-fedora-cairo', 'ocs-fedora-pango', 'ocs-fedora-atk', 'ocs-fedora-fribidi', 'ocs-fedora-gdk-pixbuf', 'ocs-fedora-libidn2']) {
            assert.ok(inv.find((e) => e.id === id)!.origin.srpm!.shipped, `${id}: SRPM shipped`);
        }
        // The GCC runtime is under the GCC Runtime Library Exception: SRPM pinned, not required.
        for (const id of ['ocs-fedora-libgcc', 'ocs-fedora-libstdcxx', 'ox-win-gcc-runtime']) {
            assert.match(inv.find((e) => e.id === id)!.licenses[0]!, /WITH GCC-exception-3\.1$/, id);
        }
        // Readline is GPL-3.0-or-later by its own text (Fedora's tag says GPL-2.0-or-later).
        const readline = inv.find((e) => e.id === 'ocs-fedora-readline')!;
        assert.deepEqual(readline.licenses, ['GPL-3.0-or-later']);
        assert.equal(readline.usage.class, 'A', 'Yosys loads readline');
        // yosys.exe and vvp.exe are distributed linked with GPL-only readline/termcap: their sources ship too.
        for (const id of ['ocs-fedora-readline', 'ocs-fedora-termcap']) {
            for (const s of ['oss-yosys', 'oss-iverilog']) assert.ok(inv.find((e) => e.id === id)!.sources.includes(s), `${id}: ${s}`);
        }
        assert.equal(ids.get('oss-yosys')!.revision, '66306a8ca34cb1dcdafe12a5838fa8f0c1a7f4c2');
        // Static GMP 6.1.2: the Fedora SRPM, the build recipe and every program it is linked into.
        const gmp = inv.find((e) => e.id === 'ocs-static-gmp')!;
        for (const s of ['fedora-srpm-mingw-gmp-6.1.2-16.fc39', 'yosyshq-oss-cad-suite-build-2026-03-24', 'oss-cvc4', 'oss-cvc5', 'oss-bitwuzla', 'oss-pono', 'oss-yices', 'libantlr3c-3.4']) assert.ok(gmp.sources.includes(s), `GMP relinking material: ${s}`);
        assert.equal(ids.get('fedora-srpm-mingw-gmp-6.1.2-16.fc39')!.url, 'https://kojipkgs.fedoraproject.org/packages/mingw-gmp/6.1.2/16.fc39/src/mingw-gmp-6.1.2-16.fc39.src.rpm');
    });

    it('openXC7: Nix-built MinGW runtime (nixpkgs 574d1eac), mcfgthread 1.6.1 = v1.6-ga.1 (LGPL-3.0-or-later) with source and recipe', async () => {
        const c = await curation();
        const inv = await winInventory();
        const mcf = inv.find((e) => e.id === 'ox-win-mcfgthread')!;
        assert.deepEqual(mcf.licenses, ['LGPL-3.0-or-later']);
        assert.equal(mcf.usage.class, 'A');
        assert.match(mcf.origin.nixpkgs!, /^NixOS\/nixpkgs 574d1eac1c200690e27b8eb4e24887f8df7ac27c/);
        const src = c.sources.find((s) => s.id === 'mcfgthread-1.6-ga.1')!;
        assert.equal(src.revision, '40263a6e2095ccba83071454191e09f14e9ee232');
        const recipe = c.sources.find((s) => s.id === 'nixpkgs-574d1eac-windows-recipes')!;
        assert.equal(recipe.revision, '574d1eac1c200690e27b8eb4e24887f8df7ac27c');
        assert.ok(recipe.paths!.includes('pkgs/os-specific/windows/mcfgthreads'));
        assert.deepEqual(mcf.sources.sort(), ['mcfgthread-1.6-ga.1', 'nixpkgs-574d1eac-windows-recipes']);
        for (const [id, version] of [['ox-win-gcc-runtime', '13.3.0'], ['ox-win-winpthreads', '11.0.1'], ['ox-win-python-3.11.9', '3.11.9'], ['ox-win-openssl', '3.0.14'], ['ox-win-eigen-compiled-in', '3.4.0']] as const) {
            assert.equal(inv.find((e) => e.id === id)!.version, version, id);
        }
        // The openXC7 runtime is not MSYS2 (the earlier assumption): the resolution says so.
        assert.match(c.resolved.find((r) => r.id === 'win32-openxc7-msys2-runtime')!.resolution, /^Not MSYS2: .*Nix/);
        // Every DLL of the openXC7 package is inventoried.
        const all = inv.filter((e) => e.component === 'apio-openxc7').flatMap((e) => e.files);
        for (const f of ['bin/libmcfgthread-1.dll', 'bin/libgcc_s_seh-1.dll', 'bin/libstdc++-6.dll', 'bin/libwinpthread-1.dll', 'bin/libpython3.11.dll', 'lib/python3.11/lib-dynload/libcrypto-3-x64.dll', 'lib/python3.11/lib-dynload/zlib1.dll']) {
            assert.ok(all.includes(`apio/packages/openxc7/${f}`), f);
        }
    });

    it('Apio: the Microsoft runtime files are identified exactly, with the authoritative redistribution terms and no source obligation', async () => {
        const inv = await winInventory();
        const vc = inv.find((e) => e.id === 'apio-win-vcruntime')!;
        assert.deepEqual(vc.files, ['apio/bin/_internal/VCRUNTIME140.dll', 'apio/bin/_internal/VCRUNTIME140_1.dll']);
        assert.equal(vc.version, '14.51.36247.0');
        const ucrt = inv.find((e) => e.id === 'apio-win-ucrt')!;
        assert.equal(ucrt.files.length, 43);
        assert.ok(ucrt.files.includes('apio/bin/_internal/ucrtbase.dll'));
        assert.equal(ucrt.version, '10.0.26100.1742');
        assert.equal(ucrt.usage.class, 'C', 'the system UCRT is always used on Windows 10/11');
        for (const e of [vc, ucrt]) {
            assert.match(e.licenses[0]!, /^LicenseRef-Microsoft-/);
            assert.equal(e.redistribution!.sourceObligation.startsWith('none'), true, e.id);
            assert.match(e.redistribution!.permittedBy, /^Microsoft → /, e.id);
            assert.ok(e.redistribution!.conditionsForNexysVHDL.some((x) => /unmodified/.test(x)), e.id);
            assert.ok(e.redistribution!.evidence.some((x) => /MicrosoftDocs\/cpp-docs f2355df9/.test(x)), `${e.id}: pinned Microsoft documentation`);
            assert.ok(e.licenseTexts.length >= 1, e.id);
        }
        assert.match(vc.licenseEvidence, /Third Party Distribution/);
        assert.match(ucrt.licenseEvidence, /Third Party Distribution/);
        // The Python runtime is byte-identical to python.org 3.14.7.
        assert.match(inv.find((e) => e.id === 'apio-win-python-runtime')!.origin.archive!, /python-3\.14\.7-embed-amd64\.zip \(SHA-256 d297e5ff/);
    });

    it('every Windows compliance license text is referenced, present and recorded with its SHA-256 and origin', async () => {
        const inv = await winInventory();
        const root = join(REPO, 'toolchains', 'compliance', 'licenses');
        const sources = await readFile(join(root, 'win32-x64', 'SOURCES.md'), 'utf8');
        const referenced = new Set<string>();
        for (const e of inv) {
            for (const t of e.licenseTexts) {
                if (t.startsWith('compliance:')) {
                    const rel = t.slice('compliance:'.length);
                    referenced.add(rel);
                    const data = await readFile(join(root, ...rel.split('/')));
                    if (rel.startsWith('win32-x64/')) assert.ok(sources.includes(`| ${rel.replace(/^win32-x64\//, '')} | \`${sha256(data).slice(0, 16)}…\``), `${rel} recorded in SOURCES.md`);
                } else {
                    assert.match(t, /^payload:(licenses\/|apio\/packages\/)/, `${e.id}: ${t}`);
                    if (t.startsWith('payload:licenses/')) assert.ok(existsSync(join(REPO, 'toolchains', 'bundle', 'licenses', t.slice('payload:licenses/'.length))), t);
                }
            }
        }
        for (const e of await readdir(join(root, 'win32-x64'), { recursive: true, withFileTypes: true })) {
            if (e.isFile() && e.name !== 'SOURCES.md') assert.ok(referenced.has(join(e.parentPath, e.name).slice(root.length + 1).split(/[\\/]/).join('/')), `${e.name} is referenced`);
        }
        // Compliance-only texts never enter a payload.
        assert.ok(!existsSync(join(REPO, 'toolchains', 'bundle', 'licenses-win32-x64')));
    });

    it('the RPM header reader returns the signature-header SHA-256 of an RPM file', async () => {
        const { rpmHeaderSha256 } = (await import(pathToFileURL(join(REPO, 'scripts', 'compliance', 'rpm-header-sha256.mjs')).href)) as { rpmHeaderSha256(b: Buffer): string | undefined };
        // Lead (96 bytes) + signature header with one STRING entry, tag 273.
        const value = Buffer.from(`${'ab'.repeat(32)}\0`);
        const head = Buffer.alloc(16);
        head.writeUInt32BE(0x8eade801, 0);
        head.writeUInt32BE(1, 8);
        head.writeUInt32BE(value.length, 12);
        const entry = Buffer.alloc(16);
        entry.writeUInt32BE(273, 0);
        entry.writeUInt32BE(6, 4);
        const lead = Buffer.alloc(96);
        lead.writeUInt32BE(0xedabeedb, 0);
        assert.equal(rpmHeaderSha256(Buffer.concat([lead, head, entry, value])), 'ab'.repeat(32));
        assert.throws(() => rpmHeaderSha256(Buffer.alloc(200)));
    });

    it('the PE import graph classifies libraries A (loaded by a used program), B (other programs only) and C (unreferenced)', async () => {
        const { classify } = (await import(pathToFileURL(join(REPO, 'scripts', 'compliance', 'pe-closure.mjs')).href)) as { classify(i: Map<string, string[]>, l: Map<string, string>, u: string[]): Record<string, { usage: string }> };
        const imports = new Map([
            ['bin/yosys.exe', ['libreadline8.dll', 'kernel32.dll']],
            ['lib/libreadline8.dll', ['libtermcap-0.dll']],
            ['bin/gtkwave.exe', ['libgtk-3-0.dll']],
            ['lib/libgtk-3-0.dll', []],
            ['lib/libtermcap-0.dll', []],
            ['lib/libunused.dll', []],
        ]);
        const libs = new Map([['libreadline8.dll', 'lib/libreadline8.dll'], ['libtermcap-0.dll', 'lib/libtermcap-0.dll'], ['libgtk-3-0.dll', 'lib/libgtk-3-0.dll'], ['libunused.dll', 'lib/libunused.dll']]);
        const r = classify(imports, libs, ['bin/yosys.exe']);
        assert.equal(r['lib/libreadline8.dll']!.usage, 'A');
        assert.equal(r['lib/libtermcap-0.dll']!.usage, 'A', 'transitively loaded');
        assert.equal(r['lib/libgtk-3-0.dll']!.usage, 'B');
        assert.equal(r['lib/libunused.dll']!.usage, 'C');
    });
});
