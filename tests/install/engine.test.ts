import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { aggregate, type ComponentDefinition, type ComponentId, type Inspection, InstallStateStore, SetupEngine, type SetupStepResult } from '../../core';
import { tempDir } from '../helpers';

/** A tiny fake machine: what is "installed" is just a map, so every state is easy to produce. */
class FakeMachine {
    readonly state = new Map<ComponentId, Inspection>();
    readonly installs: string[] = [];
    failNext = new Set<ComponentId>();
    set(id: ComponentId, i: Inspection) {
        this.state.set(id, i);
    }
    inspection(id: ComponentId): Inspection {
        return this.state.get(id) ?? { state: 'not-installed', ownership: 'managed' };
    }
}

function build(m: FakeMachine): ComponentDefinition[] {
    const leaf = (id: ComponentId, over: Partial<ComponentDefinition> = {}): ComponentDefinition => ({ id, label: id, inspect: async () => m.inspection(id), ...over });
    const step = (id: ComponentId, requires: ComponentId[], userInput: 'none' | 'consent' | 'files', covers: ComponentId[] = []) => ({
        requires,
        userInput,
        covers,
        run: async (): Promise<SetupStepResult> => {
            m.installs.push(id);
            if (m.failNext.has(id)) return { ok: false, code: 'BOOM', message: `${id} exploded` };
            for (const c of [id, ...covers]) m.set(c, { state: 'ready', ownership: m.inspection(c).ownership, version: '1' });
            return { ok: true };
        },
    });
    return [
        leaf('ghdl'),
        leaf('lima'),
        leaf('toolchain', { inspectAfter: ['ghdl', 'lima'], inspect: async (deps) => aggregate([deps.get('ghdl')!, deps.get('lima')!], 'managed'), install: step('toolchain', [], 'none', ['ghdl', 'lima']) }),
        leaf('rosetta', { inspect: async () => m.inspection('rosetta'), install: step('rosetta', [], 'consent') }),
        leaf('linux-vm', { install: step('linux-vm', ['toolchain', 'rosetta'], 'none') }),
        leaf('quartus', { install: step('quartus', ['linux-vm'], 'files') }),
    ];
}

async function setup(t: Parameters<typeof tempDir>[0]) {
    const dir = await tempDir(t);
    await mkdir(join(dir, 'state'), { recursive: true });
    const store = new InstallStateStore(join(dir, 'state', 'install-state.json'), join(dir, 'state', 'setup.lock'));
    const m = new FakeMachine();
    const engine = new SetupEngine(build(m), store);
    return { dir, store, m, engine };
}

const states = (list: readonly { id: string; state: string }[]) => Object.fromEntries(list.map((s) => [s.id, s.state]));

describe('install state model', () => {
    it('reports every component independently, with ownership, never a single boolean', async (t) => {
        const { engine, m } = await setup(t);
        m.set('ghdl', { state: 'ready', ownership: 'managed', version: '6.0.0' });
        m.set('rosetta', { state: 'ready', ownership: 'system' });
        m.set('quartus', { state: 'incompatible', ownership: 'external', detail: 'Build 1000' });
        const s = await engine.inspectAll();
        assert.deepEqual(states(s), { ghdl: 'ready', lima: 'not-installed', toolchain: 'repairable', rosetta: 'ready', 'linux-vm': 'not-installed', quartus: 'incompatible' });
        assert.equal(s.find((x) => x.id === 'rosetta')!.ownership, 'system');
        assert.equal(s.find((x) => x.id === 'quartus')!.ownership, 'external');
        assert.equal(s.find((x) => x.id === 'ghdl')!.ownership, 'managed');
    });

    it('plans in dependency order and only what is missing', async (t) => {
        const { engine, m } = await setup(t);
        m.set('rosetta', { state: 'ready', ownership: 'system' });
        const plan = engine.plan(await engine.inspectAll());
        assert.deepEqual(plan.map((p) => p.id), ['toolchain', 'linux-vm', 'quartus']);
        assert.equal(plan[0]!.mode, 'install');
    });

    it('plans a repair, not an install, when a member is damaged', async (t) => {
        const { engine, m } = await setup(t);
        m.set('ghdl', { state: 'ready', ownership: 'managed' });
        m.set('lima', { state: 'repairable', ownership: 'managed', code: 'HASH_MISMATCH' });
        const plan = engine.plan(await engine.inspectAll(), ['toolchain']);
        assert.deepEqual(plan.map((p) => `${p.id}:${p.mode}`), ['toolchain:repair']);
    });

    it('never plans work for an incompatible component (it needs the student, not a retry)', async (t) => {
        const { engine, m } = await setup(t);
        m.set('quartus', { state: 'incompatible', ownership: 'external' });
        assert.ok(!engine.plan(await engine.inspectAll()).some((p) => p.id === 'quartus'));
    });

    it('waits for user input instead of assuming consent, and keeps going with independent work', async (t) => {
        const { engine, m } = await setup(t);
        const r = await engine.run();
        assert.equal(r.outcome, 'incomplete');
        assert.deepEqual(m.installs, ['toolchain']);
        const by = Object.fromEntries(r.steps.map((s) => [s.id, s]));
        assert.equal(by['toolchain']!.outcome, 'done');
        assert.equal(by['rosetta']!.outcome, 'awaiting-input');
        assert.equal(by['rosetta']!.needs, 'consent');
        assert.equal(by['linux-vm']!.outcome, 'blocked');
        assert.equal(by['quartus']!.outcome, 'blocked');
    });

    it('completes once the student supplies consent and files', async (t) => {
        const { engine, m } = await setup(t);
        const r = await engine.run({ inputs: { rosetta: { accepted: true }, quartus: { files: ['a', 'b'] } } });
        assert.equal(r.outcome, 'complete');
        assert.deepEqual(m.installs, ['toolchain', 'rosetta', 'linux-vm', 'quartus']);
        assert.ok(r.statuses.every((s) => s.state === 'ready'));
    });

    it('is idempotent: a second run on a ready machine does nothing', async (t) => {
        const { engine, m } = await setup(t);
        const inputs = { rosetta: true, quartus: true };
        await engine.run({ inputs });
        m.installs.length = 0;
        const r = await engine.run({ inputs });
        assert.equal(r.outcome, 'complete');
        assert.deepEqual(r.steps, []);
        assert.deepEqual(m.installs, []);
    });

    it('resumes after a failure: finished steps are not redone, the failed one is retried', async (t) => {
        const { engine, m } = await setup(t);
        const inputs = { rosetta: true, quartus: true };
        m.failNext.add('quartus');
        const first = await engine.run({ inputs });
        assert.equal(first.outcome, 'incomplete');
        assert.equal(states(first.statuses)['quartus'], 'failed');
        assert.match(first.statuses.find((s) => s.id === 'quartus')!.detail!, /exploded/);
        m.installs.length = 0;
        m.failNext.clear();
        const second = await engine.run({ inputs });
        assert.equal(second.outcome, 'complete');
        assert.deepEqual(m.installs, ['quartus']);
    });

    it('treats an operation whose process died as interrupted (repairable), then resumes', async (t) => {
        const { engine, m, store } = await setup(t);
        m.set('ghdl', { state: 'ready', ownership: 'managed' }); // lima missing: toolchain partly there
        // A crash: an operation was recorded for a pid that no longer exists.
        await writeFile(store.file, JSON.stringify({ schemaVersion: 1, components: { toolchain: { operation: { id: 'dead', pid: 2 ** 22 + 12345, startedAt: 'x' } }, lima: { operation: { id: 'dead', pid: 2 ** 22 + 12345, startedAt: 'x' } } } }));
        const before = await engine.inspectAll();
        const tc = before.find((s) => s.id === 'toolchain')!;
        assert.equal(tc.state, 'repairable');
        assert.equal(tc.code, 'INTERRUPTED');
        const r = await engine.run({ inputs: { rosetta: true, quartus: true } });
        assert.equal(r.outcome, 'complete');
        assert.deepEqual(m.installs.slice(0, 1), ['toolchain']);
        assert.deepEqual((await store.read()).components, {});
    });

    it('reports a live operation as installing and refuses a second concurrent run', async (t) => {
        const { engine, store } = await setup(t);
        const release = await store.acquireLock('other');
        assert.ok(release);
        const r = await engine.run();
        assert.equal(r.outcome, 'busy');
        await release();
        // A lock whose owner is gone is taken over.
        await writeFile(store.lockFile, JSON.stringify({ pid: 2 ** 22 + 999, op: 'ghost' }));
        assert.notEqual((await engine.run()).outcome, 'busy');
    });

    it('does not trust a step that says "ok" but leaves the machine not ready', async (t) => {
        const { m, store } = await setup(t);
        const defs = build(m).map((d) => (d.id === 'toolchain' ? { ...d, install: { ...d.install!, run: async (): Promise<SetupStepResult> => ({ ok: true }) } } : d));
        const engine = new SetupEngine(defs, store);
        const r = await engine.run({ only: ['toolchain'] });
        assert.equal(r.steps[0]!.outcome, 'failed');
        assert.equal(r.steps[0]!.code, 'VERIFY_FAILED');
        assert.equal(states(r.statuses)['toolchain'], 'failed');
    });

    it('stops cleanly when cancelled and leaves no operation behind', async (t) => {
        const { m, store } = await setup(t);
        const ctl = new AbortController();
        const defs = build(m).map((d) => (d.id === 'toolchain' ? { ...d, install: { ...d.install!, run: async (): Promise<SetupStepResult> => (ctl.abort(), { ok: true }) } } : d));
        const r = await new SetupEngine(defs, store).run({ signal: ctl.signal, only: ['toolchain'] });
        assert.equal(r.outcome, 'cancelled');
        assert.deepEqual((await store.read()).components, {});
    });

    it('a corrupt state file is an empty state, not a crash', async (t) => {
        const { engine, store } = await setup(t);
        await writeFile(store.file, '{ not json');
        assert.equal((await engine.inspectAll()).length, 6);
    });

    it('rejects dependency cycles', async (t) => {
        const { store } = await setup(t);
        const a: ComponentDefinition = { id: 'a', label: 'a', inspectAfter: ['b'], inspect: async () => ({ state: 'ready', ownership: 'managed' }) };
        const b: ComponentDefinition = { id: 'b', label: 'b', inspectAfter: ['a'], inspect: async () => ({ state: 'ready', ownership: 'managed' }) };
        await assert.rejects(new SetupEngine([a, b], store).inspectAll(), /cycle/);
    });
});
