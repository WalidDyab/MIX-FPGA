import assert from 'node:assert/strict';
import { delimiter, join, win32 } from 'node:path';
import { describe, it } from 'node:test';
import { apioPathProblem, type HostInfo, installToolchainArchive, type ToolchainRequirement, type ToolInvocation } from '../core';
import { summarizeEnvironment, boardRow } from '../extension/services/environment-summary';
import type { WindowsHostEnvironment } from '../platform/windows/host-environment';
import { createWindowsPlatformServices } from '../platform/windows';
import { controllerFor, createContext, toolLocatorFor } from '../runtime/context';
import { inspectEnvironment } from '../runtime/environment';
import { fakeArchive, writeFakeBundle } from './bundle-fixture';
import { FakeRunner, makeProject, tempDir, trapProcesses } from './helpers';

const WIN: HostInfo = { platform: 'win32', arch: 'x64', nodeVersion: 'v24.0.0-test' };
const MAC: HostInfo = { platform: 'darwin', arch: 'arm64', nodeVersion: 'v24.0.0-test' };

/** Answers version probes like the real bundled tools (and djtgcfg) do. */
function toolRunner(): FakeRunner {
    return new FakeRunner((inv: ToolInvocation) => {
        const a = inv.args.join(' ');
        if (a === '--version' && /ghdl/i.test(inv.executable)) return { stdout: 'GHDL 6.0.0 (6.0.0.r0) [Dunoon edition]\n' };
        if (a === '--version') return { stdout: 'Apio CLI version 1.6.0 (pyinst-windows-amd64-2026-09-15)\n' };
        if (a.includes('yosys -V')) return { stdout: 'Yosys 0.63+173 (git sha1 66306a8ca-dirty)\n' };
        if (a.includes('nextpnr-xilinx --version')) return { stdout: '"nextpnr-xilinx" -- Next Generation Place and Route (Version 0eae9fb)\n' };
        if (a === '-version') return { stdout: 'Digilent JTAG Config Utility v2.6.1\n' };
        if (a === '--Version') return { stdout: 'openFPGALoader v1.1.1\n' };
        return {};
    });
}

/** A data root with toolchain 1.0 for `host` installed through the real installer. */
async function installedDataRoot(t: Parameters<typeof tempDir>[0], target = 'win32-x64', programmer = false, options: Pick<Parameters<typeof writeFakeBundle>[1] & object, 'manifest'> = {}): Promise<{ dataRoot: string; requirement: ToolchainRequirement }> {
    const dir = await tempDir(t, 'nexys-classroom-');
    const bundle = join(dir, 'bundle');
    await writeFakeBundle(bundle, { target, programmer, ...options });
    const { archive, requirement } = await fakeArchive(dir, bundle, { target });
    const dataRoot = join(dir, 'data');
    const r = await installToolchainArchive({ archive, dataRoot, target, requirement });
    assert.notEqual(r.status, 'failed');
    return { dataRoot, requirement };
}

describe('classroom mode: the bundled toolchain only', () => {
    it('resolves GHDL/Apio only from the installed toolchain, ignoring overrides, project paths and PATH', async (t) => {
        trapProcesses(t);
        const { dataRoot, requirement } = await installedDataRoot(t);
        const runner = toolRunner();
        const env = { NEXYSVHDL_GHDL: 'C:\\other\\ghdl.exe', NEXYSVHDL_APIO: 'C:\\other\\apio.exe', Path: 'C:\\Python314;C:\\msys64\\ucrt64\\bin', APIO_HOME: 'C:\\Users\\student\\.apio', SystemRoot: 'C:\\Windows' };
        const ctx = await createContext({ host: WIN, env, runner, classroom: { requirement, dataRoot } });
        const tc = ctx.classroom!.toolchain!;
        assert.ok(tc, JSON.stringify(ctx.classroom!.diagnostics));
        const project = await makeProject(t, { toolchain: { tools: { ghdl: 'C:\\project\\ghdl.exe' } } });
        const locator = toolLocatorFor(ctx, project);
        assert.deepEqual(await locator.locate('ghdl'), { path: tc.executables.ghdl, method: 'NexysVHDL bundled toolchain' });
        assert.deepEqual(await locator.locate('apio'), { path: tc.executables.apio, method: 'NexysVHDL bundled toolchain' });
        assert.equal(await locator.locate('programmer'), undefined, 'no Digilent install in this environment, and no PATH fallback');
        assert.deepEqual(ctx.manifests.map((m) => m.id), ['bundle-win32-x64-1.0'], 'compares with the bundle, not the reference manifests');

        const report = await inspectEnvironment(ctx, project);
        assert.equal(report.toolchain.tools.filter((x) => x.tool !== 'programmer').every((x) => x.status === 'compatible'), true, JSON.stringify(report.toolchain.tools));
        for (const call of runner.calls) {
            assert.ok(call.executable.startsWith(tc.root), `${call.executable} comes from the installed toolchain`);
            assert.equal(call.env?.['APIO_HOME'], tc.apioHome);
            assert.equal(call.env?.['Path'], undefined, 'inherited PATH removed');
            assert.ok(!call.env?.['PATH']?.includes('Python314'));
        }

        // Check runs the bundled GHDL.
        await (await controllerFor(ctx, project)).check(project);
        assert.ok(runner.calls.some((c) => c.executable === tc.executables.ghdl && c.args.includes('-a')));
    });

    it('never falls back to discovery when the toolchain is not installed', async (t) => {
        trapProcesses(t);
        const dir = await tempDir(t, 'nexys-classroom-');
        const requirement: ToolchainRequirement = { schemaVersion: 1, bundleVersion: '1.0', targets: { 'win32-x64': { status: 'validated', treeSha256: 'a'.repeat(64) } } };
        const runner = toolRunner();
        const ctx = await createContext({ host: WIN, env: { NEXYSVHDL_GHDL: 'C:\\other\\ghdl.exe', USERPROFILE: 'C:\\Users\\student' }, runner, classroom: { requirement, dataRoot: join(dir, 'data') } });
        assert.equal(ctx.classroom!.installed?.status, 'missing');
        const project = await makeProject(t, { toolchain: { tools: { ghdl: 'C:\\project\\ghdl.exe' } } });
        assert.equal(await toolLocatorFor(ctx, project).locate('ghdl'), undefined);
        assert.equal(await toolLocatorFor(ctx, project).locate('apio'), undefined);
        const summary = summarizeEnvironment(await inspectEnvironment(ctx, project));
        assert.equal(summary.level, 'setup-required');
        assert.equal(summary.toolchain?.state, 'not-installed');
        assert.equal(summary.setup.find((r) => r.id === 'toolchain')?.status, 'Not Installed');
        assert.equal(runner.calls.length, 0, 'nothing was run');
    });

    it('reports an unsupported host instead of guessing', async (t) => {
        trapProcesses(t);
        const requirement: ToolchainRequirement = { schemaVersion: 1, bundleVersion: '1.0', targets: { 'win32-x64': { status: 'validated', treeSha256: 'a'.repeat(64) } } };
        const ctx = await createContext({ host: { platform: 'linux', arch: 'x64', nodeVersion: 'x' }, env: {}, runner: toolRunner(), classroom: { requirement } });
        assert.deepEqual(ctx.classroom!.diagnostics.map((d) => d.code), ['TOOLCHAIN_TARGET_UNSUPPORTED']);
        assert.equal(ctx.platform.id, 'unsupported');
    });

    it('uses the per-user data root of the platform (LOCALAPPDATA on Windows, ~/Library/MIX-FPGA/support/nexys-a7 on macOS)', async (t) => {
        trapProcesses(t);
        const requirement: ToolchainRequirement = { schemaVersion: 1, bundleVersion: '1.0', targets: { 'win32-x64': { status: 'validated', treeSha256: 'a'.repeat(64) }, 'darwin-arm64': { status: 'pending' } } };
        const win = await createContext({ host: WIN, env: { LOCALAPPDATA: 'C:\\Users\\student\\AppData\\Local' }, runner: toolRunner(), classroom: { requirement } });
        assert.equal(win.classroom!.dataRoot, win32.join('C:\\Users\\student\\AppData\\Local', 'NexysVHDL'));
        const mac = await createContext({ host: MAC, env: { HOME: '/Users/student' }, runner: toolRunner(), classroom: { requirement } });
        assert.equal(mac.classroom!.dataRoot, '/Users/student/Library/MIX-FPGA/support/nexys-a7');
        assert.equal(mac.classroom!.installed?.status, 'pending');
        const relocated = await createContext({ host: MAC, env: { HOME: '/Users/student', MIXFPGA_HOME: '/tmp/mf' }, runner: toolRunner(), classroom: { requirement } });
        assert.equal(relocated.classroom!.dataRoot, '/tmp/mf/support/nexys-a7', 'MIXFPGA_HOME relocates the Nexys store too');
    });

    it('macOS classroom adapter takes GHDL, Apio and the programmer only from the bundle', async (t) => {
        trapProcesses(t);
        const { dataRoot, requirement } = await installedDataRoot(t, 'darwin-arm64', true);
        const runner = toolRunner();
        const ctx = await createContext({ host: MAC, env: { HOME: '/Users/student', NEXYSVHDL_PROGRAMMER: '/usr/local/bin/openFPGALoader', PATH: '/opt/homebrew/bin' }, runner, classroom: { requirement, dataRoot } });
        const tc = ctx.classroom!.toolchain!;
        assert.ok(tc, JSON.stringify(ctx.classroom!.diagnostics));
        assert.equal(ctx.platform.programmerSetup?.bundled, true);
        assert.equal((await ctx.platform.toolLocator!.locate('programmer'))?.path, tc.executables.programmer);
        assert.equal((await ctx.platform.toolLocator!.locate('ghdl'))?.path, tc.executables.ghdl);
        const report = await inspectEnvironment(ctx);
        assert.equal(report.toolchain.tools.find((x) => x.tool === 'programmer')?.detected?.version, '1.1.1');
        assert.ok(runner.calls.every((c) => c.executable.startsWith(tc.root)), 'no Homebrew or PATH tool was run');
    });

    it('macOS: a hostile shell environment never reaches a bundled tool (OS-only PATH, no Python/Apio settings, private Apio state)', async (t) => {
        trapProcesses(t);
        // The real darwin-arm64 manifest: no shims, only PYTHONDONTWRITEBYTECODE (toolchains/bundle/darwin-arm64.json).
        const { dataRoot, requirement } = await installedDataRoot(t, 'darwin-arm64', true, { manifest: (m) => ({ ...m, environment: { pathPrepend: [], set: { PYTHONDONTWRITEBYTECODE: '1' } } }) });
        const runner = toolRunner();
        const hostile = {
            HOME: '/Users/student',
            // VS Code on macOS imports the login shell's environment: Homebrew, /usr/local, a global Apio, a developer Python.
            PATH: '/opt/homebrew/bin:/usr/local/bin:/Applications/Apio:/Library/Frameworks/Python.framework/Versions/3.14/bin:/usr/bin:/bin',
            APIO_HOME: '/Users/student/.apio',
            APIO_PACKAGES: '/Users/student/.apio/packages',
            APIO_REMOTE_CONFIG_URL: 'https://example.invalid/apio-{major}.{minor}.x.jsonc',
            PYTHONHOME: '/opt/homebrew/opt/python@3.14',
            PYTHONPATH: '/Users/student/.apio/packages/oss-cad-suite/lib/python3.11',
            NEXYSVHDL_GHDL: '/opt/homebrew/bin/ghdl',
            NEXYSVHDL_APIO: '/Applications/Apio/apio',
        };
        const ctx = await createContext({ host: MAC, env: hostile, runner, classroom: { requirement, dataRoot } });
        const tc = ctx.classroom!.toolchain!;
        assert.ok(tc, JSON.stringify(ctx.classroom!.diagnostics));
        await ctx.runner.run({ executable: tc.executables.apio!, args: ['--version'] });
        const env = runner.calls.at(-1)!.env!;
        // Joined with the host's delimiter: in production the environment is always built on the machine that runs the tools.
        assert.equal(env['PATH'], ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter));
        for (const k of ['PYTHONHOME', 'PYTHONPATH']) assert.equal(env[k], undefined, k);
        assert.equal(env['PYTHONDONTWRITEBYTECODE'], '1');
        assert.equal(env['APIO_HOME'], join(dataRoot, 'state', 'darwin-arm64-1.0', 'apio-home'));
        assert.equal(env['APIO_PACKAGES'], join(tc.root, 'apio', 'packages'));
        assert.match(env['APIO_REMOTE_CONFIG_URL']!, /^file:\/\//);
        assert.ok(!Object.values(env).some((v) => typeof v === 'string' && /\.apio|homebrew|\/usr\/local|Applications\/Apio/.test(v)), JSON.stringify(env));
        assert.equal((await toolLocatorFor(ctx).locate('ghdl'))?.path, tc.executables.ghdl, 'NEXYSVHDL_GHDL is ignored');
        assert.equal((await toolLocatorFor(ctx).locate('apio'))?.path, tc.executables.apio, 'NEXYSVHDL_APIO is ignored');
    });

    it('macOS: the per-user store ~/Library/NexysVHDL satisfies Apio\'s path rule, "Application Support" would not', () => {
        assert.equal(apioPathProblem('/Users/student/Library/NexysVHDL/toolchains/darwin-arm64/1.0/apio/packages'), undefined);
        assert.equal(apioPathProblem('/Users/student/Library/NexysVHDL/state/darwin-arm64-1.0/apio-home'), undefined);
        assert.equal(apioPathProblem('/Users/student/Library/Application Support/NexysVHDL'), 'a space');
    });
});

describe('classroom mode: Windows Digilent prerequisite', () => {
    const PF86 = 'C:\\Program Files (x86)';
    const djtgcfg = `${PF86}\\Digilent\\AdeptUtilities\\djtgcfg.exe`;
    const host = (files: string[], env: Record<string, string> = {}): WindowsHostEnvironment => ({
        env: { 'ProgramFiles(x86)': PF86, ProgramFiles: 'C:\\Program Files', ...env },
        fs: {
            isFile: async (p) => files.some((f) => f.toLowerCase() === p.toLowerCase()),
            listDirectories: async () => [],
            readFile: async (p) => (p.toLowerCase() === 'c:\\program files\\digilent\\install.log' ? Buffer.from('<<<<< Digilent Adept Runtime 2.30.4 >>>>>\n') : undefined),
        },
    });

    it('uses an existing official Digilent installation', async () => {
        const services = createWindowsPlatformServices(WIN, { environment: host([djtgcfg, 'C:\\Program Files\\Digilent\\install.log']), runner: toolRunner(), classroom: {} });
        assert.equal((await services.toolLocator.locate('programmer'))?.path, djtgcfg);
        assert.equal((await services.programmer.availability()).available, true);
        assert.equal(services.programmerSetup?.bundled, false);
        assert.match(services.programmerSetup!.guide!, /^https:\/\/digilent\.com\//);
    });

    it('reports Digilent support as missing, without using a djtgcfg found elsewhere (no PATH fallback)', async () => {
        const services = createWindowsPlatformServices(WIN, { environment: host(['C:\\tools\\djtgcfg.exe'], { PATH: 'C:\\tools', NEXYSVHDL_PROGRAMMER: 'C:\\tools\\djtgcfg.exe' }), runner: toolRunner(), classroom: {} });
        assert.equal(await services.toolLocator.locate('programmer'), undefined);
        assert.equal((await services.programmer.availability()).available, false);
    });
});

describe('student setup summary', () => {
    const base = (programmerAvailable: boolean, bundledProgrammer = false) =>
        summarizeEnvironment({
            adapter: { id: 'x', displayName: 'X', status: '' },
            toolchain: {
                overall: 'compatible',
                tools: (['ghdl', 'apio', 'openxc7', 'yosys', 'nextpnr-xilinx'] as const).map((tool) => ({ tool, status: 'compatible' as const, reason: 'ok', detected: { tool, found: true, version: '1', method: 'NexysVHDL bundled toolchain' } })),
            },
            diagnostics: [],
            providers: { ghdl: { path: 'g', method: 'm' }, apio: { path: 'a', method: 'm' } },
            programmer: { displayName: 'P', availability: { available: programmerAvailable, detail: programmerAvailable ? 'ok' : 'not installed' } },
            programmerSetup: bundledProgrammer ? { name: 'Board programmer', bundled: true } : { name: 'USB/JTAG Support', bundled: false, guide: 'https://example.invalid/guide' },
            classroom: {
                requirement: { schemaVersion: 1, bundleVersion: '1.0', targets: { 'win32-x64': { status: 'validated', treeSha256: 'a'.repeat(64) } } },
                target: 'win32-x64',
                dataRoot: 'C:\\data',
                diagnostics: [],
                // A minimal usable toolchain for the summary.
                toolchain: {} as never,
                resolution: { root: 'r', target: 'win32-x64', diagnostics: [], manifest: { bundleVersion: '1.0', displayPlatform: 'Windows x64' } as never },
                installed: { status: 'installed', paths: { dataRoot: 'C:\\data', versionDir: 'C:\\data\\toolchains\\win32-x64\\1.0', stagingRoot: '', stateDir: '' }, marker: {} as never },
            },
        });

    it('ready toolchain and Digilent missing: design and build work, programming needs setup', () => {
        const s = base(false);
        assert.equal(s.headline, 'Ready (programming needs setup)');
        assert.equal(s.status, 'Ready for design and build');
        assert.deepEqual(s.setup.map((r) => `${r.label}: ${r.status}`), ['Bundled FPGA Toolchain: Ready', 'USB/JTAG Support: Setup Required']);
        assert.equal(s.programmerGuide?.url, 'https://example.invalid/guide');
    });

    it('everything ready', () => {
        const s = base(true);
        assert.equal(s.level, 'ready');
        assert.equal(s.status, 'Ready for design, build and programming');
        assert.equal(s.setup.find((r) => r.id === 'programmer')?.status, 'Ready');
        assert.equal(s.programmerGuide?.name, 'USB/JTAG Support');
    });

    it('a bundled programmer (macOS) is not a system prerequisite', () => {
        const s = base(true, true);
        assert.equal(s.setup.find((r) => r.id === 'programmer')?.status, 'Ready (bundled)');
        assert.equal(s.programmerGuide, undefined);
    });

    it('a bundled programmer (macOS) waits for the toolchain instead of showing a problem', () => {
        const s = summarizeEnvironment({
            adapter: { id: 'macos', displayName: 'macOS', status: '' },
            toolchain: { overall: 'missing', tools: [] },
            diagnostics: [],
            providers: {},
            programmer: { displayName: 'openFPGALoader', availability: { available: false, detail: 'not found' } },
            programmerSetup: { name: 'Board programmer (openFPGALoader)', bundled: true },
            classroom: {
                requirement: { schemaVersion: 1, bundleVersion: '1.0', targets: { 'darwin-arm64': { status: 'validated', treeSha256: 'a'.repeat(64) } } },
                target: 'darwin-arm64',
                dataRoot: '/Users/student/Library/NexysVHDL',
                diagnostics: [],
                installed: { status: 'missing', paths: { dataRoot: '/Users/student/Library/NexysVHDL', versionDir: '/Users/student/Library/NexysVHDL/toolchains/darwin-arm64/1.0', stagingRoot: '', stateDir: '' }, diagnostics: [] },
            },
        } as never);
        assert.deepEqual(s.setup.map((r) => `${r.label}: ${r.status}`), ['Bundled FPGA Toolchain: Not Installed', 'Board programmer (openFPGALoader): Not Installed']);
        assert.equal(s.setup[1]!.state, 'setup-required');
        assert.equal(s.setup[1]!.detail, 'installed with the FPGA toolchain');
        assert.equal(s.problems.filter((p) => /programmer/i.test(p)).length, 0, 'the toolchain problem covers the bundled programmer');
        assert.equal(s.programmerGuide, undefined);
    });

    it('a missing board is not a missing programmer', () => {
        assert.deepEqual(
            [boardRow({ status: 'none', boards: [], diagnostics: [] }).status, boardRow({ status: 'unavailable', boards: [], diagnostics: [] }).status, boardRow({ status: 'unknown', boards: [], diagnostics: [] }).status],
            ['Not Connected', 'Not Checked', 'Not Checked'],
        );
        assert.equal(boardRow({ status: 'one', boards: [{ selector: 'SN:1', serialNumber: '1', productName: 'Nexys A7-100T' } as never], diagnostics: [] }).status, 'Connected');
    });
});

describe('upgrade from NexysVHDL 0.6.0: read-only reuse of its validated toolchain', () => {
    async function homeWith(t: Parameters<typeof tempDir>[0], where: 'legacy' | 'primary' | 'both') {
        const dir = await tempDir(t, 'nexys-upgrade-');
        const home = join(dir, 'home');
        const bundle = join(dir, 'bundle');
        await writeFakeBundle(bundle, { target: 'darwin-arm64', programmer: true });
        const { archive, requirement } = await fakeArchive(dir, bundle, { target: 'darwin-arm64' });
        const legacy = join(home, 'Library', 'NexysVHDL');
        const primary = join(home, 'Library', 'MIX-FPGA', 'support', 'nexys-a7');
        if (where !== 'primary') assert.equal((await installToolchainArchive({ archive, dataRoot: legacy, target: 'darwin-arm64', requirement })).status, 'installed');
        if (where !== 'legacy') assert.equal((await installToolchainArchive({ archive, dataRoot: primary, target: 'darwin-arm64', requirement })).status, 'installed');
        return { home, legacy, primary, requirement };
    }

    it('uses the NexysVHDL store when the MIX-FPGA store has none, keeping tool state in the MIX-FPGA store', async (t) => {
        trapProcesses(t);
        const h = await homeWith(t, 'legacy');
        const ctx = await createContext({ host: MAC, env: { HOME: h.home }, runner: toolRunner(), classroom: { requirement: h.requirement } });
        const c = ctx.classroom!;
        assert.ok(c.toolchain, JSON.stringify(c.diagnostics));
        assert.equal(c.reusedFrom, h.legacy);
        assert.equal(c.dataRoot, h.primary, 'installs and state still go to the MIX-FPGA store');
        assert.equal(c.toolchain.root, join(h.legacy, 'toolchains', 'darwin-arm64', '1.0'));
        assert.ok(c.toolchain.environment['APIO_HOME']!.startsWith(join(h.primary, 'state')), c.toolchain.environment['APIO_HOME']);
    });

    it('prefers the MIX-FPGA store once it exists', async (t) => {
        trapProcesses(t);
        const h = await homeWith(t, 'both');
        const c = (await createContext({ host: MAC, env: { HOME: h.home }, runner: toolRunner(), classroom: { requirement: h.requirement } })).classroom!;
        assert.equal(c.reusedFrom, undefined);
        assert.equal(c.toolchain!.root, join(h.primary, 'toolchains', 'darwin-arm64', '1.0'));
    });

    it('never reuses a NexysVHDL store whose content differs from the validated toolchain, and ignores it under MIXFPGA_HOME', async (t) => {
        trapProcesses(t);
        const h = await homeWith(t, 'legacy');
        const other: ToolchainRequirement = { ...h.requirement, targets: { 'darwin-arm64': { status: 'validated', treeSha256: 'b'.repeat(64) } } };
        const c = (await createContext({ host: MAC, env: { HOME: h.home }, runner: toolRunner(), classroom: { requirement: other } })).classroom!;
        assert.equal(c.toolchain, undefined);
        assert.equal(c.reusedFrom, undefined);
        const fresh = (await createContext({ host: MAC, env: { HOME: h.home, MIXFPGA_HOME: join(h.home, 'fresh') }, runner: toolRunner(), classroom: { requirement: h.requirement } })).classroom!;
        assert.equal(fresh.toolchain, undefined, 'a relocated MIX-FPGA (fresh-install test) does not see NexysVHDL');
        assert.equal(fresh.installed?.status, 'missing');
    });
});
