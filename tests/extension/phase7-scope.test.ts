import './install-vscode-fake';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { classifyProjectPath } from '../../extension/project/project-layout';
import { createProject } from '../../extension/project/scaffold';
import { WorkflowController, WorkspaceManager } from '../../core';
import { isEmptyProject } from '../../extension/project/empty-project';
import { makeProject, REPO, repoBoards, tempDir } from '../helpers';
import { SchematicPanel } from '../../extension/schematic/schematic-panel';
import { NexysVhdlService } from '../../extension/services/nexys-service';
import { renderWaveHtml } from '../../extension/waveform/waveform-html';
import { FakeBackend } from './fake-backend';
import { panels } from './vscode-fake';
import { readdir } from 'node:fs/promises';

/** Phase 7 deliberately adds no Verilog export: generated.v stays an internal artifact of the RTL flow. */
describe('scope: no Verilog export, no .v project sources', () => {
    it('no command, menu entry, setting or walkthrough step offers to export or add Verilog', async () => {
        const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string }>; menus: Record<string, Array<{ command: string }>> } };
        for (const c of pkg.contributes.commands) assert.doesNotMatch(`${c.command} ${c.title}`, /verilog|\.v\b/i, c.command);
        for (const items of Object.values(pkg.contributes.menus)) for (const i of items) assert.doesNotMatch(i.command, /verilog/i);
        const text = JSON.stringify(pkg.contributes);
        assert.doesNotMatch(text, /export.{0,20}verilog|verilog.{0,20}export/i);
    });

    it('the extension registers no command about Verilog, and never copies generated.v out of .nexysvhdl/', async () => {
        const commands = await readFile(join(REPO, 'extension', 'commands', 'commands.ts'), 'utf8');
        for (const m of commands.matchAll(/register\('([^']+)'/g)) assert.doesNotMatch(m[1]!, /verilog/i, m[1]);
        for (const e of await readdir(join(REPO, 'extension'), { recursive: true, withFileTypes: true })) {
            if (!e.isFile() || !e.name.endsWith('.ts')) continue;
            const src = await readFile(join(e.parentPath, e.name), 'utf8');
            assert.doesNotMatch(src, /copyFile\([^)]*generated\.v|writeFile\([^)]*['"`]src\/[^'"`]*\.v['"`]/, `${e.name} must not export generated.v`);
        }
    });

    it('a .v file is never a project source, and a new project contains none', async (t) => {
        assert.equal(classifyProjectPath('src/top.v'), undefined);
        assert.equal(classifyProjectPath('.nexysvhdl/rtl/generated.v'), undefined);
        const parent = await tempDir(t);
        const r = await createProject({ parentDir: parent, name: 'NoVerilog', board: (await repoBoards()).get('nexys-a7-100t')!, template: 'starter' });
        assert.ok(r.ok);
        assert.deepEqual(r.files.filter((f) => /\.s?v$/i.test(f)), []);
    });
});

describe('scope: validation-only hooks are not part of a normal session', () => {
    it('no environment variable or setting changes the extension behaviour for validation', async () => {
        const text = await readFile(join(REPO, 'extension', 'extension.ts'), 'utf8');
        assert.doesNotMatch(text, /process\.env\[/, 'extension.ts reads no environment variables');
        assert.doesNotMatch(text, /NEXYSVHDL_STATE_DEBOUNCE_MS/);
    });

    it('the schematic page carries no metrics or synthetic click/scroll code unless testHooks is switched on', async () => {
        const service = new NexysVhdlService({ backend: new FakeBackend() });
        const normal = new SchematicPanel(service);
        normal.show();
        const plain = panels[panels.length - 1]!.webview.html;
        for (const marker of ['blockLabelPx', "m.action === 'click'", "m.action === 'scroll'", 'dispatchEvent']) assert.ok(!plain.includes(marker), marker);
        assert.ok(plain.includes('const metrics = () => ({});'));
        normal.dispose();
        const test = new SchematicPanel(service);
        test.testHooks = true;
        test.show();
        const hooked = panels[panels.length - 1]!.webview.html;
        for (const marker of ['blockLabelPx', "m.action === 'click'", "m.action === 'scroll'"]) assert.ok(hooked.includes(marker), marker);
        test.dispose();
        service.dispose();
    });

    it('the waveform page carries the showSignals test command only with testHooks', async () => {
        const input = { nonce: 'n', cspSource: '', rendererUri: 'r.js' };
        assert.ok(!renderWaveHtml(input).includes('showSignals'));
        assert.ok(renderWaveHtml({ ...input, testHooks: true }).includes('showSignals'));
    });
});

describe('Empty Project is a valid starting state', () => {
    const emptyConfig = { top: '', sources: [] as string[], simulation: { sources: [] as string[] } };
    const none = { sources: [], simulation: [], constraints: [] };

    it('is recognised only while there is no VHDL and no top; any file or top ends it', () => {
        assert.equal(isEmptyProject(emptyConfig, none), true);
        assert.equal(isEmptyProject({ ...emptyConfig, top: 'x' }, none), false);
        assert.equal(isEmptyProject(emptyConfig, { ...none, sources: ['src/a.vhd'] }), false);
        assert.equal(isEmptyProject(emptyConfig, { ...none, simulation: ['sim/a_tb.vhd'] }), false);
        assert.equal(isEmptyProject({ ...emptyConfig, sources: ['src/a.vhd'] }, none), false);
    });

    it('a new Empty project starts with a clean Problems list and guidance; the core still refuses to build or simulate it', async (t) => {
        const parent = await tempDir(t);
        const r = await createProject({ parentDir: parent, name: 'Blank', board: (await repoBoards()).get('nexys-a7-100t')!, template: 'empty' });
        assert.ok(r.ok);
        const backend = new FakeBackend();
        const service = new NexysVhdlService({ backend, debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(r.root);
        const snap = service.snapshot!;
        assert.equal(snap.emptyProject, true);
        assert.deepEqual(snap.validation.filter((d) => d.severity === 'error'), [], 'no errors for a valid starting state');
        assert.deepEqual(service.problems.get('project'), snap.validation);
        // The core's own validation is untouched: Build and Simulate still have their reasons to refuse.
        const strict = await backend.validate(service.project!);
        assert.ok(strict.diagnostics.some((d) => d.code === 'PROJECT_MISSING_TOP'));
        assert.ok(strict.diagnostics.some((d) => d.code === 'PROJECT_NO_SOURCES'));
        assert.equal(strict.valid, false);
    });

    it('once a source exists, normal validation begins: several entities and no top is reported', async (t) => {
        const parent = await tempDir(t);
        const r = await createProject({ parentDir: parent, name: 'Blank', board: (await repoBoards()).get('nexys-a7-100t')!, template: 'empty' });
        assert.ok(r.ok);
        const service = new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(r.root);
        assert.equal(service.snapshot!.emptyProject, true);
        await writeFile(join(r.root, 'src', 'a.vhd'), 'entity a is end entity a;\narchitecture r of a is begin end architecture r;\n');
        await writeFile(join(r.root, 'src', 'b.vhd'), 'entity b is end entity b;\narchitecture r of b is begin end architecture r;\n');
        await service.refreshNow();
        const snap = service.snapshot!;
        assert.equal(snap.emptyProject, undefined);
        assert.ok(snap.validation.some((d) => d.code === 'PROJECT_MISSING_TOP' && d.severity === 'error'), 'the missing top is reported once there is something to choose from');
    });

    it('the shared core refuses to Build or Simulate an empty project', async (t) => {
        const project = await makeProject(t, { top: '', sources: [], simulation: { sources: [] } }, false);
        const controller = new WorkflowController({ boards: await repoBoards(), workspaces: new WorkspaceManager() });
        const build = await controller.build(project, {});
        assert.equal(build.success, false);
        assert.ok(build.diagnostics.some((d) => d.code === 'PROJECT_MISSING_TOP'));
    });
});
