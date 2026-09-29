import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { architectureStatus, inspectArchitecture, MacosToolLocator, parseExecutableHeader } from '../../../platform/macos';
import { APIO, fakeSystem, fatMachO, HOME, machO, OFL, OFL_BINARY, script } from './macos-fakes';

const MANAGED_GHDL = `${HOME}/Library/Application Support/NexysVHDL/tools/ghdl/bin/ghdl`;
const DEV_GHDL = `${HOME}/WSClaude/NexysVHDL/tools/ghdl/bin/ghdl`;
const DEV = { developmentLocations: { ghdl: [{ path: DEV_GHDL, method: 'Phase 1/2 development install' }] } };
const exe = (cpu: 'arm64' | 'x86_64' = 'arm64') => ({ head: machO(cpu), executable: true });

describe('macOS executable architecture', () => {
    it('reads thin arm64 and x86_64 Mach-O headers', () => {
        assert.deepEqual(parseExecutableHeader(machO('arm64')), { kind: 'mach-o', architectures: ['arm64'] });
        assert.deepEqual(parseExecutableHeader(machO('x86_64')).architectures, ['x86_64']);
    });

    it('reads universal binaries and treats them as native when they contain arm64', () => {
        const h = parseExecutableHeader(fatMachO(['x86_64', 'arm64']));
        assert.deepEqual(h.architectures, ['x86_64', 'arm64']);
        assert.equal(architectureStatus(h.architectures), 'native');
        assert.equal(architectureStatus(['x86_64']), 'x86_64-only');
        assert.equal(architectureStatus([]), 'unknown');
    });

    it('recognises scripts and other files', () => {
        assert.equal(parseExecutableHeader(script()).kind, 'script');
        assert.equal(parseExecutableHeader(script()).interpreter, '/usr/bin/env bash');
        assert.equal(parseExecutableHeader(new TextEncoder().encode('plain text file')).kind, 'other');
    });

    it("follows Apio's bin/ wrapper scripts to the libexec/ binary", async () => {
        const system = fakeSystem({ [OFL]: { head: script(), executable: true }, [OFL_BINARY]: exe() });
        const report = await inspectArchitecture(system, OFL);
        assert.equal(report.status, 'native');
        assert.equal(report.binary, OFL_BINARY);
    });
});

describe('macOS GHDL discovery', () => {
    it('prefers the explicit NEXYSVHDL_GHDL override', async () => {
        const system = fakeSystem({ '/opt/ghdl/bin/ghdl': exe(), [MANAGED_GHDL]: exe() }, { NEXYSVHDL_GHDL: '/opt/ghdl/bin/ghdl' });
        const found = await new MacosToolLocator(system, DEV).locate('ghdl');
        assert.deepEqual(found, { path: '/opt/ghdl/bin/ghdl', method: 'NEXYSVHDL_GHDL' });
    });

    it('stops at an unusable explicit override instead of silently falling back', async () => {
        const system = fakeSystem({ [MANAGED_GHDL]: exe() }, { NEXYSVHDL_GHDL: '/missing/ghdl' });
        const d = await new MacosToolLocator(system, DEV).discover('ghdl');
        assert.equal(d.located, undefined);
        assert.equal(d.diagnostics[0]?.code, 'MACOS_TOOL_OVERRIDE_INVALID');
    });

    it('then the NexysVHDL-managed folder, then PATH, then development locations', async () => {
        const all = { [MANAGED_GHDL]: exe(), '/usr/local/bin/ghdl': exe(), [DEV_GHDL]: exe() };
        const env = { PATH: '/usr/local/bin:/usr/bin' };
        const loc = (files: Record<string, ReturnType<typeof exe>>) => new MacosToolLocator(fakeSystem(files, env), DEV).locate('ghdl');
        assert.equal((await loc(all))?.method, 'NexysVHDL tools folder');
        assert.equal((await loc({ '/usr/local/bin/ghdl': exe(), [DEV_GHDL]: exe() }))?.method, 'PATH');
        assert.deepEqual(await loc({ [DEV_GHDL]: exe() }), { path: DEV_GHDL, method: 'Phase 1/2 development install' });
        assert.equal(await loc({}), undefined);
    });

    it('honours NEXYSVHDL_TOOLS_DIR for the managed folder', async () => {
        const system = fakeSystem({ '/Volumes/lab/tools/ghdl/bin/ghdl': exe() }, { NEXYSVHDL_TOOLS_DIR: '/Volumes/lab/tools' });
        assert.equal((await new MacosToolLocator(system).locate('ghdl'))?.path, '/Volumes/lab/tools/ghdl/bin/ghdl');
    });

    it('rejects an x86_64-only GHDL (no Rosetta) and continues to a native one', async () => {
        const system = fakeSystem({ [MANAGED_GHDL]: exe('x86_64'), [DEV_GHDL]: exe('arm64') });
        const d = await new MacosToolLocator(system, DEV).discover('ghdl');
        assert.equal(d.located?.path, DEV_GHDL);
        assert.equal(d.located?.architecture.status, 'native');
        assert.ok(d.rejected.some((r) => r.path === MANAGED_GHDL && /x86_64/.test(r.reason)));
        assert.ok(d.diagnostics.some((x) => x.code === 'MACOS_TOOL_UNSUPPORTED_ARCH'));
    });
});

describe('macOS Apio and openFPGALoader discovery', () => {
    it('finds Apio at the installer location', async () => {
        const found = await new MacosToolLocator(fakeSystem({ [APIO]: exe() })).locate('apio');
        assert.deepEqual(found, { path: APIO, method: 'Apio installer location' });
    });

    it("finds openFPGALoader in Apio's oss-cad-suite (the executable apio upload used)", async () => {
        const d = await new MacosToolLocator(fakeSystem({ [OFL]: { head: script(), executable: true }, [OFL_BINARY]: exe() })).discover('programmer');
        assert.equal(d.located?.path, OFL);
        assert.equal(d.located?.method, 'Apio oss-cad-suite package');
        assert.equal(d.located?.architecture.binary, OFL_BINARY);
    });

    it('honours APIO_HOME for the package location', async () => {
        const system = fakeSystem({ '/srv/apio/packages/oss-cad-suite/bin/openFPGALoader': exe() }, { APIO_HOME: '/srv/apio' });
        assert.equal((await new MacosToolLocator(system).locate('programmer'))?.path, '/srv/apio/packages/oss-cad-suite/bin/openFPGALoader');
    });

    it('does not locate tools that are only reachable through Apio', async () => {
        const locator = new MacosToolLocator(fakeSystem({ [APIO]: exe() }));
        assert.equal(await locator.locate('yosys'), undefined);
        assert.equal(await locator.locate('nextpnr-xilinx'), undefined);
        assert.equal(await locator.locate('openxc7'), undefined);
    });
});
