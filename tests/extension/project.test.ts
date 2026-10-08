import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadProject, validateProject, xdcPinAssignments } from '../../core';
import { DesignIndex, type IndexedFile } from '../../extension/hierarchy/design-index';
import { parseVhdl } from '../../extension/hierarchy/vhdl-parser';
import { buildProjectFilesModel, classifyProjectPath, scanProjectFiles } from '../../extension/project/project-layout';
import { computeSourceSync } from '../../extension/project/project-sync';
import { createProject, validateProjectName } from '../../extension/project/scaffold';
import { starterXdc, STARTER_PORTS } from '../../extension/project/templates';
import { repoBoards, tempDir, writeFiles } from '../helpers';
import { DESIGN_FILES } from './fixtures';

async function listTree(dir: string, prefix = ''): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
        const rel = `${prefix}${e.name}`;
        out.push(e.isDirectory() ? `${rel}/` : rel);
        if (e.isDirectory()) out.push(...(await listTree(join(dir, e.name), `${rel}/`)));
    }
    return out.sort();
}

async function board() {
    return (await repoBoards()).get('nexys-a7-100t')!;
}

describe('Create Project', () => {
    it('creates the standard project tree in a new folder named after the project', async (t) => {
        const parent = await tempDir(t);
        const result = await createProject({ parentDir: parent, name: 'CounterDemo', board: await board() });
        assert.ok(result.ok);
        assert.equal(result.root, join(parent, 'CounterDemo'));
        assert.deepEqual(await listTree(result.root), [
            '.gitignore',
            '.nexysvhdl/',
            '.nexysvhdl/check/',
            '.nexysvhdl/impl/',
            '.nexysvhdl/logs/',
            '.nexysvhdl/program/',
            '.nexysvhdl/rtl/',
            '.nexysvhdl/sim/',
            '.nexysvhdl/synth/',
            'CounterDemo.nvproj',
            'constraints/',
            'constraints/nexys-a7-100t.xdc',
            'nexysvhdl.json',
            'sim/',
            'sim/top_tb.vhd',
            'src/',
            'src/top.vhd',
        ]);
        const config = JSON.parse(await readFile(join(result.root, 'nexysvhdl.json'), 'utf8'));
        assert.deepEqual(config, {
            name: 'CounterDemo',
            board: 'nexys-a7-100t',
            language: 'vhdl',
            standard: '2008',
            top: 'top',
            sources: ['src/top.vhd'],
            simulation: { sources: ['sim/top_tb.vhd'], testbench: 'top_tb' },
            constraints: 'constraints/nexys-a7-100t.xdc',
        });
        assert.match(await readFile(join(result.root, '.gitignore'), 'utf8'), /^\.nexysvhdl\/$/m);
    });

    it('produces a project the Phase 3 model loads and validates without problems', async (t) => {
        const parent = await tempDir(t);
        const result = await createProject({ parentDir: parent, name: 'Valid_1', board: await board() });
        assert.ok(result.ok);
        const loaded = await loadProject(result.root);
        assert.ok(loaded.ok);
        const validation = await validateProject(loaded.project, await repoBoards());
        assert.deepEqual(validation.diagnostics, []);
        // The starter VHDL declares what the project file promises.
        const top = parseVhdl(await readFile(join(result.root, 'src', 'top.vhd'), 'utf8'));
        assert.deepEqual(top.entities.map((e) => e.name), ['top']);
        assert.deepEqual(top.entities[0]!.ports.map((p) => p.name), STARTER_PORTS.map((p) => p.port));
        const tb = parseVhdl(await readFile(join(result.root, 'sim', 'top_tb.vhd'), 'utf8'));
        assert.equal(tb.architectures[0]!.instances[0]!.target, 'top');
    });

    it('never writes outside the new project folder', async (t) => {
        const parent = await tempDir(t);
        await writeFile(join(parent, 'keep.txt'), 'untouched');
        const before = await listTree(parent);
        const result = await createProject({ parentDir: parent, name: 'Isolated', board: await board() });
        assert.ok(result.ok);
        const after = await listTree(parent);
        const added = after.filter((p) => !before.includes(p));
        assert.ok(added.every((p) => p.startsWith('Isolated/')), added.join(', '));
        assert.equal(await readFile(join(parent, 'keep.txt'), 'utf8'), 'untouched');
    });

    it('refuses an existing folder and leaves it untouched', async (t) => {
        const parent = await tempDir(t);
        await mkdir(join(parent, 'Taken'));
        await writeFile(join(parent, 'Taken', 'mine.vhd'), '-- student work');
        const result = await createProject({ parentDir: parent, name: 'Taken', board: await board() });
        assert.equal(result.ok, false);
        assert.equal(!result.ok && result.code, 'ALREADY_EXISTS');
        assert.deepEqual(await listTree(join(parent, 'Taken')), ['mine.vhd']);
    });

    it('rejects invalid names and a missing parent folder', async (t) => {
        assert.ok(validateProjectName('my project'));
        assert.ok(validateProjectName('../escape'));
        assert.ok(validateProjectName('1st'));
        assert.equal(validateProjectName('Counter_Demo-2'), undefined);
        const parent = await tempDir(t);
        const bad = await createProject({ parentDir: parent, name: '../escape', board: await board() });
        assert.equal(!bad.ok && bad.code, 'INVALID_NAME');
        const missing = await createProject({ parentDir: join(parent, 'nope'), name: 'X', board: await board() });
        assert.equal(!missing.ok && missing.code, 'PARENT_MISSING');
        assert.deepEqual(await readdir(parent), []);
    });

    it('generates a readable, Vivado-style starter XDC from board data', async () => {
        const b = await board();
        const xdc = starterXdc('Demo', b);
        assert.match(xdc, /set_property -dict \{ PACKAGE_PIN E3 IOSTANDARD LVCMOS33 \} \[get_ports \{ clk \}\]/);
        assert.match(xdc, /create_clock -period 10\.00 \[get_ports \{ clk \}\]/);
        assert.deepEqual(
            xdcPinAssignments(xdc).map((a) => `${a.port}=${a.pin}`).sort(),
            STARTER_PORTS.map((p) => `${p.port}=${b.resources.find((r) => r.id === p.resource)!.pins[0]}`).sort(),
        );
    });
});

describe('project detection and folder contract', () => {
    it('detects a project from nexysvhdl.json and reports a malformed one', async (t) => {
        const parent = await tempDir(t);
        const created = await createProject({ parentDir: parent, name: 'Detect', board: await board() });
        assert.ok(created.ok);
        assert.equal((await loadProject(created.root)).ok, true);
        await writeFile(join(created.root, 'nexysvhdl.json'), '{ "name": ');
        const broken = await loadProject(created.root);
        assert.equal(broken.ok, false);
        assert.equal(!broken.ok && broken.diagnostics[0]!.code, 'PROJECT_FILE_INVALID_JSON');
        assert.equal((await loadProject(parent)).ok, false, 'a folder without nexysvhdl.json is not a project');
    });

    it('classifies paths by the folder contract and never looks inside .nexysvhdl', () => {
        assert.equal(classifyProjectPath('src/a/b.vhd'), 'source');
        assert.equal(classifyProjectPath('src/x.VHDL'), 'source');
        assert.equal(classifyProjectPath('sim/tb.vhd'), 'simulation');
        assert.equal(classifyProjectPath('constraints/pins.xdc'), 'constraints');
        assert.equal(classifyProjectPath('nexysvhdl.json'), 'settings');
        assert.equal(classifyProjectPath('.nexysvhdl/impl/generated.xdc'), undefined);
        assert.equal(classifyProjectPath('src/notes.txt'), undefined);
        assert.equal(classifyProjectPath('constraints/top.vhd'), undefined);
    });

    it('groups files logically into Sources, Simulation and Constraints, marking TOP, testbench and the XDC in use', async (t) => {
        const root = await tempDir(t);
        await writeFiles(root, {
            ...DESIGN_FILES,
            'constraints/nexys-a7-100t.xdc': '',
            'constraints/old.xdc': '',
            'src/readme.txt': 'not VHDL',
            '.nexysvhdl/impl/generated.xdc': 'generated',
            '.nexysvhdl/synth/generated.v': 'generated',
        });
        const scanned = await scanProjectFiles(root);
        assert.deepEqual(scanned.constraints, ['constraints/nexys-a7-100t.xdc', 'constraints/old.xdc'], 'XDC discovery ignores .nexysvhdl');
        assert.ok(scanned.sources.includes('src/display/display_mux.vhd'));
        assert.ok(!scanned.sources.some((p) => p.endsWith('.txt')));
        const model = buildProjectFilesModel(
            scanned,
            { sources: [], simulation: { sources: [], testbench: 'top_tb' }, constraints: 'constraints/nexys-a7-100t.xdc' },
            new Set(['src/top.vhd']),
            new Set(['sim/top_tb.vhd']),
        );
        assert.equal(model.sources.find((f) => f.top)?.path, 'src/top.vhd');
        assert.equal(model.sources.find((f) => f.path === 'src/display/display_mux.vhd')?.folder, 'display/');
        assert.deepEqual(model.simulation.map((f) => [f.name, f.testbench ?? false]), [['top_tb.vhd', true]]);
        assert.deepEqual(model.constraints.map((f) => [f.name, f.inUse]), [['nexys-a7-100t.xdc', true], ['old.xdc', false]]);
        assert.equal(model.generatedConstraints, false);
    });

    it('shows a pins-based project as using generated constraints, and listed files outside src/', () => {
        const model = buildProjectFilesModel({ sources: ['src/a.vhd'], simulation: [], constraints: [] }, { sources: ['src/a.vhd', 'rtl/b.vhd', 'src/gone.vhd'], pins: { led: 'LED0' } });
        assert.equal(model.generatedConstraints, true);
        assert.deepEqual(model.sources.map((f) => [f.path, f.outside ?? false, f.missing ?? false]), [
            ['src/a.vhd', false, false],
            ['rtl/b.vhd', true, false],
            ['src/gone.vhd', false, true],
        ]);
    });
});

describe('source list sync (folder contract -> nexysvhdl.json)', () => {
    const parse = (files: Record<string, string>) =>
        new Map<string, IndexedFile>(Object.entries(files).map(([path, text]) => [path, { path, role: path.startsWith('sim/') ? 'simulation' : 'source', parsed: parseVhdl(text) }]));

    it('adds new src/ and sim/ files in dependency order and drops deleted ones', () => {
        const parsed = parse(DESIGN_FILES);
        const scanned = { sources: [...parsed.keys()].filter((p) => p.startsWith('src/')).sort(), simulation: ['sim/top_tb.vhd'], constraints: [] };
        const patch = computeSourceSync({ sources: ['src/top.vhd', 'src/deleted.vhd'] }, scanned, parsed)!;
        assert.ok(patch.sources);
        assert.ok(!patch.sources.includes('src/deleted.vhd'));
        assert.equal(patch.sources.length, scanned.sources.length);
        assert.ok(patch.sources.indexOf('src/counter.vhd') < patch.sources.indexOf('src/top.vhd'));
        assert.deepEqual(patch.simulation, { sources: ['sim/top_tb.vhd'] });
        // Valid order for GHDL: re-indexing in that order binds everything.
        assert.ok(new DesignIndex(patch.sources.map((p) => parsed.get(p)!)).entity('top'));
    });

    it('returns nothing when the project is already in sync, and keeps listed files outside src/', () => {
        const parsed = parse({ 'src/counter.vhd': DESIGN_FILES['src/counter.vhd']!, 'rtl/extra.vhd': 'entity extra is end;' });
        const scanned = { sources: ['src/counter.vhd'], simulation: [], constraints: [] };
        const config = { sources: ['rtl/extra.vhd', 'src/counter.vhd'], simulation: { sources: [], testbench: 'tb' } };
        assert.equal(computeSourceSync(config, scanned, parsed, new Set(['rtl/extra.vhd'])), undefined);
    });

    it('keeps the testbench setting when updating simulation sources', () => {
        const parsed = parse({ 'sim/a_tb.vhd': 'entity a_tb is end;', 'sim/b_tb.vhd': 'entity b_tb is end;' });
        const patch = computeSourceSync({ sources: [], simulation: { sources: ['sim/a_tb.vhd'], testbench: 'a_tb' } }, { sources: [], simulation: ['sim/a_tb.vhd', 'sim/b_tb.vhd'], constraints: [] }, parsed)!;
        assert.deepEqual(patch.simulation, { sources: ['sim/a_tb.vhd', 'sim/b_tb.vhd'], testbench: 'a_tb' });
    });
});
