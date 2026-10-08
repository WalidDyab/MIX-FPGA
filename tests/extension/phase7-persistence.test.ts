import './install-vscode-fake';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createProject } from '../../extension/project/scaffold';
import { DesignView } from '../../extension/views/design-view';
import { NexysVhdlService } from '../../extension/services/nexys-service';
import { PROJECT_STATE_FILE, ProjectState, type StateStore } from '../../extension/services/project-state';
import { SCHEMATIC_STATE_KEY, SchematicPanel } from '../../extension/schematic/schematic-panel';
import { LAYOUT_STATE_KEY, RADIX_STATE_KEY, SIGNALS_STATE_KEY, WaveformPanel } from '../../extension/waveform/waveform-panel';
import { sanitizeSignalChoices } from '../../extension/waveform/wave-render';
import { REPO, repoBoards, tempDir } from '../helpers';
import { FakeBackend } from './fake-backend';
import { panels, Uri, ViewColumn } from './vscode-fake';

async function newProject(t: TestContext, name = 'Demo') {
    const parent = await tempDir(t);
    const r = await createProject({ parentDir: parent, name, board: (await repoBoards()).get('nexys-a7-100t')!, template: 'empty' });
    assert.ok(r.ok);
    return r.root;
}

const stateFile = (root: string) => join(root, '.nexysvhdl', PROJECT_STATE_FILE);
const readState = async (root: string) => (JSON.parse(await readFile(stateFile(root), 'utf8')) as { version: number; values: Record<string, unknown> }).values;
const readConfig = async (root: string) => JSON.parse(await readFile(join(root, 'nexysvhdl.json'), 'utf8')) as Record<string, any>;

describe('ProjectState: pending debounced writes are never lost', () => {
    it('a change is written after the debounce, and flush() writes it at once without waiting for the timer', async (t) => {
        const root = await newProject(t);
        const state = new ProjectState({ debounceMs: 60_000 }); // the timer would not fire during this test
        t.after(() => state.dispose());
        await state.attach(root);
        void state.update('a', 1);
        void state.update('b', { c: [1, 2] });
        assert.equal(state.pending, true);
        await assert.rejects(readFile(stateFile(root), 'utf8'), 'nothing on disk yet: the write is pending');
        await state.flush();
        assert.equal(state.pending, false);
        assert.deepEqual(await readState(root), { a: 1, b: { c: [1, 2] } });
        assert.equal(state.get<number>('a'), 1);
    });

    it('the debounce coalesces a burst (a dragged splitter) into one write, and update() settles once it is on disk', async (t) => {
        const root = await newProject(t);
        const state = new ProjectState({ debounceMs: 20 });
        t.after(() => state.dispose());
        await state.attach(root);
        const writes = [1, 2, 3, 4, 5].map((n) => state.update('width', n));
        await Promise.all(writes);
        assert.deepEqual(await readState(root), { width: 5 });
    });

    it('a change made while a write is in flight is not lost', async (t) => {
        const root = await newProject(t);
        const state = new ProjectState({ debounceMs: 1 });
        t.after(() => state.dispose());
        await state.attach(root);
        const first = state.update('k', 'one');
        await new Promise((r) => setTimeout(r, 3)); // the first write is running now
        void state.update('k', 'two');
        void state.update('other', true);
        await first;
        await state.flush();
        assert.deepEqual(await readState(root), { k: 'two', other: true });
    });

    it('switching project flushes the previous one first; nothing leaks between projects', async (t) => {
        const a = await newProject(t, 'Alpha');
        const b = await newProject(t, 'Beta');
        const state = new ProjectState({ debounceMs: 60_000 });
        t.after(() => state.dispose());
        await state.attach(a);
        void state.update('mode', 'hierarchy');
        await state.attach(b);
        assert.deepEqual(await readState(a), { mode: 'hierarchy' }, 'Alpha was saved when Beta opened');
        assert.equal(state.get('mode'), undefined, 'Beta starts with its own state');
        await state.flush();
        await assert.rejects(readFile(stateFile(b), 'utf8'), 'nothing was written for Beta');
    });

    it('leaves no temporary file behind, and a damaged state file is ignored instead of blocking the project', async (t) => {
        const root = await newProject(t);
        await mkdir(join(root, '.nexysvhdl'), { recursive: true });
        await writeFile(stateFile(root), '{ "values": [ not json');
        const state = new ProjectState({ debounceMs: 1 });
        t.after(() => state.dispose());
        await state.attach(root);
        assert.equal(state.get('anything'), undefined);
        await state.update('x', 1);
        assert.deepEqual(await readState(root), { x: 1 });
        assert.deepEqual((await readdir(join(root, '.nexysvhdl'))).filter((n) => n.endsWith('.tmp')), []);
    });

    it('state an earlier version kept in VS Code workspace storage is migrated once, and never overrides the project file', async (t) => {
        const root = await newProject(t);
        const legacy = new Map<string, unknown>([['k1', 'old'], ['k2', 'older']]);
        const store: StateStore = { get: <T>(k: string) => legacy.get(k) as T | undefined, update: () => Promise.resolve() };
        const state = new ProjectState({ debounceMs: 60_000 });
        t.after(() => state.dispose());
        await state.attach(root, { store, keys: ['k1', 'k2', 'k3'] });
        assert.equal(state.get('k1'), 'old');
        await state.update('k2', 'new');
        await state.flush();
        const again = new ProjectState({ debounceMs: 60_000 });
        t.after(() => again.dispose());
        await again.attach(root, { store, keys: ['k1', 'k2'] });
        assert.equal(again.get('k2'), 'new', 'the project file wins over the old workspace storage');
    });
});

describe('NexysVHDL-managed state survives closing and reopening', () => {
    it('top, testbench, XDC, stop time, source lists and excluded files are in nexysvhdl.json the moment each command returns', async (t) => {
        const root = await newProject(t);
        await writeFile(join(root, 'src', 'a.vhd'), 'entity a is end entity a;\narchitecture r of a is begin end architecture r;\n');
        await writeFile(join(root, 'src', 'b.vhd'), 'entity b is end entity b;\narchitecture r of b is begin end architecture r;\n');
        await writeFile(join(root, 'sim', 'a_tb.vhd'), 'entity a_tb is end entity a_tb;\narchitecture s of a_tb is begin end architecture s;\n');
        await writeFile(join(root, 'sim', 'b_tb.vhd'), 'entity b_tb is end entity b_tb;\narchitecture s of b_tb is begin end architecture s;\n');
        await writeFile(join(root, 'constraints', 'other.xdc'), '# other\n');
        const service = new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(root);
        await service.setTop('b');
        await service.setTestbench('b_tb');
        await service.setStopTime('3us');
        await service.useConstraints('constraints/other.xdc');
        await service.removeFromProject('src/a.vhd');
        // Closing the window kills the process: read the file as a new session would, with no flush at all.
        const onDisk = await readConfig(root);
        assert.equal(onDisk.top, 'b');
        assert.equal(onDisk.simulation.testbench, 'b_tb');
        assert.equal(onDisk.simulation.stopTime, '3us');
        assert.equal(onDisk.constraints, 'constraints/other.xdc');
        assert.deepEqual(onDisk.exclude, ['src/a.vhd']);
        assert.deepEqual(onDisk.sources, ['src/b.vhd']);
        assert.deepEqual(onDisk.simulation.sources.sort(), ['sim/a_tb.vhd', 'sim/b_tb.vhd']);

        // Reopen in a fresh service: the same project comes back.
        const reopened = new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 5 });
        t.after(() => reopened.dispose());
        await reopened.open(root);
        const c = reopened.project!.config;
        assert.equal(c.top, 'b');
        assert.equal(c.simulation?.testbench, 'b_tb');
        assert.equal(c.simulation?.stopTime, '3us');
        assert.equal(c.constraints, 'constraints/other.xdc');
        assert.deepEqual(reopened.snapshot!.excluded, ['src/a.vhd']);
    });

    it('service.flush() completes a debounced refresh that has not fired yet, so its source-list update is on disk before exit', async (t) => {
        const root = await newProject(t);
        const service = new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 60_000 });
        t.after(() => service.dispose());
        await service.open(root);
        assert.deepEqual((await readConfig(root)).sources, []);
        const file = join(root, 'src', 'late.vhd');
        await writeFile(file, 'entity late is end entity late;\narchitecture r of late is begin end architecture r;\n');
        service.notifyFileEvent(file); // schedules the refresh behind a 60 s timer
        assert.deepEqual((await readConfig(root)).sources, [], 'not written yet: the refresh is still pending');
        await service.flush();
        assert.deepEqual((await readConfig(root)).sources, ['src/late.vhd'], 'flush ran the pending refresh and wrote the project file');
    });

    it('Design mode, waveform signals, radix and pane widths are restored by a new session from .nexysvhdl/state.json', async (t) => {
        const root = await newProject(t);
        const service = new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(root);

        // Session 1
        const state1 = new ProjectState({ debounceMs: 60_000 });
        t.after(() => state1.dispose());
        await state1.attach(root);
        const design1 = new DesignView(service, state1);
        t.after(() => design1.dispose());
        design1.setMode('hierarchy');
        const wave1 = new WaveformPanel(service, Uri.file('/ext') as never, state1);
        t.after(() => wave1.dispose());
        wave1.show();
        const panel = panels[panels.length - 1]!;
        panel.receive({ type: 'radix', state: { buses: 'bin', signals: { 'tb/uut/count': 'udec' } } });
        panel.receive({ type: 'layout', layout: { treeWidth: 300, namesWidth: 333 } });
        panel.receive({ type: 'signals', testbench: 'top_tb', paths: ['tb/clk', 'tb/uut/count'] });
        panel.receive({ type: 'signals', testbench: 'other_tb', paths: ['tb/x'] });
        assert.equal(state1.pending, true);
        await state1.flush(); // what deactivate() does

        // Session 2: nothing in memory, only the project folder.
        const state2 = new ProjectState({ debounceMs: 60_000 });
        t.after(() => state2.dispose());
        const design2 = new DesignView(service, state2);
        t.after(() => design2.dispose());
        assert.equal(design2.mode, 'files', 'before the project state loads, the default applies');
        const modes: string[] = [];
        design2.onDidChangeMode((m) => modes.push(m));
        await state2.attach(root);
        design2.reload();
        assert.equal(design2.mode, 'hierarchy');
        assert.deepEqual(modes, ['hierarchy']);
        assert.deepEqual(state2.get(RADIX_STATE_KEY), { buses: 'bin', signals: { 'tb/uut/count': 'udec' } });
        assert.deepEqual(state2.get(LAYOUT_STATE_KEY), { treeWidth: 300, namesWidth: 333 });
        assert.deepEqual(state2.get(SIGNALS_STATE_KEY), { top_tb: ['tb/clk', 'tb/uut/count'], other_tb: ['tb/x'] });
    });

    it('remembered signal choices are bounded and cleaned', () => {
        assert.deepEqual(sanitizeSignalChoices(undefined), {});
        assert.deepEqual(sanitizeSignalChoices([1, 2]), {});
        assert.deepEqual(sanitizeSignalChoices({ tb: ['a', 3, '', 'b'], bad: 'x' }), { tb: ['a', 'b'] });
        assert.equal(sanitizeSignalChoices({ tb: Array.from({ length: 5000 }, (_, i) => `s${i}`) })['tb']!.length, 2000);
    });

    it('the Design Schematic view (zoom mode, scroll per level, notes) is restored, and survives a re-render', async (t) => {
        const root = await newProject(t);
        await writeFile(join(root, 'src', 'top.vhd'), 'entity top is port (a : in bit; y : out bit); end entity top;\narchitecture r of top is begin y <= a; end architecture r;\n');
        const service = new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(root);
        await service.setTop('top');
        const state1 = new ProjectState({ debounceMs: 60_000 });
        t.after(() => state1.dispose());
        await state1.attach(root);
        const sch1 = new SchematicPanel(service, undefined, state1);
        t.after(() => sch1.dispose());
        sch1.show();
        const panel = panels[panels.length - 1]!;
        panel.receive({ type: 'view', mode: 'width', scale: 0.8, x: 40, y: 12, notesOpen: true });
        assert.deepEqual(sch1.lastView && { mode: sch1.lastView.mode, x: sch1.lastView.x, y: sch1.lastView.y }, { mode: 'width', x: 40, y: 12 });
        // The automatic re-render on save keeps the view: the new page is told the remembered state.
        await service.refreshNow();
        assert.match(panel.webview.html, /const INIT = \{"mode":"width","scale":0\.8,"x":40,"y":12,"notesOpen":true\}/);
        await state1.flush();

        const state2 = new ProjectState({ debounceMs: 60_000 });
        t.after(() => state2.dispose());
        await state2.attach(root);
        const sch2 = new SchematicPanel(service, undefined, state2);
        t.after(() => sch2.dispose());
        sch2.show();
        const reopened = panels[panels.length - 1]!;
        assert.notEqual(reopened, panel);
        assert.match(reopened.webview.html, /const INIT = \{"mode":"width","scale":0\.8,"x":40,"y":12,"notesOpen":true\}/);
        assert.equal(((state2.get(SCHEMATIC_STATE_KEY) as { view: { mode: string } }).view).mode, 'width');
        assert.equal(reopened.viewColumn, ViewColumn.Active, 'opens as a normal tab in the active group, not beside');
    });
});

describe('deactivate flushes before exit, and never saves source buffers', () => {
    it('extension.ts wires deactivate() to the service and project-state flush, and does not save documents', async () => {
        const text = await readFile(join(REPO, 'extension', 'extension.ts'), 'utf8');
        assert.match(text, /export async function deactivate\(\): Promise<void>/);
        assert.match(text, /service\.flush\(\), state\.flush\(\)/);
        assert.match(text, /onDidChangeWindowState/);
        assert.doesNotMatch(text, /saveAll|\.save\(\)|workbench\.action\.files\.save/, 'source documents keep VS Code Save / Auto Save');
    });

    it('nothing under extension/ force-saves editor buffers except the documented save-before-run of project files', async () => {
        const commands = await readFile(join(REPO, 'extension', 'commands', 'commands.ts'), 'utf8');
        const saves = commands.match(/\.save\(\)/g) ?? [];
        assert.equal(saves.length, 1, 'only saveProjectFiles() (before Check / Simulate / Build) saves a document');
        assert.match(commands, /async function saveProjectFiles/);
    });
});
