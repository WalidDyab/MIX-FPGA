import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { describe, it } from 'node:test';
import { dataPaths, type HostInfo, type ToolInvocation, WorkspaceManager } from '../../../core';
import { createPlatformServices } from '../../../platform';
import { APIO_REMOTE_CONFIG_ENV, createMacosAdapter, createMacosPlatform, PinnedApioRunner, ResolvedApioIdentity } from '../../../platform/macos';
import { makeProject, REPO, repoBoards } from '../../helpers';
import { APIO, argsInclude, fakeSystem, type FakeFile, fixture, machO, scriptedRunner, validatedMacFiles } from './macos-fakes';

/**
 * Regression for the Phase 3B incident: an Apio call without the pinned
 * APIO_REMOTE_CONFIG_URL let Apio replace openXC7 2026-09-25 with the
 * incompatible 2026-09-27 package. Every Apio invocation the macOS adapter can
 * make must carry the pin, and the registered factory must not reach real tools.
 */

const HOST: HostInfo = { platform: 'darwin', arch: 'arm64', nodeVersion: 'v24.0.0' };
const ROOT = '/Users/student/My Projects/NexysVHDL';
const PIN_URL = `file://${ROOT}/toolchains/apio-remote-config/apio-{major}.{minor}.x.jsonc`;
const PIN_TEXT = readFileSync(join(dataPaths(REPO).toolchains, 'apio-remote-config', 'apio-1.7.x.jsonc'), 'utf8');

const isApio = (inv: ToolInvocation) => posix.basename(inv.executable) === 'apio';

function recordingAdapter(root = ROOT, env: Record<string, string> = {}, extra: Record<string, FakeFile> = {}) {
    const runner = scriptedRunner([
        [argsInclude('yosys'), { stdout: 'Yosys 0.63+173 (git sha1 66306a8ca-dirty)\n' }],
        [argsInclude('nextpnr-xilinx'), { stdout: '"nextpnr-xilinx" -- Next Generation Place and Route (Version e860c9c8)\n' }],
        [argsInclude('--version'), { stdout: 'Apio CLI version 1.7.0 (pyinst-darwin-arm64-2026-09-27)\nGHDL 6.0.0 (6.0.0.r0) [Dunoon edition]\n' }],
        [argsInclude('--Version'), { stdout: fixture('ofl-version.txt') }],
        [argsInclude('build'), { stdout: 'build log\n' }],
        [() => true, {}],
    ]);
    const system = fakeSystem(validatedMacFiles({ [`${ROOT}/toolchains/apio-remote-config/apio-1.7.x.jsonc`]: { text: PIN_TEXT }, ...extra }), env);
    return { runner, adapter: createMacosAdapter(HOST, { system, runner, root }) };
}

describe('macOS Apio pin regression', () => {
    it('every Apio invocation made through the real macOS adapter carries the pinned APIO_REMOTE_CONFIG_URL', async (t) => {
        const { runner, adapter } = recordingAdapter();

        // 1. toolchain detection: apio --version, apio raw -- yosys -V, apio raw -- nextpnr-xilinx --version
        const report = await adapter.toolchainDetector().detect();
        assert.equal(report.tools.get('openxc7')?.version, '2026.09.25');

        // 2. the shared Apio implementation provider, built by the adapter: apio build
        const { implementation, vhdl } = await adapter.providers();
        assert.ok(implementation && vhdl);
        const project = await makeProject(t);
        const { workspace } = await new WorkspaceManager().open(project);
        const verilog = join(workspace!.paths.synth, 'generated.v');
        await writeFile(verilog, 'module top; endmodule\n');
        await implementation.implement({
            project,
            board: (await repoBoards()).get('nexys-a7-100t')!,
            workspace: workspace!,
            verilog: { kind: 'generated-verilog', path: verilog, canonical: false },
            xdc: '# xdc\n',
        });

        // 3. anything else run through the adapter's runner
        await adapter.runner.run({ executable: APIO, args: ['packages', 'list'], env: { [APIO_REMOTE_CONFIG_ENV]: 'https://upstream/apio-1.7.x.jsonc' } });

        const apioCalls = runner.calls.filter(isApio);
        assert.deepEqual(
            apioCalls.map((c) => c.args.join(' ')),
            ['--version', 'raw -- yosys -V', 'raw -- nextpnr-xilinx --version', 'build --verbose', 'packages list'],
        );
        for (const call of apioCalls) assert.equal(call.env?.[APIO_REMOTE_CONFIG_ENV], PIN_URL, call.args.join(' '));
        for (const call of runner.calls.filter((c) => !isApio(c))) assert.equal(call.env?.[APIO_REMOTE_CONFIG_ENV], undefined);
    });

    it('refuses to run Apio at all when the pin cannot be expressed', async () => {
        const { runner, adapter } = recordingAdapter('/Users/student/{odd}/NexysVHDL');
        assert.match(adapter.status, /Apio refused/);
        const r = await adapter.runner.run({ executable: APIO, args: ['build'] });
        assert.equal(r.outcome, 'spawn-failed');
        assert.match(r.errorMessage ?? '', /refused to run Apio/);
        assert.equal(runner.calls.filter(isApio).length, 0);
    });

    it('the registered factory supplies the pinned runner as the platform runner; Apio is never run unpinned', async () => {
        for (const make of [createMacosPlatform, createPlatformServices]) {
            const base = scriptedRunner([[() => true, {}]]);
            const services = make(HOST, { runner: base, env: {} });
            assert.equal(services.id, 'macos');
            assert.ok(services.runner, 'the composition root must use the adapter runner');
            assert.ok(services.programmer && services.toolLocator && services.inspectToolchain);
            assert.equal(base.calls.length, 0, 'building the adapter runs nothing');

            await services.runner.run({ executable: APIO, args: ['raw', '--', 'yosys', '-V'] });
            // On a POSIX checkout the tracked pin is injected; on a Windows checkout it cannot be
            // expressed as a macOS file:// URL, so Apio is refused. Never unpinned.
            for (const call of base.calls.filter(isApio)) assert.match(call.env?.[APIO_REMOTE_CONFIG_ENV] ?? '', /^file:\/\/\/.*apio-\{major\}\.\{minor\}\.x\.jsonc$/);
        }
    });
});

/**
 * Phase 3C review: the pin used to be applied only when the executable's file
 * name was literally `apio`, so supported overrides that resolve to the real
 * Apio (NEXYSVHDL_APIO=/Applications/Apio/Apio on case-insensitive APFS, a
 * versioned alias, a symlink, a project-setting path) ran Apio UNPINNED.
 */
describe('macOS Apio pin: identity by resolved executable, not by name', () => {
    const ALIASES = {
        caseVariant: '/Applications/Apio/Apio',
        versioned: '/opt/apio/apio-1.7.0',
        symlink: '/usr/local/bin/fpga-synth',
        otherCopy: '/Volumes/lab/apio-dist/apio-cli-bin',
    };
    const UNRELATED = ['/opt/tools/apio-helper', '/opt/tools/rapio', '/usr/local/bin/yosys-wrapper'];
    const files: Record<string, FakeFile> = {
        '/Applications/Apio/BUILD-INFO.json': { text: '{ "package-name": "apio-cli", "apio-cli-version": "1.7.0" }' },
        [ALIASES.versioned]: { link: APIO },
        [ALIASES.symlink]: { link: ALIASES.versioned },
        [ALIASES.otherCopy]: { head: machO('arm64'), executable: true },
        '/Volumes/lab/apio-dist/BUILD-INFO.json': { text: '{ "package-name": "apio-cli" }' },
        ...Object.fromEntries(UNRELATED.map((p) => [p, { head: machO('arm64'), executable: true }])),
        '/opt/tools/BUILD-INFO.json': { text: '{ "package-name": "something-else" }' },
    };
    const pinOf = (calls: readonly ToolInvocation[], exe: string) => calls.filter((c) => c.executable === exe).map((c) => c.env?.[APIO_REMOTE_CONFIG_ENV]);

    it('pins `apio`, the differently-cased path, a versioned alias, a symlink chain and another Apio copy', async () => {
        const { runner, adapter } = recordingAdapter(ROOT, {}, files);
        for (const exe of [APIO, ...Object.values(ALIASES)]) {
            await adapter.runner.run({ executable: exe, args: ['raw', '--', 'yosys', '-V'] });
            assert.deepEqual(pinOf(runner.calls, exe), [PIN_URL], exe);
        }
    });

    it('does not treat unrelated executables as Apio, even if their name contains "apio"', async () => {
        const { runner, adapter } = recordingAdapter(ROOT, {}, files);
        for (const exe of UNRELATED) {
            const r = await adapter.runner.run({ executable: exe, args: ['--version'] });
            assert.equal(r.outcome, 'exited', exe);
            assert.deepEqual(pinOf(runner.calls, exe), [undefined], exe);
        }
    });

    for (const [name, override] of Object.entries(ALIASES)) {
        it(`NEXYSVHDL_APIO=${override} (${name}): detection and build calls are all pinned`, async (t) => {
            const { runner, adapter } = recordingAdapter(ROOT, { NEXYSVHDL_APIO: override }, files);
            assert.equal((await adapter.toolLocator!.locate('apio'))?.path, override);
            await adapter.toolchainDetector().detect();
            const { implementation } = await adapter.providers();
            const project = await makeProject(t);
            const { workspace } = await new WorkspaceManager().open(project);
            const verilog = join(workspace!.paths.synth, 'generated.v');
            await writeFile(verilog, 'module top; endmodule\n');
            await implementation!.implement({
                project, board: (await repoBoards()).get('nexys-a7-100t')!, workspace: workspace!,
                verilog: { kind: 'generated-verilog', path: verilog, canonical: false }, xdc: '# xdc\n',
            });
            const calls = runner.calls.filter((c) => c.executable === override);
            assert.deepEqual(calls.map((c) => c.args.join(' ')), ['--version', 'raw -- yosys -V', 'raw -- nextpnr-xilinx --version', 'build --verbose']);
            for (const c of calls) assert.equal(c.env?.[APIO_REMOTE_CONFIG_ENV], PIN_URL, c.args.join(' '));
        });
    }

    it('refuses the resolved Apio when the pin is unavailable, whatever the path is called', async () => {
        const { runner, adapter } = recordingAdapter('/Users/student/{odd}/NexysVHDL', { NEXYSVHDL_APIO: ALIASES.caseVariant }, files);
        for (const exe of [APIO, ...Object.values(ALIASES)]) {
            const r = await adapter.runner.run({ executable: exe, args: ['build'] });
            assert.equal(r.outcome, 'spawn-failed', exe);
            assert.match(r.errorMessage ?? '', /refused to run Apio/);
        }
        assert.equal(runner.calls.length, 0);
    });

    it('recognises the locator-resolved Apio by file identity even without a BUILD-INFO.json', async () => {
        // Case-insensitive volume: /SRV/BIN/APIO-REAL names the same file.
        const system = fakeSystem({ '/srv/bin/apio-real': { head: machO('arm64'), executable: true }, '/srv/bin/other-tool': { head: machO('arm64'), executable: true } });
        const identity = new ResolvedApioIdentity(system, async () => ['/srv/bin/apio-real']);
        assert.equal(await identity.isApio('/srv/bin/apio-real'), true);
        assert.equal(await identity.isApio('/SRV/BIN/APIO-REAL'), true);
        assert.equal(await identity.isApio('/srv/bin/other-tool'), false);
        assert.equal(await identity.isApio('/srv/bin/missing'), false);
        const inner = scriptedRunner([[() => true, {}]]);
        await new PinnedApioRunner(inner, { [APIO_REMOTE_CONFIG_ENV]: 'file:///pin' }, identity).run({ executable: '/SRV/BIN/APIO-REAL', args: [] });
        assert.equal(inner.calls[0]!.env?.[APIO_REMOTE_CONFIG_ENV], 'file:///pin');
    });
});

