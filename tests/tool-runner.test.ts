import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { NodeToolRunner, succeeded } from '../core';
import { tempDir } from './helpers';

const runner = new NodeToolRunner();
/** Node itself is the one executable guaranteed to exist on every platform. */
const NODE = process.execPath;
const ECHO_ARGS = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';

describe('NodeToolRunner', () => {
    it('keeps arguments with spaces and shell metacharacters as single, unexpanded arguments', async () => {
        const args = [
            'C:\\Program Files (x86)\\Some Vendor\\tool.exe',
            '/Users/First Last/My Projects/top.vhd',
            'a && echo injected',
            '%PATH%',
            '$HOME',
            '"quoted"',
            '',
        ];
        const r = await runner.run({ executable: NODE, args: ['-e', ECHO_ARGS, ...args] });
        assert.ok(succeeded(r), r.stderr);
        assert.deepEqual(JSON.parse(r.stdout), args);
    });

    it('runs in a working directory whose path contains spaces', async (t) => {
        const dir = join(await tempDir(t), 'dir with spaces');
        await mkdir(dir);
        const r = await runner.run({ executable: NODE, args: ['-e', 'process.stdout.write(process.cwd())'], cwd: dir });
        assert.ok(succeeded(r), r.stderr);
        // The child reports its cwd with symlinks resolved (macOS /var -> /private/var) and
        // Windows may hand out 8.3 temp names, so compare canonical paths on both sides.
        assert.equal((await realpath(r.stdout)).toLowerCase(), (await realpath(dir)).toLowerCase());
    });

    it('applies environment overrides and removals', async () => {
        const r = await runner.run({
            executable: NODE,
            args: ['-e', 'process.stdout.write(JSON.stringify([process.env.NVH_A, process.env.NVH_B ?? null]))'],
            env: { NVH_A: 'set here', NVH_B: undefined },
        });
        assert.deepEqual(JSON.parse(r.stdout), ['set here', null]);
    });

    it('captures stdout, stderr, exit code and duration', async () => {
        const r = await runner.run({ executable: NODE, args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(7)'] });
        assert.equal(r.outcome, 'exited');
        assert.equal(r.exitCode, 7);
        assert.equal(r.stdout, 'out');
        assert.equal(r.stderr, 'err');
        assert.equal(succeeded(r), false);
        assert.ok(r.durationMs >= 0);
    });

    it('reports a missing executable as spawn-failed instead of throwing', async () => {
        const r = await runner.run({ executable: 'definitely-not-a-real-tool-nexysvhdl', args: [] });
        assert.equal(r.outcome, 'spawn-failed');
        assert.equal(r.exitCode, null);
        assert.ok(r.errorMessage);
    });

    it('kills a process that exceeds its timeout', async () => {
        const r = await runner.run({ executable: NODE, args: ['-e', 'setTimeout(() => {}, 30000)'], timeoutMs: 300 });
        assert.equal(r.outcome, 'timed-out');
        assert.equal(r.exitCode, null);
    });

    it('supports cancellation through an AbortSignal', async () => {
        const controller = new AbortController();
        const pending = runner.run({ executable: NODE, args: ['-e', 'setTimeout(() => {}, 30000)'], signal: controller.signal });
        setTimeout(() => controller.abort(), 200);
        assert.equal((await pending).outcome, 'cancelled');
    });
});
