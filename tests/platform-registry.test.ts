import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createContext } from '../cli/context';
import type { HostInfo, ToolInvocation } from '../core';
import { createPlatformServices, findRegistration } from '../platform';
import { PinnedApioRunner } from '../platform/macos';
import { FakeRunner, ForbiddenRunner, trapProcesses } from './helpers';

const host = (platform: string, arch: string): HostInfo => ({ platform, arch, nodeVersion: 'v24.0.0-test' });
/** Building an adapter only wires objects together; nothing may run. */
const context = () => ({ runner: new ForbiddenRunner(), env: {} });

describe('platform registry', () => {
    it('resolves win32/x64 to the real Windows adapter', (t) => {
        const trap = trapProcesses(t);
        const ctx = context();
        const services = createPlatformServices(host('win32', 'x64'), ctx);
        assert.equal(services.id, 'windows');
        assert.equal(services.programmer?.id, 'digilent-adept');
        assert.ok(services.toolLocator);
        assert.ok(services.inspectToolchain);
        assert.deepEqual(trap.attempts, []);
        assert.equal(ctx.runner.calls.length, 0);
    });

    it('resolves darwin/arm64 to the real macOS adapter with a pinned Apio runner', (t) => {
        const trap = trapProcesses(t);
        const services = createPlatformServices(host('darwin', 'arm64'), context());
        assert.equal(services.id, 'macos');
        assert.ok(services.programmer);
        assert.ok(services.toolLocator);
        assert.ok(services.inspectToolchain);
        assert.ok(services.runner instanceof PinnedApioRunner);
        assert.deepEqual(trap.attempts, []);
    });

    it('rejects unsupported hosts cleanly, including Intel/Rosetta macOS', () => {
        const cases: Array<[HostInfo, RegExp]> = [
            [host('darwin', 'x64'), /requires native arm64/],
            [host('linux', 'x64'), /platform "linux" is not supported/],
            [host('win32', 'arm64'), /win32 on arm64 is not supported/],
        ];
        for (const [h, reason] of cases) {
            const services = createPlatformServices(h, context());
            assert.equal(services.id, 'unsupported', `${h.platform}/${h.arch}`);
            assert.match(services.status, reason);
            assert.equal(services.programmer, undefined);
            assert.equal(services.toolLocator, undefined);
            assert.equal(services.runner, undefined);
            assert.equal(findRegistration(h), undefined);
        }
    });
});

describe('platform-configured runner in the composition root', () => {
    it('Windows keeps the base runner undecorated (no Apio pin, no environment added)', async (t) => {
        trapProcesses(t);
        const base = new FakeRunner();
        const ctx = await createContext({ host: host('win32', 'x64'), runner: base, env: {} });
        assert.equal(ctx.platform.id, 'windows');
        assert.equal(ctx.runner, base);
        await ctx.runner.run({ executable: 'C:\\Users\\student\\.apio\\bin\\apio.exe', args: ['build'] });
        assert.equal(base.calls[0]!.env, undefined);
    });

    it('macOS replaces the base runner: Apio is pinned when expressible, refused otherwise, never unpinned', async (t) => {
        trapProcesses(t);
        const base = new FakeRunner();
        const ctx = await createContext({ host: host('darwin', 'arm64'), runner: base, env: {} });
        assert.equal(ctx.platform.id, 'macos');
        assert.notEqual(ctx.runner, base);

        const apio: ToolInvocation = { executable: '/Users/student/.apio/bin/apio', args: ['raw', '--', 'yosys', '-V'] };
        const r = await ctx.runner.run(apio);
        if (base.calls.length === 1) {
            // POSIX package root (macOS, Linux CI): the tracked pin is injected.
            assert.match(base.calls[0]!.env?.['APIO_REMOTE_CONFIG_URL'] ?? '', /^file:\/\/\/.*\/toolchains\/apio-remote-config\/apio-\{major\}\.\{minor\}\.x\.jsonc$/);
        } else {
            // Windows package root cannot be a macOS file:// pin: Apio must be refused, not run unpinned.
            assert.equal(base.calls.length, 0);
            assert.equal(r.outcome, 'spawn-failed');
            assert.match(r.errorMessage ?? '', /refused to run Apio/);
        }

        await ctx.runner.run({ executable: '/opt/ghdl/bin/ghdl', args: ['--version'] });
        assert.equal(base.calls.at(-1)!.executable, '/opt/ghdl/bin/ghdl');
        assert.equal(base.calls.at(-1)!.env?.['APIO_REMOTE_CONFIG_URL'], undefined);
    });
});
