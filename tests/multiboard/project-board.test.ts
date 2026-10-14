import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LEGACY_BOARD_ID, loadProject, resolveProjectBoard, validateProject } from '../../core';
import { addFileKindsFor, kindInfo, normalizeFileName, targetPath, validateFileName } from '../../extension/project/add-file';
import { createProject } from '../../extension/project/scaffold';
import { buildProjectFilesModel, classifyProjectPath, scanProjectFiles } from '../../extension/project/project-layout';
import { repoBoards, tempDir, writeFiles } from '../helpers';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const base = { name: 'p', top: 't', language: 'vhdl', standard: '2008', sources: [] as string[] };

describe('board selection and legacy projects', () => {
    it('uses an explicit board as is', async (t) => {
        const dir = await tempDir(t);
        const r = await resolveProjectBoard({ ...base, board: 'de10-lite' }, dir);
        assert.deepEqual(r, { ok: true, board: 'de10-lite', legacyDefault: false });
    });

    it('rejects a malformed board instead of guessing', async (t) => {
        const dir = await tempDir(t);
        for (const bad of [42, '', '  ', null, ['nexys-a7-100t'], { id: 'x' }]) {
            const r = await resolveProjectBoard({ ...base, board: bad, pins: {} }, dir);
            assert.ok(!r.ok, JSON.stringify(bad));
            assert.equal(!r.ok && r.diagnostics[0]?.code, 'PROJECT_BOARD_INVALID');
        }
    });

    it('reads an original NexysVHDL project without a board as the Nexys A7-100T (pin mapping or XDC file)', async (t) => {
        const dir = await tempDir(t);
        assert.deepEqual(await resolveProjectBoard({ ...base, pins: { clk: 'CLK100MHZ' } }, dir), { ok: true, board: LEGACY_BOARD_ID, legacyDefault: true });
        assert.deepEqual(await resolveProjectBoard({ ...base, constraints: 'constraints/n.xdc' }, dir), { ok: true, board: LEGACY_BOARD_ID, legacyDefault: true });
    });

    it('refuses to guess when the project is ambiguous', async (t) => {
        const empty = await tempDir(t);
        const none = await resolveProjectBoard({ ...base }, empty);
        assert.ok(!none.ok && none.diagnostics[0]?.code === 'PROJECT_BOARD_MISSING');
        const quartus = await tempDir(t);
        await writeFiles(quartus, { 'constraints/a.qsf': '', 'constraints/a.sdc': '' });
        const q = await resolveProjectBoard({ ...base, pins: {} }, quartus);
        assert.ok(!q.ok && q.diagnostics[0]?.code === 'PROJECT_BOARD_MISSING', 'Quartus files make a board-less project ambiguous');
        const other = await resolveProjectBoard({ ...base, constraints: 'constraints/a.qsf' }, empty);
        assert.ok(!other.ok, 'a non-XDC constraints entry is not evidence of a Nexys project');
    });

    it('applies the legacy default in memory only: the project file is byte-identical afterwards', async (t) => {
        const dir = await tempDir(t);
        const text = JSON.stringify({ ...base, pins: { clk: 'CLK100MHZ' } }, null, 4);
        await writeFile(join(dir, 'nexysvhdl.json'), text);
        const loaded = await loadProject(dir);
        assert.ok(loaded.ok);
        assert.equal(loaded.project.config.board, 'nexys-a7-100t');
        assert.equal(loaded.project.legacyBoardDefault, true);
        assert.equal(sha(await readFile(join(dir, 'nexysvhdl.json'), 'utf8')), sha(text), 'nothing was rewritten');
        assert.deepEqual((await readdir(dir)).sort(), ['nexysvhdl.json'], 'no backup or temp file was created');
    });

    it('does not flag a project that already names its board', async (t) => {
        const dir = await tempDir(t);
        await writeFile(join(dir, 'nexysvhdl.json'), JSON.stringify({ ...base, board: 'de10-lite' }));
        const loaded = await loadProject(dir);
        assert.ok(loaded.ok);
        assert.equal(loaded.project.legacyBoardDefault, undefined);
        assert.equal(loaded.project.config.board, 'de10-lite');
    });

    it('loadProject reports an ambiguous project as an error with a clear fix', async (t) => {
        const dir = await tempDir(t);
        await writeFile(join(dir, 'nexysvhdl.json'), JSON.stringify({ ...base }));
        const loaded = await loadProject(dir);
        assert.ok(!loaded.ok);
        assert.match(loaded.diagnostics[0]!.message, /"nexys-a7-100t" or "de10-lite"/);
    });
});

describe('DE10-Lite project validation (QSF + SDC)', () => {
    const qsf = (device: string) => `set_global_assignment -name FAMILY "MAX 10"\nset_global_assignment -name DEVICE ${device}\n`;
    const setup = async (t: import('node:test').TestContext, files: Record<string, string>, extra: object = {}) => {
        const dir = await tempDir(t);
        await writeFiles(dir, { 'src/top.vhd': 'entity top is end;', ...files });
        await writeFile(join(dir, 'nexysvhdl.json'), JSON.stringify({ ...base, top: 'top', board: 'de10-lite', sources: ['src/top.vhd'], ...extra }));
        const loaded = await loadProject(dir);
        assert.ok(loaded.ok);
        return validateProject(loaded.project, await repoBoards());
    };

    it('accepts a QSF for 10M50DAF484C7G plus an SDC, with no XDC and no pins', async (t) => {
        const v = await setup(t, { 'constraints/b.qsf': qsf('10M50DAF484C7G'), 'constraints/b.sdc': '# clk\n' });
        assert.deepEqual(v.diagnostics.filter((d) => d.severity === 'error'), []);
        assert.equal(v.valid, true);
    });

    it('reports a missing QSF and SDC', async (t) => {
        const v = await setup(t, {});
        assert.deepEqual(v.diagnostics.map((d) => d.code).sort(), ['PROJECT_NO_QSF', 'PROJECT_NO_SDC']);
        assert.equal(v.valid, false);
    });

    it('rejects a QSF for another device and a QSF with no device', async (t) => {
        const wrong = await setup(t, { 'constraints/b.qsf': qsf('10M08SAE144C8G'), 'constraints/b.sdc': '' });
        assert.ok(wrong.diagnostics.some((d) => d.code === 'PROJECT_QSF_WRONG_DEVICE' && /10M50DAF484C7G/.test(d.message)));
        const none = await setup(t, { 'constraints/b.qsf': '# nothing\n', 'constraints/b.sdc': '' });
        assert.ok(none.diagnostics.some((d) => d.code === 'PROJECT_QSF_NO_DEVICE'));
    });

    it('rejects Nexys-style settings and ignores stray XDC files (with a warning)', async (t) => {
        const pins = await setup(t, { 'constraints/b.qsf': qsf('10M50DAF484C7G'), 'constraints/b.sdc': '' }, { pins: { clk: 'MAX10_CLK1_50' } });
        assert.ok(pins.diagnostics.some((d) => d.code === 'PROJECT_PINS_UNSUPPORTED'));
        const xdcField = await setup(t, { 'constraints/b.qsf': qsf('10M50DAF484C7G'), 'constraints/b.sdc': '' }, { constraints: 'constraints/x.xdc' });
        assert.ok(xdcField.diagnostics.some((d) => d.code === 'PROJECT_CONSTRAINTS_WRONG_FORMAT'));
        const stray = await setup(t, { 'constraints/b.qsf': qsf('10M50DAF484C7G'), 'constraints/b.sdc': '', 'constraints/old.xdc': '' });
        assert.equal(stray.valid, true);
        assert.ok(stray.diagnostics.some((d) => d.code === 'PROJECT_XDC_IGNORED' && d.severity === 'warning'));
    });

    it('still validates a Nexys project exactly as before (XDC rules, no QSF rules)', async (t) => {
        const dir = await tempDir(t);
        await writeFiles(dir, { 'src/top.vhd': 'x', 'constraints/n.xdc': '# xdc\n' });
        await writeFile(join(dir, 'nexysvhdl.json'), JSON.stringify({ ...base, top: 'top', board: 'nexys-a7-100t', sources: ['src/top.vhd'], constraints: 'constraints/n.xdc' }));
        const loaded = await loadProject(dir);
        assert.ok(loaded.ok);
        const v = await validateProject(loaded.project, await repoBoards());
        assert.equal(v.valid, true);
        assert.ok(!v.diagnostics.some((d) => /QSF|SDC/.test(d.code)));
    });
});

describe('New Project: board-specific scaffolding', () => {
    it('Nexys A7: the original structure (XDC, no QSF/SDC)', async (t) => {
        const parent = await tempDir(t);
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        const r = await createProject({ parentDir: parent, name: 'NexysDemo', board, template: 'starter' });
        assert.ok(r.ok);
        assert.deepEqual([...r.files].sort(), ['.gitignore', 'NexysDemo.nvproj', 'constraints/nexys-a7-100t.xdc', 'nexysvhdl.json', 'sim/top_tb.vhd', 'src/top.vhd']);
        const cfg = JSON.parse(await readFile(join(r.root, 'nexysvhdl.json'), 'utf8'));
        assert.equal(cfg.board, 'nexys-a7-100t');
        assert.equal(cfg.constraints, 'constraints/nexys-a7-100t.xdc');
    });

    it('DE10-Lite starter: VHDL, QSF, SDC, exact device, no XDC, validates clean', async (t) => {
        const parent = await tempDir(t);
        const boards = await repoBoards();
        const board = boards.get('de10-lite')!;
        const r = await createProject({ parentDir: parent, name: 'De10Demo', board, template: 'starter' });
        assert.ok(r.ok);
        assert.deepEqual([...r.files].sort(), ['.gitignore', 'De10Demo.nvproj', 'constraints/de10-lite.qsf', 'constraints/de10-lite.sdc', 'nexysvhdl.json', 'sim/top_tb.vhd', 'src/top.vhd']);
        const cfg = JSON.parse(await readFile(join(r.root, 'nexysvhdl.json'), 'utf8'));
        assert.equal(cfg.board, 'de10-lite');
        assert.equal(cfg.constraints, undefined);
        assert.equal(cfg.pins, undefined);
        const qsf = await readFile(join(r.root, 'constraints', 'de10-lite.qsf'), 'utf8');
        assert.match(qsf, /set_global_assignment -name DEVICE 10M50DAF484C7G/);
        assert.match(qsf, /set_global_assignment -name FAMILY "MAX 10"/);
        assert.match(qsf, /^set_location_assignment PIN_P11 -to clk$/m, 'Terasic clock pin');
        assert.match(qsf, /^set_location_assignment PIN_A8 -to led0$/m, 'LEDR0');
        assert.match(qsf, /^set_location_assignment PIN_B8 -to key0$/m);
        assert.match(qsf, /^set_location_assignment PIN_C10 -to sw0$/m);
        assert.match(qsf, /^# set_location_assignment PIN_A9 -to ledr\[1\]$/m, 'other resources are commented out');
        const sdc = await readFile(join(r.root, 'constraints', 'de10-lite.sdc'), 'utf8');
        assert.match(sdc, /^create_clock -name clk -period 20\.000 \[get_ports \{ clk \}\]$/m);
        const top = await readFile(join(r.root, 'src', 'top.vhd'), 'utf8');
        for (const port of ['clk', 'key0', 'sw0', 'led0']) assert.match(top, new RegExp(`\\b${port}\\b`));
        const loaded = await loadProject(r.root);
        assert.ok(loaded.ok);
        const v = await validateProject(loaded.project, boards);
        assert.deepEqual(v.diagnostics.filter((d) => d.severity === 'error'), []);
    });

    it('DE10-Lite empty project: device active, pins commented, project valid except "no sources"', async (t) => {
        const parent = await tempDir(t);
        const boards = await repoBoards();
        const r = await createProject({ parentDir: parent, name: 'Blank', board: boards.get('de10-lite')!, template: 'empty' });
        assert.ok(r.ok);
        const qsf = await readFile(join(r.root, 'constraints', 'blank.qsf').replace('blank', 'de10-lite'), 'utf8');
        assert.match(qsf, /^set_global_assignment -name DEVICE 10M50DAF484C7G$/m);
        assert.doesNotMatch(qsf, /^set_location_assignment/m);
        const loaded = await loadProject(r.root);
        assert.ok(loaded.ok);
        const codes = (await validateProject(loaded.project, boards)).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
        assert.deepEqual(codes, ['PROJECT_MISSING_TOP', 'PROJECT_NO_SOURCES']);
    });

    it('never writes outside the new project folder', async (t) => {
        const parent = await tempDir(t);
        const boards = await repoBoards();
        await createProject({ parentDir: parent, name: 'Only', board: boards.get('de10-lite')!, template: 'starter' });
        assert.deepEqual(await readdir(parent), ['Only']);
    });
});

describe('board-aware file recognition and Add File', () => {
    it('Nexys lists .xdc only; DE10-Lite lists .qsf and .sdc only (top level of constraints/)', async (t) => {
        const dir = await tempDir(t);
        await writeFiles(dir, { 'constraints/a.xdc': '', 'constraints/b.qsf': '', 'constraints/b.sdc': '', 'constraints/deep/c.qsf': '', 'src/t.vhd': '' });
        assert.deepEqual((await scanProjectFiles(dir, 'xdc')).constraints, ['constraints/a.xdc']);
        assert.deepEqual((await scanProjectFiles(dir)).constraints, ['constraints/a.xdc'], 'default stays the original behaviour');
        assert.deepEqual((await scanProjectFiles(dir, 'qsf-sdc')).constraints, ['constraints/b.qsf', 'constraints/b.sdc']);
    });

    it('classifies constraint files by the board\'s format', () => {
        assert.equal(classifyProjectPath('constraints/a.xdc'), 'constraints');
        assert.equal(classifyProjectPath('constraints/a.qsf'), undefined, 'not a constraint of an XDC board');
        assert.equal(classifyProjectPath('constraints/a.qsf', 'qsf-sdc'), 'constraints');
        assert.equal(classifyProjectPath('constraints/a.sdc', 'qsf-sdc'), 'constraints');
        assert.equal(classifyProjectPath('constraints/a.xdc', 'qsf-sdc'), undefined);
        assert.equal(classifyProjectPath('constraints/sub/a.qsf', 'qsf-sdc'), undefined);
        assert.equal(classifyProjectPath('src/a.vhd', 'qsf-sdc'), 'source');
    });

    it('the Project Files model treats every Quartus constraint file as in use and names the right extensions', () => {
        const scanned = { sources: [], simulation: [], constraints: ['constraints/b.qsf', 'constraints/b.sdc'] };
        const q = buildProjectFilesModel(scanned, { sources: [] }, new Set(), new Set(), 'qsf-sdc');
        assert.deepEqual(q.constraints.map((c) => c.inUse), [true, true]);
        assert.equal(q.generatedConstraints, false);
        assert.equal(q.constraintExtensions, '.qsf and .sdc');
        const n = buildProjectFilesModel({ sources: [], simulation: [], constraints: ['constraints/a.xdc'] }, { sources: [], constraints: 'constraints/a.xdc' });
        assert.equal(n.constraintExtensions, '.xdc');
        assert.deepEqual(n.constraints.map((c) => c.inUse), [true]);
    });

    it('Add File offers only the constraint types of the active board', () => {
        const x = addFileKindsFor('xdc').map((k) => k.label);
        assert.deepEqual(x, ['Source', 'Simulation Testbench', 'Constraint']);
        assert.ok(!x.some((l) => /QSF|SDC/.test(l)));
        const q = addFileKindsFor('qsf-sdc').map((k) => k.label);
        assert.deepEqual(q, ['Source', 'Simulation Testbench', 'Constraint: Pins (QSF)', 'Constraint: Clock (SDC)']);
        assert.ok(!q.some((l) => /xdc/i.test(l)));
    });

    it('QSF and SDC files go to constraints/ and accept only their own extension', () => {
        assert.equal(targetPath('qsf', 'my_pins'), 'constraints/my_pins.qsf');
        assert.equal(targetPath('sdc', 'clk.SDC'), 'constraints/clk.sdc');
        assert.equal(kindInfo('qsf').extension, '.qsf');
        assert.equal(normalizeFileName('sdc', 'x'), 'x.sdc');
        assert.equal(validateFileName('qsf', 'pins'), undefined);
        assert.match(validateFileName('qsf', 'pins.xdc')!, /Only \.qsf files/);
        assert.match(validateFileName('sdc', 'clk.qsf')!, /Only \.sdc files/);
        assert.match(validateFileName('qsf', 'bad name')!, /English letters/);
    });
});

describe('QSF device detection ignores comments', () => {
    it('does not read a DEVICE phrase inside a # comment', async (t) => {
        const dir = await tempDir(t);
        await writeFiles(dir, {
            'src/top.vhd': 'x',
            'constraints/b.qsf': '# set_global_assignment -name DEVICE selects the FPGA\nset_global_assignment -name DEVICE 10M50DAF484C7G\n',
            'constraints/b.sdc': '',
        });
        await writeFile(join(dir, 'nexysvhdl.json'), JSON.stringify({ ...base, top: 'top', board: 'de10-lite', sources: ['src/top.vhd'] }));
        const loaded = await loadProject(dir);
        assert.ok(loaded.ok);
        assert.equal((await validateProject(loaded.project, await repoBoards())).valid, true);
        // a commented-out DEVICE line alone is "no device"
        await writeFiles(dir, { 'constraints/b.qsf': '# set_global_assignment -name DEVICE 10M50DAF484C7G\n' });
        const again = await loadProject(dir);
        assert.ok(again.ok);
        assert.ok((await validateProject(again.project, await repoBoards())).diagnostics.some((d) => d.code === 'PROJECT_QSF_NO_DEVICE'));
    });
});
