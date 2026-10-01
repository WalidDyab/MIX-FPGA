import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { runCli } from '../cli/main';
import { BufferedOutput } from '../cli/output';
import { createContext } from '../cli/context';
import { ForbiddenRunner, isolatedCli, REPO, trapProcesses } from './helpers';

/**
 * Regression for Phase 3B: a CLI unit test built the host's real platform
 * adapter, found the developer's Apio and ran it, and Apio replaced an
 * installed FPGA package. `npm test` must never reach host tools, USB/JTAG,
 * the network or FPGA packages — on Windows, macOS and clean CI alike.
 */
describe('unit tests are isolated from the host FPGA environment', () => {
    it('every CLI command runs with zero external processes and zero runner calls', async (t) => {
        const trap = trapProcesses(t);
        const example = join(REPO, 'examples', 'nexys-a7-counter');
        const commands = [
            ['doctor'],
            ['doctor', '--project', example],
            ['boards'],
            ['project', 'info', '--project', example],
            ['check', '--project', example],
            ['simulate', '--project', example],
            ['build', '--project', example],
            ['program', '--project', example],
            ['program', '--project', example, '--serial', '210292BCFFE4'],
        ];
        for (const args of commands) {
            const overrides = isolatedCli();
            await runCli(args, new BufferedOutput(), overrides);
            assert.equal((overrides.runner as ForbiddenRunner).calls.length, 0, args.join(' '));
        }
        assert.deepEqual(trap.attempts, []);
    });

    it('an injected platform replaces the host registry entirely', async (t) => {
        trapProcesses(t);
        const overrides = isolatedCli();
        const ctx = await createContext(overrides);
        assert.equal(ctx.platform, overrides.platform);
        assert.equal(ctx.runner, overrides.runner);
        assert.equal(ctx.host.platform, 'win32'); // the fake host, whatever this machine is
    });

    it('test sources never build a CLI context or run the CLI without isolation overrides', async () => {
        const offenders: string[] = [];
        const dir = join(REPO, 'tests');
        for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
            if (!e.isFile() || !e.name.endsWith('.ts') || e.name === 'test-isolation.test.ts') continue; // not this checker itself
            const file = join(e.parentPath, e.name);
            const text = await readFile(file, 'utf8');
            // Without overrides, runCli()/createContext() use the host registry and a real NodeToolRunner.
            const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
            // Such files must inject the isolation overrides, or (registry tests) a fake runner under a process trap.
            if (/\b(runCli|createContext)\(|\bnew CoreBackend\(/.test(code) && !/\b(isolatedCli|trapProcesses)\(/.test(code)) offenders.push(relative(REPO, file));
            // The extension backend builds the same context, so it must always get isolation overrides too.
            if (/\bnew CoreBackend\(\s*\)/.test(code)) offenders.push(`${relative(REPO, file)}: new CoreBackend()`);
            if (/\bcreateContext\(\s*\)/.test(code)) offenders.push(`${relative(REPO, file)}: createContext()`);
        }
        assert.deepEqual(offenders, []);
    });
});
