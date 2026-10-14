import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { InstallStateStore, SetupEngine } from '../../core';
import { inventoryTree, makeWritable, treeDigest } from '../../core/install/tree';
import { toolchainDefinitions } from '../../platform/macos/install/toolchain-components';
import { installToolchain, readMarker, SimulatedCrash, type ToolchainContext } from '../../platform/macos/install/toolchain-installer';
import { fixture, noProgress } from './fixtures';

const exists = (p: string) => lstat(p).then(() => true, () => false);
const engineFor = (ctx: ToolchainContext, depth: 'quick' | 'full' = 'quick') => new SetupEngine(toolchainDefinitions(ctx, depth), new InstallStateStore(ctx.layout.installStateFile, ctx.layout.lockFile));
const states = async (ctx: ToolchainContext, depth: 'quick' | 'full' = 'quick') => Object.fromEntries((await engineFor(ctx, depth).inspectAll()).map((s) => [s.id, s.state]));
const READY = { ghdl: 'ready', yosys: 'ready', openfpgaloader: 'ready', lima: 'ready', toolchain: 'ready' };

async function modify(path: string, change: () => Promise<void>): Promise<void> {
    await makeWritable(path);
    await change();
}

describe('toolchain installer', () => {
    it('installs a clean machine: exact tree, executable bits, links, read-only, manifest, marker last', async (t) => {
        const f = await fixture(t);
        const before = await states(f.ctx);
        assert.deepEqual(before, { ghdl: 'not-installed', yosys: 'not-installed', openfpgaloader: 'not-installed', lima: 'not-installed', toolchain: 'not-installed' });
        const r = await installToolchain(f.ctx, noProgress);
        assert.deepEqual(r.ok, true, JSON.stringify(r));
        assert.deepEqual(await states(f.ctx, 'full'), READY);
        const L = f.ctx.layout;
        assert.equal((await stat(join(L.unit('ghdl'), 'bin', 'ghdl'))).mode & 0o111, 0o111);
        assert.equal((await lstat(join(L.unit('lima'), 'lib', 'templates'))).isSymbolicLink(), true);
        assert.equal((await stat(join(L.unit('ghdl'), 'bin', 'ghdl'))).mode & 0o222, 0, 'read-only');
        assert.equal(await readFile(L.manifestFile, 'utf8'), f.ctx.expected.text, 'manifest.json is the recorded manifest, byte for byte');
        const marker = await readMarker(L);
        assert.equal(marker?.manifestSha256, f.ctx.expected.sha256);
        assert.equal(marker?.source, 'test payload');
        assert.deepEqual(marker?.units.map((u) => u.id), f.ctx.expected.toolchain.units.map((u) => u.id));
        assert.equal(await exists(L.toolchainStaging), false, 'no staging folder left behind');
    });

    it('is idempotent: installing again changes nothing and copies nothing', async (t) => {
        const f = await fixture(t);
        await installToolchain(f.ctx, noProgress);
        const first = (await readMarker(f.ctx.layout))!.installedAt;
        f.copied.length = 0;
        const again = await installToolchain({ ...f.ctx, now: () => new Date('2099-01-01') }, noProgress);
        assert.deepEqual(again, { ok: true, detail: 'already installed' });
        assert.deepEqual(f.copied, []);
        assert.equal((await readMarker(f.ctx.layout))!.installedAt, '2099-01-01T00:00:00.000Z', 'marker is rewritten but nothing else');
        assert.notEqual(first, undefined);
    });

    it('runs through the setup engine and Setup opened again is a no-op, even after the source is gone', async (t) => {
        const f = await fixture(t);
        const run = await engineFor(f.ctx).run();
        assert.equal(run.outcome, 'complete');
        assert.deepEqual(run.steps.map((s) => s.id), ['toolchain']);
        // The installation source is removed (a student deletes the download).
        await rm(f.dir + '/ghdl-src', { recursive: true });
        await rm(f.dir + '/engine-src', { recursive: true });
        f.copied.length = 0;
        const again = await engineFor(f.ctx).run();
        assert.equal(again.outcome, 'complete');
        assert.deepEqual(again.steps, []);
        assert.deepEqual(await states(f.ctx), READY);
        assert.deepEqual(f.copied, []);
    });

    it('detects a damaged executable quickly, and any damaged byte on a full check; repair touches only that tool', async (t) => {
        const f = await fixture(t);
        await installToolchain(f.ctx, noProgress);
        const L = f.ctx.layout;
        const inodeOf = async (id: string) => (await stat(L.unit(id))).ino;
        const yosysInode = await inodeOf('yosys');
        // A flipped byte in a data file (same size): the quick check cannot see it, the full check can.
        await modify(L.unit('ghdl'), () => writeFile(join(L.unit('ghdl'), 'lib', 'deep', 'data.txt'), 'data for ghdm'));
        assert.equal((await states(f.ctx, 'quick'))['ghdl'], 'ready');
        assert.equal((await states(f.ctx, 'full'))['ghdl'], 'repairable');
        // A damaged executable is seen even by the quick check.
        await modify(L.unit('ghdl'), () => writeFile(join(L.unit('ghdl'), 'bin', 'ghdl'), `#!/bin/sh\necho evil 1.0\n`));
        const quick = await states(f.ctx, 'quick');
        assert.deepEqual([quick['ghdl'], quick['toolchain']], ['repairable', 'repairable']);
        f.copied.length = 0;
        const run = await engineFor(f.ctx, 'full').run();
        assert.equal(run.outcome, 'complete');
        assert.deepEqual(f.copied, ['ghdl']);
        assert.deepEqual(await states(f.ctx, 'full'), READY);
        assert.equal(await inodeOf('yosys'), yosysInode, 'untouched tools are not rewritten');
        assert.equal((await stat(join(L.unit('ghdl'), 'bin', 'ghdl'))).mode & 0o222, 0, 'repaired unit is read-only again');
    });

    it('repairs a missing tool, a lost executable bit, an unexpected file and a changed manifest', async (t) => {
        const f = await fixture(t);
        await installToolchain(f.ctx, noProgress);
        const L = f.ctx.layout;
        await modify(L.toolchainDir, async () => {
            await rm(L.unit('yosys'), { recursive: true, force: true });
            await makeWritable(L.unit('lima'));
            await chmod(join(L.unit('lima'), 'bin', 'lima'), 0o644);
            await makeWritable(L.unit('openfpgaloader'));
            await writeFile(join(L.unit('openfpgaloader'), 'stray.txt'), 'x');
            await writeFile(L.manifestFile, '{"changed":true}');
        });
        const broken = await states(f.ctx, 'quick');
        assert.deepEqual(broken, { ghdl: 'ready', yosys: 'not-installed', openfpgaloader: 'repairable', lima: 'repairable', toolchain: 'repairable' });
        f.copied.length = 0;
        assert.equal((await engineFor(f.ctx).run()).outcome, 'complete');
        assert.deepEqual([...f.copied].sort(), ['lima', 'openfpgaloader', 'yosys']);
        assert.deepEqual(await states(f.ctx, 'full'), READY);
        assert.equal(await readFile(L.manifestFile, 'utf8'), f.ctx.expected.text);
    });

    it('a different manifest version on disk makes the toolchain repairable', async (t) => {
        const f = await fixture(t);
        await installToolchain(f.ctx, noProgress);
        await modify(f.ctx.layout.toolchainDir, () => writeFile(f.ctx.layout.manifestFile, f.ctx.expected.text.replace('"1.0"', '"0.9"')));
        const s = (await engineFor(f.ctx).inspectAll()).find((x) => x.id === 'toolchain')!;
        assert.deepEqual([s.state, s.code], ['repairable', 'MANIFEST_MISMATCH']);
    });

    describe('interruption', () => {
        it('a crash while staging leaves nothing visible; the next run cleans up and finishes', async (t) => {
            const f = await fixture(t);
            const crashing: ToolchainContext = { ...f.ctx, hooks: { afterUnitStaged: (id) => { if (id === 'yosys') throw new SimulatedCrash('power cut'); } } };
            await assert.rejects(installToolchain(crashing, noProgress), SimulatedCrash);
            assert.equal(await exists(f.ctx.layout.toolchainDir), false);
            assert.equal((await readdir(f.ctx.layout.toolchainStaging)).length, 1, 'half-staged folder left, as after a real crash');
            assert.deepEqual(await states(f.ctx), { ghdl: 'not-installed', yosys: 'not-installed', openfpgaloader: 'not-installed', lima: 'not-installed', toolchain: 'not-installed' });
            assert.equal((await engineFor(f.ctx).run()).outcome, 'complete');
            assert.deepEqual(await states(f.ctx, 'full'), READY);
            assert.equal(await exists(f.ctx.layout.toolchainStaging), false);
        });

        it('a crash after the folder appeared but before the marker is repairable, and finishing copies nothing', async (t) => {
            const f = await fixture(t);
            const crashing: ToolchainContext = { ...f.ctx, hooks: { beforeMarker: () => { throw new SimulatedCrash('killed'); } } };
            await assert.rejects(installToolchain(crashing, noProgress), SimulatedCrash);
            const s = (await engineFor(f.ctx).inspectAll()).find((x) => x.id === 'toolchain')!;
            assert.deepEqual([s.state, s.code], ['repairable', 'NOT_COMPLETE']);
            f.copied.length = 0;
            assert.equal((await engineFor(f.ctx).run()).outcome, 'complete');
            assert.deepEqual(f.copied, []);
            assert.deepEqual(await states(f.ctx, 'full'), READY);
        });

        it('a crash during a repair leaves the installed tools untouched', async (t) => {
            const f = await fixture(t);
            await installToolchain(f.ctx, noProgress);
            await modify(f.ctx.layout.unit('lima'), () => writeFile(join(f.ctx.layout.unit('lima'), 'lib', 'deep', 'data.txt'), 'nope'));
            const before = treeDigest(await inventoryTree(f.ctx.layout.unit('ghdl')));
            const crashing: ToolchainContext = { ...f.ctx, hooks: { beforeActivate: () => { throw new SimulatedCrash('killed'); } } };
            await assert.rejects(installToolchain(crashing, noProgress), SimulatedCrash);
            assert.equal(treeDigest(await inventoryTree(f.ctx.layout.unit('ghdl'))), before);
            assert.equal(await exists(join(f.ctx.layout.unit('lima'), 'bin', 'lima')), true, 'the old copy is still in place');
            assert.equal((await engineFor(f.ctx).run()).outcome, 'complete');
            assert.deepEqual(await states(f.ctx, 'full'), READY);
        });

        it('a dead operation record is shown as interrupted and resumed', async (t) => {
            const f = await fixture(t);
            await mkdir(f.ctx.layout.stateDir, { recursive: true });
            await writeFile(f.ctx.layout.installStateFile, JSON.stringify({ schemaVersion: 1, components: { toolchain: { operation: { id: 'x', pid: 2 ** 22 + 77, startedAt: 'x' } } } }));
            const s = (await engineFor(f.ctx).inspectAll()).find((x) => x.id === 'toolchain')!;
            assert.deepEqual([s.state, s.code], ['not-installed', 'INTERRUPTED']);
            assert.equal((await engineFor(f.ctx).run()).outcome, 'complete');
            assert.deepEqual((await new InstallStateStore(f.ctx.layout.installStateFile, f.ctx.layout.lockFile).read()).components, {});
        });

        it('cancelling stops before anything becomes visible and cleans up', async (t) => {
            const f = await fixture(t);
            const ctl = new AbortController();
            const ctx: ToolchainContext = { ...f.ctx, hooks: { afterUnitStaged: (id) => { if (id === 'ghdl') ctl.abort(); } } };
            const r = await installToolchain(ctx, { signal: ctl.signal, progress: () => undefined });
            assert.deepEqual(r.ok === false && r.code, 'CANCELLED');
            assert.equal(await exists(f.ctx.layout.toolchainDir), false);
            assert.equal(await exists(f.ctx.layout.toolchainMarker), false);
            assert.equal((await readdir(f.ctx.layout.toolchainStaging)).length, 0);
        });
    });

    describe('refusals', () => {
        it('refuses bytes that differ from the manifest and installs nothing', async (t) => {
            const f = await fixture(t);
            await writeFile(join(f.sources['yosys']!, 'lib', 'deep', 'data.txt'), 'tampered after the manifest was recorded');
            const r = await installToolchain(f.ctx, noProgress);
            assert.equal(r.ok === false && r.code, 'PAYLOAD_VERIFY_FAILED');
            assert.equal(await exists(f.ctx.layout.toolchainDir), false);
            assert.equal(await exists(f.ctx.layout.toolchainMarker), false);
            assert.equal(await exists(join(f.ctx.layout.toolchainStaging, 'tree')), false);
        });

        it('reports an incomplete source without touching the machine', async (t) => {
            const f = await fixture(t);
            await rm(f.sources['lima']!, { recursive: true });
            const r = await installToolchain(f.ctx, noProgress);
            assert.equal(r.ok === false && r.code, 'PAYLOAD_INCOMPLETE');
            assert.equal(await exists(f.ctx.layout.toolchainDir), false);
        });

        it('checks free disk space first and creates nothing when there is not enough', async (t) => {
            const f = await fixture(t, { freeBytes: async () => 10_000_000 });
            const r = await installToolchain(f.ctx, noProgress);
            assert.equal(r.ok === false && r.code, 'INSUFFICIENT_DISK');
            assert.match(r.ok === false ? r.message : '', /free/);
            assert.equal(await exists(f.ctx.layout.toolchainDir), false);
            assert.equal(await exists(f.ctx.layout.toolchainMarker), false);
        });

        it('reports an unsupported Mac as incompatible, not repairable', async (t) => {
            const f = await fixture(t, { host: { platform: 'darwin', arch: 'x64' } });
            assert.equal((await states(f.ctx)).toolchain, 'incompatible');
            const r = await installToolchain(f.ctx, noProgress);
            assert.equal(r.ok === false && r.code, 'UNSUPPORTED_HOST');
            assert.equal((await engineFor(f.ctx).plan(await engineFor(f.ctx).inspectAll())).length, 0);
        });

        it('never installs inside another product\'s folder, and leaves NexysVHDL Toolchain 1.0 untouched', async (t) => {
            const f = await fixture(t);
            const nexys = join(f.dir, 'home', 'Library', 'NexysVHDL', 'toolchains', 'darwin-arm64', '1.0');
            await mkdir(join(nexys, 'bin'), { recursive: true });
            await writeFile(join(nexys, 'bin', 'ghdl'), 'nexys ghdl');
            const before = treeDigest(await inventoryTree(join(f.dir, 'home', 'Library', 'NexysVHDL')));
            assert.equal((await installToolchain(f.ctx, noProgress)).ok, true);
            assert.equal(treeDigest(await inventoryTree(join(f.dir, 'home', 'Library', 'NexysVHDL'))), before);
            const wrong = await fixture(t, {});
            const bad = { ...wrong.ctx, layout: { ...wrong.ctx.layout, root: join(wrong.dir, 'Library', 'NexysVHDL', 'x') } };
            const r = await installToolchain(bad, noProgress);
            assert.equal(r.ok === false && r.code, 'FOREIGN_PRODUCT_PATH');
        });

        it('needs no network: the installer imports no networking module', async () => {
            const src = await readFile(join(__dirname, '..', '..', '..', 'platform', 'macos', 'install', 'toolchain-installer.ts'), 'utf8').catch(() => readFile(join(__dirname, '..', '..', 'platform', 'macos', 'install', 'toolchain-installer.js'), 'utf8'));
            assert.doesNotMatch(src, /node:(https?|net|dns|tls|dgram)|fetch\(/);
        });
    });
});
