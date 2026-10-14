import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { InstallStateStore, SetupEngine } from '../../core';
import { isRosettaConsent, type RosettaCommand, rosettaDefinition, type RosettaHost, rosettaInstallCommand } from '../../platform/macos/install/rosetta';
import { tempDir } from '../helpers';

function host(over: Partial<{ arm: boolean; present: boolean; translates: boolean }> = {}): RosettaHost & { state: { arm: boolean; present: boolean; translates: boolean } } {
    const state = { arm: true, present: false, translates: false, ...over };
    return { state, appleSilicon: async () => state.arm, runtimePresent: async () => state.present, translates: async () => state.translates };
}

async function engineWith(t: Parameters<typeof tempDir>[0], h: RosettaHost, exit: number | undefined = 0) {
    const dir = await tempDir(t);
    await mkdir(join(dir, 'state'));
    const ran: RosettaCommand[] = [];
    const def = rosettaDefinition({
        host: h,
        runCommand: async (c) => {
            ran.push(c);
            if (exit === 0) Object.assign((h as ReturnType<typeof host>).state, { present: true, translates: true });
            return { exitCode: exit, output: exit === 0 ? '' : 'softwareupdate: failed' };
        },
    });
    return { ran, engine: new SetupEngine([def], new InstallStateStore(join(dir, 'state', 's.json'), join(dir, 'state', 'l'))) };
}

describe('Rosetta handling', () => {
    it('reports ready only when the runtime is present and x86-64 really runs; ownership is the system\'s', async (t) => {
        const { engine } = await engineWith(t, host({ present: true, translates: true }));
        const [s] = await engine.inspectAll();
        assert.deepEqual([s!.state, s!.ownership], ['ready', 'system']);
    });

    it('distinguishes missing, broken and unsupported', async (t) => {
        assert.equal((await (await engineWith(t, host())).engine.inspectAll())[0]!.state, 'not-installed');
        const broken = (await (await engineWith(t, host({ present: true }))).engine.inspectAll())[0]!;
        assert.deepEqual([broken.state, broken.code], ['repairable', 'NOT_TRANSLATING']);
        const intel = (await (await engineWith(t, host({ arm: false }))).engine.inspectAll())[0]!;
        assert.deepEqual([intel.state, intel.code], ['incompatible', 'NOT_APPLE_SILICON']);
    });

    it('never runs Apple\'s installer without the student\'s consent', async (t) => {
        const { engine, ran } = await engineWith(t, host());
        const r = await engine.run();
        assert.equal(r.outcome, 'incomplete');
        assert.deepEqual(r.steps, [{ id: 'rosetta', outcome: 'awaiting-input', needs: 'consent' }]);
        assert.deepEqual(ran, []);
    });

    it('rejects a malformed or incomplete consent', async (t) => {
        assert.equal(isRosettaConsent({ method: 'agree-to-license' }), false);
        assert.equal(isRosettaConsent({ method: 'agree-to-license', studentAcceptedAppleLicense: false }), false);
        assert.equal(isRosettaConsent(true), false);
        assert.equal(isRosettaConsent({ method: 'apple-prompt' }), true);
        const { engine, ran } = await engineWith(t, host());
        const r = await engine.run({ inputs: { rosetta: { method: 'agree-to-license' } } });
        assert.equal(r.steps[0]!.outcome, 'failed');
        assert.equal(r.steps[0]!.code, 'CONSENT_REQUIRED');
        assert.deepEqual(ran, []);
    });

    it('apple-prompt: Apple\'s own licence prompt is used, and --agree-to-license is never passed', async (t) => {
        const c = rosettaInstallCommand({ method: 'apple-prompt' });
        assert.deepEqual([c.executable, c.args, c.interactive, c.elevated], ['/usr/sbin/softwareupdate', ['--install-rosetta'], true, true]);
        const { engine, ran } = await engineWith(t, host());
        const r = await engine.run({ inputs: { rosetta: { method: 'apple-prompt' } } });
        assert.equal(r.outcome, 'complete');
        assert.equal(ran.length, 1);
        assert.ok(!ran[0]!.args.includes('--agree-to-license'));
        assert.equal(r.statuses[0]!.state, 'ready');
    });

    it('agree-to-license: only with the student\'s explicit acceptance of Apple\'s licence', async (t) => {
        const c = rosettaInstallCommand({ method: 'agree-to-license', studentAcceptedAppleLicense: true });
        assert.deepEqual(c.args, ['--install-rosetta', '--agree-to-license']);
        const { engine, ran } = await engineWith(t, host());
        assert.equal((await engine.run({ inputs: { rosetta: { method: 'agree-to-license', studentAcceptedAppleLicense: true } } })).outcome, 'complete');
        assert.deepEqual(ran.map((x) => x.args), [['--install-rosetta', '--agree-to-license']]);
    });

    it('does nothing when Rosetta is already there, whatever the consent', async (t) => {
        const { engine, ran } = await engineWith(t, host({ present: true, translates: true }));
        const r = await engine.run({ inputs: { rosetta: { method: 'apple-prompt' } } });
        assert.deepEqual([r.outcome, r.steps, ran], ['complete', [], []]);
    });

    it('a failed or cancelled install is recorded as failed, with Apple\'s last line, and can be retried', async (t) => {
        const { engine } = await engineWith(t, host(), 1);
        const r = await engine.run({ inputs: { rosetta: { method: 'apple-prompt' } } });
        assert.equal(r.steps[0]!.code, 'ROSETTA_INSTALL_FAILED');
        assert.match(r.steps[0]!.message!, /softwareupdate: failed/);
        assert.equal(r.statuses[0]!.state, 'failed');
    });

    it('an install that "succeeds" but leaves Rosetta unusable is not accepted', async (t) => {
        const h = host();
        const dir = await tempDir(t);
        await mkdir(join(dir, 'state'));
        const def = rosettaDefinition({ host: h, runCommand: async () => ({ exitCode: 0, output: '' }) });
        const r = await new SetupEngine([def], new InstallStateStore(join(dir, 'state', 's.json'), join(dir, 'state', 'l'))).run({ inputs: { rosetta: { method: 'apple-prompt' } } });
        assert.equal(r.steps[0]!.code, 'VERIFY_FAILED');
    });
});
