import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { installToolchainArchive, type HostInfo, type ToolchainRequirement } from '../../core';
import { createContext } from '../../runtime/context';
import { fakeArchive, writeFakeBundle } from '../bundle-fixture';
import { tempDir, trapProcesses } from '../helpers';
import { ONLY_WINDOWS } from '../platform';

const WIN: HostInfo = { platform: 'win32', arch: 'x64', nodeVersion: 'v24.0.0-test' };
const refuse = { run: async () => { throw new Error('no process may start'); } };

describe('Windows upgrade from NexysVHDL 0.6.0: read-only reuse of its validated toolchain, state in the MIX-FPGA area', () => {
    async function homeWith(t: Parameters<typeof tempDir>[0], where: 'legacy' | 'primary' | 'both') {
        const dir = await tempDir(t, 'nexys-upgrade-');
        const local = join(dir, 'AppData', 'Local');
        const bundle = join(dir, 'bundle');
        await writeFakeBundle(bundle, { target: 'win32-x64' });
        const { archive, requirement } = await fakeArchive(dir, bundle, { target: 'win32-x64' });
        const legacy = join(local, 'NexysVHDL');
        const primary = join(local, 'MIX-FPGA', 'support', 'nexys-a7');
        if (where !== 'primary') assert.equal((await installToolchainArchive({ archive, dataRoot: legacy, target: 'win32-x64', requirement })).status, 'installed');
        if (where !== 'legacy') assert.equal((await installToolchainArchive({ archive, dataRoot: primary, target: 'win32-x64', requirement })).status, 'installed');
        return { local, legacy, primary, requirement };
    }

    it('uses the NexysVHDL store when the MIX-FPGA store has none, keeping ALL writable tool state in the MIX-FPGA state area', { skip: ONLY_WINDOWS }, async (t) => {
        trapProcesses(t);
        const h = await homeWith(t, 'legacy');
        const ctx = await createContext({ host: WIN, env: { LOCALAPPDATA: h.local }, runner: refuse, classroom: { requirement: h.requirement } });
        const c = ctx.classroom!;
        assert.ok(c.toolchain, JSON.stringify(c.diagnostics));
        assert.equal(c.reusedFrom, h.legacy);
        assert.equal(c.dataRoot, h.primary, 'installs still go to the MIX-FPGA store');
        assert.equal(c.toolchain.root, join(h.legacy, 'toolchains', 'win32-x64', '1.0'));
        const state = join(h.local, 'MIX-FPGA', 'state', 'nexys-a7');
        const apio = c.toolchain.environment['APIO_HOME']!;
        assert.ok(apio.toLowerCase().startsWith(state.toLowerCase()), `Apio's home ${apio} is under ${state}`);
        // Never inside an immutable toolchain folder, and never in the NexysVHDL folder.
        assert.ok(!apio.toLowerCase().includes(`${join(h.primary, 'toolchains')}`.toLowerCase()));
        assert.ok(!apio.toLowerCase().startsWith(h.legacy.toLowerCase()));
    });

    it('prefers the MIX-FPGA store once it exists, with the same state area', { skip: ONLY_WINDOWS }, async (t) => {
        trapProcesses(t);
        const h = await homeWith(t, 'both');
        const c = (await createContext({ host: WIN, env: { LOCALAPPDATA: h.local }, runner: refuse, classroom: { requirement: h.requirement } })).classroom!;
        assert.equal(c.reusedFrom, undefined);
        assert.equal(c.toolchain!.root, join(h.primary, 'toolchains', 'win32-x64', '1.0'));
        assert.ok(c.toolchain!.environment['APIO_HOME']!.toLowerCase().startsWith(join(h.local, 'MIX-FPGA', 'state', 'nexys-a7').toLowerCase()));
    });

    it('never reuses a NexysVHDL store whose content differs from the validated toolchain, and ignores it under MIXFPGA_HOME', { skip: ONLY_WINDOWS }, async (t) => {
        trapProcesses(t);
        const h = await homeWith(t, 'legacy');
        const other: ToolchainRequirement = { ...h.requirement, targets: { 'win32-x64': { status: 'validated', treeSha256: 'b'.repeat(64) } } };
        const c = (await createContext({ host: WIN, env: { LOCALAPPDATA: h.local }, runner: refuse, classroom: { requirement: other } })).classroom!;
        assert.equal(c.toolchain, undefined);
        assert.equal(c.reusedFrom, undefined);
        const fresh = (await createContext({ host: WIN, env: { LOCALAPPDATA: h.local, MIXFPGA_HOME: join(h.local, 'fresh') }, runner: refuse, classroom: { requirement: h.requirement } })).classroom!;
        assert.equal(fresh.toolchain, undefined, 'a relocated MIX-FPGA (fresh-install test) does not see NexysVHDL');
        assert.equal(fresh.installed?.status, 'missing');
        assert.equal(fresh.dataRoot, join(h.local, 'fresh', 'support', 'nexys-a7'));
    });

    it('creating a context starts nothing and creates no folder', { skip: ONLY_WINDOWS }, async (t) => {
        trapProcesses(t);
        const h = await homeWith(t, 'legacy');
        await createContext({ host: WIN, env: { LOCALAPPDATA: h.local }, runner: refuse, classroom: { requirement: h.requirement } });
        assert.equal(await stat(join(h.local, 'MIX-FPGA')).then(() => true, () => false), false);
    });
});
