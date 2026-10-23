import assert from 'node:assert/strict';
import { readFile, readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { InstallStateStore, SetupEngine } from '../../core';
import { compareTree, inventoryTree, makeWritable, treeIsIdentical } from '../../core/install/tree';
import { DEV_PAYLOAD_VARIABLE, devPayload } from '../../platform/macos/install/dev-payload';
import { loadExpectedToolchain } from '../../platform/macos/install/expected';
import { MACOS_CATALOG, studentRows } from '../../platform/macos/install/catalog';
import { resolveRuntimeLayout } from '../../platform/macos/install/layout';
import { toolchainDefinitions } from '../../platform/macos/install/toolchain-components';
import { REPO } from '../helpers';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ONLY_MACOS } from '../platform';

const run = promisify(execFile);
const MANIFEST = join(REPO, 'toolchains', 'mixfpga', 'toolchain-1.1-macos-arm64.json');
// The tools the 1.1 manifest records: the validated 1.0 tools after the compliance changes (built by scripts/mixfpga/assemble-1.1.mjs).
const EXPERIMENTAL = join(REPO, '.artifacts', 'tools-1.1');
const code = async (f: string) => (await readFile(join(REPO, f), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('installer independence', () => {
    it('the development payload variable is read by the installer development module only, never by runtime resolution', async () => {
        const files = (await readdir(join(REPO, 'platform'), { recursive: true })).filter((f) => f.endsWith('.ts')).map((f) => join('platform', f));
        files.push(...(await readdir(join(REPO, 'core'), { recursive: true })).filter((f) => f.endsWith('.ts')).map((f) => join('core', f)), ...(await readdir(join(REPO, 'runtime'))).filter((f) => f.endsWith('.ts')).map((f) => join('runtime', f)));
        const offenders: string[] = [];
        for (const f of files) {
            const text = await code(f);
            if (text.includes(DEV_PAYLOAD_VARIABLE) || text.includes('MIXFPGA_DEV_PAYLOAD')) offenders.push(f);
        }
        assert.deepEqual(offenders.sort(), [join('platform', 'macos', 'install', 'dev-payload.ts'), join('platform', 'windows', 'install', 'dev-payload.ts')]);
    });

    it('layout, installer, inspectors and manifest reader never mention the repository tool folder or the dev payload', async () => {
        for (const f of ['layout', 'expected', 'toolchain-installer', 'toolchain-components', 'catalog']) {
            const text = await code(join('platform', 'macos', 'install', `${f}.ts`));
            assert.doesNotMatch(text, /experimental|packageRoot|repoRoot|MIXFPGA_DEV_PAYLOAD|MIXFPGA_TOOLCHAIN_ROOT/i, f);
        }
    });

    it('the only environment variable the layout reads is MIXFPGA_HOME', async () => {
        const text = await code(join('platform', 'macos', 'install', 'layout.ts'));
        assert.deepEqual([...new Set(text.match(/MIXFPGA_[A-Z_]+/g))], ['MIXFPGA_HOME']);
    });
});

describe('Toolchain 1.1 manifest and catalog', () => {
    it('the committed manifest is well formed and lists the four validated tools', async () => {
        const { toolchain } = await loadExpectedToolchain(MANIFEST);
        assert.equal(toolchain.toolchainVersion, '1.1');
        assert.deepEqual(toolchain.units.filter((u) => u.kind === 'tool').map((u) => `${u.id} ${u.version}`), ['ghdl 6.0.0', 'yosys 0.63', 'openfpgaloader 1.1.1', 'lima 2.2.1']);
        for (const u of toolchain.units.filter((x) => x.kind === 'tool')) assert.ok(u.files.some((f) => f.path === u.executable && f.exec), `${u.id} executable`);
    });

    it('the manifest is current for the engine scripts and notices committed in this repository', { skip: ONLY_MACOS }, async () => {
        const { toolchain } = await loadExpectedToolchain(MANIFEST);
        const check = async (id: string, dir: string) => {
            const unit = toolchain.units.find((u) => u.id === id)!;
            const d = compareTree(unit, await inventoryTree(dir));
            assert.ok(treeIsIdentical(d), `${id} differs from the recorded manifest: re-run scripts/mixfpga/record-toolchain.mjs (${JSON.stringify(d)})`);
        };
        await check('engine', join(REPO, 'platform', 'macos', 'lima'));
        const notices = join(REPO, 'toolchains', 'mixfpga', 'notices', 'macos-arm64-1.1');
        await check('licenses', join(notices, 'LICENSES'));
        await check('notices', join(notices, 'THIRD_PARTY_NOTICES.txt'));
    });

    it('lists every component once (the Nexys A7 bundle and the ten DE10-Lite parts), with ownership, and no student-facing Linux terms', () => {
        assert.deepEqual(MACOS_CATALOG.map((c) => c.id), ['nexys-toolchain', 'toolchain', 'ghdl', 'yosys', 'openfpgaloader', 'lima', 'rosetta', 'linux-vm', 'quartus', 'max10', 'programmer']);
        const own = Object.fromEntries(MACOS_CATALOG.map((c) => [c.id, c.ownership]));
        assert.deepEqual([own['rosetta'], own['quartus'], own['max10'], own['ghdl'], own['linux-vm']], ['system', 'external', 'external', 'managed', 'managed']);
        for (const c of MACOS_CATALOG) assert.doesNotMatch(c.label, /limactl|ubuntu|mixfpga-q|rosettad/i);
        for (const c of MACOS_CATALOG) for (const r of c.requires) assert.ok(MACOS_CATALOG.some((x) => x.id === r), `${c.id} requires unknown ${r}`);
    });

    it('turns component states into the three student rows, worst state first', () => {
        const s = (id: string, state: 'ready' | 'not-installed' | 'repairable' | 'failed') => ({ id, state, ownership: 'managed' as const });
        const ready = MACOS_CATALOG.map((c) => s(c.id, 'ready'));
        assert.deepEqual(studentRows(ready).map((r) => [r.label, r.word]), [['VHDL Tools', 'Ready'], ['FPGA Engine', 'Ready'], ['Programmer', 'Ready']]);
        const fresh = MACOS_CATALOG.map((c) => s(c.id, 'not-installed'));
        assert.deepEqual(studentRows(fresh).map((r) => r.word), ['Not installed', 'Not installed', 'Not installed']);
        const mixed = ready.map((x) => (x.id === 'quartus' ? s('quartus', 'failed') : x.id === 'ghdl' ? s('ghdl', 'repairable') : x));
        assert.deepEqual(studentRows(mixed).map((r) => r.word), ['Needs repair', 'Failed', 'Ready']);
    });
});

describe('real validated tools (skipped when the assembled 1.1 tools are absent)', () => {
    it('install into an isolated root, then run from the installed location only', { skip: ONLY_MACOS }, async (t) => {
        if (!(await stat(EXPERIMENTAL).then(() => true, () => false))) return t.skip('no development payload on this machine');
        const dir = await mkdtemp(join(tmpdir(), 'mixfpga real '));
        t.after(async () => {
            await makeWritable(dir).catch(() => undefined);
            await rm(dir, { recursive: true, force: true });
        });
        const expected = await loadExpectedToolchain(MANIFEST);
        const layout = resolveRuntimeLayout({ env: { MIXFPGA_HOME: join(dir, 'MIX-FPGA') } });
        const payload = devPayload({ toolsRoot: EXPERIMENTAL, engineDir: join(REPO, 'platform', 'macos', 'lima'), noticesDir: join(REPO, 'toolchains', 'mixfpga', 'notices', 'macos-arm64-1.1') });
        const ctx = { layout, expected, payload, freeBytes: async () => 1e12 };
        const engine = new SetupEngine(toolchainDefinitions(ctx, 'full'), new InstallStateStore(layout.installStateFile, layout.lockFile));
        const r = await engine.run();
        assert.equal(r.outcome, 'complete', JSON.stringify(r.steps));
        assert.ok(r.statuses.every((s) => s.state === 'ready'));
        const out = async (exe: string, args: string[]) => {
            const x = await run(join(layout.toolchainDir, exe), args);
            return `${x.stdout}${x.stderr}`;
        };
        assert.match(await out('ghdl/bin/ghdl', ['--version']), /GHDL 6\.0\.0/);
        assert.match(await out('yosys/libexec/yosys', ['-V']), /Yosys 0\.63/);
        assert.match(await out('openfpgaloader/libexec/openFPGALoader', ['-V']), /v1\.1\.1/);
        assert.match(await out('lima/bin/limactl', ['--version']), /2\.2\.1/);
        // The installed GHDL really analyses and elaborates VHDL (its library path is relative to itself).
        const work = join(dir, 'work');
        await run('mkdir', ['-p', work]);
        const ghdl = join(layout.toolchainDir, 'ghdl', 'bin', 'ghdl');
        await run(ghdl, ['-a', '--std=08', `--workdir=${work}`, join(REPO, 'experiments', 'phase1-de10-blink', 'src', 'blink.vhd')]);
        await run(ghdl, ['-e', '--std=08', `--workdir=${work}`, 'blink']);
    });
});
