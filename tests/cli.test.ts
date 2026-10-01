import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { runCli } from '../cli/main';
import { BufferedOutput, EXIT } from '../cli/output';
import { canonicalBitstreamPath } from '../cli/commands/program';
import {
    type DetectedTool,
    NodeToolRunner,
    type ProgrammerProvider,
    ProgrammingError,
    succeeded,
    type ToolId,
    type ToolInvocation,
} from '../core';
import { FakeRunner, fakePlatform, ForbiddenRunner, isolatedCli, makeProject, REPO, trapProcesses } from './helpers';
import type { ContextOverrides } from '../cli/context';

const EXAMPLE = join(REPO, 'examples', 'nexys-a7-counter');

/**
 * Runs the CLI in-process with a fake host, a fake platform (no tools), a
 * runner that refuses everything and all child_process entry points trapped.
 * Nothing here can find or start the developer's real FPGA tools.
 */
async function cli(t: TestContext, args: string[], overrides: ContextOverrides = {}) {
    const trap = trapProcesses(t);
    const iso = isolatedCli(overrides);
    const out = new BufferedOutput();
    const code = await runCli(args, out, iso);
    assert.deepEqual(trap.attempts, [], 'no external process may be started');
    return { code, text: out.text(), runner: iso.runner };
}

describe('CLI (isolated: fake platform, no tools, no hardware)', () => {
    it('prints help and version', async (t) => {
        assert.equal((await cli(t, ['--help'])).code, EXIT.ok);
        assert.match((await cli(t, ['--version'])).text, /^\d+\.\d+\.\d+/);
    });

    it('doctor reports host, board support, expectations and provider state', async (t) => {
        const { code, text, runner } = await cli(t, ['doctor']);
        assert.equal(code, EXIT.ok);
        assert.match(text, /NexysVHDL Doctor/);
        assert.match(text, /platform: win32/); // the injected test host, identical on every OS
        assert.match(text, /adapter:  Test platform — fake platform \(no tools\)/);
        assert.match(text, /nexys-a7-100t/);
        assert.match(text, /GHDL:\n\s+expected: 6\.0\.0\n\s+detected: not checked/);
        assert.match(text, /Programmer:\s+not configured/);
        assert.equal((runner as ForbiddenRunner).calls.length, 0);
    });

    it('doctor shows the platform toolchain inspection instead of probing tools itself', async (t) => {
        const requested: ToolId[][] = [];
        const tool = (id: ToolId, version: string): [ToolId, DetectedTool] => [id, { tool: id, found: true, version, method: 'fake inspection' }];
        const platform = fakePlatform({
            async inspectToolchain(request) {
                requested.push([...request.tools]);
                return {
                    tools: new Map([tool('ghdl', '6.0.0'), tool('openxc7', '2026-09-24'), tool('programmer', '9.9.9')]),
                    diagnostics: [{ severity: 'warning', source: 'toolchain', code: 'FAKE_FINDING', message: 'a platform finding' }],
                };
            },
        });
        const { text, runner } = await cli(t, ['doctor'], { platform });
        assert.equal(requested.length, 1);
        assert.match(text, /GHDL:\n\s+expected: 6\.0\.0\n\s+detected: 6\.0\.0  \[fake inspection\]\n\s+status:\s+compatible/);
        assert.match(text, /openXC7:\n\s+expected: 2026-09-24\n\s+detected: 2026-09-24  \[fake inspection\]\n\s+status:\s+compatible/);
        assert.match(text, /Programmer \(.*\):\n\s+expected: 2\.7\.1\n\s+detected: 9\.9\.9 .*\n\s+status:\s+incompatible/);
        assert.match(text, /warning\s+a platform finding\s+\[FAKE_FINDING\]/);
        assert.equal((runner as ForbiddenRunner).calls.length, 0);
    });

    it('boards lists the proven Nexys A7 resources', async (t) => {
        const { code, text } = await cli(t, ['boards']);
        assert.equal(code, EXIT.ok);
        assert.match(text, /CLK100MHZ\s+clock\s+pin E3 LVCMOS33, 100 MHz/);
    });

    it('project info validates the example project and previews constraints', async (t) => {
        const { code, text } = await cli(t, ['project', 'info', '--project', EXAMPLE]);
        assert.equal(code, EXIT.ok);
        assert.match(text, /Validation: OK/);
        assert.match(text, /create_clock -name clk100mhz -period 10\.00/);
    });

    it('check / simulate / build fail honestly with "not configured" (exit 3)', async (t) => {
        for (const cmd of ['check', 'simulate', 'build']) {
            const { code, text } = await cli(t, [cmd, '--project', EXAMPLE]);
            assert.equal(code, EXIT.notConfigured, cmd);
            assert.match(text, /provider is not configured for this platform/, cmd);
            assert.doesNotMatch(text, /SUCCEEDED|PASSED/, cmd);
        }
    });

    it('program reports that no programmer is configured (exit 3)', async (t) => {
        const { code, text } = await cli(t, ['program', '--project', EXAMPLE]);
        assert.equal(code, EXIT.notConfigured);
        assert.match(text, /Programming provider is not configured for this platform\./);
    });

    it('rejects unknown commands and options with exit 2', async (t) => {
        assert.equal((await cli(t, ['frobnicate'])).code, EXIT.usage);
        assert.equal((await cli(t, ['doctor', '--bogus'])).code, EXIT.usage);
        assert.equal((await cli(t, ['check', '--project', join(REPO, 'does-not-exist')])).code, EXIT.usage);
    });

    it('the compiled CLI starts as a real process (help/version only: no context, no tool discovery)', async (t) => {
        trapProcesses(t, { allowNode: true });
        for (const [flag, expected] of [['--help', /nexysvhdl doctor/], ['--version', /^\d+\.\d+\.\d+/]] as const) {
            const r = await new NodeToolRunner().run({ executable: process.execPath, args: [join(REPO, 'dist', 'cli', 'main.js'), flag] });
            assert.ok(succeeded(r), r.stderr);
            assert.match(r.stdout, expected);
        }
    });
});

describe('CLI uses the platform-configured runner everywhere', () => {
    it('doctor, check, simulate and build run tools only through PlatformServices.runner', async (t) => {
        const platformRunner = new FakeRunner((inv: ToolInvocation) => {
            if (inv.args[0] === '--version') return { stdout: inv.executable.includes('ghdl') ? 'GHDL 6.0.0 (x) [Dunoon edition]\n' : 'Apio CLI version 1.6.0\n' };
            if (inv.args[0] === '--synth') return { stdout: 'module top(input sw, output led);\nendmodule\n' };
            if (inv.args[0] === '-r') return { stdout: 'counter_tb.vhd:1:1:@280ns:(report note): ALL TESTS PASSED\n' };
            return {};
        });
        const platform = fakePlatform({
            runner: platformRunner,
            toolLocator: { locate: async (tool) => (tool === 'ghdl' || tool === 'apio' ? { path: `C:\\fake\\${tool}.exe`, method: 'fake' } : undefined) },
        });
        const base = new ForbiddenRunner();
        const project = await makeProject(t);
        for (const cmd of [['doctor'], ['check'], ['simulate'], ['build']]) {
            await cli(t, [...cmd, '--project', project.root], { platform, runner: base });
        }
        assert.equal(base.calls.length, 0, 'the base runner must never be used when the platform supplies one');
        const tools = new Set(platformRunner.calls.map((c) => `${c.executable} ${c.args[0]}`));
        for (const expected of ['C:\\fake\\ghdl.exe --version', 'C:\\fake\\apio.exe --version', 'C:\\fake\\ghdl.exe -a', 'C:\\fake\\ghdl.exe -r', 'C:\\fake\\ghdl.exe --synth', 'C:\\fake\\apio.exe build']) {
            assert.ok(tools.has(expected), expected);
        }
    });
});

describe('CLI program with a failing provider', () => {
    async function projectWithBitstream(t: TestContext) {
        const project = await makeProject(t);
        const bit = canonicalBitstreamPath(project);
        await mkdir(join(bit, '..'), { recursive: true });
        await writeFile(bit, 'canonical-bitstream-bytes');
        return project;
    }

    function programmer(prepare: () => never): ProgrammerProvider {
        return {
            id: 'fake-programmer',
            displayName: 'Fake programmer',
            availability: async () => ({ available: true, detail: 'fake' }),
            detectBoards: async () => ({ boards: [{ selector: 'SN:1', serialNumber: '1', boardId: 'nexys-a7-100t' }], diagnostics: [] }),
            prepareArtifact: async () => prepare(),
            program: async () => {
                throw new Error('program must not be reached');
            },
        };
    }

    it('reports a preparation failure as diagnostics with exit 1, not a crash or stack trace', async (t) => {
        const project = await projectWithBitstream(t);
        const cases: Array<[() => never, RegExp]> = [
            [() => { throw new ProgrammingError([{ severity: 'error', source: 'programming', code: 'FAKE_BIT_MALFORMED', message: 'bitstream header is malformed' }]); }, /error\s+bitstream header is malformed/],
            [() => { throw new TypeError('unexpected provider bug'); }, /Fake programmer could not prepare .*: unexpected provider bug/],
        ];
        for (const [prepare, expected] of cases) {
            const { code, text } = await cli(t, ['program', '--project', project.root], { platform: fakePlatform({ programmer: programmer(prepare) }) });
            assert.equal(code, EXIT.failed);
            assert.match(text, /Program: FAILED/);
            assert.match(text, expected);
            assert.doesNotMatch(text, /\n\s+at .+:\d+:\d+/, 'no stack trace');
        }
    });
});
