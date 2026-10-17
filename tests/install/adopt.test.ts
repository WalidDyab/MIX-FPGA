import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { copyTree, inventoryTree, treeDigest } from '../../core/install/tree';
import { type AdoptionDeps, formatAdoptionPlan, performAdoption, planAdoption } from '../../platform/macos/install/adopt';
import { ENGINE_SPEC } from '../../platform/macos/install/engine-config';
import { installedDe10Paths } from '../../platform/macos/install/paths';
import { DirectoryPayload } from '../../platform/macos/install/payload';
import { installToolchain } from '../../platform/macos/install/toolchain-installer';
import { FakeMachine } from './fake-machine';
import { fixture, noProgress } from './fixtures';
import { InstallStateStore, SetupEngine } from '../../core';
import { toolchainDefinitions } from '../../platform/macos/install/toolchain-components';
import { EngineProvisioner, LinuxVmRecordStore } from '../../platform/macos/install/engine-provision';
import { QuartusInstaller, QuartusRecordStore } from '../../platform/macos/install/quartus-install';
import { readFile, readdir, stat } from 'node:fs/promises';
import { ONLY_MACOS } from '../platform';

const IDS = ['ghdl', 'yosys', 'openfpgaloader', 'lima'];

async function rig(t: TestContext) {
    const f = await fixture(t, {}, { realEngine: true, shortRoot: true });
    // The "existing development setup": the tools as separate folders under one root, as the repo keeps them.
    const legacy = join(f.dir, 'experimental');
    const folders: Record<string, string> = {};
    for (const id of IDS) {
        folders[id] = `${id}-9.9`;
        await mkdir(legacy, { recursive: true });
        await copyTree(f.sources[id]!, join(legacy, folders[id]!));
    }
    const m = new FakeMachine(installedDe10Paths(f.ctx.layout).limactl, f.ctx.layout.shareDir);
    m.instance = {
        status: 'Running',
        config: { cpus: 4, memory: '8GiB', disk: '60GiB', vmType: 'vz', arch: 'aarch64', images: [{ digest: `sha256:${ENGINE_SPEC.image.sha256}` }], mounts: [{ location: f.ctx.layout.shareDir, mountPoint: '/mnt/mixfpga', writable: true }], vmOpts: { vz: { rosetta: { enabled: true, binfmt: true } } } },
    };
    m.quartusInstalled = true;
    m.wrapperInstalled = true;
    const stuff = join(f.dir, 'vendor');
    await mkdir(stuff);
    await writeFile(join(stuff, 'installer.run'), 'x'.repeat(1000));
    const deps: AdoptionDeps = {
        layout: f.ctx.layout,
        expected: f.ctx.expected,
        payload: new DirectoryPayload(f.sources, 'test source'),
        legacyFolders: folders,
        legacyToolsRoot: legacy,
        legacyPaths: installedDe10Paths(f.ctx.layout),
        runner: m,
        leaveAlone: [{ path: stuff, why: 'Altera installer copies' }],
    };
    return { f, m, deps, legacy, folders };
}

const snapshot = async (...dirs: string[]) => Promise.all(dirs.map((d) => inventoryTree(d).then(treeDigest, () => 'absent')));

describe('adoption dry run', () => {
    it('reports what would be copied, written and left alone, and changes nothing', async (t) => {
        const r = await rig(t);
        const before = await snapshot(r.legacy, r.f.dir + '/vendor', dirname(r.f.ctx.layout.root));
        r.m.calls.length = 0;
        const plan = await planAdoption(r.deps);
        assert.equal(plan.status, 'adoptable', JSON.stringify(plan.blockers));
        assert.deepEqual(plan.copies.map((c) => [c.unit, c.identical]), [['ghdl', true], ['yosys', true], ['openfpgaloader', true], ['lima', true], ['engine', true], ['licenses', true], ['notices', true]]);
        assert.ok(plan.totalCopyBytes > 0);
        assert.equal(plan.engine.matches, true);
        assert.deepEqual([plan.engine.guest?.wrapper, plan.engine.guest?.rosettadSocketAbsent, plan.engine.guest?.quartusIsExpectedBuild], [true, true, true]);
        // Every write is inside the MIX-FPGA root; every untouched item is listed with a reason.
        for (const w of plan.writes) assert.ok(w.startsWith(r.f.ctx.layout.root), w);
        assert.ok(plan.untouched.some((u) => u.path.endsWith('vendor') && u.bytes !== undefined && u.bytes <= 8192));
        assert.ok(plan.untouched.some((u) => u.path === r.f.ctx.layout.instanceDir));
        // Nothing changed on disk, and the engine was only asked to list and to run read-only checks.
        assert.deepEqual(await snapshot(r.legacy, r.f.dir + '/vendor', dirname(r.f.ctx.layout.root)), before);
        assert.deepEqual([...new Set(r.m.calls.map((c) => c[0]))].sort(), ['list', 'shell']);
        assert.equal(r.m.instance!.status, 'Running');
        assert.equal(r.m.quartusInstalls, 0);
        const text = formatAdoptionPlan(plan);
        assert.match(text, /nothing was changed/i);
        assert.match(text, /WOULD COPY/);
        assert.match(text, /LEFT UNTOUCHED/);
    });

    it('refuses to adopt unknown or modified binaries', async (t) => {
        const r = await rig(t);
        await writeFile(join(r.legacy, r.folders['yosys']!, 'bin', 'yosys'), '#!/bin/sh\necho not the validated one\n');
        const plan = await planAdoption(r.deps);
        assert.equal(plan.status, 'blocked');
        assert.match(plan.blockers.join('\n'), /YOSYS.*differ/);
        assert.equal(plan.copies.find((c) => c.unit === 'yosys')!.identical, false);
    });

    it('refuses a missing tool, a different engine configuration and a different Quartus build', async (t) => {
        const missing = await rig(t);
        missing.deps = { ...missing.deps, legacyFolders: { ...missing.folders, lima: 'nope' } } as never;
        assert.match((await planAdoption(missing.deps)).blockers.join('\n'), /LIMA: not found/);

        const other = await rig(t);
        (other.m.instance!.config as { cpus: number }).cpus = 2;
        (other.m.instance!.config as { images: { digest: string }[] }).images[0]!.digest = 'sha256:other';
        const p2 = await planAdoption(other.deps);
        assert.equal(p2.status, 'blocked');
        assert.match(p2.blockers.join('\n'), /differs from the validated configuration/);

        const wrong = await rig(t);
        wrong.m.quartusInstalled = false;
        assert.match((await planAdoption(wrong.deps)).blockers.join('\n'), /not the expected build/);
    });

    it('a stopped engine is not started by the dry run', async (t) => {
        const r = await rig(t);
        r.m.instance!.status = 'Stopped';
        r.m.calls.length = 0;
        const plan = await planAdoption(r.deps);
        assert.equal(plan.status, 'adoptable');
        assert.equal(plan.engine.guest, undefined);
        assert.match(plan.notes.join('\n'), /would start it once/);
        assert.deepEqual(r.m.calls.map((c) => c[0]), ['list']);
    });

    it('with no engine it says so and plans only the copy', async (t) => {
        const r = await rig(t);
        r.m.instance = undefined;
        const plan = await planAdoption(r.deps);
        assert.equal(plan.engine.found, false);
        assert.ok(plan.writes.every((w) => !w.includes('linux-vm.json')));
    });

    it('after the toolchain is installed it plans no second copy', async (t) => {
        const r = await rig(t);
        assert.equal((await installToolchain(r.f.ctx, noProgress)).ok, true);
        const plan = await planAdoption(r.deps);
        assert.equal(plan.totalCopyBytes, 0);
        assert.ok(plan.writes.every((w) => !w.includes('copied then verified')));
        assert.equal(plan.status, 'nothing-to-do');
        void createHash;
    });

    describe('performing it', () => {
        const snap = async (r: Awaited<ReturnType<typeof rig>>) => snapshot(r.legacy, r.f.dir + '/vendor');

        it('copies and seals the tools, adopts the engine by verification only, and records no licence acceptance', { skip: ONLY_MACOS }, async (t) => {
            const r = await rig(t);
            const before = await snap(r);
            r.m.calls.length = 0;
            const out = await performAdoption(r.deps);
            assert.equal(out.outcome, 'adopted', JSON.stringify(out.steps));
            assert.ok(out.steps.every((s) => s.ok));
            // Engine: only read (list) and entered for read-only checks / the scratch smoke test; never started, stopped, edited, created or deleted.
            assert.deepEqual([...new Set(r.m.calls.map((c) => c[0]))].sort(), ['list', 'shell']);
            assert.equal(r.m.quartusInstalls, 0);
            assert.equal(r.m.instance!.status, 'Running');
            assert.equal(r.m.guest.some((g) => /rm -rf "\$d"|--accept_eula|--install_lic/.test(g)), false);
            // The development copies and the student's other files are untouched.
            assert.deepEqual(await snap(r), before);
            // Records.
            const q = await new QuartusRecordStore(join(r.f.ctx.layout.stateDir, 'quartus.json')).read();
            assert.ok(q.verifiedAt && q.adoptedAt && q.device === '10M50DAF484C7G');
            assert.equal(q.eula, undefined, 'no acceptance is invented');
            assert.equal(q.licenseOffered, undefined);
            const vm = await new LinuxVmRecordStore(join(r.f.ctx.layout.stateDir, 'linux-vm.json')).read();
            assert.ok(vm.adoptedAt && vm.verifiedAt && vm.quartusPresent && vm.createdAt === undefined);
            // Nothing in the shared staging folder was added.
            assert.deepEqual(await readdir(r.f.ctx.layout.shareDir).catch(() => []), []);
            // Afterwards every component reads Ready, without starting anything.
            const engine = new SetupEngine(
                [...toolchainDefinitions({ ...r.f.ctx }, 'full'), { id: 'rosetta', label: 'r', inspect: async () => ({ state: 'ready', ownership: 'system' }) }, new EngineProvisioner({ layout: r.f.ctx.layout, runner: r.m, downloader: async () => ({ ok: true, reused: true }), freeBytes: async () => 1e12 }).definition(), ...new QuartusInstaller({ layout: r.f.ctx.layout, runner: r.m, freeBytes: async () => 1e12 }).definitions()],
                new InstallStateStore(r.f.ctx.layout.installStateFile, r.f.ctx.layout.lockFile),
            );
            r.m.calls.length = 0;
            const st = await engine.inspectAll();
            assert.ok(st.every((s) => s.state === 'ready'), JSON.stringify(st.filter((s) => s.state !== 'ready')));
            assert.ok(r.m.calls.every((c) => c[0] === 'list'));
        });

        it('the completion marker is written last, after the engine records and the sealed tools', { skip: ONLY_MACOS }, async (t) => {
            const r = await rig(t);
            await performAdoption(r.deps);
            const L = r.f.ctx.layout;
            const times = await Promise.all([join(L.stateDir, 'quartus.json'), join(L.stateDir, 'linux-vm.json'), L.manifestFile, L.toolchainMarker].map((p) => stat(p).then((s) => s.mtimeMs)));
            assert.ok(times[3]! >= Math.max(...times.slice(0, 3)));
            assert.equal(((await stat(L.unit('ghdl'))).mode & 0o222), 0, 'installed tools are read-only');
        });

        it('stops and changes nothing when a tool differs from the approved plan', async (t) => {
            const r = await rig(t);
            await writeFile(join(r.legacy, r.folders['ghdl']!, 'bin', 'ghdl'), '#!/bin/sh\necho different\n');
            const out = await performAdoption(r.deps);
            assert.equal(out.outcome, 'refused');
            assert.equal(await stat(r.f.ctx.layout.root).then(() => true, () => false), false, 'no installed layout was created');
            assert.equal(r.m.calls.some((c) => c[0] === 'shell' && c.join(' ').includes('MIXFPGA_SMOKE_OK')), false);
        });

        it('stops when the engine configuration or Quartus differs, or the engine is not running', async (t) => {
            for (const tweak of [(m: FakeMachine) => ((m.instance!.config as { cpus: number }).cpus = 2), (m: FakeMachine) => (m.quartusInstalled = false), (m: FakeMachine) => (m.instance!.status = 'Stopped')]) {
                const r = await rig(t);
                tweak(r.m);
                const out = await performAdoption(r.deps);
                assert.equal(out.outcome, 'refused');
                assert.equal(await stat(r.f.ctx.layout.stateDir).then(() => true, () => false), false);
            }
        });

        it('stops (changing nothing) when the engine does not pass the Quartus check', async (t) => {
            const r = await rig(t);
            r.m.smokeFails = true;
            const out = await performAdoption(r.deps);
            assert.equal(out.outcome, 'failed');
            assert.equal(await stat(r.f.ctx.layout.toolchainDir).then(() => true, () => false), false);
            assert.equal(await stat(join(r.f.ctx.layout.stateDir, 'quartus.json')).then(() => true, () => false), false);
            void readFile;
        });
    });
});
