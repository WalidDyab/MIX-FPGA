import './install-vscode-fake';
import assert from 'node:assert/strict';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { findOpenTab } from '../../extension/commands/open-existing';
import { sourceSkeleton, testbenchSkeleton, writeNewFile } from '../../extension/project/add-file';
import { createProject, DEFAULT_TEMPLATE, PROJECT_TEMPLATES } from '../../extension/project/scaffold';
import { NexysError, NexysVhdlService } from '../../extension/services/nexys-service';
import { FilesView } from '../../extension/views/files-view';
import { HierarchyView } from '../../extension/views/hierarchy-view';
import { clampPaneWidth, DEFAULT_LAYOUT, NAMES_LIMITS, sanitizeLayout, TREE_LIMITS } from '../../extension/waveform/wave-render';
import { renderWaveHtml } from '../../extension/waveform/waveform-html';
import { REPO, repoBoards, tempDir } from '../helpers';
import { FakeBackend, OK, successfulBuild } from './fake-backend';
import type { Node } from '../../extension/views/base';

async function board() {
    return (await repoBoards()).get('nexys-a7-100t')!;
}
async function newProject(t: TestContext, name = 'Demo', template: 'starter' | 'empty' = 'starter', parent?: string) {
    const parentDir = parent ?? (await tempDir(t));
    const r = await createProject({ parentDir, name, board: await board(), template });
    assert.ok(r.ok);
    return { root: r.root, parentDir };
}
async function open(t: TestContext, root: string, service?: NexysVhdlService) {
    const s = service ?? new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 5 });
    if (!service) t.after(() => s.dispose());
    await s.open(root);
    return s;
}
const readConfig = async (root: string) => JSON.parse(await readFile(join(root, 'nexysvhdl.json'), 'utf8')) as Record<string, any>;
const exists = (p: string) => stat(p).then(() => true, () => false);
const tree = (view: { getChildren(n?: Node): Node[] }): string[] => view.getChildren().flatMap((n) => [String(n.label), ...view.getChildren(n).map((c) => `  ${String(c.label)}`)]);

describe('Remove from Project', () => {
    it('removes a source from the lists and the hierarchy but keeps it on disk, and it stays removed after refreshes', async (t) => {
        const { root } = await newProject(t);
        await writeNewFile(root, 'src/Alu.vhd', sourceSkeleton('Alu'));
        const service = await open(t, root);
        await service.fileAdded('source', 'src/Alu.vhd');
        assert.ok(service.snapshot!.index.entity('Alu'));
        const r = await service.removeFromProject('src/Alu.vhd');
        assert.deepEqual(r, { path: 'src/Alu.vhd', kind: 'source' });
        assert.equal(await exists(join(root, 'src', 'Alu.vhd')), true, 'the file is not deleted');
        const config = await readConfig(root);
        assert.ok(!config.sources.includes('src/Alu.vhd'));
        assert.deepEqual(config.exclude, ['src/Alu.vhd']);
        assert.equal(service.snapshot!.index.entity('Alu'), undefined, 'the hierarchy was recomputed');
        assert.ok(!service.snapshot!.files.sources.some((f) => f.path === 'src/Alu.vhd'));
        assert.deepEqual(service.snapshot!.excluded, ['src/Alu.vhd']);
        await service.refreshNow();
        await service.refreshNow();
        assert.ok(!(await readConfig(root)).sources.includes('src/Alu.vhd'), 'the folder contract does not add it back');
    });

    it('add back puts it in the project again', async (t) => {
        const { root } = await newProject(t);
        await writeNewFile(root, 'src/Alu.vhd', sourceSkeleton('Alu'));
        const service = await open(t, root);
        await service.removeFromProject('src/Alu.vhd');
        await service.restoreToProject('src/Alu.vhd');
        assert.ok((await readConfig(root)).sources.includes('src/Alu.vhd'));
        assert.equal((await readConfig(root)).exclude, undefined, 'the empty exclude list is dropped');
        assert.ok(service.snapshot!.index.entity('Alu'));
        // Adding the same file through Add File also brings it back.
        await service.removeFromProject('src/Alu.vhd');
        await service.filesAdded('source', ['src/Alu.vhd']);
        assert.ok(service.snapshot!.index.entity('Alu'));
    });

    it('the top entity: said explicitly, top is cleared (not left dangling), the problem is visible', async (t) => {
        const { root } = await newProject(t);
        const service = await open(t, root);
        assert.deepEqual(service.removalImpact('src/top.vhd'), { topEntity: 'top' });
        const r = await service.removeFromProject('src/top.vhd');
        assert.equal(r.topEntity, 'top');
        assert.equal((await readConfig(root)).top, '');
        assert.equal(service.snapshot!.hierarchy.root, undefined);
        assert.ok(service.snapshot!.validation.some((d) => d.code === 'PROJECT_MISSING_TOP'), 'validation reports it');
        assert.equal(await exists(join(root, 'src', 'top.vhd')), true);
        assert.equal(service.lastBuild, undefined);
        const hierarchy = tree(new HierarchyView(service));
        assert.ok(hierarchy.includes('No top entity is set'), hierarchy.join('|'));
    });

    it('the selected testbench: selection cleared, other simulation settings kept', async (t) => {
        const { root } = await newProject(t);
        const service = await open(t, root);
        await service.setStopTime('1us');
        const r = await service.removeFromProject('sim/top_tb.vhd');
        assert.equal(r.testbench, 'top_tb');
        const sim = (await readConfig(root)).simulation;
        assert.equal(sim.testbench, undefined);
        assert.equal(sim.stopTime, '1us');
        assert.deepEqual(sim.sources, []);
        assert.equal(await exists(join(root, 'sim', 'top_tb.vhd')), true);
    });

    it('the active XDC: no silent hidden reference; another XDC can be chosen explicitly', async (t) => {
        const { root } = await newProject(t);
        await writeFile(join(root, 'constraints', 'second.xdc'), '## second\n');
        const service = await open(t, root);
        const active = (await readConfig(root)).constraints as string;
        assert.deepEqual(service.removalImpact(active), { constraints: true });
        const r = await service.removeFromProject(active);
        assert.equal(r.constraints, true);
        assert.equal((await readConfig(root)).constraints, undefined);
        assert.ok(service.snapshot!.validation.some((d) => d.code === 'PROJECT_NO_PINS'));
        assert.deepEqual(service.snapshot!.files.constraints.map((f) => f.path), ['constraints/second.xdc'], 'the other XDC remains');
        await service.useConstraints('constraints/second.xdc');
        assert.equal((await readConfig(root)).constraints, 'constraints/second.xdc');
        assert.equal(await exists(join(root, active)), true);
    });

    it('removing an unrelated file clears nothing else', async (t) => {
        const { root } = await newProject(t);
        await writeNewFile(root, 'src/Alu.vhd', sourceSkeleton('Alu'));
        await writeNewFile(root, 'sim/alu_tb.vhd', testbenchSkeleton('alu_tb'));
        const service = await open(t, root);
        const before = await readConfig(root);
        assert.deepEqual(service.removalImpact('src/Alu.vhd'), {});
        await service.removeFromProject('sim/alu_tb.vhd');
        const after = await readConfig(root);
        assert.equal(after.top, before.top);
        assert.equal(after.constraints, before.constraints);
        assert.equal(after.simulation.testbench, before.simulation.testbench);
    });

    it('refuses things that are not project files', async (t) => {
        const { root } = await newProject(t);
        const service = await open(t, root);
        await assert.rejects(service.removeFromProject('nexysvhdl.json'), NexysError);
        await assert.rejects(service.removeFromProject('README.md'), NexysError);
        await assert.rejects(service.restoreToProject('src/x.txt'), NexysError);
    });

    it('the Files view lists removed files in their own group with an add-back context value', async (t) => {
        const { root } = await newProject(t);
        await writeNewFile(root, 'src/Alu.vhd', sourceSkeleton('Alu'));
        const service = await open(t, root);
        const view = new FilesView(service);
        t.after(() => view.dispose());
        assert.ok(!tree(view).includes('Removed from project'));
        await service.removeFromProject('src/Alu.vhd');
        const lines = tree(view);
        assert.ok(lines.includes('Removed from project'));
        assert.ok(lines.includes('  Alu.vhd'));
        const group = view.getChildren().find((n) => n.label === 'Removed from project')!;
        const file = view.getChildren(group)[0]!;
        assert.equal(file.contextValue, 'nexysvhdl.removed');
        assert.equal(file.payload, 'src/Alu.vhd');
        const sources = view.getChildren().find((n) => n.label === 'Sources')!;
        assert.ok(!view.getChildren(sources).some((n) => n.label === 'Alu.vhd'));
        assert.equal(view.getChildren(sources)[0]!.contextValue, 'nexysvhdl.source', 'files in the project keep the context that offers Remove');
    });

    it('is offered in the right-click menu of source, simulation and constraint files only', async () => {
        const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { contributes: { menus: Record<string, Array<{ command: string; when?: string }>>; commands: Array<{ command: string; title: string }> } };
        const item = pkg.contributes.menus['view/item/context']!;
        const remove = item.find((m) => m.command === 'nexysvhdl.removeFromProject')!;
        const re = new RegExp(/\/(.*)\/$/.exec(remove.when!)![1]!.replace(/\\\\/g, '\\'));
        for (const v of ['nexysvhdl.source', 'nexysvhdl.simulation', 'nexysvhdl.constraints']) assert.ok(re.test(v), v);
        for (const v of ['nexysvhdl.group', 'nexysvhdl.entity', 'nexysvhdl.removed']) assert.ok(!re.test(v), v);
        assert.equal(pkg.contributes.commands.find((c) => c.command === 'nexysvhdl.removeFromProject')!.title, 'Remove from Project');
        assert.ok(!pkg.contributes.commands.some((c) => /delete/i.test(c.title)), 'nothing here deletes files from disk');
        assert.ok(item.some((m) => m.command === 'nexysvhdl.restoreToProject' && m.when?.includes('nexysvhdl.removed')));
    });
});

describe('Multi-file Add: one update and one refresh for the whole batch', () => {
    it('lists every file once and recomputes the hierarchy once, after the batch', async (t) => {
        const { root } = await newProject(t);
        const service = await open(t, root);
        const names = ['Alu', 'Decoder', 'Mux4'];
        for (const n of names) await writeNewFile(root, `src/${n}.vhd`, sourceSkeleton(n));
        let projectEvents = 0;
        service.onDidChange((k) => k === 'project' && projectEvents++);
        const r = await service.filesAdded('source', names.map((n) => `src/${n}.vhd`));
        assert.deepEqual(r, {});
        assert.equal(projectEvents, 1, 'one refresh for three files');
        const config = await readConfig(root);
        for (const n of names) assert.ok(config.sources.includes(`src/${n}.vhd`), n);
        for (const n of names) assert.ok(service.snapshot!.index.entity(n), `${n} is in the hierarchy index`);
        assert.equal(new Set(config.sources).size, config.sources.length, 'no duplicates');
    });

    it('several testbenches: the first becomes the selected one only if none was selected', async (t) => {
        const { root } = await newProject(t);
        const service = await open(t, root);
        await writeNewFile(root, 'sim/a_tb.vhd', testbenchSkeleton('a_tb'));
        await writeNewFile(root, 'sim/b_tb.vhd', testbenchSkeleton('b_tb'));
        assert.deepEqual(await service.filesAdded('simulation', ['sim/a_tb.vhd', 'sim/b_tb.vhd']), {}, 'top_tb stays selected');
        const sim = (await readConfig(root)).simulation;
        assert.ok(sim.sources.includes('sim/a_tb.vhd') && sim.sources.includes('sim/b_tb.vhd'));
        assert.equal(sim.testbench, 'top_tb');
    });

    it('several XDC files: the active one never changes silently; all candidates are offered', async (t) => {
        const { root } = await newProject(t);
        const service = await open(t, root);
        const active = (await readConfig(root)).constraints;
        await writeFile(join(root, 'constraints', 'a.xdc'), '## a\n');
        await writeFile(join(root, 'constraints', 'b.xdc'), '## b\n');
        const r = await service.filesAdded('constraints', ['constraints/a.xdc', 'constraints/b.xdc']);
        assert.deepEqual(r, { constraints: 'ask', candidates: ['constraints/a.xdc', 'constraints/b.xdc'] });
        assert.equal((await readConfig(root)).constraints, active);
        assert.deepEqual(service.snapshot!.files.constraints.map((f) => f.path).sort(), [active, 'constraints/a.xdc', 'constraints/b.xdc'].sort());
    });

    it('a project without constraints and several new XDC files asks instead of picking one', async (t) => {
        const { root } = await newProject(t, 'Bare', 'empty');
        const service = await open(t, root);
        await service.removeFromProject('constraints/nexys-a7-100t.xdc');
        await writeFile(join(root, 'constraints', 'a.xdc'), '## a\n');
        await writeFile(join(root, 'constraints', 'b.xdc'), '## b\n');
        const r = await service.filesAdded('constraints', ['constraints/a.xdc', 'constraints/b.xdc']);
        assert.equal(r.constraints, 'ask');
        assert.equal((await readConfig(root)).constraints, undefined);
    });
});

describe('New projects are clean (pilot: new projects showed old files)', () => {
    it('an empty project has empty src/ and sim/, and the first source added becomes the top', async (t) => {
        const { root } = await newProject(t, 'Fresh', 'empty');
        assert.deepEqual(await readdir(join(root, 'src')), []);
        assert.deepEqual(await readdir(join(root, 'sim')), []);
        assert.deepEqual((await readdir(join(root, 'constraints'))).sort(), ['nexys-a7-100t.xdc']);
        const config = await readConfig(root);
        assert.deepEqual([config.sources, config.simulation.sources, config.top], [[], [], '']);
        const service = await open(t, root);
        assert.deepEqual(service.snapshot!.files.sources, []);
        assert.equal(service.snapshot!.hierarchy.root, undefined);
        await writeNewFile(root, 'src/DigitDisplay.vhd', sourceSkeleton('DigitDisplay'));
        assert.deepEqual(await service.fileAdded('source', 'src/DigitDisplay.vhd'), { top: 'DigitDisplay' });
        assert.equal((await readConfig(root)).top, 'DigitDisplay');
        assert.equal((service.snapshot!.hierarchy.root as { entityName: string } | undefined)?.entityName, 'DigitDisplay');
        assert.ok(!service.snapshot!.validation.some((d) => d.code === 'PROJECT_MISSING_TOP'));
    });

    it('the starter project is only the intentional starter files', async (t) => {
        const { root } = await newProject(t, 'Starter');
        assert.deepEqual(await readdir(join(root, 'src')), ['top.vhd']);
        assert.deepEqual(await readdir(join(root, 'sim')), ['top_tb.vhd']);
    });

    it('Project B contains nothing of Project A: files, hierarchy, results, cached state', async (t) => {
        const parent = await tempDir(t);
        const a = await newProject(t, 'ProjectA', 'starter', parent);
        for (const n of ['Alu', 'Decoder']) await writeNewFile(a.root, `src/${n}.vhd`, sourceSkeleton(n));
        await writeNewFile(a.root, 'sim/alu_tb.vhd', testbenchSkeleton('alu_tb'));
        const backend = new FakeBackend();
        const service = new NexysVhdlService({ backend, debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(a.root);
        await service.fileAdded('source', 'src/Alu.vhd');
        await service.fileAdded('source', 'src/Decoder.vhd');
        await service.setStopTime('2us');
        backend.checkResult = { ...OK, elaborated: ['top'] };
        await service.check();
        backend.buildResult = successfulBuild(join(a.root, 'hardware.bit'));
        await service.build();
        await service.simulate();
        await service.generateRtl();
        const revisionA = service.designRevision;
        assert.ok(service.snapshot!.index.entity('Alu'));
        assert.equal(service.lastBuild?.success, true);
        assert.equal(service.rtl.status, 'ready');
        assert.equal(service.simulationRun, 1);
        const aFiles = ['Alu', 'Decoder', 'top', 'alu_tb', 'top_tb'];

        // Project B, created next to A and opened in the very same service (as when a window switches project).
        const b = await newProject(t, 'ProjectB', 'empty', parent);
        await service.open(b.root);
        const snap = service.snapshot!;
        assert.equal(snap.project!.config.name, 'ProjectB');
        assert.deepEqual([snap.files.sources, snap.files.simulation], [[], []], 'Files view');
        assert.deepEqual(snap.scanned.sources.concat(snap.scanned.simulation), []);
        for (const name of aFiles) assert.equal(snap.index.entity(name), undefined, `hierarchy index has no ${name}`);
        assert.equal(snap.hierarchy.root, undefined);
        assert.deepEqual(snap.hierarchy.testbenches, []);
        assert.deepEqual(snap.hierarchy.unreachable, []);
        assert.deepEqual(snap.excluded, []);
        assert.equal(service.lastBuild, undefined);
        assert.equal(service.lastCheck, undefined);
        assert.equal(service.lastSimulation, undefined);
        assert.equal(service.simulationRun, 0);
        assert.equal(service.rtl.status, 'idle');
        assert.equal(service.workflow.build.state, 'idle');
        assert.ok(service.designRevision > revisionA, 'the design identity changed, so nothing cached for A matches B');
        const config = await readConfig(b.root);
        const text = JSON.stringify(config);
        for (const name of ['Alu', 'Decoder', 'alu_tb', 'top_tb', 'top.vhd', 'ProjectA', '2us']) assert.ok(!text.includes(name), `nexysvhdl.json of B does not mention ${name}`);
        assert.deepEqual(await readdir(join(b.root, 'src')), []);
        assert.deepEqual(await readdir(join(b.root, 'sim')), []);
        const views = [new FilesView(service), new HierarchyView(service)];
        for (const v of views) t.after(() => v.dispose());
        assert.deepEqual(tree(views[0]!).filter((l) => /\.vhd/.test(l) && !/No \.vhd files/.test(l)), [], 'no .vhd file in the Files view (only the empty-folder hints)');
        assert.ok(!tree(views[1]!).some((l) => ['Alu', 'Decoder', 'alu_tb', 'top_tb'].some((n) => l.includes(n))), 'no A entity in the Hierarchy view');
        // B's generated area holds only B's own (empty) workspace.
        assert.equal(await exists(join(b.root, '.nexysvhdl', 'sim', 'waveform.vcd')), false);
        // And A is untouched.
        assert.ok((await readConfig(a.root)).sources.includes('src/Alu.vhd'));
    });

    it('a second new project in the same folder never reuses or overwrites the first', async (t) => {
        const parent = await tempDir(t);
        const a = await newProject(t, 'Same', 'starter', parent);
        const again = await createProject({ parentDir: parent, name: 'Same', board: await board(), template: 'empty' });
        assert.equal(again.ok, false);
        assert.deepEqual(await readdir(join(a.root, 'src')), ['top.vhd']);
    });
});

describe('one editor per file', () => {
    it('finds the tab that already shows a file, whichever group, case and separator', () => {
        const tabs = [
            { fsPath: 'C:\\proj\\src\\Alu.vhd', viewColumn: 1 },
            { fsPath: undefined, viewColumn: 1 }, // a webview tab
            { fsPath: 'C:\\proj\\sim\\alu_tb.vhd', viewColumn: 2 },
        ];
        assert.equal(findOpenTab(tabs, 'c:/proj/src/alu.vhd')?.viewColumn, 1);
        assert.equal(findOpenTab(tabs, 'C:\\PROJ\\sim\\ALU_TB.VHD')?.viewColumn, 2);
        assert.equal(findOpenTab(tabs, 'C:\\proj\\src\\other.vhd'), undefined);
        assert.equal(findOpenTab([], 'C:\\x.vhd'), undefined);
        assert.equal(findOpenTab(tabs, 'C:\\proj\\src'), undefined, 'a folder is not a file');
    });

    it('every NexysVHDL command that shows a project file goes through the one helper', async () => {
        const text = await readFile(join(REPO, 'extension', 'commands', 'commands.ts'), 'utf8');
        const direct = [...text.matchAll(/vscode\.window\.showTextDocument\(/g)].length;
        assert.equal(direct, 1, 'only the helper itself calls showTextDocument');
        assert.match(text, /findOpenTab\(tabs, uri\.fsPath\)/);
        assert.match(text, /viewColumn: open\.viewColumn/);
        assert.match(text, /register\('nexysvhdl\.openLocation'[\s\S]*?await showFile\(/);
    });
});

describe('waveform: resizable signal list', () => {
    it('keeps widths inside their limits, leaves room for the waveform and survives bad input', () => {
        assert.equal(clampPaneWidth(300, TREE_LIMITS, 1200, 420, 210), 300);
        assert.equal(clampPaneWidth(5, TREE_LIMITS, 1200, 420, 210), TREE_LIMITS.min);
        assert.equal(clampPaneWidth(5000, TREE_LIMITS, 1200, 420, 210), TREE_LIMITS.max, 'the upper limit');
        assert.equal(clampPaneWidth(900, TREE_LIMITS, 800, 420, 210), 380, 'never so wide that fewer than 420 px remain for the rest');
        assert.equal(clampPaneWidth(900, TREE_LIMITS, 300, 420, 210), TREE_LIMITS.min, 'a tiny window still gets the minimum, not a negative width');
        assert.equal(clampPaneWidth('wide', TREE_LIMITS, 1200, 420, 210), 210);
        assert.equal(clampPaneWidth(Number.NaN, NAMES_LIMITS, 1200, 240, 380), 380);
        assert.equal(clampPaneWidth(250.6, TREE_LIMITS, 1200, 420, 210), 251);
    });

    it('a stored layout is validated: malformed values fall back, out-of-range ones are clamped', () => {
        assert.deepEqual(sanitizeLayout(undefined), DEFAULT_LAYOUT);
        assert.deepEqual(sanitizeLayout('x'), DEFAULT_LAYOUT);
        assert.deepEqual(sanitizeLayout({ treeWidth: 300, namesWidth: 450 }), { treeWidth: 300, namesWidth: 450 });
        assert.deepEqual(sanitizeLayout({ treeWidth: 1, namesWidth: 99999 }), { treeWidth: TREE_LIMITS.min, namesWidth: NAMES_LIMITS.max });
        assert.deepEqual(sanitizeLayout({ treeWidth: '300', namesWidth: null }), DEFAULT_LAYOUT);
    });

    it('the page has two draggable splitters wired for mouse and keyboard, a live redraw, persistence, and keeps its panes flexible', () => {
        const html = renderWaveHtml({ nonce: 'n', cspSource: 'vscode-resource:', rendererUri: 'r.js' });
        assert.match(html, /id="split-tree" class="splitter" role="separator" aria-orientation="vertical" tabindex="0"/);
        assert.match(html, /id="split-names" class="splitter"/);
        assert.match(html, /cursor: col-resize/);
        assert.match(html, /#tree \{ width: var\(--tree-w, 210px\)/, 'the fixed width became a variable');
        assert.match(html, /#names \{ width: var\(--names-w, 380px\)/);
        assert.doesNotMatch(html, /#tree \{ width: 210px/);
        assert.match(html, /el\.addEventListener\('mousedown'/);
        assert.match(html, /window\.addEventListener\('mousemove', move\)/, 'live while dragging');
        assert.match(html, /requestAnimationFrame\(function \(\) \{ frame = 0; if \(data\) draw\(\)/, 'the waveform canvas is redrawn at the new width');
        assert.match(html, /type: 'layout', layout: layout/, 'the width is reported for storage');
        assert.match(html, /m\.layout\) \{ layout = W\.sanitizeLayout\(m\.layout\)/, 'and restored on load');
        assert.match(html, /e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'/);
        assert.match(html, /addEventListener\('dblclick'/);
        assert.match(html, /#cvwrap \{ flex: 1; min-width: 0/, 'the waveform area still takes the remaining width');
        assert.match(html, /window\.addEventListener\('resize', relayout\)/);
        assert.match(html, /#tree, #split-tree \{ display: none; \}/, 'hidden together on a narrow panel');
    });
});

describe('New Project defaults to an empty project', () => {
    it('Empty is the first, recommended and default choice; Starter stays available as an explicit option', async () => {
        assert.equal(DEFAULT_TEMPLATE, 'empty');
        assert.deepEqual(PROJECT_TEMPLATES.map((t) => [t.template, t.recommended]), [['empty', true], ['starter', false]]);
        assert.match(PROJECT_TEMPLATES[0]!.label, /Empty project \(recommended\)/);
        assert.match(PROJECT_TEMPLATES[1]!.label, /Starter project/);
        const commands = await readFile(join(REPO, 'extension', 'commands', 'commands.ts'), 'utf8');
        assert.match(commands, /scripted\?\.template \?\? DEFAULT_TEMPLATE/, 'a scripted create without a template is an empty project');
        assert.match(commands, /PROJECT_TEMPLATES\.map\(/, 'the dialog lists the templates in that order, so the first (empty) item is the default selection');
        assert.doesNotMatch(commands, /template: 'starter' as const/, 'no hand-written list that could put the starter first');
    });

    it('a project created with the default template has empty src/ and sim/; the starter is only created when asked for', async (t) => {
        const parent = await tempDir(t);
        const normal = await createProject({ parentDir: parent, name: 'Normal', board: await board(), template: DEFAULT_TEMPLATE });
        const starter = await createProject({ parentDir: parent, name: 'WithStarter', board: await board(), template: 'starter' });
        assert.ok(normal.ok && starter.ok);
        assert.deepEqual(await readdir(join(normal.root, 'src')), []);
        assert.deepEqual(await readdir(join(normal.root, 'sim')), []);
        assert.deepEqual(await readdir(join(starter.root, 'src')), ['top.vhd']);
    });
});

describe('top entity when a project has none', () => {
    const two = (a: string, b: string) => `${entityText(a)}\n${entityText(b)}`;
    function entityText(name: string) {
        return `library ieee;\nuse ieee.std_logic_1164.all;\nentity ${name} is\n    port (a : in std_logic; y : out std_logic);\nend entity;\narchitecture rtl of ${name} is begin y <= not a; end architecture;\n`;
    }
    const warning = (s: NexysVhdlService) => tree(new HierarchyView(s)).includes('No top entity is set');

    it('exactly one entity added: it becomes the top', async (t) => {
        const { root } = await newProject(t, 'One', 'empty');
        const service = await open(t, root);
        await writeFile(join(root, 'src', 'Alu.vhd'), entityText('Alu'));
        const r = await service.filesAdded('source', ['src/Alu.vhd']);
        assert.deepEqual(r, { top: 'Alu' });
        assert.equal((await readConfig(root)).top, 'Alu');
        assert.equal(warning(service), false);
    });

    it('several source files at once: no arbitrary top; the candidates are returned and the warning stays', async (t) => {
        const { root } = await newProject(t, 'Many', 'empty');
        const service = await open(t, root);
        for (const n of ['Adder', 'Decoder', 'Mux']) await writeFile(join(root, 'src', `${n}.vhd`), entityText(n));
        const r = await service.filesAdded('source', ['src/Adder.vhd', 'src/Decoder.vhd', 'src/Mux.vhd']);
        assert.deepEqual(r, { topCandidates: ['Adder', 'Decoder', 'Mux'] });
        assert.equal((await readConfig(root)).top, '', 'the first file was not made top');
        assert.ok(service.snapshot!.validation.some((d) => d.code === 'PROJECT_MISSING_TOP'));
        assert.equal(warning(service), true, 'the existing "No top entity is set" warning is shown');
        assert.equal(service.snapshot!.hierarchy.root, undefined);
    });

    it('one file with several entities is also ambiguous', async (t) => {
        const { root } = await newProject(t, 'Pack', 'empty');
        const service = await open(t, root);
        await writeFile(join(root, 'src', 'Pack.vhd'), two('First', 'Second'));
        const r = await service.filesAdded('source', ['src/Pack.vhd']);
        assert.deepEqual(r, { topCandidates: ['First', 'Second'] });
        assert.equal((await readConfig(root)).top, '');
    });

    it('the student can then choose one (entity names match case-insensitively, the declared spelling is stored)', async (t) => {
        const { root } = await newProject(t, 'Choose', 'empty');
        const service = await open(t, root);
        for (const n of ['DigitDisplay', 'Decoder']) await writeFile(join(root, 'src', `${n}.vhd`), entityText(n));
        await service.filesAdded('source', ['src/DigitDisplay.vhd', 'src/Decoder.vhd']);
        await service.setTop('digitdisplay');
        assert.equal((await readConfig(root)).top, 'DigitDisplay');
        assert.equal((service.snapshot!.hierarchy.root as { entityName: string } | undefined)?.entityName, 'DigitDisplay');
        assert.equal(warning(service), false);
        assert.ok(service.snapshot!.validation.every((d) => d.code !== 'PROJECT_MISSING_TOP'));
    });

    it('the same entity spelled with different case in two files is one candidate, not two', async (t) => {
        const { root } = await newProject(t, 'Case', 'empty');
        const service = await open(t, root);
        await writeFile(join(root, 'src', 'a.vhd'), entityText('Alu'));
        await writeFile(join(root, 'src', 'b.vhd'), entityText('ALU'));
        const r = await service.filesAdded('source', ['src/a.vhd', 'src/b.vhd']);
        assert.deepEqual(r, { top: 'Alu' });
    });

    it('a project that already has a top never has it changed by adding sources', async (t) => {
        const { root } = await newProject(t, 'Has');
        const service = await open(t, root);
        await writeFile(join(root, 'src', 'Extra1.vhd'), entityText('Extra1'));
        await writeFile(join(root, 'src', 'Extra2.vhd'), entityText('Extra2'));
        assert.deepEqual(await service.filesAdded('source', ['src/Extra1.vhd', 'src/Extra2.vhd']), {});
        assert.equal((await readConfig(root)).top, 'top');
    });

    it('the Add File command asks for the top when there are several candidates, or leaves it unset', async () => {
        const text = await readFile(join(REPO, 'extension', 'commands', 'commands.ts'), 'utf8');
        assert.match(text, /outcome\.topCandidates/);
        assert.match(text, /Which one is the top\?/);
        assert.match(text, /Leave unset for now/);
        assert.match(text, /script\.top!\.toLowerCase\(\)/, 'a scripted answer is matched case-insensitively');
    });
});
