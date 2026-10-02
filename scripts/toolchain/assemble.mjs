#!/usr/bin/env node
// Assembles the private NexysVHDL FPGA toolchain for one platform package from
// the official release archives pinned in toolchains/bundle/<target>.json.
//
//   node scripts/toolchain/assemble.mjs [--target win32-x64] [--archives <dir>] [--download]
//
// Every archive is checked against the recipe (size + SHA-256) before it is
// extracted; nothing is taken from a developer's local tool installation.
// Output (ignored by Git): toolchain/<target>/ with toolchain-manifest.json.
// Build time only: needs the system `tar` (bsdtar on Windows 10+ and macOS).
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
    apioInstalledPackages,
    apioRemoteConfig,
    apioRemoteConfigFileName,
    ARCHIVE_DIR,
    fail,
    hostTarget,
    inventory,
    listFiles,
    loadRecipe,
    MANIFEST_NAME,
    NOTICES_NAME,
    parseArgs,
    RECIPE_DIR,
    REPO_ROOT,
    sha256File,
    TOOLCHAIN_DIR,
} from './lib.mjs';
import { renderNotices } from './notices.mjs';

const args = parseArgs(process.argv.slice(2));
const target = args.target ?? hostTarget();
const archiveDir = args.archives ?? ARCHIVE_DIR;
const recipe = loadRecipe(target);
const out = join(TOOLCHAIN_DIR, target);
const staging = join(TOOLCHAIN_DIR, `.staging-${target}`);
const GENERATED_MTIME = new Date('2026-09-26T00:00:00Z');

function tarExecutable() {
    // Windows 10+ ships bsdtar as System32\tar.exe; a Git-for-Windows/MSYS GNU tar on PATH cannot read zip.
    if (process.platform === 'win32') return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    return '/usr/bin/tar';
}

async function download(url, file) {
    console.log(`  downloading ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) fail(`download failed (${res.status}): ${url}`);
    const tmp = `${file}.part`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    await rename(tmp, file);
}

async function verifyArchive(c) {
    const file = join(archiveDir, c.archive.file);
    if (!existsSync(file)) {
        if (!args.download) fail(`${c.id}: missing archive ${file} (run with --download to fetch ${c.archive.url})`);
        await mkdir(archiveDir, { recursive: true });
        await download(c.archive.url, file);
    }
    const size = (await stat(file)).size;
    if (size !== c.archive.size) fail(`${c.id}: ${c.archive.file} is ${size} bytes, recipe says ${c.archive.size}`);
    const sha = await sha256File(file);
    if (sha !== c.archive.sha256) fail(`${c.id}: ${c.archive.file} sha256 ${sha} does not match the recipe ${c.archive.sha256}`);
    return file;
}

function extract(file, dest, strip) {
    const tarArgs = ['-xf', file, '-C', dest, ...(strip ? [`--strip-components=${strip}`] : [])];
    const r = spawnSync(tarExecutable(), tarArgs, { stdio: ['ignore', 'inherit', 'inherit'], shell: false });
    if (r.status !== 0) fail(`extracting ${file} failed (tar exit ${r.status ?? r.error})`);
}

async function main() {
    console.log(`Assembling NexysVHDL toolchain ${recipe.bundleVersion} for ${target}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });

    const components = [];
    for (const c of recipe.components) {
        const file = await verifyArchive(c);
        console.log(`  ${c.id} ${c.version}: ${c.archive.file} verified`);
        const dest = join(staging, ...c.dest.split('/'));
        await mkdir(dest, { recursive: true });
        extract(file, dest, c.archive.strip);
        for (const [name, expected] of Object.entries(c.verifyFiles ?? {})) {
            const actual = await sha256File(join(dest, name));
            if (actual !== expected) fail(`${c.id}: ${name} sha256 ${actual}, expected ${expected}`);
        }
    }

    // Apio state that lives with the immutable packages: the package index Apio
    // itself would have written, and the remote config pinned to the same tags.
    const packagesDir = join(staging, ...recipe.apio.packagesDir.split('/'));
    await writeFile(join(packagesDir, 'installed_packages.json'), `${JSON.stringify(apioInstalledPackages(recipe), null, 4)}`);
    const remoteConfigDir = join(staging, ...recipe.apio.remoteConfigDir.split('/'));
    await mkdir(remoteConfigDir, { recursive: true });
    const remoteConfigFile = apioRemoteConfigFileName(recipe.apio.version);
    await writeFile(
        join(remoteConfigDir, remoteConfigFile),
        `// NexysVHDL pinned Apio remote config (generated from toolchains/bundle/${target}.json).\n// Every package is pinned to the validated release tag, so Apio never upgrades the bundle.\n${JSON.stringify(apioRemoteConfig(recipe), null, 2)}\n`,
    );

    // NexysVHDL-authored shims (e.g. `python` for openXC7's scripts), generated from the recipe.
    for (const shim of recipe.shims ?? []) {
        if (!existsSync(join(staging, ...shim.target.split('/')))) fail(`shim ${shim.file}: target ${shim.target} not found`);
        const file = join(staging, ...shim.file.split('/'));
        await mkdir(join(file, '..'), { recursive: true });
        const depth = shim.file.split('/').length - 1;
        if (shim.file.endsWith('.cmd')) {
            const rel = `${'..\\'.repeat(depth)}${shim.target.replaceAll('/', '\\')}`;
            await writeFile(file, `@echo off\r\nrem NexysVHDL toolchain shim (see toolchains/bundle/${target}.json "shims").\r\n"%~dp0${rel}" %*\r\n`);
        } else {
            const rel = `${'../'.repeat(depth)}${shim.target}`;
            await writeFile(file, `#!/bin/sh\n# NexysVHDL toolchain shim (see toolchains/bundle/${target}.json "shims").\nexec "$(dirname "$0")/${rel}" "$@"\n`, { mode: 0o755 });
        }
    }

    // Executables must exist where the recipe says.
    for (const [tool, rel] of Object.entries(recipe.executables)) {
        if (!existsSync(join(staging, ...rel.split('/')))) fail(`executable ${tool} not found at ${rel} after extraction`);
    }

    // Inventory per component (nested component folders are counted once, by the innermost component).
    const dests = recipe.components.map((c) => c.dest);
    for (const c of recipe.components) {
        const nested = dests.filter((d) => d !== c.dest && d.startsWith(`${c.dest}/`)).map((d) => d.slice(c.dest.length + 1));
        const inv = await inventory(join(staging, ...c.dest.split('/')), { exclude: nested });
        components.push({
            id: c.id,
            name: c.name,
            version: c.version,
            description: c.description,
            license: c.license,
            licenseEvidence: c.licenseEvidence,
            homepage: c.homepage,
            sourceCode: c.sourceCode,
            path: c.dest,
            licenseFiles: c.licenseFiles ?? [],
            archive: c.archive,
            ...(c.apioPackage ? { apioPackage: { name: c.apioPackage.name, releaseTag: c.apioPackage.releaseTag } } : {}),
            content: { files: inv.files, bytes: inv.bytes, treeSha256: inv.treeSha256 },
        });
        console.log(`  ${c.id}: ${inv.files} files, ${(inv.bytes / 2 ** 20).toFixed(1)} MiB`);
    }

    const executables = {};
    for (const [tool, rel] of Object.entries(recipe.executables)) executables[tool] = { path: rel, sha256: await sha256File(join(staging, ...rel.split('/'))) };

    const manifest = {
        schemaVersion: 1,
        product: 'NexysVHDL',
        bundleVersion: recipe.bundleVersion,
        target,
        platform: recipe.platform,
        arch: recipe.arch,
        displayPlatform: recipe.displayPlatform,
        recipe: `toolchains/bundle/${target}.json`,
        recipeSha256: await sha256File(join(RECIPE_DIR, `${target}.json`)),
        versions: recipe.versions,
        executables,
        apio: {
            version: recipe.apio.version,
            platformId: recipe.apio.platformId,
            packagesDir: recipe.apio.packagesDir,
            remoteConfig: `${recipe.apio.remoteConfigDir}/${remoteConfigFile}`,
            remoteConfigTemplate: `${recipe.apio.remoteConfigDir}/apio-{major}.{minor}.x.jsonc`,
            packages: Object.fromEntries(recipe.components.filter((c) => c.apioPackage).map((c) => [c.apioPackage.name, c.apioPackage.releaseTag.replaceAll('-', '.')])),
        },
        environment: { pathPrepend: recipe.environment?.pathPrepend ?? [], set: recipe.environment?.set ?? {} },
        shims: (recipe.shims ?? []).map((s) => ({ file: s.file, target: s.target })),
        programmer: recipe.programmer,
        components,
    };
    await writeFile(join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(staging, NOTICES_NAME), renderNotices(manifest));
    // Full license texts for components whose archives ship none.
    const licenseSrc = join(RECIPE_DIR, 'licenses');
    if (existsSync(licenseSrc)) await cp(licenseSrc, join(staging, 'licenses'), { recursive: true });

    // Files NexysVHDL generates get a fixed timestamp, so the packed archive is reproducible.
    const generated = [MANIFEST_NAME, NOTICES_NAME, `${recipe.apio.packagesDir}/installed_packages.json`, `${recipe.apio.remoteConfigDir}/${remoteConfigFile}`, ...(recipe.shims ?? []).map((s) => s.file)];
    if (existsSync(licenseSrc)) generated.push(...(await listFiles(join(staging, 'licenses'))).map((f) => `licenses/${f}`));
    for (const rel of generated) await utimes(join(staging, ...rel.split('/')), GENERATED_MTIME, GENERATED_MTIME);

    await rm(out, { recursive: true, force: true });
    await rename(staging, out);
    const total = await inventory(out);
    console.log(`Done: ${relative(REPO_ROOT, out)} — ${total.files} files, ${(total.bytes / 2 ** 20).toFixed(1)} MiB, tree ${total.treeSha256}`);
    await writeFile(join(TOOLCHAIN_DIR, `${target}.inventory.json`), `${JSON.stringify({ target, files: total.files, bytes: total.bytes, treeSha256: total.treeSha256 }, null, 2)}\n`);
}

// Never leave a half-built toolchain in place of a good one.
main().catch(async (err) => {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    fail(err.stack ?? String(err));
});
