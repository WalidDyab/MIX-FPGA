import assert from 'node:assert/strict';
import { lstat, mkdir, readlink, realpath, symlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { apioPathProblem, GhdlVhdlProvider, installToolchainArchive, loadBundledToolchain, type ToolchainRequirement, WorkspaceManager } from '../core';
import { ghdlSourceMap } from '../extension/rtl/rtl-model';
import { type EntryInfo, macosPathAlias, type MacosAliasFileSystem } from '../platform/macos/path-alias';
import { type AliasFileSystem, windowsPathAlias } from '../platform/windows/path-alias';
import { createContext } from '../runtime/context';
import { fakeArchive, writeFakeBundle } from './bundle-fixture';
import { FakeRunner, makeProject, tempDir, trapProcesses, VALID_CONFIG, writeFiles } from './helpers';

/** Space + accented Latin + CJK: the hostile Windows profile/folder names validated in Phase 4B. */
const HOSTILE = 'José García 学生';
const WIN = { platform: 'win32', arch: 'x64' } as const;
const MAC = { platform: 'darwin', arch: 'arm64', nodeVersion: 'x' } as const;

/** In-memory junctions (case-insensitive like NTFS); never touches %ProgramData%. */
function fakeAliasFs(existing: Record<string, string> = {}, real: (p: string) => string | undefined = (p) => p) {
    const links = new Map(Object.entries(existing).map(([k, v]) => [k.toLowerCase(), v]));
    const created: string[] = [];
    const fs: AliasFileSystem = {
        realpath: async (p) => links.get(p.toLowerCase()) ?? real(p),
        exists: async (p) => links.has(p.toLowerCase()),
        mkdirp: async () => undefined,
        junction: async (target, path) => {
            links.set(path.toLowerCase(), target);
            created.push(path);
        },
    };
    return { fs, created };
}

describe('hostile paths: ASCII alias for the toolchain (Windows)', () => {
    const env = { ProgramData: 'C:\\ProgramData' };
    const target = `C:\\Users\\${HOSTILE}\\AppData\\Local\\NexysVHDL\\toolchains\\win32-x64\\1.0`;

    it('creates a junction under %ProgramData%\\NexysVHDL\\links named by a hash of the target', async () => {
        const { fs, created } = fakeAliasFs();
        const a = await windowsPathAlias(target, env, fs);
        assert.match(a.path!, /^C:\\ProgramData\\NexysVHDL\\links\\[0-9a-f]{16}$/);
        assert.deepEqual(created, [a.path]);
        assert.equal(a.path, (await windowsPathAlias(target, env, fs)).path, 'stable: the existing junction is reused');
        assert.equal(created.length, 1);
    });

    it('never uses an entry it did not make for this target (another user\'s folder or a planted junction)', async () => {
        const first = (await windowsPathAlias(target, env, fakeAliasFs().fs)).path!;
        const { fs, created } = fakeAliasFs({ [first]: 'C:\\Users\\mallory\\evil-toolchain' });
        const a = await windowsPathAlias(target, env, fs);
        assert.equal(a.path, `${first}-1`);
        assert.deepEqual(created, [`${first}-1`]);
    });

    it('reports a problem instead of guessing', async () => {
        assert.match((await windowsPathAlias(target, {}, fakeAliasFs().fs)).problem!, /ProgramData/);
        assert.match((await windowsPathAlias(target, { ProgramData: 'C:\\Program Data' }, fakeAliasFs().fs)).problem!, /space/);
        assert.match((await windowsPathAlias(target, env, fakeAliasFs({}, () => undefined).fs)).problem!, /does not exist/);
        const failing = fakeAliasFs().fs;
        failing.junction = async () => {
            throw new Error('access denied');
        };
        assert.match((await windowsPathAlias(target, env, failing)).problem!, /access denied/);
    });
});

describe('hostile paths: the loader runs tools through the alias', () => {
    async function hostileBundle(t: Parameters<typeof tempDir>[0]) {
        const dir = await tempDir(t, 'nexys-hostile-');
        const bundleDir = join(dir, HOSTILE, 'toolchains', 'win32-x64', '1.0');
        await writeFakeBundle(bundleDir);
        const stateDir = join(dir, HOSTILE, 'state', 'win32-x64-1.0');
        const aliasRoot = join(dir, 'links');
        await mkdir(aliasRoot);
        const aliased: string[] = [];
        // A stand-in for the junction: the real folder under an ASCII name is enough for the loader's checks.
        const pathAlias = async (real: string) => {
            aliased.push(real);
            return { path: real.replace(join(dir, HOSTILE), join(dir, 'ascii')) };
        };
        return { dir, bundleDir, stateDir, aliased, pathAlias };
    }

    it('without an alias Apio is disabled (Check/Simulate still work)', async (t) => {
        const { bundleDir, stateDir } = await hostileBundle(t);
        const r = await loadBundledToolchain({ bundleDir, host: WIN, stateDir, systemPath: [], inheritedEnv: {} });
        assert.equal(r.toolchain?.executables.apio, undefined);
        assert.ok(r.toolchain?.executables.ghdl);
        assert.ok(r.diagnostics.some((d) => d.code === 'BUNDLE_PATH_UNSUPPORTED'));
    });

    it('with the alias every tool path, APIO_HOME, APIO_PACKAGES and the remote config are plain ASCII', async (t) => {
        const { dir, bundleDir, stateDir, aliased, pathAlias } = await hostileBundle(t);
        // Make the ASCII stand-in folders real so the loader's file checks pass.
        await writeFakeBundle(join(dir, 'ascii', 'toolchains', 'win32-x64', '1.0'));
        const r = await loadBundledToolchain({ bundleDir, host: WIN, stateDir, systemPath: ['C:\\Windows\\System32'], inheritedEnv: {}, pathAlias });
        const tc = r.toolchain!;
        assert.deepEqual(aliased, [bundleDir, stateDir]);
        assert.ok(tc.executables.apio, JSON.stringify(r.diagnostics));
        assert.deepEqual(r.diagnostics.map((d) => `${d.severity}:${d.code}`), ['info:BUNDLE_PATH_ALIAS', 'info:BUNDLE_PATH_ALIAS']);
        assert.equal(tc.root, bundleDir, 'the real (verified) folder is still the toolchain');
        assert.deepEqual(tc.aliases, { toolchain: join(dir, 'ascii', 'toolchains', 'win32-x64', '1.0'), state: join(dir, 'ascii', 'state', 'win32-x64-1.0') });
        for (const v of [tc.executables.ghdl!, tc.executables.apio!, tc.environment['APIO_HOME']!, tc.environment['APIO_PACKAGES']!, tc.environment['APIO_REMOTE_CONFIG_URL']!, tc.environment['PATH']!]) {
            assert.ok(!v.includes(HOSTILE), v);
        }
    });

    it('an alias failure disables Apio with the reason', async (t) => {
        const { bundleDir, stateDir } = await hostileBundle(t);
        const r = await loadBundledToolchain({ bundleDir, host: WIN, stateDir, systemPath: [], inheritedEnv: {}, pathAlias: async () => ({ problem: 'junctions are not allowed here' }) });
        assert.equal(r.toolchain?.executables.apio, undefined);
        assert.ok(r.diagnostics.some((d) => d.code === 'BUNDLE_PATH_ALIAS_FAILED' && /junctions are not allowed/.test(d.message)));
    });

    it('classroom mode uses the alias hook for a data root under a hostile profile', async (t) => {
        trapProcesses(t);
        const dir = await tempDir(t, 'nexys-hostile-');
        const bundle = join(dir, 'bundle');
        await writeFakeBundle(bundle);
        const { archive, requirement } = await fakeArchive(dir, bundle);
        const dataRoot = join(dir, HOSTILE, 'NexysVHDL');
        assert.notEqual((await installToolchainArchive({ archive, dataRoot, target: 'win32-x64', requirement: requirement as ToolchainRequirement })).status, 'failed');
        const calls: string[] = [];
        const ctx = await createContext({
            host: { ...WIN, nodeVersion: 'x' },
            env: {},
            runner: new FakeRunner(),
            classroom: { requirement, dataRoot, pathAlias: async (p) => (calls.push(p), { problem: 'test: no junctions' }) },
        });
        assert.equal(calls.length, 2, 'toolchain and state folders');
        assert.ok(ctx.classroom!.diagnostics.some((d) => d.code === 'BUNDLE_PATH_ALIAS_FAILED'));
    });
});

/** In-memory POSIX filesystem for the macOS alias: folders, files and symbolic links with owners and modes. */
function fakeMacFs(uid = 501) {
    type Node = { kind: 'dir' | 'file' | 'link'; uid: number; mode: number; target?: string };
    const nodes = new Map<string, Node>([
        ['/private/var/folders/xx/T', { kind: 'dir', uid, mode: 0o40700 }],
        ['/Users/José García 学生/Library/NexysVHDL/toolchains/darwin-arm64/1.0', { kind: 'dir', uid, mode: 0o40755 }],
    ]);
    const tmpAlias = (p: string) => p.replace(/^\/var\/folders\//, '/private/var/folders/');
    const resolveLink = (p: string, depth = 0): string | undefined => {
        const n = nodes.get(tmpAlias(p));
        if (!n) return undefined;
        if (n.kind !== 'link') return tmpAlias(p);
        return depth > 8 ? undefined : resolveLink(n.target!, depth + 1);
    };
    const made: string[] = [];
    const fs: MacosAliasFileSystem = {
        uid: () => uid,
        entry: async (p) => {
            const n = nodes.get(tmpAlias(p));
            return n ? ({ isDirectory: n.kind === 'dir', isSymbolicLink: n.kind === 'link', uid: n.uid, mode: n.mode } satisfies EntryInfo) : undefined;
        },
        realpath: async (p) => resolveLink(p),
        readlink: async (p) => nodes.get(tmpAlias(p))?.target,
        mkdir: async (p, mode) => void nodes.set(tmpAlias(p), { kind: 'dir', uid, mode: 0o40000 | mode }),
        symlink: async (target, p) => {
            made.push(p);
            nodes.set(tmpAlias(p), { kind: 'link', uid, mode: 0o120755, target });
        },
        unlink: async (p) => void nodes.delete(tmpAlias(p)),
    };
    return { fs, nodes, made };
}

describe('hostile paths: ASCII alias for the toolchain (macOS home folder with spaces/Unicode)', () => {
    const env = { TMPDIR: '/var/folders/xx/T/' };
    const target = '/Users/José García 学生/Library/NexysVHDL/toolchains/darwin-arm64/1.0';

    it('creates a private 0700 folder in $TMPDIR and a symbolic link named by a hash of the target; reuses it', async () => {
        const { fs, nodes, made } = fakeMacFs();
        const a = await macosPathAlias(target, env, fs);
        assert.match(a.path!, /^\/var\/folders\/xx\/T\/NexysVHDL-links\/[0-9a-f]{16}$/);
        assert.equal(apioPathProblem(a.path!), undefined);
        assert.equal(nodes.get('/private/var/folders/xx/T/NexysVHDL-links')!.mode & 0o777, 0o700);
        assert.equal((await macosPathAlias(target, env, fs)).path, a.path, 'stable: the existing link is reused');
        assert.deepEqual(made, [a.path]);
    });

    it('never uses a link it did not make for this target; replaces only its own dangling link', async () => {
        const first = (await macosPathAlias(target, env, fakeMacFs().fs)).path!;
        const planted = fakeMacFs();
        planted.nodes.set('/private/var/folders/xx/T/NexysVHDL-links', { kind: 'dir', uid: 501, mode: 0o40700 });
        planted.nodes.set(first.replace('/var/', '/private/var/'), { kind: 'link', uid: 501, mode: 0o120755, target: '/Users/mallory/evil' });
        planted.nodes.set('/Users/mallory/evil', { kind: 'dir', uid: 502, mode: 0o40755 });
        assert.equal((await macosPathAlias(target, env, planted.fs)).path, `${first}-1`, 'a live link to elsewhere is never used');
        const foreign = fakeMacFs();
        foreign.nodes.set('/private/var/folders/xx/T/NexysVHDL-links', { kind: 'dir', uid: 501, mode: 0o40700 });
        foreign.nodes.set(first.replace('/var/', '/private/var/'), { kind: 'link', uid: 0, mode: 0o120755, target: '/gone' });
        assert.equal((await macosPathAlias(target, env, foreign.fs)).path, `${first}-1`, "another owner's link is never replaced");
        const stale = fakeMacFs();
        stale.nodes.set('/private/var/folders/xx/T/NexysVHDL-links', { kind: 'dir', uid: 501, mode: 0o40700 });
        stale.nodes.set(first.replace('/var/', '/private/var/'), { kind: 'link', uid: 501, mode: 0o120755, target: '/gone' });
        assert.equal((await macosPathAlias(target, env, stale.fs)).path, first, 'its own dangling link (target moved, folder purged) is recreated');
    });

    it('refuses an alias folder that is not private to the user, and reports instead of guessing', async () => {
        for (const bad of [
            { kind: 'link' as const, uid: 501, mode: 0o120755, target: '/private/var/folders/xx/T' },
            { kind: 'dir' as const, uid: 0, mode: 0o40700 },
            { kind: 'dir' as const, uid: 501, mode: 0o40777 },
        ]) {
            const { fs, nodes, made } = fakeMacFs();
            nodes.set('/private/var/folders/xx/T/NexysVHDL-links', bad);
            assert.match((await macosPathAlias(target, env, fs)).problem!, /not a private folder/, JSON.stringify(bad));
            assert.deepEqual(made, []);
        }
        const shared = fakeMacFs();
        shared.nodes.set('/private/var/folders/xx/T', { kind: 'dir', uid: 0, mode: 0o41777 });
        assert.match((await macosPathAlias(target, env, shared.fs)).problem!, /not a private folder of this user/, 'a world-writable /tmp-like folder is not used');
        assert.match((await macosPathAlias(target, {}, fakeMacFs().fs)).problem!, /TMPDIR/);
        assert.match((await macosPathAlias(target, { TMPDIR: '/Volumes/Home Drive/tmp' }, fakeMacFs().fs)).problem!, /contains a space/);
        assert.match((await macosPathAlias('/nowhere', env, fakeMacFs().fs)).problem!, /does not exist/);
    });

    it('classroom mode on macOS: a HOME with spaces/accents/CJK keeps the real MIX-FPGA store and runs Apio through a private alias', { skip: process.platform === 'win32' }, async (t) => {
        trapProcesses(t);
        const dir = await tempDir(t, 'nexys-machome-');
        const home = join(dir, 'Users', HOSTILE);
        const tmp = join(dir, 'T');
        await mkdir(tmp, { mode: 0o700 });
        const bundle = join(dir, 'bundle');
        await writeFakeBundle(bundle, { target: 'darwin-arm64', programmer: true });
        await symlink('../bin/apio', join(bundle, 'apio', 'packages', 'oss-cad-suite', 'apio-alias'));
        const { archive, requirement } = await fakeArchive(dir, bundle, { target: 'darwin-arm64' });
        const dataRoot = join(home, 'Library', 'MIX-FPGA', 'support', 'nexys-a7');
        assert.equal((await installToolchainArchive({ archive, dataRoot, target: 'darwin-arm64', requirement })).status, 'installed');
        // The real registry hook (platform/index.ts) with the real filesystem; HOME is never changed or written outside the MIX-FPGA store.
        const ctx = await createContext({ host: MAC, env: { HOME: home, TMPDIR: `${tmp}/` }, runner: new FakeRunner(), classroom: { requirement } });
        const tc = ctx.classroom!.toolchain!;
        assert.equal(ctx.classroom!.dataRoot, dataRoot);
        assert.equal(tc.root, join(dataRoot, 'toolchains', 'darwin-arm64', '1.0'), 'the real store stays the toolchain');
        assert.ok(tc.executables.apio, JSON.stringify(ctx.classroom!.diagnostics));
        const aliases = tc.aliases!;
        assert.ok(aliases.toolchain?.startsWith(join(tmp, 'NexysVHDL-links')) && aliases.state?.startsWith(join(tmp, 'NexysVHDL-links')), JSON.stringify(aliases));
        for (const k of ['APIO_HOME', 'APIO_PACKAGES', 'APIO_REMOTE_CONFIG_URL']) assert.equal(apioPathProblem(tc.environment[k]!), undefined, k);
        for (const p of Object.values(tc.executables)) assert.ok(p.startsWith(aliases.toolchain!), p);
        assert.equal(await readlink(aliases.toolchain!), await realpath(tc.root));
        assert.equal(await readlink(aliases.state!), await realpath(join(dataRoot, 'state', 'darwin-arm64-1.0')));
        assert.equal((await lstat(join(tmp, 'NexysVHDL-links'))).mode & 0o777, 0o700);
        const again = await createContext({ host: MAC, env: { HOME: home, TMPDIR: tmp }, runner: new FakeRunner(), classroom: { requirement } });
        assert.deepEqual(again.classroom!.toolchain!.aliases, tc.aliases, 'the alias is reused');
    });
});

describe('hostile paths: GHDL never sees the project location', () => {
    it('a project under a space/Unicode folder is passed to GHDL only workspace-relative', async (t) => {
        const root = join(await tempDir(t, 'nexys-hostile-'), HOSTILE, 'Mis Proyectos ñ', 'Demo');
        await writeFiles(root, { 'src/top.vhd': '-- top\n', 'sim/top_tb.vhd': '-- tb\n' });
        const project = { root, file: join(root, 'nexysvhdl.json'), config: { ...VALID_CONFIG } };
        const { workspace } = await new WorkspaceManager().open(project);
        const runner = new FakeRunner();
        const ghdl = new GhdlVhdlProvider('/fake/ghdl', runner);
        await ghdl.check({ project, workspace: workspace! });
        await ghdl.simulate({ project, workspace: workspace! }, { testbench: 'top_tb', waveform: true, vcd: true });
        await ghdl.synthesize({ project, workspace: workspace! });
        assert.ok(runner.calls.length >= 5);
        for (const c of runner.calls) {
            for (const a of c.args) assert.ok(!a.includes(HOSTILE) && !a.includes('ñ'), `GHDL argument "${a}" contains the project location`);
            assert.ok(c.args.includes('--workdir=.'));
            for (const a of c.args.filter((x) => x.endsWith('.vhd'))) assert.ok(!relative(project.root, resolve(c.cwd!, a)).startsWith('..'));
        }
    });

    it('a source file name GHDL cannot record gets a located Check error instead of a cryptic GHDL failure', async (t) => {
        const project = await makeProject(t, { sources: ['src/学生.vhd'] });
        const { workspace } = await new WorkspaceManager().open(project);
        const runner = new FakeRunner();
        const r = await new GhdlVhdlProvider('/fake/ghdl', runner).check({ project, workspace: workspace! });
        assert.equal(r.status, 'failed');
        assert.equal(r.diagnostics[0]!.code, 'GHDL_FILE_NAME_UNSUPPORTED');
        assert.deepEqual(r.diagnostics[0]!.location, { file: 'src/学生.vhd' });
        assert.equal(runner.calls.length, 0, 'GHDL is not run');
    });

    it('RTL source links resolve GHDL\'s relative comments from the folder GHDL ran in', () => {
        const root = resolve(HOSTILE, 'Demo');
        const rtlDir = join(root, '.nexysvhdl', 'rtl');
        const verilog = `  /*# ${join('..', '..', 'src', 'top.vhd')}:32:19 */\n  assign led0 = a & b;`;
        const map = ghdlSourceMap(verilog, resolve(root), resolve(rtlDir));
        assert.deepEqual(map.get(2), { file: 'src/top.vhd', line: 32, col: 19 });
        assert.equal(ghdlSourceMap(verilog, resolve(root)).size, 0, 'without the folder a relative comment is not guessed');
    });
});
