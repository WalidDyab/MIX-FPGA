import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { ONLY_WINDOWS } from '../platform';
import { describe, it } from 'node:test';
import { InstallStateStore, SetupEngine } from '../../core';
import { compareTree, inventoryTree, makeWritable, treeIsIdentical } from '../../core/install/tree';
import { windowsLegacyDataRoots, windowsToolStateRoot, windowsUserDataRoot } from '../../platform/windows';
import { windowsDevPayload } from '../../platform/windows/install/dev-payload';
import { checkPathLength, isInsideForeignProduct, MAX_PATH, NEXYS_LONGEST_RELATIVE_PATH, resolveWindowsLayout } from '../../platform/windows/install/layout';
import { installedWindowsDe10Paths, parseRegValue } from '../../platform/windows/install/paths';
import { windowsToolchainDefinitions } from '../../platform/windows/install/toolchain';
import { loadExpectedToolchain } from '../../platform/shared/install/expected';
import { REPO, tempDir } from '../helpers';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const LOCAL = 'C:\\Users\\student\\AppData\\Local';
const MANIFEST = join(REPO, 'toolchains', 'mixfpga', 'toolchain-1.0-windows-x64.json');
const EXPERIMENTAL = join(REPO, 'toolchains', 'experimental');
const code = async (f: string) => (await readFile(join(REPO, f), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Windows runtime layout', () => {
    it('lives under %LOCALAPPDATA%\\MIX-FPGA with the support, toolchain, state, staging and logs areas', () => {
        const l = resolveWindowsLayout({ env: { LOCALAPPDATA: LOCAL } });
        assert.equal(l.root, win32.join(LOCAL, 'MIX-FPGA'));
        assert.equal(l.nexysRoot, win32.join(l.root, 'support', 'nexys-a7'));
        assert.equal(l.nexysStateRoot, win32.join(l.root, 'state', 'nexys-a7'));
        assert.equal(l.toolchainDir, win32.join(l.root, 'toolchains', '1.0', 'windows-x64'));
        assert.equal(l.jobsRoot, win32.join(l.root, 'staging', 'jobs'));
        assert.equal(l.installersDir, win32.join(l.root, 'staging', 'installers'));
        assert.equal(l.installStateFile, win32.join(l.root, 'state', 'install-state.json'));
        assert.equal(l.logsDir, win32.join(l.root, 'logs'));
        assert.equal(l.unit('scripts'), win32.join(l.toolchainDir, 'scripts'));
    });

    it('MIXFPGA_HOME is the only override and relocates everything', () => {
        const l = resolveWindowsLayout({ env: { LOCALAPPDATA: LOCAL, MIXFPGA_HOME: 'D:\\lab\\mf' } });
        for (const p of [l.root, l.nexysRoot, l.nexysStateRoot, l.toolchainDir, l.jobsRoot, l.installersDir, l.stateDir, l.logsDir, l.helperDir]) assert.ok(p.startsWith('D:\\lab\\mf'), p);
        assert.ok(![l.root, l.toolchainDir, l.stateDir].some((p) => p.includes('AppData')));
    });

    it('platform roots: Nexys store under support, tool state under the MIX-FPGA state area, NexysVHDL only as a legacy source', () => {
        const env = { LOCALAPPDATA: LOCAL };
        assert.equal(windowsUserDataRoot(env), win32.join(LOCAL, 'MIX-FPGA', 'support', 'nexys-a7'));
        assert.equal(windowsToolStateRoot(env), win32.join(LOCAL, 'MIX-FPGA', 'state', 'nexys-a7'));
        assert.deepEqual(windowsLegacyDataRoots(env), [win32.join(LOCAL, 'NexysVHDL')]);
        assert.deepEqual(windowsLegacyDataRoots({ ...env, MIXFPGA_HOME: 'D:\\lab' }), [], 'a relocated MIX-FPGA never sees NexysVHDL');
        assert.equal(windowsUserDataRoot({ ...env, MIXFPGA_HOME: 'D:\\lab' }), 'D:\\lab\\support\\nexys-a7');
    });

    it('installed tool paths come from the layout only: no repository, no experimental folder, support script inside the verified toolchain', () => {
        const l = resolveWindowsLayout({ env: { LOCALAPPDATA: LOCAL } });
        const p = installedWindowsDe10Paths(l);
        for (const v of [p.toolchainRoot, p.ghdl, p.yosys, p.partCheckScript, p.jobsRoot]) {
            assert.ok(v.startsWith(l.root), v);
            assert.doesNotMatch(v, /nexys|experimental|repo/i, v);
        }
        assert.equal(p.partCheckScript, win32.join(l.toolchainDir, 'scripts', 'part-check.tcl'));
        assert.equal(p.ghdl, win32.join(l.toolchainDir, 'ghdl', 'bin', 'ghdl.exe'));
    });

    it('never writes into another product\'s folder', () => {
        assert.equal(isInsideForeignProduct('C:\\Users\\s\\AppData\\Local\\NexysVHDL\\toolchains'), true);
        assert.equal(isInsideForeignProduct('C:\\Users\\s\\AppData\\Local\\MIX-FPGA\\support'), false);
    });

    it('reads registry values the way reg.exe prints them', () => {
        assert.equal(parseRegValue('\r\nHKEY_LOCAL_MACHINE\\X\r\n    InstallLocation    REG_SZ    C:/intelFPGA_lite/25.1std\r\n', 'InstallLocation'), 'C:/intelFPGA_lite/25.1std');
        assert.equal(parseRegValue('nothing', 'InstallLocation'), undefined);
    });
});

describe('Windows path-length preflight arithmetic', () => {
    it('the normal account root fits Windows\' limit for the Nexys tools with room to spare', () => {
        const root = win32.join(LOCAL, 'MIX-FPGA', 'support', 'nexys-a7', 'toolchains', 'win32-x64', '1.0');
        const c = checkPathLength(root, NEXYS_LONGEST_RELATIVE_PATH, false);
        assert.equal(c.ok, true);
        assert.equal(c.over, 0);
        assert.ok(c.worstLength < MAX_PATH - 1);
    });

    it('a deep root is detected, with the exact overshoot, and allowed when long paths are on', () => {
        const root = `C:\\${'folder-name-that-is-long\\'.repeat(6)}MIX-FPGA\\support\\nexys-a7\\toolchains\\win32-x64\\1.0`;
        const off = checkPathLength(root, NEXYS_LONGEST_RELATIVE_PATH, false);
        assert.equal(off.ok, false);
        assert.equal(off.over, root.length + 1 + NEXYS_LONGEST_RELATIVE_PATH - (MAX_PATH - 1));
        assert.equal(checkPathLength(root, NEXYS_LONGEST_RELATIVE_PATH, true).ok, true);
    });
});

describe('Windows installer independence', () => {
    it('layout, paths, installer, inspectors, support script locator and the runtime never mention the repository tool folder or the dev payload', async () => {
        for (const f of ['install/layout.ts', 'install/paths.ts', 'install/toolchain.ts', 'install/nexys-support.ts', 'install/quartus-install.ts', 'install/setup-controller.ts', 'install/boards.ts', 'de10/runtime.ts', 'de10/native-quartus-engine.ts']) {
            const text = await code(join('platform', 'windows', f));
            assert.doesNotMatch(text, /experimental|packageRoot|MIXFPGA_DEV_PAYLOAD|MIXFPGA_TOOLCHAIN_ROOT|MIXFPGA_QUARTUS_ROOT|defaultWindowsPaths/i, f);
        }
    });

    it('the only environment variable the layout reads is MIXFPGA_HOME', async () => {
        const text = await code(join('platform', 'windows', 'install', 'layout.ts'));
        assert.deepEqual([...new Set(text.match(/MIXFPGA_[A-Z_]+/g))], ['MIXFPGA_HOME']);
    });

    it('the Windows installer never runs openFPGALoader or any Linux/Lima tool', async () => {
        for (const f of await readdir(join(REPO, 'platform', 'windows', 'install'))) {
            const text = await code(join('platform', 'windows', 'install', f));
            assert.doesNotMatch(text, /openfpgaloader|limactl|rosetta|\bbash\b/i, f);
        }
    });
});

describe('Windows Toolchain 1.0 manifest', () => {
    it('the committed manifest is well formed and lists the two validated tools', async () => {
        const { toolchain } = await loadExpectedToolchain(MANIFEST);
        assert.equal(toolchain.toolchainVersion, '1.0');
        assert.equal(toolchain.target, 'windows-x64');
        assert.deepEqual(toolchain.units.filter((u) => u.kind === 'tool').map((u) => `${u.id} ${u.version}`), ['ghdl 6.0.0', 'yosys 0.63+173']);
        assert.deepEqual(toolchain.units.filter((u) => u.kind === 'support').map((u) => u.id), ['scripts', 'licenses', 'notices']);
        for (const u of toolchain.units.filter((x) => x.kind === 'tool')) assert.ok(u.files.some((f) => f.path === u.executable), `${u.id} executable`);
        assert.ok(toolchain.units.every((u) => u.links.length === 0 && u.files.every((f) => !f.exec)), 'Windows files carry no link or exec-bit semantics');
    });

    it('the manifest is current for the support script and the notices committed in this repository', async () => {
        const { toolchain } = await loadExpectedToolchain(MANIFEST);
        const check = async (id: string, path: string) => {
            const unit = toolchain.units.find((u) => u.id === id)!;
            const d = compareTree(unit, await inventoryTree(path));
            assert.ok(treeIsIdentical(d), `${id} differs from the recorded manifest: re-run scripts/mixfpga/record-toolchain-windows.mjs (${JSON.stringify(d)})`);
        };
        await check('scripts', join(REPO, 'platform', 'windows', 'scripts'));
        const notices = join(REPO, 'toolchains', 'mixfpga', 'notices', 'windows-x64');
        await check('licenses', join(notices, 'LICENSES'));
        await check('notices', join(notices, 'THIRD_PARTY_NOTICES.txt'));
    });

    it('the notices stay marked DRAFT while the legal questions are open', async () => {
        const text = await readFile(join(REPO, 'toolchains', 'mixfpga', 'notices', 'windows-x64', 'THIRD_PARTY_NOTICES.txt'), 'utf8');
        assert.match(text.split('\n')[1]!, /DRAFT - NOT FOR REDISTRIBUTION/);
    });
});

describe('real validated tools (skipped when toolchains/experimental is absent)', { skip: ONLY_WINDOWS }, () => {
    it('install into an isolated root, then run from the installed location only, with nothing but the Windows folders on PATH', async (t) => {
        if (!(await stat(EXPERIMENTAL).then(() => true, () => false))) return t.skip('no development payload on this machine');
        const dir = await mkdtemp(join(tmpdir(), 'mixfpga real '));
        t.after(async () => {
            await makeWritable(dir).catch(() => undefined);
            await rm(dir, { recursive: true, force: true });
        });
        const expected = await loadExpectedToolchain(MANIFEST);
        const layout = resolveWindowsLayout({ env: { MIXFPGA_HOME: join(dir, 'MIX-FPGA') } });
        const payload = windowsDevPayload({ toolsRoot: EXPERIMENTAL, scriptsDir: join(REPO, 'platform', 'windows', 'scripts'), noticesDir: join(REPO, 'toolchains', 'mixfpga', 'notices', 'windows-x64') });
        const ctx = { layout, expected, payload, host: { platform: 'win32', arch: 'x64' }, freeBytes: async () => 1e12 };
        const engine = new SetupEngine(windowsToolchainDefinitions(ctx, 'full'), new InstallStateStore(layout.installStateFile, layout.lockFile));
        const r = await engine.run();
        assert.equal(r.outcome, 'complete', JSON.stringify(r.steps));
        assert.ok(r.statuses.every((s) => s.state === 'ready'));
        const env = { ...process.env, PATH: `${process.env['SystemRoot']}\\System32;${process.env['SystemRoot']}` };
        const out = async (exe: string, args: string[]) => {
            const x = await run(join(layout.toolchainDir, exe), args, { env });
            return `${x.stdout}${x.stderr}`;
        };
        assert.match(await out('ghdl\\bin\\ghdl.exe', ['--version']), /GHDL 6\.0\.0/);
        assert.match(await out('yosys\\bin\\yosys.exe', ['-V']), /Yosys 0\.63/);
        // The installed GHDL really analyses and elaborates VHDL (its library path is relative to itself).
        const work = join(dir, 'work');
        await run('cmd.exe', ['/c', 'mkdir', work]);
        const ghdl = join(layout.toolchainDir, 'ghdl', 'bin', 'ghdl.exe');
        await run(ghdl, ['-a', '--std=08', `--workdir=${work}`, join(REPO, 'experiments', 'phase1-de10-blink', 'src', 'blink.vhd')], { env });
        await run(ghdl, ['-e', '--std=08', `--workdir=${work}`, 'blink'], { env });
        assert.ok((await stat(join(layout.unit('scripts'), 'part-check.tcl'))).isFile());
        void tempDir;
    });
});
