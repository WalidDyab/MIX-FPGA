#!/usr/bin/env node
// Builds the complete macOS Apple-silicon release of NexysVHDL from the CURRENT, COMMITTED source:
//
//   node scripts/release/macos-release.mjs [--allow-dirty] [--skip-zip]
//
//   1. scripts/package.mjs      typecheck, build, VSIX (content + privacy audits), toolchain requirement check
//   2. scripts/launcher/build-macos.mjs   NexysVHDL.app (launcher + the VSIX + icon; no toolchain)
//   3. NexysVHDL-<version>-darwin-arm64.dmg   NexysVHDL.app + an Applications shortcut (drag to install)
//   4. .artifacts/release/NexysVHDL-<version>-darwin-arm64/   everything a student receives, with SHA256SUMS.txt and RELEASE-MANIFEST.json
//
// The FPGA toolchain archive is the FROZEN, validated artifact named by toolchains/bundle/requirement.json (never rebuilt here);
// the toolchain source/compliance archive is the frozen one from .artifacts/compliance. Nothing is written outside .artifacts/.
//
// Signing and notarization are never faked. With NEXYSVHDL_CODESIGN_IDENTITY (a "Developer ID Application: ..." identity)
// the app and the DMG are signed with the hardened runtime. With NEXYSVHDL_NOTARY_PROFILE (a `xcrun notarytool
// store-credentials` profile) as well, the DMG is notarized and the ticket stapled. Without them the release is an
// unsigned beta (the app carries only the ad-hoc signature Apple silicon requires) and RELEASE-MANIFEST.json says so.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, cp, link, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fail, parseArgs, REPO_ROOT, sha256File } from '../toolchain/lib.mjs';

const args = parseArgs(process.argv.slice(2));
if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('this builds the Apple-silicon macOS release');
const target = 'darwin-arm64';
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const requirement = JSON.parse(readFileSync(join(REPO_ROOT, 'toolchains', 'bundle', 'requirement.json'), 'utf8'));
const want = requirement.targets[target];
const git = (...a) => spawnSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
const commit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain') !== '';
if (dirty && !args['allow-dirty']) fail('the working tree has uncommitted changes: commit first so the manifest names the exact source (or pass --allow-dirty for a trial build)');

const run = (cmd, a, opts = {}) => {
    console.log(`> ${cmd} ${a.join(' ')}`);
    const r = spawnSync(cmd, a, { cwd: REPO_ROOT, stdio: 'inherit', shell: false, ...opts });
    if (r.status !== 0) fail(`${cmd} ${a.join(' ')} failed (${r.status})`);
};
const node = process.execPath;
const identity = process.env.NEXYSVHDL_CODESIGN_IDENTITY;
const notaryProfile = process.env.NEXYSVHDL_NOTARY_PROFILE;

// 1. VSIX with the full audit gates (also verifies the toolchain archive against requirement.json).
run(node, ['scripts/package.mjs', '--target', target, '--skip-zip']);
const dist = join(REPO_ROOT, '.artifacts', 'dist');
const vsixName = `nexysvhdl-${pkg.version}-${target}.vsix`;
const vsix = join(dist, vsixName);
if (!existsSync(vsix)) fail(`${vsixName} was not produced`);

// 2. The app.
run(node, ['scripts/launcher/build-macos.mjs', '--vsix', vsix]);
const app = join(REPO_ROOT, '.artifacts', 'launcher', 'NexysVHDL.app');
if (!existsSync(join(app, 'Contents', 'MacOS', 'NexysVHDL'))) fail('NexysVHDL.app was not produced');

// 3. The disk image: the app and an Applications shortcut, in the normal macOS "drag to install" arrangement.
const release = join(REPO_ROOT, '.artifacts', 'release');
const name = `NexysVHDL-${pkg.version}-${target}`;
const folder = join(release, name);
await rm(folder, { recursive: true, force: true });
await mkdir(join(folder, 'Licenses_and_Source'), { recursive: true });
const staging = join(release, '.dmg-staging');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
run('ditto', [app, join(staging, 'NexysVHDL.app')]); // keeps the bundle's signature and attributes intact
await symlink('/Applications', join(staging, 'Applications'));
const dmgName = `${name}.dmg`;
const dmg = join(folder, dmgName);
run('hdiutil', ['create', '-volname', `NexysVHDL ${pkg.version}`, '-srcfolder', staging, '-fs', 'HFS+', '-format', 'UDZO', '-ov', dmg]);
await rm(staging, { recursive: true, force: true });
let signing = 'unsigned';
if (identity) {
    run('codesign', ['--force', '--timestamp', '--sign', identity, dmg]);
    signing = 'developer-id-signed';
    if (notaryProfile) {
        run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', notaryProfile, '--wait']);
        run('xcrun', ['stapler', 'staple', dmg]);
        signing = 'developer-id-signed-notarized-stapled';
    }
}

// 4. The release folder.
const place = async (from, to) => {
    await link(from, to).catch(() => copyFile(from, to));
    return to;
};
const toolchainArchive = join(dist, want.archive);
const sources = join(REPO_ROOT, '.artifacts', 'compliance', 'NexysVHDL-Toolchain-1.0-Sources.zip');
if (!existsSync(toolchainArchive)) fail(`the frozen toolchain archive ${want.archive} is missing from .artifacts/dist`);
if (!existsSync(sources)) fail('the frozen toolchain source archive is missing from .artifacts/compliance');
const items = [
    { role: 'disk-image', file: dmg },
    { role: 'extension', file: await place(vsix, join(folder, vsixName)) },
    { role: 'toolchain', file: await place(toolchainArchive, join(folder, want.archive)) },
    { role: 'toolchain-sources', file: await place(sources, join(folder, 'Licenses_and_Source', 'NexysVHDL-Toolchain-1.0-Sources.zip')) },
    { role: 'notices', file: await place(join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md'), join(folder, 'Licenses_and_Source', 'THIRD_PARTY_NOTICES.md')) },
    { role: 'license', file: await place(join(REPO_ROOT, 'LICENSE'), join(folder, 'Licenses_and_Source', 'LICENSE')) },
    { role: 'notice', file: await place(join(REPO_ROOT, 'NOTICE'), join(folder, 'Licenses_and_Source', 'NOTICE')) },
    { role: 'readme', file: await place(join(REPO_ROOT, 'docs', 'classroom', 'README-MACOS.md'), join(folder, 'README-MACOS.md')) },
    { role: 'install-guide', file: await place(join(REPO_ROOT, 'docs', 'student-install-macos.md'), join(folder, 'INSTALL.md')) },
];

// The toolchain must be exactly the frozen one.
const toolchainSha = await sha256File(toolchainArchive);
const recorded = readFileSync(`${toolchainArchive}.sha256`, 'utf8').split(/\s+/)[0];
if (toolchainSha !== recorded) fail('the toolchain archive does not match its recorded .sha256');

const artifacts = [];
for (const it of items) artifacts.push({ role: it.role, name: relative(folder, it.file).split('\\').join('/'), bytes: (await stat(it.file)).size, sha256: await sha256File(it.file) });
const manifest = {
    product: 'NexysVHDL',
    version: pkg.version,
    platform: target,
    toolchain: { version: requirement.bundleVersion, archive: want.archive, sha256: toolchainSha, installedTreeSha256: want.treeSha256, rebuilt: false },
    source: { commit, dirty },
    signing: { status: signing, appSignature: identity ? 'developer-id' : 'ad-hoc', notarized: signing.includes('notarized') },
    builtAt: new Date().toISOString(),
    artifacts,
};
await writeFile(join(folder, 'RELEASE-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const names = [...artifacts.map((a) => a.name), 'RELEASE-MANIFEST.json'];
const lines = [];
for (const n of names.sort()) lines.push(`${await sha256File(join(folder, ...n.split('/')))}  ${n}`);
await writeFile(join(folder, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
console.log(`\nrelease folder: ${relative(REPO_ROOT, folder)}`);
for (const a of artifacts) console.log(`  ${a.name.padEnd(62)} ${String(a.bytes).padStart(12)}  ${a.sha256}`);

if (!args['skip-zip']) {
    const zip = join(release, `${name}.zip`);
    await rm(zip, { force: true });
    run('ditto', ['-c', '-k', '--keepParent', folder, zip]);
    console.log(`release zip: ${relative(REPO_ROOT, zip)} ${(await stat(zip)).size} bytes sha256 ${await sha256File(zip)}`);
    await writeFile(`${zip}.sha256`, `${await sha256File(zip)}  ${name}.zip\n`);
}
console.log(`\nsigning: ${signing}`);
console.log(`source commit ${commit}${dirty ? ' (DIRTY)' : ''}`);
