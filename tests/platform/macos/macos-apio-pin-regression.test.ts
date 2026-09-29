import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { describe, it } from 'node:test';
import { dataPaths, type HostInfo, type ToolInvocation, WorkspaceManager } from '../../../core';
import { createPlatformServices } from '../../../platform';
import { APIO_REMOTE_CONFIG_ENV, createMacosAdapter, createMacosPlatform } from '../../../platform/macos';
import { makeProject, REPO, repoBoards } from '../../helpers';
import { APIO, argsInclude, fakeSystem, fixture, scriptedRunner, validatedMacFiles } from './macos-fakes';

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

function recordingAdapter(root = ROOT) {
    const runner = scriptedRunner([
        [argsInclude('yosys'), { stdout: 'Yosys 0.63+173 (git sha1 66306a8ca-dirty)\n' }],
        [argsInclude('nextpnr-xilinx'), { stdout: '"nextpnr-xilinx" -- Next Generation Place and Route (Version e860c9c8)\n' }],
        [argsInclude('--version'), { stdout: 'Apio CLI version 1.7.0 (pyinst-darwin-arm64-2026-09-27)\nGHDL 6.0.0 (6.0.0.r0) [Dunoon edition]\n' }],
        [argsInclude('--Version'), { stdout: fixture('ofl-version.txt') }],
        [argsInclude('build'), { stdout: 'build log\n' }],
        [() => true, {}],
    ]);
    const system = fakeSystem(validatedMacFiles({ [`${ROOT}/toolchains/apio-remote-config/apio-1.7.x.jsonc`]: { text: PIN_TEXT } }));
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

    it('the factory registered in platform/index.ts is inert: no locator, programmer or runner reach local tools', () => {
        for (const services of [createMacosPlatform(HOST), createPlatformServices(HOST)]) {
            assert.equal(services.id, 'macos');
            assert.equal(services.toolLocator, undefined);
            assert.equal(services.programmer, undefined);
            assert.equal('runner' in services, false);
        }
    });
});
