import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { describe, it } from 'node:test';
import { ALL_TOOL_IDS, currentHost, evaluateToolchain, type ToolchainManifest, type ToolInvocation } from '../../../core';
import { getEnv, type WindowsHostEnvironment } from '../../../platform/windows/host-environment';
import { WindowsToolchainInspector } from '../../../platform/windows/toolchain-inspector';
import { WindowsToolLocator } from '../../../platform/windows/tool-locator';
import { createWindowsPlatform, createWindowsPlatformServices } from '../../../platform/windows';
import { FakeRunner, REPO } from '../../helpers';

const USER = 'C:\\Users\\student';
const PF86 = 'C:\\Program Files (x86)';
const PKG = 'D:\\apps\\NexysVHDL';

/** An in-memory Windows filesystem; paths compare case-insensitively like NTFS. */
function fakeHost(files: Record<string, string>, env: Record<string, string> = {}, packageRoot: string | undefined = PKG): WindowsHostEnvironment {
    const norm = (p: string) => win32.normalize(p).toLowerCase();
    const table = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
    return {
        env: { USERPROFILE: USER, LOCALAPPDATA: `${USER}\\AppData\\Local`, 'ProgramFiles(x86)': PF86, ProgramFiles: 'C:\\Program Files', SystemDrive: 'C:', ...env },
        fs: {
            isFile: async (p) => table.has(norm(p)),
            listDirectories: async (dir) => {
                const prefix = norm(dir).replace(/\\$/, '') + '\\';
                const names = new Set<string>();
                for (const [path] of table) if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split('\\')[0]!);
                // Return original casing where possible.
                return [...names].map((n) => Object.keys(files).map((k) => k.slice(dir.length + 1).split('\\')[0]!).find((o) => o.toLowerCase() === n) ?? n);
            },
            readFile: async (p) => (table.has(norm(p)) ? Buffer.from(table.get(norm(p))!, 'utf8') : undefined),
        },
        ...(packageRoot ? { packageRoot } : {}),
    };
}

const VALIDATED_MACHINE = {
    [`${PKG}\\tools\\ghdl-6.0.0\\bin\\ghdl.exe`]: '',
    [`${USER}\\.apio\\bin\\apio.exe`]: '',
    [`${USER}\\.apio\\packages\\openxc7\\BUILD-INFO.json`]: JSON.stringify({ 'package-name': 'openxc7', 'release-tag': '2026-09-24' }),
    [`${PF86}\\Digilent\\AdeptUtilities\\djtgcfg.exe`]: '',
    ['C:\\Program Files\\Digilent\\install.log']: '<<<<< Digilent Adept Runtime 2.30.4 >>>>>\n',
};

describe('Windows tool discovery', () => {
    it('finds the validated layout: package-local GHDL, Apio home, Digilent Program Files', async () => {
        const locator = new WindowsToolLocator(fakeHost(VALIDATED_MACHINE));
        assert.deepEqual(await locator.locate('ghdl'), { path: `${PKG}\\tools\\ghdl-6.0.0\\bin\\ghdl.exe`, method: 'NexysVHDL tools folder' });
        assert.deepEqual(await locator.locate('apio'), { path: `${USER}\\.apio\\bin\\apio.exe`, method: 'Apio default install' });
        assert.deepEqual(await locator.locate('programmer'), { path: `${PF86}\\Digilent\\AdeptUtilities\\djtgcfg.exe`, method: 'Digilent Adept Utilities default install' });
        assert.equal(await locator.locate('yosys'), undefined); // reached through Apio
    });

    it('lets NEXYSVHDL_<TOOL> override everything', async () => {
        const custom = 'E:\\my tools\\ghdl\\bin\\ghdl.exe';
        const locator = new WindowsToolLocator(fakeHost({ ...VALIDATED_MACHINE, [custom]: '' }, { NEXYSVHDL_GHDL: custom }));
        assert.deepEqual(await locator.locate('ghdl'), { path: custom, method: 'NEXYSVHDL_GHDL' });
    });

    it('is not tied to one user profile path', async () => {
        const other = 'C:\\Users\\someone else';
        const host = fakeHost({ [`${other}\\.apio\\bin\\apio.exe`]: '' }, { USERPROFILE: other });
        assert.equal((await new WindowsToolLocator(host).locate('apio'))?.path, `${other}\\.apio\\bin\\apio.exe`);
        const apioHome = fakeHost({ ['F:\\apio\\bin\\apio.exe']: '' }, { APIO_HOME: 'F:\\apio' });
        assert.equal((await new WindowsToolLocator(apioHome).locate('apio'))?.path, 'F:\\apio\\bin\\apio.exe');
    });

    it('prefers the newest managed GHDL, then the per-user managed folder, then MSYS2, then PATH', async () => {
        const managed = fakeHost({
            [`${PKG}\\tools\\ghdl-5.1.1\\bin\\ghdl.exe`]: '',
            [`${PKG}\\tools\\ghdl-6.0.0\\bin\\ghdl.exe`]: '',
        });
        assert.equal((await new WindowsToolLocator(managed).locate('ghdl'))?.path, `${PKG}\\tools\\ghdl-6.0.0\\bin\\ghdl.exe`);

        const perUser = fakeHost({ [`${USER}\\AppData\\Local\\NexysVHDL\\tools\\ghdl-6.0.0\\bin\\ghdl.exe`]: '' });
        assert.equal((await new WindowsToolLocator(perUser).locate('ghdl'))?.method, 'NexysVHDL per-user tools');

        const msys = fakeHost({ ['C:\\msys64\\ucrt64\\bin\\ghdl.exe']: '', ['D:\\bin\\ghdl.exe']: '' }, { PATH: 'D:\\bin' });
        assert.equal((await new WindowsToolLocator(msys).locate('ghdl'))?.method, 'MSYS2 ucrt64');

        const onPath = fakeHost({ ['D:\\x y\\ghdl.exe']: '' }, { Path: 'C:\\Windows;"D:\\x y";' });
        assert.deepEqual(await new WindowsToolLocator(onPath).locate('ghdl'), { path: 'D:\\x y\\ghdl.exe', method: 'PATH' });
    });

    it('only accepts .exe files from PATH (no .cmd/.bat that would need a shell)', async () => {
        const host = fakeHost({ ['D:\\bin\\apio.cmd']: '', ['D:\\bin\\apio.bat']: '' }, { PATH: 'D:\\bin' });
        assert.equal(await new WindowsToolLocator(host).locate('apio'), undefined);
    });

    it('finds nothing on an empty machine', async () => {
        const locator = new WindowsToolLocator(fakeHost({}, {}, undefined));
        for (const tool of ALL_TOOL_IDS) assert.equal(await locator.locate(tool), undefined, tool);
    });

    it('reads environment variables case-insensitively', () => {
        assert.equal(getEnv({ Path: 'a' }, 'PATH'), 'a');
        assert.equal(getEnv({ PROGRAMFILES: 'b' }, 'ProgramFiles'), 'b');
        assert.equal(getEnv({ X: '' }, 'X'), undefined);
    });
});

describe('Windows toolchain version detection', () => {
    /** Answers version probes with the Phase 2 Windows outputs. */
    function versionRunner() {
        return new FakeRunner((inv: ToolInvocation) => {
            const a = inv.args.join(' ');
            if (inv.executable.endsWith('ghdl.exe')) return { stdout: 'GHDL 6.0.0 (6.0.0.r0.ge589c698c.dirty) [Dunoon edition]\n' };
            if (a === '--version') return { stdout: 'Apio CLI version 1.6.0 (pyinst-windows-amd64-2026-09-15)\n' };
            if (a.includes('yosys')) return { stdout: 'Yosys 0.63+173 (git sha1 66306a8ca-dirty, clang++ 18.1.8 -O3)\n' };
            if (a.includes('nextpnr-xilinx')) return { stdout: '"nextpnr-xilinx" -- Next Generation Place and Route (Version 0eae9fb)\n' };
            if (a === '-version') return { stdout: 'Digilent JTAG Config Utility v2.6.1\n' };
            return { exitCode: 1 };
        });
    }

    it('detects every tool of the Phase 2 Windows manifest as compatible', async () => {
        const host = fakeHost(VALIDATED_MACHINE);
        const inspector = new WindowsToolchainInspector(new WindowsToolLocator(host), versionRunner(), host);
        const detected = await inspector.detectAll(ALL_TOOL_IDS);
        const versions = Object.fromEntries([...detected].map(([k, v]) => [k, v.version]));
        assert.deepEqual(versions, {
            ghdl: '6.0.0',
            apio: '1.6.0',
            openxc7: '2026-09-24',
            yosys: '0.63+173',
            'nextpnr-xilinx': '0eae9fb',
            programmer: '2.7.1',
        });
        assert.match(detected.get('programmer')!.rawVersion!, /Adept Runtime 2\.30\.4/);

        const manifest = JSON.parse(await readFile(join(REPO, 'toolchains', 'reference-phase2-windows-x64.json'), 'utf8')) as ToolchainManifest;
        assert.equal(evaluateToolchain(manifest, detected, ALL_TOOL_IDS).overall, 'compatible');
    });

    it('reports missing openXC7/programmer instead of guessing', async () => {
        const host = fakeHost({});
        const inspector = new WindowsToolchainInspector(new WindowsToolLocator(host), versionRunner(), host);
        assert.equal((await inspector.detect('openxc7'))?.found, false);
        assert.equal((await inspector.detect('programmer'))?.found, false);
        assert.equal(await inspector.detect('ghdl'), undefined);
    });

    it('leaves an unknown djtgcfg build without a package version', async () => {
        const host = fakeHost(VALIDATED_MACHINE);
        const runner = new FakeRunner(() => ({ stdout: 'Digilent JTAG Config Utility v9.9.9\n' }));
        const d = await new WindowsToolchainInspector(new WindowsToolLocator(host), runner, host).detect('programmer');
        assert.equal(d?.found, true);
        assert.equal(d?.version, undefined);
        assert.match(d!.rawVersion!, /unknown Adept Utilities package/);
    });
});

describe('Windows platform factory', () => {
    it('assembles locator, programmer and inspector without running anything', () => {
        const runner = new FakeRunner();
        const services = createWindowsPlatformServices(currentHost(), { environment: fakeHost({}), runner });
        assert.equal(services.id, 'windows');
        assert.equal(services.programmer.id, 'digilent-adept');
        assert.ok(services.toolLocator instanceof WindowsToolLocator);
        assert.ok(services.inspector instanceof WindowsToolchainInspector);
        assert.equal(runner.calls.length, 0);
    });

    it('the registered factory builds the real adapter on the base runner, undecorated', async () => {
        const runner = new FakeRunner();
        const services = createWindowsPlatform(currentHost(), { runner, env: {} });
        assert.equal(services.programmer?.id, 'digilent-adept');
        assert.ok(services.toolLocator instanceof WindowsToolLocator);
        assert.equal(services.runner, undefined); // composition root keeps the base runner
        assert.equal(runner.calls.length, 0);

        // Its inspection uses the locator it is given (project settings / NEXYSVHDL_* first).
        const inspection = await services.inspectToolchain!({ tools: ['ghdl'], locator: { locate: async () => undefined } });
        assert.equal(inspection.tools.size, 0);
        assert.equal(runner.calls.length, 0);
    });
});
