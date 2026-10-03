#!/usr/bin/env node
// Assembles the corresponding-source package of a NexysVHDL toolchain version:
//
//   .artifacts/compliance/NexysVHDL-Toolchain-<version>-Sources.zip (+ .sha256)
//
// from the pinned sources of toolchains/compliance/toolchain-<version>.json.
// Build time only; the package is a release asset, never committed to Git.
//
//   npm run compliance:assemble [-- --draft] [-- --record | --record-new] [-- --offline]
//
// - Git sources are fetched by exact commit (never a branch or "latest") into a
//   cache under .artifacts/compliance/git/, with their submodules at the exact
//   commits the tree records, and archived with `git archive` (deterministic
//   tar, gzip without timestamp). A git source with `paths` archives only those
//   paths of the commit (e.g. one port directory of a ports tree; no
//   submodules); sources with the same `cache` share one cache repository.
// - PyPI sources (`pypi-sdist`) and other release files (`archive`: upstream
//   tarballs, distribution mirrors) are downloaded from their pinned URL and
//   must match the pinned SHA-256 and size (and `md5` when the publisher only
//   publishes MD5 sums).
// - toolchains/compliance/sources-<version>.lock.json records the SHA-256 of
//   every produced archive. A run fails if any archive differs from the lock
//   (reproducibility); --record (re)writes the lock instead; --record-new adds
//   only sources the lock does not have yet and still verifies every existing
//   entry (a new platform's sources, without re-recording another platform's).
// - The run fails if any blocking item of the compliance manifest is still
//   unresolved. --draft builds the package anyway, named ...-Sources-DRAFT.zip,
//   marked as a draft in README.md and manifest.json; it must not be published.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { constants, createGzip } from 'node:zlib';
import { fail, listFiles, parseArgs, RECIPE_DIR, REPO_ROOT, sha256File } from '../toolchain/lib.mjs';
import { writeZip } from './zip.mjs';

const COMPLIANCE_DIR = join(REPO_ROOT, 'toolchains', 'compliance');
const WORK = join(REPO_ROOT, '.artifacts', 'compliance');

const args = parseArgs(process.argv.slice(2));
const curation = JSON.parse(readFileSync(join(COMPLIANCE_DIR, 'curation.json'), 'utf8'));
const version = curation.toolchainVersion;
const manifestFile = join(COMPLIANCE_DIR, `toolchain-${version}.json`);
const lockFile = join(COMPLIANCE_DIR, `sources-${version}.lock.json`);
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const draft = Boolean(args.draft);
const packageName = `NexysVHDL-Toolchain-${version}-Sources${draft ? '-DRAFT' : ''}`;

function git(cwd, argv, { allowFail = false } = {}) {
    const r = spawnSync('git', argv, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0 && !allowFail) fail(`git ${argv.join(' ')} (in ${relative(REPO_ROOT, cwd) || '.'}): ${r.stderr.trim()}`);
    return r.status === 0 ? r.stdout : undefined;
}

/** A bare cache repository holding `commit` fetched from `url` (by commit; whole repository if the server refuses). */
function fetchCommit(cacheName, url, commit) {
    const dir = join(WORK, 'git', `${cacheName}.git`);
    if (!existsSync(dir)) git(REPO_ROOT, ['init', '--quiet', '--bare', dir]);
    const has = () => git(dir, ['cat-file', '-e', `${commit}^{commit}`], { allowFail: true }) !== undefined;
    if (!has()) {
        if (args.offline) fail(`${cacheName}: ${commit} is not cached and --offline was given`);
        console.log(`  fetching ${url} ${commit}`);
        if (git(dir, ['fetch', '--quiet', '--depth', '1', url, commit], { allowFail: true }) === undefined || !has()) {
            git(dir, ['fetch', '--quiet', url, '+refs/heads/*:refs/fetched/heads/*', '+refs/tags/*:refs/fetched/tags/*']);
        }
        if (!has()) fail(`${cacheName}: ${url} does not provide commit ${commit}`);
    }
    const full = git(dir, ['rev-parse', `${commit}^{commit}`]).trim();
    if (!full.startsWith(commit)) fail(`${cacheName}: ${commit} resolves to ${full}`);
    return { dir, commit: full };
}

function resolveUrl(base, rel) {
    if (!rel.startsWith('./') && !rel.startsWith('../')) return rel;
    const parts = base.replace(/\/+$/, '').replace(/\.git$/, '').split('/');
    for (const seg of rel.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.') parts.push(seg);
    }
    return parts.join('/');
}

/** Submodules (path, url, commit) recorded in a commit's tree. */
function submodules(dir, commit, url) {
    const tree = git(dir, ['ls-tree', '-r', commit]);
    const links = [...tree.matchAll(/^160000 commit ([0-9a-f]{40})\t(.+)$/gm)].map((m) => ({ commit: m[1], path: m[2] }));
    if (!links.length) return [];
    const gm = git(dir, ['show', `${commit}:.gitmodules`]);
    const byPath = new Map();
    for (const block of gm.split(/^\[submodule /m).slice(1)) {
        const p = /^\s*path\s*=\s*(.+?)\s*$/m.exec(block)?.[1];
        const u = /^\s*url\s*=\s*(.+?)\s*$/m.exec(block)?.[1];
        if (p && u) byPath.set(p, resolveUrl(url, u));
    }
    return links.map((l) => {
        if (!byPath.has(l.path)) fail(`${url} ${commit}: submodule ${l.path} has no URL in .gitmodules`);
        return { ...l, url: byPath.get(l.path) };
    });
}

async function gitArchive(dir, commit, prefix, out, paths = []) {
    const child = spawn('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', `--prefix=${prefix}`, commit, ...(paths.length ? ['--', ...paths] : [])], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
    const done = new Promise((resolve, reject) => child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git archive exited ${code}`)))));
    await pipeline(child.stdout, createGzip({ level: constants.Z_BEST_COMPRESSION }), createWriteStream(out));
    await done;
    await normalizeGzipHeader(out);
}

/**
 * zlib writes the compressing platform into the gzip header's OS byte (RFC 1952
 * offset 9: e.g. 10 on Windows, 19 on macOS), the only platform-dependent byte
 * of these archives (tar and deflate data are identical). Fix it to 255
 * ("unknown") so the same commit gives the same archive bytes everywhere.
 */
async function normalizeGzipHeader(file) {
    const fh = await open(file, 'r+');
    try {
        await fh.write(Buffer.from([0xff]), 0, 1, 9);
    } finally {
        await fh.close();
    }
}

function download(url, to) {
    return new Promise((resolve, reject) => {
        const go = (u, redirects) =>
            get(u, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
                    res.resume();
                    return go(new URL(res.headers.location, u).href, redirects + 1);
                }
                if (res.statusCode !== 200) return reject(new Error(`${u}: HTTP ${res.statusCode}`));
                pipeline(res, createWriteStream(to)).then(resolve, reject);
            }).on('error', reject);
        go(url, 0);
    });
}

const safeName = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '-');

async function buildSources(outDir) {
    const produced = {};
    for (const s of manifest.sources) {
        if (s.kind === 'git') {
            const { dir, commit } = fetchCommit(s.cache ?? s.id, s.url, s.revision);
            const archives = [];
            const queue = [{ dir, commit, url: s.url, prefix: `${s.id}/`, file: `${s.id}.tar.gz`, path: '' }];
            while (queue.length) {
                const a = queue.shift();
                const paths = a.path === '' ? (s.paths ?? []) : [];
                await gitArchive(a.dir, a.commit, a.prefix, join(outDir, a.file), paths);
                archives.push({ path: a.path || '.', url: a.url, commit: a.commit, file: `sources/${a.file}`, sha256: await sha256File(join(outDir, a.file)), size: (await stat(join(outDir, a.file))).size });
                if (paths.length) continue; // a path-limited archive of a large tree: no submodules
                for (const sm of submodules(a.dir, a.commit, a.url)) {
                    const sub = fetchCommit(`${s.id}--${safeName(join(a.path, sm.path))}`, sm.url, sm.commit);
                    const path = a.path ? `${a.path}/${sm.path}` : sm.path;
                    queue.push({ dir: sub.dir, commit: sub.commit, url: sm.url, prefix: `${s.id}/${path}/`, file: `${s.id}--${safeName(path)}.tar.gz`, path });
                }
            }
            produced[s.id] = { kind: 'git', url: s.url, commit, archives };
            console.log(`  ${s.id}: ${archives.length} archive(s)`);
        } else if (s.kind === 'pypi-sdist' || s.kind === 'archive') {
            // The published file name, or `file` when the URL does not end in one (e.g. a raw file at a commit).
            const name = s.file ?? s.url.split('/').pop();
            const cacheDir = join(WORK, s.kind === 'pypi-sdist' ? 'pypi' : 'archives');
            const cached = join(cacheDir, name);
            await mkdir(cacheDir, { recursive: true });
            if (!existsSync(cached) || (await sha256File(cached)) !== s.sha256) {
                if (args.offline) fail(`${s.id}: ${name} is not cached and --offline was given`);
                console.log(`  downloading ${s.url}`);
                await download(s.url, cached);
            }
            const sha = await sha256File(cached);
            const size = (await stat(cached)).size;
            if (sha !== s.sha256 || size !== s.size) fail(`${s.id}: ${name} has SHA-256 ${sha} (${size} B); pinned ${s.sha256} (${s.size} B)`);
            if (s.md5) {
                const md5 = createHash('md5').update(readFileSync(cached)).digest('hex');
                if (md5 !== s.md5) fail(`${s.id}: ${name} has MD5 ${md5}; the publisher lists ${s.md5}`);
            }
            await copyFile(cached, join(outDir, name));
            produced[s.id] = { kind: s.kind, url: s.url, archives: [{ path: '.', file: `sources/${name}`, sha256: sha, size }] };
            console.log(`  ${s.id}: ${name} verified`);
        } else {
            fail(`${s.id}: unknown source kind ${s.kind}`);
        }
    }
    return produced;
}

function readme(produced, blocking) {
    const lines = [
        `# NexysVHDL Toolchain ${version}: corresponding source${draft ? ' (DRAFT, NOT FOR PUBLICATION)' : ''}`,
        '',
        ...(draft ? ['**This is a draft.** The compliance review still has blocking open items (listed below and in `manifest.json` under `unresolved`). Do not publish this package as the corresponding source of Toolchain ' + version + '.', ''] : []),
        `This package contains the source code of the components of NexysVHDL Toolchain ${version} (Windows x64 and macOS Apple silicon) whose licenses require source availability (GNU GPL, GNU LGPL, EUPL, EPL, MPL and similar), at the exact revisions the redistributed binaries were built from.`,
        '',
        `NexysVHDL Toolchain ${version} is an aggregation of separate third-party programs, each under its own license. It is not licensed under the NexysVHDL license (Apache License 2.0, ${curation.nexysvhdl.copyright}; ${curation.nexysvhdl.project}); see \`nexysvhdl/\`.`,
        '',
        '## Contents',
        '',
        '- `manifest.json`: the compliance manifest (every component, license, binary archive, source and open item) plus the SHA-256 of every source archive in this package.',
        '- `sources/`: one `.tar.gz` per source (git sources: `git archive` of the pinned commit, plus one archive per submodule at the commit recorded by the parent tree; PyPI sources: the original sdist).',
        '- `licenses/`: the license texts NexysVHDL ships in the toolchain folders (`shared/`, `<platform>/`), and in `compliance/` additional texts of bundled libraries that a toolchain payload does not carry yet.',
        '- `patches/`: modifications NexysVHDL made to third-party source code (none).',
        '- `nexysvhdl/`: the NexysVHDL license and notice (they do not apply to the third-party components).',
        '',
        'NexysVHDL does not modify, patch or rebuild third-party programs: the binaries are redistributed unmodified from the official archives listed in `manifest.json`, which also records the upstream repository, commit and build recipe of each.',
        '',
        '## Sources',
        '',
        '| Source | License | Upstream | Revision | Archives |',
        '|---|---|---|---|---|',
    ];
    for (const s of manifest.sources) {
        const p = produced[s.id];
        lines.push(`| ${s.id} | ${s.license} | ${s.url} | ${s.kind === 'git' ? `\`${p.commit}\`` : `sha256 \`${s.sha256}\``} | ${p.archives.length} |`);
    }
    if (blocking.length) {
        lines.push('', '## Open items (blocking)', '');
        for (const u of blocking) lines.push(`- **${u.id}** (${u.platform}): ${u.missing} Resolution: ${u.resolution}`);
    }
    return `${lines.join('\n')}\n`;
}

async function main() {
    const sameSources = JSON.stringify(manifest.sources) === JSON.stringify(curation.sources);
    if (!sameSources) fail(`${relative(REPO_ROOT, manifestFile)} is out of date with curation.json: run node scripts/compliance/manifest.mjs`);
    const blocking = manifest.unresolved.filter((u) => u.blocking);
    if (blocking.length && !draft) {
        fail(`the compliance review has ${blocking.length} blocking open item(s): ${blocking.map((u) => u.id).join(', ')}.\n  The corresponding-source package for Toolchain ${version} cannot be released yet. Use --draft to build a draft for review.`);
    }
    const stage = join(WORK, 'package', packageName);
    await rm(stage, { recursive: true, force: true });
    await mkdir(join(stage, 'sources'), { recursive: true });
    console.log(`Building ${packageName}`);
    const produced = await buildSources(join(stage, 'sources'));

    const lock = {
        schemaVersion: 1,
        toolchainVersion: version,
        tools: { git: git(REPO_ROOT, ['--version']).trim(), node: process.version },
        sources: Object.fromEntries(Object.entries(produced).map(([id, p]) => [id, p.archives.map((a) => ({ path: a.path, ...(a.commit ? { commit: a.commit } : {}), file: a.file, sha256: a.sha256, size: a.size }))])),
    };
    if (args.record) {
        writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
        console.log(`Recorded ${relative(REPO_ROOT, lockFile)}`);
    } else if (args['record-new']) {
        const pinned = JSON.parse(readFileSync(lockFile, 'utf8'));
        const diffs = Object.keys(pinned.sources).filter((id) => lock.sources[id] && JSON.stringify(lock.sources[id]) !== JSON.stringify(pinned.sources[id]));
        for (const id of Object.keys(pinned.sources)) if (!lock.sources[id]) diffs.push(`${id} (no longer produced)`);
        if (diffs.length) fail(`existing lock entries differ (not reproducible with ${lock.tools.git}, node ${process.version}?): ${diffs.join(', ')}`);
        const added = Object.keys(lock.sources).filter((id) => !pinned.sources[id]);
        // Keep the lock in manifest source order; existing entries are byte-for-byte the recorded ones.
        const sources = Object.fromEntries(Object.keys(lock.sources).map((id) => [id, pinned.sources[id] ?? lock.sources[id]]));
        writeFileSync(lockFile, `${JSON.stringify({ ...pinned, tools: { ...pinned.tools, ...(added.length ? { [`recordedNew-${process.platform}`]: lock.tools } : {}) }, sources }, null, 2)}\n`);
        console.log(`All ${Object.keys(pinned.sources).length} existing sources match; recorded ${added.length} new source(s) in ${relative(REPO_ROOT, lockFile)}`);
    } else {
        if (!existsSync(lockFile)) fail(`no ${relative(REPO_ROOT, lockFile)}: run once with --record, review it, and commit it`);
        const pinned = JSON.parse(readFileSync(lockFile, 'utf8'));
        const diffs = [];
        for (const [id, archives] of Object.entries(lock.sources)) {
            if (JSON.stringify(archives) !== JSON.stringify(pinned.sources[id])) diffs.push(id);
        }
        for (const id of Object.keys(pinned.sources)) if (!lock.sources[id]) diffs.push(`${id} (no longer produced)`);
        if (diffs.length) fail(`source archives differ from ${relative(REPO_ROOT, lockFile)} (not reproducible with ${lock.tools.git}, node ${process.version}?): ${diffs.join(', ')}`);
        console.log(`All ${Object.keys(lock.sources).length} sources match ${relative(REPO_ROOT, lockFile)}`);
    }

    // License texts shipped in the toolchain folders, and NexysVHDL's own license (kept apart).
    for (const d of (await readdir(RECIPE_DIR, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name.startsWith('licenses'))) {
        for (const f of await listFiles(join(RECIPE_DIR, d.name))) {
            const target = d.name === 'licenses' ? 'shared' : d.name.slice('licenses-'.length);
            await mkdir(join(stage, 'licenses', target), { recursive: true });
            await copyFile(join(RECIPE_DIR, d.name, f), join(stage, 'licenses', target, f));
        }
    }
    // License texts kept only for the release-level notices and this package (toolchains/compliance/licenses/):
    // texts a payload does not ship yet, added without changing an already validated toolchain payload.
    const complianceLicenses = join(COMPLIANCE_DIR, 'licenses');
    if (existsSync(complianceLicenses)) {
        for (const f of await listFiles(complianceLicenses)) {
            await mkdir(join(stage, 'licenses', 'compliance', f, '..'), { recursive: true });
            await copyFile(join(complianceLicenses, f), join(stage, 'licenses', 'compliance', f));
        }
    }
    await mkdir(join(stage, 'nexysvhdl'), { recursive: true });
    for (const f of ['LICENSE', 'NOTICE']) await copyFile(join(REPO_ROOT, f), join(stage, 'nexysvhdl', f));
    await mkdir(join(stage, 'patches'), { recursive: true });
    await writeFile(join(stage, 'patches', 'README.md'), `# Patches\n\nNexysVHDL Toolchain ${version} applies no patches to third-party source code and rebuilds no third-party binary.\n`);
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify({ ...manifest, sourcePackage: { name: `${packageName}.zip`, draft, archives: lock.sources } }, null, 2)}\n`);
    await writeFile(join(stage, 'README.md'), readme(produced, blocking));

    const zip = join(WORK, `${packageName}.zip`);
    const count = await writeZip(stage, zip);
    const sha = await sha256File(zip);
    await writeFile(`${zip}.sha256`, `${sha}  ${packageName}.zip\n`);
    const size = (await stat(zip)).size;
    console.log(`Wrote ${relative(REPO_ROOT, zip)}: ${count} files, ${(size / 2 ** 20).toFixed(1)} MiB, SHA-256 ${sha}`);
    if (blocking.length) console.log(`DRAFT: ${blocking.length} blocking open item(s) remain; do not publish.`);
}

await main();
