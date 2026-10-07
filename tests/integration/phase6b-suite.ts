/**
 * Phase 6 refinements, validated inside a real VS Code (NOT part of `npm test`;
 * needs VS Code and the installed FPGA toolchain). Run with run-phase6.ts:
 *   NEXYS_P6_SUITE=phase6b NEXYSVHDL_P6_EXTENSIONS_DIR=<installed extensions> NEXYSVHDL_P6_HOST_DIR=<empty host> node run-phase6.js ...
 * Covers: Remove from Project, multi-file Add, clean New Project, one editor per file,
 * the resizable waveform signal list. Workspace: a copy of the mixed-case "DigitDisplay" project.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { NexysVhdlApi } from '../../extension/extension';
import { EXTENSION_ID, log, report, step, waitFor } from './edh-suite';

const shots = process.env['NEXYS_P6_SHOTS'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function shot(name: string): Promise<void> {
    if (!shots) return;
    await mkdir(shots, { recursive: true });
    await writeFile(join(shots, `${name}.shot`), new Date().toISOString());
    await waitFor(`screenshot ${name}`, () => existsSync(join(shots, `${name}.done`)), 30_000).catch(() => undefined);
}
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;

const entity = (name: string) => `library ieee;\nuse ieee.std_logic_1164.all;\n\nentity ${name} is\n    port (a : in std_logic; y : out std_logic);\nend entity ${name};\n\narchitecture rtl of ${name} is\nbegin\n    y <= not a;\nend architecture rtl;\n`;

export async function run(): Promise<void> {
    const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const ext = vscode.extensions.getExtension<NexysVhdlApi>(EXTENSION_ID)!;
    const out = process.env['NEXYS_EDH_REPORT']!;
    try {
        step('extensionPath', ext.extensionPath);
        const { service, waveform } = await ext.activate();
        await waitFor('project', () => service.snapshot?.project);
        const s = () => service.snapshot!;
        const cfg = () => readJson(join(root, 'nexysvhdl.json'));
        const run = (cmd: string, ...args: unknown[]) => vscode.commands.executeCommand(cmd, ...args) as Promise<any>;
        await run('workbench.action.closeAuxiliaryBar');
        await run('workbench.view.extension.nexysvhdl');
        await run('nexysvhdl.design.focus');
        await sleep(2500);

        // ---------------------------------------------------------------- 1. Remove from Project
        const decoder = 'src/seven_seg_decoder.vhd';
        const r1 = await run('nexysvhdl.removeFromProject', { path: decoder, confirm: true });
        step('remove.source', { result: r1, onDisk: existsSync(join(root, decoder)), sources: (await cfg())['sources'], exclude: (await cfg())['exclude'], inIndex: !!s().index.entity('seven_seg_decoder'), removedGroup: s().excluded });
        await sleep(600);
        await shot('20-removed-from-project');
        await run('nexysvhdl.restoreToProject', decoder);
        step('remove.restored', { sources: (await cfg())['sources'], inIndex: !!s().index.entity('seven_seg_decoder'), exclude: (await cfg())['exclude'] ?? null });

        const topFile = 'src/DigitDisplay.vhd';
        step('remove.topImpact', service.removalImpact(topFile));
        const r2 = await run('nexysvhdl.removeFromProject', { path: topFile, confirm: true });
        step('remove.top', { result: r2, top: (await cfg())['top'], validation: s().validation.map((d) => d.code), hierarchyRoot: s().hierarchy.root?.entityName ?? null, onDisk: existsSync(join(root, topFile)) });
        await sleep(600);
        await shot('21-removed-top-entity');
        await run('nexysvhdl.restoreToProject', topFile);
        await service.setTop('DigitDisplay');
        step('remove.topRestored', { top: (await cfg())['top'], root: s().hierarchy.root?.entityName });

        const tbFile = 'sim/DigitDisplay_tb.vhd';
        const r3 = await run('nexysvhdl.removeFromProject', { path: tbFile, confirm: true });
        step('remove.testbench', { result: r3, testbench: (await cfg())['simulation'].testbench ?? null });
        await run('nexysvhdl.restoreToProject', tbFile);
        await service.setTestbench('DigitDisplay_tb');

        const xdc = 'constraints/pins.xdc';
        await writeFile(join(root, 'constraints', 'other.xdc'), '## other\n');
        await service.refreshNow();
        const r4 = await run('nexysvhdl.removeFromProject', { path: xdc, confirm: true });
        step('remove.activeXdc', { result: r4, constraints: (await cfg())['constraints'] ?? null, validation: s().validation.map((d) => d.code), onDisk: existsSync(join(root, xdc)) });
        await run('nexysvhdl.restoreToProject', xdc);
        await service.useConstraints(xdc);
        await rm(join(root, 'constraints', 'other.xdc'));
        await service.refreshNow();
        step('remove.after', { top: (await cfg())['top'], testbench: (await cfg())['simulation'].testbench, constraints: (await cfg())['constraints'], validation: s().validation.map((d) => d.code) });

        // ---------------------------------------------------------------- 2. Multi-file Add
        const ext2 = join(root, '..', 'incoming');
        await mkdir(ext2, { recursive: true });
        for (const n of ['Adder', 'Subtractor', 'Comparator']) await writeFile(join(ext2, `${n}.vhd`), entity(n));
        await writeFile(join(ext2, 'bad.vhdl'), entity('Bad'));
        let projectEvents = 0;
        const sub = service.onDidChange((k) => k === 'project' && projectEvents++);
        const copied = await run('nexysvhdl.addFile', { kind: 'source', mode: 'copy', froms: ['Adder', 'Subtractor', 'Comparator'].map((n) => join(ext2, `${n}.vhd`)).concat([join(ext2, 'bad.vhdl')]), open: false });
        sub.dispose();
        const inIndex = ['Adder', 'Subtractor', 'Comparator', 'Bad'].map((n) => [n, !!s().index.entity(n)]);
        step('multiAdd.copy', { paths: copied?.paths, skipped: copied?.skipped, projectEvents, inIndexRightAfter: inIndex, sources: (await cfg())['sources'], noExternalPaths: !JSON.stringify(await cfg()).match(/[A-Za-z]:\\|\.\.\//), copiedPhysically: (await readdir(join(root, 'src'))).sort() });
        await sleep(600);
        await shot('22-multi-add');
        await writeFile(join(ext2, 'Adder.vhd'), entity('AdderNew'));
        const collide = await run('nexysvhdl.addFile', { kind: 'source', mode: 'copy', froms: [join(ext2, 'Adder.vhd'), join(ext2, 'Comparator.vhd')], collision: 'skip', open: false });
        step('multiAdd.collisionSkip', { paths: collide?.paths ?? null, skipped: collide?.skipped, adderUnchanged: !(await readFile(join(root, 'src', 'Adder.vhd'), 'utf8')).includes('AdderNew') });
        const replaced = await run('nexysvhdl.addFile', { kind: 'source', mode: 'copy', froms: [join(ext2, 'Adder.vhd')], collision: 'replace', open: false });
        step('multiAdd.collisionReplace', { replaced: replaced?.replaced, adderReplaced: (await readFile(join(root, 'src', 'Adder.vhd'), 'utf8')).includes('AdderNew') });
        const rename = await run('nexysvhdl.addFile', { kind: 'source', mode: 'copy', froms: [join(ext2, 'Subtractor.vhd')], collision: 'rename', open: false });
        step('multiAdd.collisionRename', { paths: rename?.paths });
        for (const n of ['a', 'b']) await writeFile(join(ext2, `${n}.xdc`), `## ${n}\n`);
        const xdcBatch = await run('nexysvhdl.addFile', { kind: 'constraints', mode: 'copy', froms: [join(ext2, 'a.xdc'), join(ext2, 'b.xdc')], activate: false, open: false });
        step('multiAdd.xdc', { paths: xdcBatch?.paths, active: (await cfg())['constraints'], files: s().files.constraints.map((f) => `${f.path}${f.inUse ? ' IN USE' : ''}`) });
        const tbBatch = await run('nexysvhdl.addFile', { kind: 'simulation', mode: 'copy', froms: [], open: false }).catch(() => 'none');
        step('multiAdd.emptySelection', tbBatch ?? 'cancelled');
        // clean up what the batch added
        for (const f of ['Adder', 'Subtractor', 'Subtractor_2', 'Comparator']) await rm(join(root, 'src', `${f}.vhd`), { force: true });
        for (const f of ['a.xdc', 'b.xdc']) await rm(join(root, 'constraints', f), { force: true });
        await service.refreshNow();

        // ---------------------------------------------------------------- 3. New Project is clean
        const parent = join(root, '..', 'new-projects');
        await mkdir(parent, { recursive: true });
        const a = await run('nexysvhdl.createProject', { parentDir: parent, name: 'ProjectA', template: 'starter' });
        await writeFile(join(a.root, 'src', 'OnlyInA.vhd'), entity('OnlyInA'));
        await service.open(a.root);
        const aState = { entities: [...s().index.entities.keys()].sort(), sources: s().files.sources.map((f) => f.path) };
        const b = await run('nexysvhdl.createProject', { parentDir: parent, name: 'ProjectB', template: 'empty' });
        await service.open(b.root);
        await sleep(500);
        await shot('23-new-project-clean');
        step('newProject.clean', {
            A: aState,
            B: { entities: [...s().index.entities.keys()], sources: s().files.sources.map((f) => f.path), sim: s().files.simulation.map((f) => f.path), hierarchyRoot: s().hierarchy.root?.entityName ?? null, srcOnDisk: await readdir(join(b.root, 'src')), simOnDisk: await readdir(join(b.root, 'sim')), json: (await readJson(join(b.root, 'nexysvhdl.json'))) },
            leaked: aState.entities.filter((e) => s().index.entities.has(e)),
        });
        const starter = await run('nexysvhdl.createProject', { parentDir: parent, name: 'ProjectC', template: 'starter' });
        step('newProject.starterOnlyItsOwnFiles', { src: await readdir(join(starter.root, 'src')), sim: await readdir(join(starter.root, 'sim')) });
        await service.open(root);
        await waitFor('original project back', () => s().project?.config.name !== 'ProjectB' && s().hierarchy.root);
        step('newProject.backToOriginal', { top: s().hierarchy.root?.entityName });

        // ---------------------------------------------------------------- 4. one editor per file
        const decoderUri = vscode.Uri.file(join(root, 'src', 'seven_seg_decoder.vhd'));
        const tabsOf = (uri: vscode.Uri) => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase()).length;
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(decoderUri), { viewColumn: vscode.ViewColumn.Two, preview: false });
        const before = tabsOf(decoderUri);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, 'src', 'display_mux.vhd'))), { viewColumn: vscode.ViewColumn.One, preview: false });
        for (let i = 0; i < 3; i++) await run('nexysvhdl.openLocation', root, 'src/seven_seg_decoder.vhd', 5 + i, 1);
        const active = vscode.window.activeTextEditor;
        step('editor.reuse', {
            tabsBefore: before,
            tabsAfterThreeClicks: tabsOf(decoderUri),
            activeFile: active?.document.uri.fsPath.endsWith('seven_seg_decoder.vhd'),
            activeColumn: active?.viewColumn,
            cursorLine: active ? active.selection.active.line + 1 : null,
            totalTextTabs: vscode.window.tabGroups.all.flatMap((g) => g.tabs).length,
        });
        // From the hierarchy: an entity node and the file in Files.
        await run('nexysvhdl.goToEntity', { payload: { entity: 'seven_seg_decoder', entityFile: 'src/seven_seg_decoder.vhd', entityLine: 3 } });
        await run('nexysvhdl.openProjectSettings');
        await run('nexysvhdl.openProjectSettings');
        step('editor.reuseOthers', { decoderTabs: tabsOf(decoderUri), settingsTabs: tabsOf(vscode.Uri.file(join(root, 'nexysvhdl.json'))) });

        // ---------------------------------------------------------------- 5. resizable waveform signal list
        await run('nexysvhdl.setSimulationStopTime', { value: '2us' });
        await run('nexysvhdl.simulate');
        await run('nexysvhdl.openWaveform');
        const loaded = await waitFor('waveform loaded', () => (waveform.lastWebviewState?.['loaded'] ? waveform.lastWebviewState : undefined), 25_000);
        const widthOf = () => waveform.lastWebviewState as Record<string, any>;
        const setPane = async (pane: string, width: number, expect: (st: Record<string, any>) => boolean) => {
            for (let i = 0; i < 30; i++) {
                waveform.postCommand({ action: 'paneWidth', pane, width });
                await sleep(200);
                if (expect(widthOf())) return widthOf();
            }
            return widthOf();
        };
        const initial = { tree: loaded['treeWidthPx'] as number, canvas: loaded['canvasWidthPx'] as number, layout: loaded['layout'] };
        const wide = await setPane('tree', 340, (st) => st['treeWidthPx'] === 340);
        const afterWide = { tree: wide['treeWidthPx'] as number, canvas: wide['canvasWidthPx'] as number };
        await shot('24-waveform-wide-signal-list');
        const huge = await setPane('tree', 5000, (st) => st['treeWidthPx'] <= 600 && st['treeWidthPx'] !== 340);
        const tiny = await setPane('tree', 3, (st) => st['treeWidthPx'] === 120);
        const back = await setPane('tree', 300, (st) => st['treeWidthPx'] === 300);
        step('waveform.splitter', { initial, afterWide, huge: { tree: huge['treeWidthPx'], canvas: huge['canvasWidthPx'] }, tiny: tiny['treeWidthPx'], canvasShrinksAsPaneGrows: afterWide.canvas < initial.canvas, layoutReported: back['layout'] });
        const stored = (waveform as unknown as { memory?: vscode.Memento }).memory?.get('nexysvhdl.waveform.layout');
        step('waveform.layoutRemembered', stored);
        await run('workbench.action.closeActiveEditor');
        await sleep(500);
        waveform.dispose();
        await run('nexysvhdl.openWaveform');
        const reopened = await waitFor('waveform reloaded', () => (waveform.lastWebviewState?.['loaded'] ? waveform.lastWebviewState : undefined), 25_000);
        step('waveform.layoutRestoredAfterReopen', { tree: reopened['treeWidthPx'], layout: reopened['layout'] });
        step('result', 'completed');
    } catch (err) {
        step('result', `FAILED: ${(err as Error).stack ?? String(err)}`);
        throw err;
    } finally {
        await writeFile(out, JSON.stringify({ report, log }, null, 2));
        await copyFile(out, `${out}.copy`).catch(() => undefined);
        if (shots) await writeFile(join(shots, 'finished'), '').catch(() => undefined);
    }
}
