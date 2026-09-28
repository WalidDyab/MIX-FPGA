import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCli } from '../cli/main';
import { BufferedOutput, EXIT } from '../cli/output';
import { currentHost, NodeToolRunner, succeeded } from '../core';
import { createPlatformServices } from '../platform';
import { REPO } from './helpers';

const EXAMPLE = join(REPO, 'examples', 'nexys-a7-counter');
/** No tool paths: the CLI must work with no GHDL, Apio, Vivado or board present. */
const NO_TOOLS = { env: {} };

async function cli(args: string[]) {
    const out = new BufferedOutput();
    const code = await runCli(args, out, NO_TOOLS);
    return { code, text: out.text() };
}

describe('CLI (no FPGA tools, no hardware)', () => {
    it('prints help and version', async () => {
        assert.equal((await cli(['--help'])).code, EXIT.ok);
        assert.match((await cli(['--version'])).text, /^\d+\.\d+\.\d+/);
    });

    it('doctor reports host, board support, expectations and provider state', async () => {
        const { code, text } = await cli(['doctor']);
        assert.equal(code, EXIT.ok);
        assert.match(text, /NexysVHDL Doctor/);
        assert.match(text, new RegExp(`platform: ${process.platform}`));
        assert.match(text, /nexys-a7-100t/);
        assert.match(text, /GHDL:\n\s+expected: .*\n\s+detected: not checked/);
        assert.match(text, /Programmer:\s+not configured/);
    });

    it('boards lists the proven Nexys A7 resources', async () => {
        const { code, text } = await cli(['boards']);
        assert.equal(code, EXIT.ok);
        assert.match(text, /CLK100MHZ\s+clock\s+pin E3 LVCMOS33, 100 MHz/);
    });

    it('project info validates the example project and previews constraints', async () => {
        const { code, text } = await cli(['project', 'info', '--project', EXAMPLE]);
        assert.equal(code, EXIT.ok);
        assert.match(text, /Validation: OK/);
        assert.match(text, /create_clock -name clk100mhz -period 10\.00/);
    });

    it('check / simulate / build fail honestly with "not configured" (exit 3)', async () => {
        for (const cmd of ['check', 'simulate', 'build']) {
            const { code, text } = await cli([cmd, '--project', EXAMPLE]);
            assert.equal(code, EXIT.notConfigured, cmd);
            assert.match(text, /provider is not configured for this platform/, cmd);
            assert.doesNotMatch(text, /SUCCEEDED|PASSED/, cmd);
        }
    });

    it('program reports that no programmer is configured (exit 3)', async () => {
        const { code, text } = await cli(['program', '--project', EXAMPLE]);
        assert.equal(code, EXIT.notConfigured);
        assert.match(text, /Programming provider is not configured for this platform\./);
    });

    it('rejects unknown commands and options with exit 2', async () => {
        assert.equal((await cli(['frobnicate'])).code, EXIT.usage);
        assert.equal((await cli(['doctor', '--bogus'])).code, EXIT.usage);
        assert.equal((await cli(['check', '--project', join(REPO, 'does-not-exist')])).code, EXIT.usage);
    });

    it('the compiled CLI starts as a real process', async () => {
        const r = await new NodeToolRunner().run({
            executable: process.execPath,
            args: [join(REPO, 'dist', 'cli', 'main.js'), 'doctor'],
            env: { NEXYSVHDL_GHDL: undefined, NEXYSVHDL_APIO: undefined },
        });
        assert.ok(succeeded(r), r.stderr);
        assert.match(r.stdout, /NexysVHDL Doctor/);
    });
});

describe('platform adapters (Phase 3A placeholders)', () => {
    it('map win32/darwin to placeholder adapters that provide nothing yet', () => {
        const host = currentHost();
        for (const platform of ['win32', 'darwin']) {
            const services = createPlatformServices({ ...host, platform });
            assert.equal(services.programmer, undefined);
            assert.equal(services.toolLocator, undefined);
        }
        assert.equal(createPlatformServices({ ...host, platform: 'linux' }).id, 'unsupported');
    });
});
