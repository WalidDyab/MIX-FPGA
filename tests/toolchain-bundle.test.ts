import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import {
    apioFileUrl,
    apioPathProblem,
    bundleCompatibilityManifest,
    BundledToolLocator,
    BundledToolRunner,
    extractTarGz,
    installedToolchain,
    installToolchainArchive,
    inventoryDirectory,
    loadBundledToolchain,
    posixLinkTarget,
    safeArchivePath,
    safeLinkTarget,
    storePaths,
    treeHash,
    validateRequirement,
    verifyInstalledToolchain,
    writeTarGz,
} from '../core';
import { fakeArchive, writeFakeBundle } from './bundle-fixture';
import { FakeRunner, REPO, tempDir, writeFiles } from './helpers';

const WIN = { platform: 'win32', arch: 'x64' } as const;
const SYSTEM_PATH = ['C:\\Windows\\System32', 'C:\\Windows'];

async function loadFake(t: Parameters<typeof tempDir>[0], options: Parameters<typeof writeFakeBundle>[1] = {}, stateName = 'state') {
    const dir = await tempDir(t, 'nexys-bundle-');
    const bundleDir = join(dir, 'toolchains', 'win32-x64', '1.0');
    await writeFakeBundle(bundleDir, options);
    const inheritedEnv = { Path: 'C:\\Python314;C:\\Users\\student\\.apio\\bin', PYTHONPATH: 'x', PYTHONHOME: 'y', APIO_HOME: 'C:\\Users\\student\\.apio', SystemRoot: 'C:\\Windows' };
    const r = await loadBundledToolchain({ bundleDir, host: WIN, stateDir: join(dir, stateName), systemPath: SYSTEM_PATH, inheritedEnv });
    return { dir, bundleDir, r };
}

describe('bundled toolchain: loading and resolution', () => {
    it('resolves absolute executables, the private Apio state and the bundle environment', async (t) => {
        const { dir, bundleDir, r } = await loadFake(t);
        assert.deepEqual(r.diagnostics, []);
        const tc = r.toolchain!;
        assert.equal(tc.executables.ghdl, join(bundleDir, 'ghdl', 'bin', 'ghdl.exe'));
        assert.equal(tc.executables.apio, join(bundleDir, 'apio', 'bin', 'apio.exe'));
        assert.equal(tc.executables.programmer, undefined, 'the Windows bundle carries no programmer');
        const env = tc.environment;
        assert.equal(env['APIO_HOME'], join(dir, 'state', 'apio-home'), 'Apio state lives in the NexysVHDL state folder');
        assert.equal(env['APIO_PACKAGES'], join(bundleDir, 'apio', 'packages'));
        assert.equal(env['APIO_REMOTE_CONFIG_URL'], `file://${join(bundleDir, 'apio', 'remote-config').split(sep).join('/')}/apio-{major}.{minor}.x.jsonc`);
        assert.equal(env['PATH'], [join(bundleDir, 'shims'), ...SYSTEM_PATH].join(delimiter), 'PATH = bundle shims + OS folders only');
        assert.equal(env['PYTHONDONTWRITEBYTECODE'], '1');
        for (const inherited of ['Path', 'PYTHONPATH', 'PYTHONHOME']) assert.ok(inherited in env && env[inherited] === undefined, `${inherited} is removed`);
        assert.ok(!Object.values(env).some((v) => v?.includes('.apio') || v?.includes('Python314')), 'nothing points at ~/.apio or a system Python');
    });

    it('refuses a bundle for another platform', async (t) => {
        const { r } = await loadFake(t, { target: 'darwin-arm64' });
        assert.equal(r.toolchain, undefined);
        assert.deepEqual(r.diagnostics.map((d) => d.code), ['BUNDLE_WRONG_PLATFORM']);
    });

    it('reports a missing manifest and missing executables', async (t) => {
        const dir = await tempDir(t, 'nexys-bundle-');
        const none = await loadBundledToolchain({ bundleDir: join(dir, 'nothing'), host: WIN, stateDir: dir, systemPath: [], inheritedEnv: {} });
        assert.deepEqual(none.diagnostics.map((d) => d.code), ['BUNDLE_MISSING']);
        const { r } = await loadFake(t, { manifest: (m) => ({ ...m, executables: { ...m.executables, ghdl: { path: 'ghdl/bin/missing.exe', sha256: '' } } }) });
        assert.equal(r.toolchain, undefined);
        assert.ok(r.diagnostics.some((d) => d.code === 'BUNDLE_INCOMPLETE'));
    });

    it('never resolves an executable outside the bundle', async (t) => {
        for (const path of ['../../../Windows/System32/cmd.exe', 'C:/Windows/notepad.exe', '/usr/bin/env', 'ghdl\\bin\\ghdl.exe']) {
            const { r } = await loadFake(t, { manifest: (m) => ({ ...m, executables: { ...m.executables, ghdl: { path, sha256: '' } } }) });
            assert.equal(r.toolchain, undefined, path);
            assert.ok(r.diagnostics.some((d) => d.code === 'BUNDLE_MANIFEST_INVALID'), path);
        }
    });

    it('disables Apio (never "repairs" the bundle) when its package state differs from the pinned versions', async (t) => {
        const mismatch = await loadFake(t, { files: { 'apio/packages/installed_packages.json': JSON.stringify({ definitions: { version: '2026.09.17', platform: 'windows-amd64' }, openxc7: { version: '2026.09.27', platform: 'windows-amd64' } }) } });
        assert.equal(mismatch.r.toolchain?.executables.apio, undefined);
        assert.ok(mismatch.r.toolchain?.executables.ghdl, 'GHDL still works');
        assert.ok(mismatch.r.diagnostics.some((d) => d.code === 'BUNDLE_APIO_INCONSISTENT'));
        assert.equal(mismatch.r.toolchain?.environment['APIO_HOME'], undefined);

        const orphan = await loadFake(t, { files: { 'apio/packages/stray/file.txt': 'x' } });
        assert.equal(orphan.r.toolchain?.executables.apio, undefined, 'Apio would delete an unknown package folder');
        assert.match(orphan.r.diagnostics[0]!.message, /Unexpected entry "stray"/);
    });

    it('keeps Check/Simulate but disables Apio when a path has a space (Apio requirement)', async (t) => {
        const { r } = await loadFake(t, {}, 'state with space');
        assert.ok(r.toolchain?.executables.ghdl);
        assert.equal(r.toolchain?.executables.apio, undefined);
        assert.deepEqual(r.diagnostics.map((d) => d.code), ['BUNDLE_PATH_UNSUPPORTED']);
        assert.match(r.diagnostics[0]!.message, /Check and Simulate still work/);
    });

    it('apioPathProblem and apioFileUrl follow Apio\'s rules', () => {
        assert.equal(apioPathProblem('C:\\Users\\student\\AppData\\Local\\NexysVHDL'), undefined);
        assert.equal(apioPathProblem('C:\\Users\\John Smith\\AppData'), 'a space');
        assert.equal(apioPathProblem('C:\\Users\\José\\AppData'), 'the character "é"');
        assert.throws(() => apioFileUrl('relative/path'));
        assert.throws(() => apioFileUrl(join(sep, 'a{b}', 'apio-{major}.{minor}.x.jsonc')));
    });
});

describe('bundled toolchain: locator, runner and expected versions', () => {
    it('locates only bundled executables (no PATH, no overrides)', async (t) => {
        const { r } = await loadFake(t);
        const locator = new BundledToolLocator(r.toolchain!);
        assert.equal((await locator.locate('ghdl'))?.method, BundledToolLocator.METHOD);
        assert.equal(await locator.locate('programmer'), undefined);
        assert.equal(await locator.locate('yosys'), undefined);
    });

    it('starts every tool with the bundle environment and creates the private Apio home once', async (t) => {
        const { r } = await loadFake(t);
        const inner = new FakeRunner();
        const made: string[] = [];
        const runner = new BundledToolRunner(inner, r.toolchain!, async (p) => made.push(p));
        await runner.run({ executable: r.toolchain!.executables.apio!, args: ['--version'], env: { APIO_HOME: 'C:\\Users\\student\\.apio', OTHER: '1' } });
        await runner.run({ executable: r.toolchain!.executables.ghdl!, args: ['--version'] });
        assert.deepEqual(made, [r.toolchain!.apioHome]);
        assert.equal(inner.calls[0]!.env!['APIO_HOME'], r.toolchain!.apioHome, 'a caller cannot point Apio back at ~/.apio');
        assert.equal(inner.calls[0]!.env!['OTHER'], '1');
        assert.equal(inner.calls[1]!.env!['PATH'], r.toolchain!.environment['PATH']);
    });

    it('expected versions come from the bundle itself', async (t) => {
        const { r } = await loadFake(t);
        const m = bundleCompatibilityManifest(r.toolchain!.manifest);
        assert.equal(m.id, 'bundle-win32-x64-1.0');
        assert.deepEqual(Object.fromEntries(m.tools.map((x) => [x.tool, x.testedVersions])), {
            ghdl: ['6.0.0'], apio: ['1.6.0'], openxc7: ['2026-09-24'], yosys: ['0.63+173'], 'nextpnr-xilinx': ['0eae9fb'], programmer: ['2.7.1'],
        });
    });
});

describe('toolchain archive (tar.gz)', () => {
    it('round-trips files, long paths, non-ASCII names and empty files with an identical tree hash', async (t) => {
        const dir = await tempDir(t, 'nexys-tar-');
        const src = join(dir, 'src');
        const long = `${'deep/'.repeat(30)}file-with-a-long-name.txt`;
        await writeFiles(src, { 'a.txt': 'alpha', [long]: 'long path', 'ünïcode/ñame.txt': 'utf8', 'empty.bin': '' });
        await mkdir(join(src, 'empty-dir'));
        const before = await inventoryDirectory(src);
        await writeTarGz(src, join(dir, 'x.tar.gz'));
        const out = join(dir, 'out');
        await mkdir(out);
        const extracted = await extractTarGz(join(dir, 'x.tar.gz'), out);
        assert.equal(extracted.treeSha256, before.treeSha256);
        assert.equal((await inventoryDirectory(out)).treeSha256, before.treeSha256);
        assert.equal(await readFile(join(out, ...long.split('/')), 'utf8'), 'long path');
        assert.ok((await stat(join(out, 'empty-dir'))).isDirectory());
    });

    it('writes the same archive bytes for the same content (deterministic)', async (t) => {
        const dir = await tempDir(t, 'nexys-tar-');
        await writeFiles(join(dir, 'src'), { 'b.txt': 'b', 'a/c.txt': 'c' });
        await writeTarGz(join(dir, 'src'), join(dir, '1.tar.gz'));
        await writeTarGz(join(dir, 'src'), join(dir, '2.tar.gz'));
        const h = async (f: string) => createHash('sha256').update(await readFile(join(dir, f))).digest('hex');
        assert.equal(await h('1.tar.gz'), await h('2.tar.gz'));
    });

    it('refuses unsafe paths, links, damaged headers and truncation', async (t) => {
        for (const bad of ['../evil.txt', '/etc/passwd', 'C:/x', 'a/../../b', 'a\\b', 'con:x', 'trailing.', 'a/./b']) assert.equal(safeArchivePath(bad), undefined, bad);
        assert.equal(safeArchivePath('apio/packages/x.json'), 'apio/packages/x.json');

        const dir = await tempDir(t, 'nexys-tar-');
        const header = (name: string, type: string, size = 0, linkname = '') => {
            const b = Buffer.alloc(512);
            b.write(name, 0);
            b.write(linkname, 157);
            b.write('0000644\0', 100);
            b.write('0000000\0', 108);
            b.write('0000000\0', 116);
            b.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
            b.write('00000000000\0', 136);
            b.write('        ', 148);
            b.write(type, 156);
            b.write('ustar\0', 257);
            let sum = 0;
            for (const x of b) sum += x;
            b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
            return b;
        };
        const archive = async (name: string, blocks: Buffer[]) => {
            const f = join(dir, name);
            await writeFile(f, gzipSync(Buffer.concat(blocks)));
            const out = join(dir, `${name}.out`);
            await mkdir(out);
            return { f, out };
        };
        const cases: Array<[string, Buffer[], RegExp]> = [
            ['traversal', [header('../evil.txt', '0'), Buffer.alloc(1024)], /unsafe path/],
            ['symlink without target', [header('link', '2'), Buffer.alloc(1024)], /unsafe symbolic link/],
            ['absolute symlink', [header('link', '2', 0, '/etc'), Buffer.alloc(1024)], /unsafe symbolic link/],
            ['escaping symlink', [header('a/link', '2', 0, '../../evil.txt'), Buffer.alloc(1024)], /unsafe symbolic link/],
            ['inner .. in symlink', [header('a/link', '2', 0, 'b/../../evil.txt'), Buffer.alloc(1024)], /unsafe symbolic link/],
            ['entry written through a symlink', [header('a', '2', 0, 'b'), header('a/evil.txt', '0'), Buffer.alloc(1024)], /below a symbolic link/],
            ['symlink replacing a folder with entries', [header('a/x.txt', '0'), header('a', '2', 0, 'b'), Buffer.alloc(1024)], /below a symbolic link/],
            ['hard link', [header('link', '1', 0, 'a.txt'), Buffer.alloc(1024)], /hard links and special files are not allowed/],
            ['damaged', [(() => { const h = header('a.txt', '0'); h[0] = 0x62; return h; })(), Buffer.alloc(1024)], /checksum/],
            ['truncated', [header('a.txt', '0', 600), Buffer.alloc(100)], /truncated/],
        ];
        for (const [name, blocks, expected] of cases) {
            const { f, out } = await archive(name, blocks);
            await assert.rejects(extractTarGz(f, out), expected, name);
            assert.equal(existsSync(join(dir, 'evil.txt')), false);
        }
    });

    it('uses the same tree-hash definition as the build scripts', async (t) => {
        const dir = await tempDir(t, 'nexys-tar-');
        await writeFiles(dir, { 'z.txt': 'z', 'a/b.txt': 'bb', 'a/a.txt': '' });
        const lib = (await import(pathToFileURL(join(REPO, 'scripts', 'toolchain', 'lib.mjs')).href)) as { inventory(dir: string): Promise<{ treeSha256: string }> };
        assert.equal((await lib.inventory(dir)).treeSha256, (await inventoryDirectory(dir)).treeSha256);
        assert.equal(treeHash([]), createHash('sha256').digest('hex'));
        // With symbolic links (macOS bundles), too.
        await symlink('b.txt', join(dir, 'a', 'link'));
        assert.equal((await lib.inventory(dir)).treeSha256, (await inventoryDirectory(dir)).treeSha256);
    });

    it('a tree without links hashes exactly as before link support (released content hashes stay valid)', async (t) => {
        const dir = await tempDir(t, 'nexys-tar-');
        await writeFiles(dir, { 'z.txt': 'z', 'a/b.txt': 'bb' });
        const sha = (s: string) => createHash('sha256').update(s).digest('hex');
        const legacy = createHash('sha256').update(`a/b.txt\x002\x00${sha('bb')}\nz.txt\x001\x00${sha('z')}\n`).digest('hex');
        assert.equal((await inventoryDirectory(dir)).treeSha256, legacy);
    });

    it('link targets read on any host are archived in POSIX form, with the same safety rules', () => {
        // Windows reads a link created as "Versions/Current/Q" back with backslashes.
        assert.equal(posixLinkTarget('Versions\\Current\\Q', '\\'), 'Versions/Current/Q');
        assert.equal(posixLinkTarget('..\\bin\\yosys-abc', '\\'), '../bin/yosys-abc');
        assert.equal(safeLinkTarget('Q.framework/Q', posixLinkTarget('Versions\\Current\\Q', '\\')), 'Versions/Current/Q');
        // POSIX hosts: unchanged; a literal backslash stays and is still refused.
        assert.equal(posixLinkTarget('Versions/Current/Q', '/'), 'Versions/Current/Q');
        assert.equal(posixLinkTarget('a\\b', '/'), 'a\\b');
        assert.equal(safeLinkTarget('lib/x', posixLinkTarget('a\\b', '/')), undefined);
        // Normalizing never makes an unsafe Windows target acceptable.
        for (const raw of ['C:\\Windows\\System32\\cmd.exe', '\\\\server\\share\\x', '\\Windows\\x', '..\\..\\..\\outside', 'a\\..\\..\\b']) {
            assert.equal(safeLinkTarget('lib/x', posixLinkTarget(raw, '\\')), undefined, raw);
        }
        assert.equal(posixLinkTarget('Versions/Current/Q'), sep === '/' ? 'Versions/Current/Q' : 'Versions/Current/Q', 'the host default is the host separator');
    });

    it('round-trips relative symbolic links (macOS frameworks, dylib aliases) as links, inside the tree', async (t) => {
        const dir = await tempDir(t, 'nexys-tar-');
        const src = join(dir, 'src');
        await writeFiles(src, { 'Q.framework/Versions/5/Q': 'dylib', 'bin/yosys-abc': '#!/bin/sh\n', 'lib/libz.1.dylib': 'z' });
        await symlink('5', join(src, 'Q.framework', 'Versions', 'Current'));
        await symlink('Versions/Current/Q', join(src, 'Q.framework', 'Q'));
        await symlink('../bin/yosys-abc', join(src, 'lib', 'yosys-abc'));
        const longTarget = `${'n'.repeat(120)}.dylib`;
        await writeFiles(src, { [`lib/${longTarget}`]: 'long' });
        await symlink(longTarget, join(src, 'lib', 'libz.dylib'));
        const before = await inventoryDirectory(src);
        assert.equal(before.entries.filter((e) => e.link !== undefined).length, 4);
        await writeTarGz(src, join(dir, 'l.tar.gz'));
        const out = join(dir, 'out');
        await mkdir(out);
        const r = await extractTarGz(join(dir, 'l.tar.gz'), out);
        assert.equal(r.treeSha256, before.treeSha256);
        assert.equal((await inventoryDirectory(out)).treeSha256, before.treeSha256);
        assert.ok((await lstat(join(out, 'Q.framework', 'Q'))).isSymbolicLink());
        assert.equal(await readlink(join(out, 'lib', 'libz.dylib')), longTarget);
        assert.equal(await readFile(join(out, 'Q.framework', 'Q'), 'utf8'), 'dylib');
        // A changed link target changes the content hash (Verify Toolchain sees it).
        const changed = await tempDir(t, 'nexys-tar-');
        await writeFiles(changed, { 'a.txt': 'a', 'b.txt': 'a' });
        await symlink('a.txt', join(changed, 'l'));
        const h1 = (await inventoryDirectory(changed)).treeSha256;
        const changed2 = await tempDir(t, 'nexys-tar-');
        await writeFiles(changed2, { 'a.txt': 'a', 'b.txt': 'a' });
        await symlink('b.txt', join(changed2, 'l'));
        assert.notEqual((await inventoryDirectory(changed2)).treeSha256, h1);
    });

    it('accepts only link targets that stay inside the tree, and never archives an unsafe link', async (t) => {
        assert.equal(safeLinkTarget('a/b/link', '../../x'), '../../x');
        assert.equal(safeLinkTarget('Q.framework/Versions/Current', '5'), '5');
        for (const [link, target] of [['link', '../x'], ['a/link', '../../x'], ['a/link', 'x/../y'], ['a/link', './x'], ['a/link', '/x'], ['a/link', '..'], ['a/link', ''], ['a/link', 'C:/x'], ['a/link', 'x\\y']] as const) {
            assert.equal(safeLinkTarget(link, target), undefined, `${link} -> ${target}`);
        }
        const dir = await tempDir(t, 'nexys-tar-');
        await writeFiles(join(dir, 'src'), { 'a.txt': 'a' });
        await symlink('/etc/passwd', join(dir, 'src', 'evil'));
        await assert.rejects(writeTarGz(join(dir, 'src'), join(dir, 'x.tar.gz')), /must be relative and inside/);
    });
});

describe('toolchain store: separately versioned, immutable installs', () => {
    async function setup(t: Parameters<typeof tempDir>[0], version = '1.0') {
        const dir = await tempDir(t, 'nexys-store-');
        const bundle = join(dir, 'bundle');
        await writeFakeBundle(bundle, { version });
        const { archive, requirement } = await fakeArchive(dir, bundle, { version });
        return { dir, dataRoot: join(dir, 'data'), archive, requirement };
    }

    it('installs into <data root>/toolchains/<target>/<version> after verifying the content hash', async (t) => {
        const { dataRoot, archive, requirement } = await setup(t);
        assert.equal((await installedToolchain(dataRoot, 'win32-x64', requirement)).status, 'missing');
        const r = await installToolchainArchive({ archive, dataRoot, target: 'win32-x64', requirement });
        assert.equal(r.status, 'installed');
        const paths = storePaths(dataRoot, 'win32-x64', '1.0');
        assert.equal(r.paths.versionDir, paths.versionDir);
        assert.ok(existsSync(join(paths.versionDir, 'toolchain-manifest.json')));
        assert.equal((await installedToolchain(dataRoot, 'win32-x64', requirement)).status, 'installed');
        assert.deepEqual(await readdir(join(dataRoot, 'toolchains')), ['win32-x64'], 'no staging folder is left behind');
        assert.equal((await verifyInstalledToolchain(dataRoot, 'win32-x64', requirement)).ok, true);
    });

    it('reuses an installed version untouched (an extension update needs no reinstall)', async (t) => {
        const { dataRoot, archive, requirement } = await setup(t);
        await installToolchainArchive({ archive, dataRoot, target: 'win32-x64', requirement });
        const marker = join(storePaths(dataRoot, 'win32-x64', '1.0').versionDir, '.nexysvhdl-installed.json');
        const before = (await stat(marker)).mtimeMs;
        const again = await installToolchainArchive({ archive: join(dataRoot, 'not-even-read.tar.gz'), dataRoot, target: 'win32-x64', requirement });
        assert.equal(again.status, 'already-installed');
        assert.equal((await stat(marker)).mtimeMs, before);
    });

    it('installs a new toolchain version side by side and never touches the older one', async (t) => {
        const one = await setup(t, '1.0');
        await installToolchainArchive({ archive: one.archive, dataRoot: one.dataRoot, target: 'win32-x64', requirement: one.requirement });
        const two = await setup(t, '1.1');
        const r = await installToolchainArchive({ archive: two.archive, dataRoot: one.dataRoot, target: 'win32-x64', requirement: two.requirement });
        assert.equal(r.status, 'installed');
        assert.deepEqual((await readdir(join(one.dataRoot, 'toolchains', 'win32-x64'))).sort(), ['1.0', '1.1']);
        assert.equal((await verifyInstalledToolchain(one.dataRoot, 'win32-x64', one.requirement)).ok, true, '1.0 is unchanged');
    });

    it('refuses an archive whose content differs from the validated toolchain', async (t) => {
        const { dataRoot, archive, requirement } = await setup(t);
        const tampered = { ...requirement, targets: { 'win32-x64': { ...requirement.targets['win32-x64']!, treeSha256: 'f'.repeat(64) } } };
        const r = await installToolchainArchive({ archive, dataRoot, target: 'win32-x64', requirement: tampered });
        assert.equal(r.status, 'failed');
        assert.equal(r.status === 'failed' && r.diagnostics[0]!.code, 'TOOLCHAIN_ARCHIVE_MISMATCH');
        assert.equal(existsSync(storePaths(dataRoot, 'win32-x64', '1.0').versionDir), false);
        assert.deepEqual(await readdir(join(dataRoot, 'toolchains')), [], 'staging removed');
    });

    it('refuses an archive for another platform or version, and a file that is not an archive', async (t) => {
        const { dir, dataRoot, archive, requirement } = await setup(t);
        const asMac = { ...requirement, targets: { 'darwin-arm64': requirement.targets['win32-x64']! } };
        const mac = await installToolchainArchive({ archive, dataRoot, target: 'darwin-arm64', requirement: asMac });
        assert.equal(mac.status === 'failed' && mac.diagnostics[0]!.code, 'TOOLCHAIN_ARCHIVE_WRONG_PLATFORM');
        const newer = await installToolchainArchive({ archive, dataRoot, target: 'win32-x64', requirement: { ...requirement, bundleVersion: '2.0' } });
        assert.equal(newer.status === 'failed' && newer.diagnostics[0]!.code, 'TOOLCHAIN_ARCHIVE_WRONG_VERSION');
        await writeFile(join(dir, 'junk.tar.gz'), 'not gzip');
        const junk = await installToolchainArchive({ archive: join(dir, 'junk.tar.gz'), dataRoot, target: 'win32-x64', requirement });
        assert.equal(junk.status === 'failed' && junk.diagnostics[0]!.code, 'TOOLCHAIN_ARCHIVE_INVALID');
    });

    it('never overwrites an existing folder of the same version', async (t) => {
        const { dataRoot, archive, requirement } = await setup(t);
        const versionDir = storePaths(dataRoot, 'win32-x64', '1.0').versionDir;
        await writeFiles(versionDir, { 'something.txt': 'keep me', '.nexysvhdl-installed.json': JSON.stringify({ target: 'win32-x64', bundleVersion: '1.0', treeSha256: 'a'.repeat(64) }) });
        assert.equal((await installedToolchain(dataRoot, 'win32-x64', requirement)).status, 'conflict');
        const r = await installToolchainArchive({ archive, dataRoot, target: 'win32-x64', requirement });
        assert.equal(r.status, 'failed');
        assert.equal(await readFile(join(versionDir, 'something.txt'), 'utf8'), 'keep me');
    });

    it('an installed 1.0 with another content hash (e.g. the replaced pre-release candidate 43b3fb80…) is a version conflict, never changed in place', async (t) => {
        const { dataRoot, archive, requirement } = await setup(t);
        const versionDir = storePaths(dataRoot, 'win32-x64', '1.0').versionDir;
        const candidate = '43b3fb80d30f7f87a61364ce636a57da1dcfd44ee07033746ca5854f133eaef9';
        assert.notEqual(requirement.targets['win32-x64']!.treeSha256, candidate);
        await writeFiles(versionDir, { 'apio/packages/graphviz/bin/dot.exe': 'candidate content', '.nexysvhdl-installed.json': JSON.stringify({ target: 'win32-x64', bundleVersion: '1.0', treeSha256: candidate }) });
        const state = await installedToolchain(dataRoot, 'win32-x64', requirement);
        assert.equal(state.status, 'conflict');
        assert.equal(state.status === 'conflict' && state.diagnostics[0]!.code, 'TOOLCHAIN_VERSION_CONFLICT');
        const r = await installToolchainArchive({ archive, dataRoot, target: 'win32-x64', requirement });
        assert.equal(r.status, 'failed', 'the installer does not replace or repair an existing version folder');
        assert.equal(await readFile(join(versionDir, 'apio', 'packages', 'graphviz', 'bin', 'dot.exe'), 'utf8'), 'candidate content');
    });

    it('a macOS toolchain with framework and dylib links installs, verifies, and a re-pointed link is detected', async (t) => {
        const dir = await tempDir(t, 'nexys-store-');
        const bundle = join(dir, 'bundle');
        await writeFakeBundle(bundle, { target: 'darwin-arm64', programmer: true, files: { 'apio/bin/_internal/Python.framework/Versions/3.14/Python': 'python dylib', 'apio/packages/oss-cad-suite/lib/libusb-1.0.0.dylib': 'libusb' } });
        await symlink('3.14', join(bundle, 'apio', 'bin', '_internal', 'Python.framework', 'Versions', 'Current'));
        await symlink('Python.framework/Versions/3.14/Python', join(bundle, 'apio', 'bin', '_internal', 'Python'));
        await symlink('libusb-1.0.0.dylib', join(bundle, 'apio', 'packages', 'oss-cad-suite', 'lib', 'libusb-1.0.dylib'));
        const { archive, requirement } = await fakeArchive(dir, bundle, { target: 'darwin-arm64' });
        const dataRoot = join(dir, 'data');
        const r = await installToolchainArchive({ archive, dataRoot, target: 'darwin-arm64', requirement });
        assert.equal(r.status, 'installed');
        const root = join(dataRoot, 'toolchains', 'darwin-arm64', '1.0');
        assert.equal(posixLinkTarget(await readlink(join(root, 'apio', 'bin', '_internal', 'Python'))), 'Python.framework/Versions/3.14/Python');
        assert.equal(await readFile(join(root, 'apio', 'bin', '_internal', 'Python'), 'utf8'), 'python dylib');
        // POSIX permission bits exist only on POSIX hosts (Windows stat() never reports them for such a file).
        if (sep === '/') assert.ok(((await stat(join(root, 'apio', 'packages', 'oss-cad-suite', 'bin', 'openFPGALoader'))).mode & 0o111) !== 0, 'executable bit survives pack and install');
        assert.equal((await verifyInstalledToolchain(dataRoot, 'darwin-arm64', requirement)).ok, true);
        // Re-point a link (same files, different target): Verify Toolchain must notice.
        const link = join(root, 'apio', 'packages', 'oss-cad-suite', 'lib', 'libusb-1.0.dylib');
        await rm(link);
        await symlink('../../../bin/apio', link);
        const v = await verifyInstalledToolchain(dataRoot, 'darwin-arm64', requirement);
        assert.equal(v.ok, false);
        assert.equal(v.diagnostics[0]!.code, 'TOOLCHAIN_MODIFIED');
    });

    it('Verify Toolchain detects a modified file', async (t) => {
        const { dataRoot, archive, requirement } = await setup(t);
        await installToolchainArchive({ archive, dataRoot, target: 'win32-x64', requirement });
        await writeFile(join(storePaths(dataRoot, 'win32-x64', '1.0').versionDir, 'apio', 'packages', 'openxc7', 'BUILD-INFO.json'), '{"release-tag":"2026-09-27"}');
        const v = await verifyInstalledToolchain(dataRoot, 'win32-x64', requirement);
        assert.equal(v.ok, false);
        assert.equal(v.diagnostics[0]!.code, 'TOOLCHAIN_MODIFIED');
    });

    it('reports pending and unsupported targets', async (t) => {
        const dir = await tempDir(t, 'nexys-store-');
        const req = { schemaVersion: 1 as const, bundleVersion: '1.0', targets: { 'darwin-arm64': { status: 'pending' as const } } };
        assert.equal((await installedToolchain(dir, 'darwin-arm64', req)).status, 'pending');
        assert.equal((await installedToolchain(dir, 'linux-x64', req)).status, 'unsupported');
    });

    it('validates the requirement format', () => {
        assert.deepEqual(validateRequirement({ schemaVersion: 1, bundleVersion: '1.0', targets: { 'win32-x64': { status: 'validated', treeSha256: 'a'.repeat(64) } } }), []);
        assert.ok(validateRequirement({ schemaVersion: 1, bundleVersion: 'latest', targets: {} }).length >= 2);
        assert.ok(validateRequirement({ schemaVersion: 1, bundleVersion: '1.0', targets: { x: { status: 'validated' } } }).some((p) => /treeSha256/.test(p)));
    });

    it('streams large files without loading them into memory at once', async (t) => {
        const dir = await tempDir(t, 'nexys-tar-');
        const big = join(dir, 'src', 'big.bin');
        await mkdir(join(dir, 'src'));
        await new Promise<void>((resolve, reject) => {
            const w = createWriteStream(big);
            const chunk = Buffer.alloc(1 << 20, 7);
            for (let i = 0; i < 24; i++) w.write(chunk);
            w.end(resolve);
            w.on('error', reject);
        });
        await writeTarGz(join(dir, 'src'), join(dir, 'big.tar.gz'));
        await mkdir(join(dir, 'out'));
        const r = await extractTarGz(join(dir, 'big.tar.gz'), join(dir, 'out'));
        assert.equal(r.entries[0]!.size, 24 << 20);
    });
});
