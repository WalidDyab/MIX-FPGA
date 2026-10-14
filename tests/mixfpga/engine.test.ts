import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LimaEngine, classifyProbe } from '../../platform/macos/de10/engine';
import { FakeVm, testPaths } from './fake-vm';

const mk = async (t: import('node:test').TestContext, o: ConstructorParameters<typeof FakeVm>[1] = {}) => {
    const { paths } = await testPaths(t);
    const vm = new FakeVm(paths, o);
    return { vm, engine: new LimaEngine(paths, vm), paths };
};

describe('Lima engine state', () => {
    it('reports a running, healthy engine with the Quartus version', async (t) => {
        const { engine } = await mk(t);
        const s = await engine.status();
        assert.equal(s.state, 'running');
        assert.match(s.toolVersion ?? '', /25\.1std\.0 Build 1129/);
        assert.deepEqual(s.problems, []);
    });

    it('reports a stopped VM without starting it', async (t) => {
        const { engine, vm } = await mk(t, { vm: 'Stopped' });
        assert.equal((await engine.status()).state, 'stopped');
        assert.ok(!vm.limaArgs.some((a) => a[0] === 'start'));
    });

    it('reports an engine that was never installed', async (t) => {
        const { engine } = await mk(t, { vm: 'missing' });
        const s = await engine.status();
        assert.equal(s.state, 'not-installed');
        assert.equal(s.problems[0]?.code, 'ENGINE_NOT_INSTALLED');
    });
});

describe('ensureReady', () => {
    it('starts a stopped VM automatically, then proves Quartus runs', async (t) => {
        const { engine, vm } = await mk(t, { vm: 'Stopped' });
        const s = await engine.ensureReady();
        assert.equal(s.state, 'running');
        assert.deepEqual(vm.limaArgs.filter((a) => a[0] === 'start').length, 1);
        assert.ok(vm.limaArgs.find((a) => a[0] === 'start')!.includes('mix-fpga-de10'));
    });

    it('does not restart a VM that is already running', async (t) => {
        const { engine, vm } = await mk(t);
        await engine.ensureReady();
        assert.ok(!vm.limaArgs.some((a) => a[0] === 'start'));
    });

    it('turns a failed VM start into ENGINE_START_FAILED', async (t) => {
        const { engine } = await mk(t, { vm: 'Stopped', startFails: true });
        const s = await engine.ensureReady();
        assert.equal(s.state, 'stopped');
        assert.equal(s.problems[0]?.code, 'ENGINE_START_FAILED');
        assert.match(s.problems[0]!.message, /vz driver failed/);
    });

    it('fails clearly when the engine was never installed', async (t) => {
        const { engine } = await mk(t, { vm: 'missing' });
        assert.equal((await engine.ensureReady()).problems[0]?.code, 'ENGINE_NOT_INSTALLED');
    });

    it('repairs the Rosetta AOT daemon (rosettad) before Quartus can crash on it', async (t) => {
        const { engine, vm, paths } = await mk(t, { rosettadActive: true });
        const s = await engine.ensureReady();
        assert.equal(s.state, 'running');
        assert.equal(vm.remediated, 1);
        assert.equal(s.problems[0]?.code, 'ROSETTAD_REPAIRED');
        assert.ok(vm.guestScripts.some((x) => x.includes(`${paths.guestShareDir}/provision/provision-quartus-env.sh`)));
    });

    it('recognises the bus-error signature even with no visible socket, repairs once and re-probes', async (t) => {
        const { engine, vm } = await mk(t, { probes: ['sigbus', 'ok'] });
        const s = await engine.ensureReady();
        assert.equal(s.state, 'running');
        assert.equal(vm.remediated, 1);
        assert.equal(s.problems[0]?.code, 'ROSETTAD_REPAIRED');
    });

    it('reports QUARTUS_SIGBUS (never "ready") when the repair does not help', async (t) => {
        const { engine, vm } = await mk(t, { probes: ['sigbus'] });
        const s = await engine.ensureReady();
        assert.equal(s.state, 'unhealthy');
        assert.equal(vm.remediated, 1, 'repairs exactly once, no loop');
        assert.ok(s.problems.some((p) => p.code === 'QUARTUS_SIGBUS' && p.severity === 'error'));
    });

    it('rejects a Quartus that answers with the wrong version', async (t) => {
        const { engine } = await mk(t, { probes: ['wrong-version'] });
        const s = await engine.ensureReady();
        assert.equal(s.state, 'unhealthy');
        assert.equal(s.problems.at(-1)?.code, 'QUARTUS_PROBE_FAILED');
    });

    it('status() flags an active rosettad as unhealthy', async (t) => {
        const { engine } = await mk(t, { rosettadActive: true, probes: ['sigbus'] });
        const s = await engine.status();
        assert.equal(s.state, 'unhealthy');
        assert.ok(s.problems.some((p) => p.code === 'ROSETTAD_AOT_ACTIVE'));
    });
});

describe('shutdown and restart', () => {
    it('stops the VM, and restart = stop then ready', async (t) => {
        const { engine, vm } = await mk(t);
        await engine.shutdown();
        assert.equal(vm.state, 'Stopped');
        const s = await engine.restart();
        assert.equal(s.state, 'running');
        assert.deepEqual(vm.limaArgs.filter((a) => a[0] === 'stop' || a[0] === 'start').map((a) => a[0]), ['stop', 'stop', 'start']);
    });
});

describe('probe classification', () => {
    const run = (o: object) => ({ invocation: { executable: 'x', args: [] }, outcome: 'exited' as const, exitCode: 0, stdout: '', stderr: '', durationMs: 1, ...o });
    it('maps exit 135 and 127', () => {
        assert.equal(classifyProbe(run({ exitCode: 135 }), 'b').kind, 'sigbus');
        assert.equal(classifyProbe(run({ exitCode: 127, stderr: 'mixfpga-q: command not found' }), 'b').kind, 'missing');
        assert.equal(classifyProbe(run({ stdout: 'Version 25.1std.0 Build 1129' }), '25.1std.0 Build 1129').kind, 'ok');
    });
});
