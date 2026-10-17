import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { type ComponentDefinition, InstallStateStore, SetupEngine, type ToolInvocation, type ToolRunResult, type ToolRunner } from '../../core';
import type { DownloadRequest, DownloadResult, Downloader } from '../../platform/macos/install/download';
import { compareInstanceConfig, ENGINE_SPEC, EXPECTED_STORAGE, renderEngineTemplate } from '../../platform/macos/install/engine-config';
import { EngineProvisioner } from '../../platform/macos/install/engine-provision';
import { resolveRuntimeLayout, type RuntimeLayout } from '../../platform/macos/install/layout';
import { installedDe10Paths } from '../../platform/macos/install/paths';
import { REPO } from '../helpers';
import { ONLY_MACOS } from '../platform';

/** A scripted stand-in for limactl and the VM: it builds the instance description from the YAML it was given, like Lima does. */
class FakeLima implements ToolRunner {
    readonly calls: string[][] = [];
    readonly guest: string[] = [];
    instance: { status: string; config: Record<string, unknown>; errors?: string[] } | undefined;
    createFails = false;
    guestNetworkDown = false;
    verifyFails = false;
    yaml = '';
    constructor(private readonly limactl: string) {}

    async run(inv: ToolInvocation): Promise<ToolRunResult> {
        const base: ToolRunResult = { invocation: inv, outcome: 'exited', exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
        if (inv.executable !== this.limactl) return { ...base, outcome: 'spawn-failed', exitCode: null };
        const a = [...inv.args];
        this.calls.push(a);
        switch (a[0]) {
            case 'list':
                return this.instance ? { ...base, stdout: `${JSON.stringify({ name: 'mix-fpga-de10', status: this.instance.status, errors: this.instance.errors ?? null, config: this.instance.config })}\n` } : { ...base, exitCode: 1, stderr: 'No instance matching mix-fpga-de10 found.' };
            case 'create': {
                if (this.createFails) return { ...base, exitCode: 1, stderr: 'FATA: could not create' };
                this.yaml = await readFile(a[a.length - 1]!, 'utf8');
                const y = this.yaml;
                const pick = (re: RegExp) => re.exec(y)?.[1];
                this.instance = {
                    status: 'Stopped',
                    config: {
                        cpus: Number(pick(/^cpus: (\d+)/m)), memory: pick(/^memory: (\S+)/m), disk: pick(/^disk: (\S+)/m), vmType: pick(/^vmType: (\S+)/m), arch: pick(/^arch: (\S+)/m),
                        images: [{ location: pick(/location: "([^"]+\.img)"/), digest: pick(/digest: "([^"]+)"/) }],
                        mounts: [{ location: pick(/mounts:\n- location: "([^"]+)"/), mountPoint: pick(/mountPoint: (\S+)/), writable: /writable: true/.test(y) }],
                        vmOpts: { vz: { rosetta: { enabled: /enabled: true/.test(y), binfmt: /binfmt: true/.test(y) } } },
                    },
                };
                return base;
            }
            case 'delete':
                this.instance = undefined;
                return base;
            case 'start':
                this.instance!.status = 'Running';
                return base;
            case 'stop':
                this.instance!.status = 'Stopped';
                return base;
            case 'edit':
                (this.instance!.config as { cpus: number }).cpus = 4;
                return base;
            case 'shell': {
                const script = a[a.length - 1]!;
                this.guest.push(script);
                if (script.includes('provision-guest.sh')) return this.guestNetworkDown ? { ...base, exitCode: 100, stderr: 'E: Could not resolve archive.ubuntu.com' } : base;
                if (script.includes('MIXFPGA_GUEST_OK')) return this.verifyFails ? { ...base, exitCode: 1 } : { ...base, stdout: 'MIXFPGA_GUEST_OK\n' };
                return base;
            }
            default:
                return { ...base, exitCode: 2 };
        }
    }
    count(verb: string): number {
        return this.calls.filter((c) => c[0] === verb).length;
    }
}

interface Rig {
    readonly layout: RuntimeLayout;
    readonly lima: FakeLima;
    readonly prov: EngineProvisioner;
    readonly downloads: DownloadRequest[];
    readonly engine: SetupEngine;
    downloadResult: DownloadResult;
    free: number;
}

async function rig(t: TestContext, home?: string): Promise<Rig> {
    // Lima's sockets live under the root and macOS limits their path to 103 bytes, so the rig needs a short root.
    const dir = await mkdtemp(join('/tmp', 'mfe '));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const layout = resolveRuntimeLayout({ env: { MIXFPGA_HOME: home ?? join(dir, 'MIX-FPGA') } });
    await mkdir(join(layout.unit('lima'), 'bin'), { recursive: true });
    await writeFile(installedDe10Paths(layout).limactl, '#!/bin/sh\n');
    await cp(join(REPO, 'platform', 'macos', 'lima'), layout.unit('engine'), { recursive: true });
    await mkdir(layout.stateDir, { recursive: true });
    const lima = new FakeLima(installedDe10Paths(layout).limactl);
    const downloads: DownloadRequest[] = [];
    const r: Rig = { layout, lima, downloads, downloadResult: { ok: true, reused: false }, free: 1e12, prov: undefined as unknown as EngineProvisioner, engine: undefined as unknown as EngineSetup };
    const downloader: Downloader = async (req) => (downloads.push(req), r.downloadResult);
    const prov = new EngineProvisioner({ layout, runner: lima, downloader, freeBytes: async () => r.free });
    const stub = (id: string): ComponentDefinition => ({ id, label: id, inspect: async () => ({ state: 'ready', ownership: 'managed' }) });
    const engine = new SetupEngine([stub('toolchain'), stub('rosetta'), prov.definition()], new InstallStateStore(layout.installStateFile, layout.lockFile));
    return Object.assign(r, { prov, engine });
}
type EngineSetup = SetupEngine;

const vm = async (r: Rig) => (await r.engine.inspectAll()).find((s) => s.id === 'linux-vm')!;

describe('managed FPGA engine (Lima)', () => {
    it('renders the validated configuration, with the local verified image and the real staging folder', async (t) => {
        const r = await rig(t);
        const yaml = renderEngineTemplate(await readFile(join(r.layout.unit('engine'), 'mix-fpga-de10.yaml'), 'utf8'), { imageLocation: '/x/ubuntu.img', shareDir: '/s/staging' });
        assert.match(yaml, /^vmType: vz$/m);
        assert.match(yaml, /^cpus: 4$/m);
        assert.match(yaml, /^memory: 8GiB$/m);
        assert.match(yaml, /^disk: 60GiB$/m);
        assert.match(yaml, new RegExp(`digest: "sha256:${ENGINE_SPEC.image.sha256}"`));
        assert.match(yaml, /location: "\/x\/ubuntu\.img"/);
        assert.match(yaml, /mounts:\n- location: "\/s\/staging"\n {2}mountPoint: \/mnt\/mixfpga\n {2}writable: true/);
        assert.match(yaml, /rosetta:\n {6}enabled: true\n {6}binfmt: true/);
        assert.doesNotMatch(yaml, /\{\{/);
        assert.throws(() => renderEngineTemplate('a: {{OTHER}} {{IMAGE_LOCATION}}', { imageLocation: 'i', shareDir: 's' }), /unfilled/);
        assert.match(renderEngineTemplate('x: "{{IMAGE_LOCATION}}" "{{SHARE_DIR}}"', { imageLocation: 'a"b\\c', shareDir: 's' }), /"a\\"b\\\\c"/);
    });

    it('inspecting only asks Lima for its list: never starts, creates or enters the VM', async (t) => {
        const r = await rig(t);
        assert.equal((await vm(r)).state, 'not-installed');
        await r.engine.run({ only: [] });
        assert.ok(r.lima.calls.length > 0 && r.lima.calls.every((c) => c[0] === 'list'));
        assert.deepEqual(r.lima.guest, []);
    });

    it('without Lima installed it does not even try', async (t) => {
        const r = await rig(t);
        await rm(installedDe10Paths(r.layout).limactl);
        const s = await vm(r);
        assert.deepEqual([s.state, s.code], ['not-installed', 'LIMA_MISSING']);
        assert.deepEqual(r.lima.calls, []);
    });

    it('creates the engine from nothing: verified image, create, start, Linux setup, check, stop; ends ready and stopped', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        const run = await r.engine.run();
        assert.equal(run.outcome, 'complete', JSON.stringify(run.steps));
        assert.deepEqual(r.downloads.map((d) => [d.url, d.sha256, d.dest]), [[ENGINE_SPEC.image.url, ENGINE_SPEC.image.sha256, join(r.layout.downloadsDir, ENGINE_SPEC.image.fileName)]]);
        assert.deepEqual(r.lima.calls.map((c) => c[0]).filter((v) => v !== 'list'), ['create', 'start', 'shell', 'shell', 'shell', 'stop']);
        assert.match(r.lima.yaml, new RegExp(join(r.layout.downloadsDir, ENGINE_SPEC.image.fileName).replace(/[.\\/]/g, '\\$&')));
        assert.equal(r.lima.instance!.status, 'Stopped', 'setup does not leave the VM running');
        assert.equal((await vm(r)).state, 'ready');
        assert.ok(r.lima.guest[0]!.includes('/mnt/mixfpga/provision/provision-guest.sh'));
        assert.ok(r.lima.guest[1]!.includes('provision-quartus-env.sh'));
        const rec = await r.prov.record.read();
        assert.ok(rec.createdAt && rec.guestPackagesAt && rec.wrapperAt && rec.verifiedAt);
        assert.match(await readFile(join(r.layout.shareDir, 'provision', 'provision-quartus-env.sh'), 'utf8'), /mixfpga-q/);
    });

    it('opening MIX-FPGA afterwards (inspection) does not start the VM', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await r.engine.run();
        r.lima.calls.length = 0;
        assert.equal((await vm(r)).state, 'ready');
        assert.deepEqual(r.lima.calls.map((c) => c[0]), ['list']);
        assert.equal(r.lima.instance!.status, 'Stopped');
    });

    it('is resumable: a lost internet connection inside the VM stops setup, and the next run continues without re-downloading or re-creating', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        r.lima.guestNetworkDown = true;
        const first = await r.engine.run();
        assert.equal(first.steps[0]!.code, 'GUEST_NETWORK');
        assert.match(first.steps[0]!.message!, /internet/);
        assert.equal((await vm(r)).state, 'failed');
        assert.equal(r.lima.instance!.status, 'Stopped');
        r.lima.guestNetworkDown = false;
        const second = await r.engine.run();
        assert.equal(second.outcome, 'complete');
        assert.equal(r.lima.count('create'), 1);
        assert.equal(r.downloads.length, 1, 'the existing engine needs no new image');
        assert.equal((await vm(r)).state, 'ready');
    });

    it('resumes after a failed creation', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        r.lima.createFails = true;
        assert.equal((await r.engine.run()).steps[0]!.code, 'ENGINE_CREATE_FAILED');
        r.lima.createFails = false;
        assert.equal((await r.engine.run()).outcome, 'complete');
        assert.equal(r.lima.count('create'), 2);
        assert.equal(r.downloads.length, 2, 'the downloader is asked again and reuses its verified file');
    });

    it('a failed or tampered image download creates nothing', async (t) => {
        const r = await rig(t);
        r.downloadResult = { ok: false, code: 'HASH_MISMATCH', message: 'discarded' };
        const run = await r.engine.run();
        assert.equal(run.steps[0]!.code, 'IMAGE_HASH_MISMATCH');
        r.downloadResult = { ok: false, code: 'NETWORK', message: 'offline' };
        assert.equal((await r.engine.run()).steps[0]!.code, 'IMAGE_DOWNLOAD_FAILED');
        assert.equal(r.lima.count('create'), 0);
    });

    it('checks free disk space before downloading anything and reports real numbers, not 60 GB', async (t) => {
        const r = await rig(t);
        r.free = 5e9;
        const run = await r.engine.run();
        assert.equal(run.steps[0]!.code, 'INSUFFICIENT_DISK');
        assert.match(run.steps[0]!.message!, /20\.0 GB free/);
        assert.doesNotMatch(run.steps[0]!.message!, /60/);
        assert.deepEqual(r.downloads, []);
        assert.ok(EXPECTED_STORAGE.requiredFreeGB < EXPECTED_STORAGE.vmDiskLimitGB);
        assert.ok(EXPECTED_STORAGE.vmAfterQuartusGB < 15 && EXPECTED_STORAGE.vmDiskLimitGB === 60);
    });

    it('detects a Lima socket path that is too long and stops before touching anything (no workaround)', async (t) => {
        const r = await rig(t, join(tmpdir(), 'x'.repeat(90)));
        const run = await r.engine.run();
        assert.equal(run.steps[0]!.code, 'LIMA_SOCKET_PATH_TOO_LONG');
        assert.deepEqual(r.lima.calls.filter((c) => c[0] !== 'list'), []);
        assert.deepEqual(r.downloads, []);
    });

    it('an unfinished engine of ours is replaced; one that ever held Quartus is never deleted automatically', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await r.engine.run();
        r.lima.instance!.status = 'Broken';
        r.lima.instance!.errors = ['disk missing'];
        assert.equal((await vm(r)).code, 'BROKEN_INSTANCE');
        assert.equal((await r.engine.run()).outcome, 'complete');
        assert.equal(r.lima.count('delete'), 1);
        // Now it has Quartus in it.
        await r.prov.record.merge({ quartusInstalledAt: 'then' });
        r.lima.instance!.status = 'Broken';
        r.lima.instance!.errors = ['disk missing'];
        const guarded = await r.engine.run();
        assert.equal(guarded.steps[0]!.code, 'RECREATE_NEEDS_CONFIRMATION');
        assert.equal(r.lima.count('delete'), 1, 'not deleted a second time');
    });

    it('a different configuration under our name is incompatible and left alone; a settings drift is repaired in place', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await r.engine.run();
        const cfg = r.lima.instance!.config as { images: { digest: string }[]; cpus: number };
        cfg.cpus = 2;
        const drift = await vm(r);
        assert.deepEqual([drift.state, drift.code], ['repairable', 'CONFIG_DRIFT']);
        await r.engine.run();
        assert.equal(r.lima.count('edit'), 1);
        assert.equal(cfg.cpus, 4);
        cfg.images[0]!.digest = 'sha256:other';
        const other = await vm(r);
        assert.deepEqual([other.state, other.code], ['incompatible', 'ENGINE_CONFIG_DIFFERS']);
        const before = r.lima.calls.length;
        assert.equal((await r.engine.run()).outcome, 'complete', 'nothing to plan for an incompatible engine');
        assert.ok(r.lima.calls.slice(before).every((c) => c[0] === 'list'), 'only reads');
    });

    it('an existing, correctly configured engine without a setup record needs verification, not re-creation', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await r.engine.run();
        await rm(join(r.layout.stateDir, 'linux-vm.json'));
        const s = await vm(r);
        assert.deepEqual([s.state, s.code], ['repairable', 'GUEST_UNVERIFIED']);
        r.lima.calls.length = 0;
        assert.equal((await r.engine.run()).outcome, 'complete');
        assert.equal(r.lima.count('create'), 0);
        assert.equal(r.lima.count('delete'), 0);
    });

    it('does not accept a guest that fails its own check', async (t) => {
        const r = await rig(t);
        r.lima.verifyFails = true;
        assert.equal((await r.engine.run()).steps[0]!.code, 'GUEST_VERIFY_FAILED');
        assert.notEqual((await vm(r)).state, 'ready');
    });

    it('compares a real Lima description field by field', () => {
        const ok = { config: { cpus: 4, memory: '8GiB', disk: '60GiB', vmType: 'vz', arch: 'aarch64', images: [{ digest: `sha256:${ENGINE_SPEC.image.sha256}` }], mounts: [{ location: '/s', mountPoint: '/mnt/mixfpga', writable: true }], vmOpts: { vz: { rosetta: { enabled: true, binfmt: true } } } } };
        assert.deepEqual(compareInstanceConfig(ok, '/s'), []);
        assert.deepEqual(compareInstanceConfig({ config: { ...ok.config, disk: '100GiB' } }, '/s'), [], 'a larger disk is harmless');
        assert.deepEqual(compareInstanceConfig({ config: { ...ok.config, disk: '40GiB' } }, '/s').map((d) => d.field), ['disk']);
        assert.deepEqual(compareInstanceConfig(ok, '/elsewhere').map((d) => d.field), ['mount location']);
        assert.deepEqual(compareInstanceConfig({ config: { ...ok.config, mounts: [{ ...ok.config.mounts[0], writable: false }] } }, '/s').map((d) => d.field), ['mount writable']);
    });
});
