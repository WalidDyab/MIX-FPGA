import assert from 'node:assert/strict';
import { readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createProject } from '../../extension/project/scaffold';
import { flatten } from '../../extension/hierarchy/hierarchy';
import { NexysError, NexysVhdlService } from '../../extension/services/nexys-service';
import { repoBoards, tempDir, writeFiles } from '../helpers';
import { DESIGN_FILES } from './fixtures';
import { FakeBackend, OK, successfulBuild } from './fake-backend';

async function newProject(t: TestContext, name = 'Demo') {
    const parent = await tempDir(t);
    const r = await createProject({ parentDir: parent, name, board: (await repoBoards()).get('nexys-a7-100t')! });
    assert.ok(r.ok);
    return r.root;
}

async function openService(t: TestContext, root: string, backend = new FakeBackend(), checkOnSave = false) {
    const service = new NexysVhdlService({ backend, debounceMs: 5, checkOnSave: () => checkOnSave });
    t.after(() => service.dispose());
    await service.open(root);
    return { service, backend };
}

const outline = (service: NexysVhdlService) => flatten(service.snapshot!.hierarchy.root!).map((n) => (n.kind === 'instance' ? `${n.label}:${n.entityName}` : n.entityName));
/** Polls until cond() holds (2 s max), so tests do not depend on machine speed. */
async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond(), 'condition not reached');
}

const readConfig = async (root: string) => JSON.parse(await readFile(join(root, 'nexysvhdl.json'), 'utf8'));

describe('NexysVhdlService: project and hierarchy', () => {
    it('opens a project: model, Project Files groups and hierarchy from the configured top', async (t) => {
        const root = await newProject(t);
        const { service } = await openService(t, root);
        const snap = service.snapshot!;
        assert.equal(snap.project?.config.name, 'Demo');
        assert.equal(snap.boardName, 'Nexys A7-100T');
        assert.deepEqual(snap.validation, []);
        assert.deepEqual(snap.files.sources.map((f) => [f.path, f.top]), [['src/top.vhd', true]]);
        assert.deepEqual(snap.files.constraints.map((f) => [f.path, f.inUse]), [['constraints/nexys-a7-100t.xdc', true]]);
        assert.deepEqual(outline(service), ['top']);
        assert.deepEqual(snap.hierarchy.testbenches.map((t) => t.entityName), ['top_tb']);
    });

    it('reports a malformed nexysvhdl.json as a project error, without guessing', async (t) => {
        const root = await newProject(t);
        await writeFile(join(root, 'nexysvhdl.json'), '{ "name": "x", ');
        const { service } = await openService(t, root);
        assert.equal(service.snapshot!.project, undefined);
        assert.equal(service.snapshot!.loadDiagnostics[0]!.code, 'PROJECT_FILE_INVALID_JSON');
        assert.match(service.problems.get('project')![0]!.location!.file, /nexysvhdl.json$/);
        await assert.rejects(service.check(), NexysError);
    });

    it('refreshes the hierarchy after a save that adds a structural instantiation (debounced)', async (t) => {
        const root = await newProject(t);
        const { service } = await openService(t, root);
        await writeFiles(root, { 'src/counter.vhd': DESIGN_FILES['src/counter.vhd']! });
        service.notifyFileEvent(join(root, 'src', 'counter.vhd'));
        await service.whenIdle();
        assert.ok(service.snapshot!.files.sources.some((f) => f.path === 'src/counter.vhd'), 'new file appears in Project Files');
        assert.deepEqual(service.snapshot!.hierarchy.unreachable.map((e) => e.decl.name), ['counter']);

        const top = await readFile(join(root, 'src', 'top.vhd'), 'utf8');
        await writeFile(
            join(root, 'src', 'top.vhd'),
            top.replace('begin\n\n    counter : process', 'begin\n\n    u_counter : entity work.counter port map (clk => clk, reset => btnc, enable => sw0, count => open);\n\n    counter : process'),
        );
        // Several saves in a burst are coalesced into one refresh.
        service.notifyFileSaved(join(root, 'src', 'top.vhd'));
        service.notifyFileSaved(join(root, 'src', 'top.vhd'));
        await service.whenIdle();
        assert.deepEqual(outline(service), ['top', 'u_counter:counter']);
        assert.deepEqual(service.snapshot!.hierarchy.unreachable, []);
        // The source list follows the folder contract, in dependency order.
        assert.deepEqual((await readConfig(root)).sources, ['src/counter.vhd', 'src/top.vhd']);
    });

    it('ignores saves of files outside the folder contract', async (t) => {
        const root = await newProject(t);
        const { service } = await openService(t, root);
        let changes = 0;
        service.onDidChange(() => changes++);
        service.notifyFileSaved(join(root, 'notes.txt'));
        service.notifyFileSaved(join(root, '.nexysvhdl', 'impl', 'generated.xdc'));
        await service.whenIdle();
        assert.equal(changes, 0);
    });

    it('manual refresh picks up changes made without file events', async (t) => {
        const root = await newProject(t);
        const { service } = await openService(t, root);
        await writeFiles(root, DESIGN_FILES);
        await rm(join(root, 'src', 'old_blinker.vhd'));
        await service.refreshNow();
        assert.equal(service.snapshot!.hierarchy.root!.entityName, 'Top', 'DESIGN_FILES replaced src/top.vhd');
        assert.equal(flatten(service.snapshot!.hierarchy.root!).length, 6);
        assert.ok(service.snapshot!.files.sources.length >= 7);
    });

    it('sets the top entity through nexysvhdl.json and rebuilds the hierarchy', async (t) => {
        const root = await newProject(t);
        await writeFiles(root, DESIGN_FILES);
        const { service } = await openService(t, root);
        await service.setTop('DISPLAY_DRIVER');
        const config = await readConfig(root);
        assert.equal(config.top, 'display_driver', 'stored with the declaration spelling');
        assert.equal(config.name, 'Demo', 'other settings are kept');
        assert.equal(service.snapshot!.hierarchy.root!.entityName, 'display_driver');
        assert.deepEqual(service.snapshot!.files.sources.filter((f) => f.top).map((f) => f.path), ['src/display/display_driver.vhd']);
        await assert.rejects(service.setTop('top_tb'), /simulation folder/);
        await assert.rejects(service.setTop('nothing'), /No entity/);
    });

    it('selects a constraints file, refusing to drop a pin mapping silently', async (t) => {
        const root = await newProject(t);
        await writeFiles(root, { 'constraints/alt.xdc': '' });
        const { service } = await openService(t, root);
        await service.useConstraints('constraints/alt.xdc');
        assert.equal((await readConfig(root)).constraints, 'constraints/alt.xdc');
        assert.deepEqual(service.snapshot!.files.constraints.map((f) => [f.name, f.inUse]), [['alt.xdc', true], ['nexys-a7-100t.xdc', false]]);

        const config = await readConfig(root);
        delete config.constraints;
        config.pins = { clk: 'CLK100MHZ' };
        await writeFile(join(root, 'nexysvhdl.json'), JSON.stringify(config));
        await service.refreshNow();
        assert.equal(service.snapshot!.files.generatedConstraints, true);
        await assert.rejects(service.useConstraints('constraints/alt.xdc'), /confirm/);
        await service.useConstraints('constraints/alt.xdc', true);
        const after = await readConfig(root);
        assert.equal(after.pins, undefined);
        assert.equal(after.constraints, 'constraints/alt.xdc');
    });
});

describe('NexysVhdlService: workflow', () => {
    it('Check: idle -> running -> passed, through the backend, clearing old diagnostics', async (t) => {
        const root = await newProject(t);
        const { service, backend } = await openService(t, root);
        backend.checkResult = {
            ...OK, status: 'failed', elaborated: [],
            diagnostics: [{ severity: 'error', source: 'vhdl', code: 'GHDL_ERROR', message: "missing ';'", location: { file: 'src/top.vhd', line: 12, column: 5 } }],
        };
        const states: string[] = [];
        service.onDidChange((k) => k === 'workflow' && states.push(service.workflow.check.state));
        await service.check();
        assert.deepEqual(states, ['running', 'failed']);
        assert.equal(service.workflow.check.summary, '1 error');
        assert.equal(service.problems.get('vhdl')!.length, 1);

        backend.checkResult = { ...OK, elaborated: ['top', 'top_tb'] };
        await service.check();
        assert.equal(service.workflow.check.state, 'passed');
        assert.equal(service.workflow.check.summary, 'No VHDL errors');
        assert.deepEqual(service.problems.get('vhdl'), []);
        assert.deepEqual(backend.calls, ['check:top', 'check:top']);
    });

    it('runs one action at a time', async (t) => {
        const root = await newProject(t);
        const { service, backend } = await openService(t, root);
        let release!: () => void;
        backend.gate = new Promise((r) => (release = r));
        const first = service.check();
        await until(() => backend.calls.length === 1);
        assert.equal(service.busy, 'check');
        await assert.rejects(service.build(), /still running/);
        release();
        await first;
        assert.equal(service.busy, undefined);
    });

    it('a requested Check joins a running check, and Build waits for an automatic check', async (t) => {
        const root = await newProject(t);
        const { service, backend } = await openService(t, root, new FakeBackend(), true);
        let release!: () => void;
        backend.gate = new Promise((r) => (release = r));
        service.notifyFileSaved(join(root, 'src', 'top.vhd')); // starts an automatic check
        await until(() => backend.calls.length === 1);
        const joined = service.check();
        backend.buildResult = successfulBuild(join(root, 'hardware.bit'));
        const build = service.build();
        await new Promise((r) => setTimeout(r, 20));
        assert.deepEqual(backend.calls, ['check:top'], 'no second check, and the build has not started yet');
        release();
        assert.equal((await joined).status, 'succeeded');
        assert.equal((await build).success, true);
        assert.deepEqual(backend.calls, ['check:top', 'build']);
    });

    it('check on save runs Check after the re-index when enabled', async (t) => {
        const root = await newProject(t);
        const { service, backend } = await openService(t, root, new FakeBackend(), true);
        service.notifyFileSaved(join(root, 'src', 'top.vhd'));
        await service.whenIdle();
        await until(() => backend.calls.length > 0 && service.busy === undefined);
        assert.deepEqual(backend.calls, ['check:top']);
    });

    it('Simulate uses the configured testbench, or asks when none is set', async (t) => {
        const root = await newProject(t);
        const { service, backend } = await openService(t, root);
        const done = await service.simulate();
        assert.equal(done.kind, 'done');
        assert.equal(service.workflow.simulate.state, 'passed');
        assert.equal(service.workflow.simulate.summary, 'Passed · stopped at 280 ns');
        assert.deepEqual(backend.calls, ['simulate:top_tb']);

        const config = await readConfig(root);
        delete config.simulation.testbench;
        await writeFile(join(root, 'nexysvhdl.json'), JSON.stringify(config));
        await service.refreshNow();
        const ask = await service.simulate();
        assert.deepEqual(ask, { kind: 'needs-testbench', candidates: ['top_tb'] });
        await service.setTestbench('top_tb');
        assert.equal((await readConfig(root)).simulation.testbench, 'top_tb');
    });

    it('Build: stages advance with backend progress and end from the BuildResult', async (t) => {
        const root = await newProject(t);
        const { service, backend } = await openService(t, root);
        backend.buildProgress = [
            { kind: 'step-started', step: 'check' },
            { kind: 'step-finished', step: 'check', status: 'succeeded' },
            { kind: 'implementation-stage', stage: 'synthesis' },
            { kind: 'implementation-stage', stage: 'implementation' },
        ];
        backend.buildResult = successfulBuild(join(root, '.nexysvhdl', 'impl', 'hardware.bit'));
        const seen: string[] = [];
        service.onDidChange((k) => {
            if (k === 'workflow') seen.push(['synthesis', 'implementation', 'bitstream'].map((s) => service.workflow.stages[s as 'synthesis'].state[0]).join(''));
        });
        let release!: () => void;
        backend.gate = new Promise((r) => (release = r));
        const run = service.build();
        await until(() => backend.calls.includes('build'));
        assert.equal(service.workflow.stages.synthesis.state, 'passed');
        assert.equal(service.workflow.stages.implementation.state, 'running');
        assert.equal(service.workflow.stages.bitstream.state, 'idle');
        release();
        await run;
        assert.deepEqual(seen, ['rii', 'rii', 'rii', 'rii', 'pri', 'ppp']);
        assert.equal(service.workflow.build.summary, 'BUILD COMPLETE');
        assert.equal(service.workflow.stages.implementation.summary, 'Timing PASS · 372.58 MHz');
        assert.equal(service.lastBuild?.utilization?.luts?.used, 56);
    });
});

describe('NexysVhdlService: hardware and program', () => {
    const board = (serial: string) => ({ selector: `SN:${serial}`, serialNumber: serial, productName: 'Nexys A7 -100T', boardId: 'nexys-a7-100t' });

    async function built(t: TestContext) {
        const root = await newProject(t);
        const { service, backend } = await openService(t, root);
        const bitPath = join(root, '.nexysvhdl', 'impl', 'hardware.bit');
        await writeFile(bitPath, 'bits');
        const future = new Date(Date.now() + 60_000);
        await utimes(bitPath, future, future);
        backend.bit = { path: bitPath, modifiedMs: future.getTime() };
        return { root, service, backend };
    }

    it('represents no board, one board and several boards', async (t) => {
        const { service, backend } = await built(t);
        await service.detectBoards();
        assert.equal(service.hardware.status, 'none');
        backend.detection = { configured: true, boards: [board('210292BCFFE4')], diagnostics: [] };
        await service.detectBoards();
        assert.equal(service.hardware.status, 'one');
        backend.detection = { configured: true, boards: [board('A'), board('B')], diagnostics: [{ severity: 'info', source: 'programming', code: 'X', message: 'ignored device' }] };
        await service.detectBoards();
        assert.equal(service.hardware.status, 'many');
        assert.deepEqual(service.hardware.diagnostics, [], 'info-level detection notes are not shown as problems');
        backend.detection = { configured: false, boards: [], diagnostics: [] };
        await service.detectBoards();
        assert.equal(service.hardware.status, 'unavailable');
    });

    it('overlapping detections share one scan, because the programmer cable allows a single user', async (t) => {
        const { service, backend } = await built(t);
        backend.detection = { configured: true, boards: [board('210292BCFFE4')], diagnostics: [] };
        const [a, b] = await Promise.all([service.detectBoards(), service.detectBoards()]);
        assert.equal(a.status, 'one');
        assert.equal(b.status, 'one');
        assert.equal(backend.calls.filter((c) => c === 'detect').length, 1);
        await service.detectBoards();
        assert.equal(backend.calls.filter((c) => c === 'detect').length, 2, 'a later request scans again');
    });

    it('with several boards Program asks for a choice instead of picking one, then uses it', async (t) => {
        const { service, backend } = await built(t);
        backend.detection = { configured: true, boards: [board('A'), board('B')], diagnostics: [] };
        await service.detectBoards();
        const ask = await service.program();
        assert.equal(ask.kind, 'needs-board');
        assert.deepEqual(ask.kind === 'needs-board' && ask.boards.map((b) => b.serial), ['A', 'B']);
        assert.ok(!backend.calls.some((c) => c.startsWith('program')));
        service.selectBoard('B');
        const done = await service.program();
        assert.equal(done.kind, 'done');
        assert.ok(backend.calls.includes('program:B'));
        assert.equal(service.workflow.program.summary, 'FPGA programmed');
    });

    it('with one board Program lets the shared service select it', async (t) => {
        const { service, backend } = await built(t);
        backend.detection = { configured: true, boards: [board('210292BCFFE4')], diagnostics: [] };
        const r = await service.program();
        assert.equal(r.kind, 'done');
        assert.ok(backend.calls.includes('program:(auto)'));
    });

    it('refuses to program without a bitstream or after a failed build, and asks about stale bitstreams', async (t) => {
        const { root, service, backend } = await built(t);
        backend.bit = undefined;
        assert.equal((await service.program()).kind, 'blocked');
        backend.bit = { path: 'x', modifiedMs: 0 };
        const stale = await service.program();
        assert.equal(stale.kind, 'stale');
        backend.detection = { configured: true, boards: [board('S1')], diagnostics: [] };
        assert.equal((await service.program({ allowStale: true })).kind, 'done');

        backend.buildResult = { ...successfulBuild(join(root, 'x.bit')), success: false, timing: { clocks: [], passed: false } };
        await service.build();
        const blocked = await service.program({ allowStale: true });
        assert.equal(blocked.kind, 'blocked');
        assert.match(blocked.kind === 'blocked' ? blocked.message : '', /last build failed/i);
    });
});
