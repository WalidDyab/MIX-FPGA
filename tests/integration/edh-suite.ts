/**
 * Extension Development Host validation (NOT part of `npm test`): runs
 * inside a real VS Code with the extension loaded, against real tools.
 * Started by tests/integration/run-edh.ts through VS Code's
 * --extensionTestsPath entry point. Never programs a board.
 *
 *   NEXYS_EDH_PHASE=create   workspace = an empty parent folder; runs Create Project
 *   NEXYS_EDH_PHASE=project  workspace = a NexysVHDL project; runs the workflow
 *   NEXYS_EDH_REPORT=<file>  JSON report written here
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { NexysVhdlApi } from '../../extension/extension';
import type * as HierarchyModule from '../../extension/hierarchy/hierarchy';
import type * as SchematicModule from '../../extension/schematic/schematic-model';

/** The NexysVHDL extension id (publisher.name). */
export const EXTENSION_ID = 'emxplore.nexysvhdl';

/**
 * Helper modules are loaded from the extension under test (its own dist/),
 * never from this repository, so an installed-package run loads no repository
 * code into the extension host.
 */
export function extensionModules(extensionPath: string) {
    const load = <T>(...p: string[]) => require(join(extensionPath, 'dist', 'extension', ...p)) as T;
    return {
        flatten: load<typeof HierarchyModule>('hierarchy', 'hierarchy.js').flatten,
        buildSchematic: load<typeof SchematicModule>('schematic', 'schematic-model.js').buildSchematic,
    };
}

type Report = Record<string, unknown>;
export const report: Report = {};
export const log: string[] = [];
export const step = (name: string, value: unknown) => {
    report[name] = value;
    log.push(`${name}: ${JSON.stringify(value)}`);
};

export async function waitFor<T>(what: string, get: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
    const start = Date.now();
    for (;;) {
        const v = get();
        if (v) return v;
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 100));
    }
}

export async function tree(dir: string, prefix = ''): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
        const rel = `${prefix}${e.name}`;
        if (e.isDirectory()) {
            out.push(`${rel}/`);
            if (e.name !== '.nexysvhdl') out.push(...(await tree(join(dir, e.name), `${rel}/`)));
        } else out.push(rel);
    }
    return out.sort();
}

/** Re-sends a webview command until the reported state satisfies `done` (a page reload may drop one message). */
async function command<T>(what: string, send: () => void, done: () => T | undefined | false, timeoutMs = 15_000): Promise<T> {
    const start = Date.now();
    for (;;) {
        send();
        for (let i = 0; i < 10; i++) {
            const v = done();
            if (v) return v;
            await new Promise((r) => setTimeout(r, 100));
        }
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    }
}

/** Replaces UI prompts with scripted answers (window API functions are plain properties). */
export function stub<K extends keyof typeof vscode.window>(name: K, impl: unknown): void {
    (vscode.window as unknown as Record<string, unknown>)[name] = impl;
}

async function createPhase(): Promise<void> {
    const parent = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const before = await tree(parent);
    stub('showOpenDialog', async () => [vscode.Uri.file(parent)]);
    stub('showInputBox', async (o: vscode.InputBoxOptions) => {
        step('createProject.nameValidation', { 'my project': o.validateInput?.('my project') ?? null, EdhDemo: o.validateInput?.('EdhDemo') ?? null });
        return 'EdhDemo';
    });
    // Two pickers: the board, then the template. Taking the first item of each is "accept the defaults".
    let picks = 0;
    stub('showQuickPick', async (items: readonly vscode.QuickPickItem[]) => {
        step(picks++ % 2 === 0 ? 'createProject.boards' : 'createProject.templates', items.map((i) => i.label));
        return items[0];
    });
    stub('showInformationMessage', async (message: string) => {
        step('createProject.openPrompt', message);
        return undefined; // do not reload this window
    });
    const errors: string[] = [];
    stub('showErrorMessage', async (m: string) => {
        errors.push(m);
        return undefined;
    });
    await vscode.commands.executeCommand('nexysvhdl.createProject');
    const after = await tree(parent);
    step('createProject.added', after.filter((p) => !before.includes(p)));
    step('createProject.projectTree', await tree(join(parent, 'EdhDemo')));
    const created = JSON.parse(await readFile(join(parent, 'EdhDemo', 'nexysvhdl.json'), 'utf8')) as { top: string; sources: string[]; simulation?: { sources: string[] } };
    step('createProject.nexysvhdlJson', created);
    // A normal new project is the Empty project (the first, recommended template): empty src/ and sim/, no starter files.
    const templates = report['createProject.templates'] as string[];
    const projectTree = await tree(join(parent, 'EdhDemo'));
    step('createProject.emptyByDefault', {
        firstTemplateIsEmpty: /^\$\(file-directory\) Empty project \(recommended\)$/.test(templates[0] ?? ''),
        starterStillOffered: templates.some((t) => /Starter project/.test(t)),
        noSourceFiles: !projectTree.some((p) => /^(src|sim)\/.+/.test(p)),
        noTopOrLists: created.top === '' && created.sources.length === 0 && (created.simulation?.sources.length ?? 0) === 0,
    });
    // Second attempt with the same name must be refused without touching the folder.
    await vscode.commands.executeCommand('nexysvhdl.createProject');
    step('createProject.duplicateError', errors);
}

export async function projectPhase(): Promise<void> {
    const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const ext = vscode.extensions.getExtension<NexysVhdlApi>(EXTENSION_ID)!;
    const { flatten, buildSchematic } = extensionModules(ext.extensionPath);
    step('activatedOnOpen', ext.isActive);
    const { service, rtl, waveform } = await ext.activate();
    await waitFor('project', () => service.snapshot?.project);
    const s = () => service.snapshot!;
    const outline = () => (s().hierarchy.root ? flatten(s().hierarchy.root!).map((n) => (n.kind === 'instance' ? `${n.label} : ${n.entityName}` : n.entityName)) : []);
    step('detected', { name: s().project!.config.name, top: s().project!.config.top, board: s().boardName, validation: s().validation.map((d) => d.code) });
    step('projectFiles', { sources: s().files.sources.map((f) => `${f.path}${f.top ? ' TOP' : ''}`), simulation: s().files.simulation.map((f) => f.path), constraints: s().files.constraints.map((f) => `${f.path}${f.inUse ? ' IN USE' : ''}`) });
    step('hierarchy.initial', outline());

    // New VHDL file created on disk -> watcher -> Project Files.
    const counter = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity blink_counter is
    generic ( BITS : positive := 26 );
    port (
        clk   : in  std_logic;
        reset : in  std_logic;
        q     : out std_logic
    );
end entity blink_counter;

architecture rtl of blink_counter is
    signal count : unsigned(BITS downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if reset = '1' then
                count <= (others => '0');
            else
                count <= count + 1;
            end if;
        end if;
    end process;
    q <= count(BITS);
end architecture rtl;
`;
    await writeFile(join(root, 'src', 'blink_counter.vhd'), counter);
    await waitFor('new file in Project Files', () => s().files.sources.some((f) => f.path === 'src/blink_counter.vhd'));
    step('projectFiles.afterCreate', s().files.sources.map((f) => f.path));
    step('hierarchy.unreachableAfterCreate', s().hierarchy.unreachable.map((e) => e.decl.name));

    // Structural edit in the editor + save -> hierarchy.
    const topUri = vscode.Uri.file(join(root, 'src', 'top.vhd'));
    const doc = await vscode.workspace.openTextDocument(topUri);
    await vscode.window.showTextDocument(doc);
    const original = doc.getText();
    const structural = original
        .replace(/    signal count : unsigned\(BLINK_BITS downto 0\) := \(others => '0'\);\n/, '    signal blink : std_logic;\n')
        .replace(/    counter : process[\s\S]*?end process counter;\n/, '    u_blink : entity work.blink_counter\n        generic map (BITS => BLINK_BITS)\n        port map (clk => clk, reset => btnc, q => blink);\n')
        .replace('led0 <= count(BLINK_BITS) and sw0;', 'led0 <= blink and sw0;');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(topUri, new vscode.Range(doc.positionAt(0), doc.positionAt(original.length)), structural);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    await waitFor('u_blink in hierarchy', () => outline().includes('u_blink : blink_counter'));
    step('hierarchy.afterSave', outline());
    step('sources.afterSync', JSON.parse(await readFile(join(root, 'nexysvhdl.json'), 'utf8')).sources);

    // Manual refresh.
    await vscode.commands.executeCommand('nexysvhdl.refreshHierarchy');
    step('hierarchy.afterManualRefresh', outline());

    // Clicking a hierarchy node opens the instantiation.
    const blinkNode = flatten(s().hierarchy.root!).find((n) => n.label === 'u_blink')!;
    await vscode.commands.executeCommand('nexysvhdl.openLocation', root, blinkNode.location!.file, blinkNode.location!.line, blinkNode.location!.col);
    const ed = vscode.window.activeTextEditor!;
    step('hierarchy.clickOpens', { file: ed.document.uri.fsPath.endsWith('top.vhd'), line: ed.selection.active.line + 1, text: ed.document.lineAt(ed.selection.active.line).text.trim() });

    // Set Top Entity (context-menu path) updates nexysvhdl.json, then back.
    await vscode.commands.executeCommand('nexysvhdl.setTopEntityFromItem', { payload: { entity: 'blink_counter' } });
    step('setTop.json', JSON.parse(await readFile(join(root, 'nexysvhdl.json'), 'utf8')).top);
    step('setTop.hierarchyRoot', s().hierarchy.root?.entityName);
    await vscode.commands.executeCommand('nexysvhdl.setTopEntityFromItem', { payload: { entity: 'top' } });
    step('setTop.restored', JSON.parse(await readFile(join(root, 'nexysvhdl.json'), 'utf8')).top);

    // Check (real GHDL).
    await vscode.commands.executeCommand('nexysvhdl.check');
    step('check', { status: service.lastCheck?.status, state: service.workflow.check, elaborated: service.lastCheck?.elaborated });

    // Intentional syntax error -> save -> Problems (check on save) -> fix -> cleared.
    const broken = structural.replace('led0 <= blink and sw0;', 'led0 <= blink and sw0');
    const e2 = new vscode.WorkspaceEdit();
    e2.replace(topUri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), broken);
    await vscode.workspace.applyEdit(e2);
    await doc.save();
    const diags = await waitFor('diagnostics in Problems', () => {
        const d = vscode.languages.getDiagnostics(topUri);
        return d.length > 0 && d;
    }, 30_000);
    step('problems.afterError', diags.map((d) => ({ line: d.range.start.line + 1, col: d.range.start.character + 1, severity: vscode.DiagnosticSeverity[d.severity], message: d.message, source: d.source })));
    step('check.afterError', service.workflow.check);
    const e3 = new vscode.WorkspaceEdit();
    e3.replace(topUri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), structural);
    await vscode.workspace.applyEdit(e3);
    await doc.save();
    await waitFor('diagnostics cleared', () => vscode.languages.getDiagnostics(topUri).length === 0 && service.workflow.check.state === 'passed', 30_000);
    step('problems.afterFix', { count: vscode.languages.getDiagnostics(topUri).length, check: service.workflow.check });

    // Simulate (real GHDL).
    await waitFor('idle', () => service.busy === undefined);
    await vscode.commands.executeCommand('nexysvhdl.simulate');
    step('simulate', { state: service.workflow.simulate, passed: service.lastSimulation?.passed, messages: service.lastSimulation?.messages, stoppedAt: service.lastSimulation?.stoppedAt });

    // Build (real Apio/openXC7): record stage transitions as the UI sees them.
    const transitions: string[] = [];
    const sub = service.onDidChange((k) => {
        if (k !== 'workflow' || service.workflow.running !== 'build') return;
        const st = service.workflow.stages;
        const line = `${st.synthesis.state}/${st.implementation.state}/${st.bitstream.state}`;
        if (transitions[transitions.length - 1] !== line) transitions.push(line);
    });
    await vscode.commands.executeCommand('nexysvhdl.build');
    sub.dispose();
    const b = service.lastBuild!;
    step('build', {
        success: b.success,
        stagesLive: transitions,
        stagesFinal: service.workflow.stages,
        summary: service.workflow.build.summary,
        timing: b.timing,
        utilization: { luts: b.utilization?.luts, ff: b.utilization?.flipFlops, bram: b.utilization?.bram, dsp: b.utilization?.dsp },
        constraintsSource: b.constraintsSource,
        bitstream: b.bitstream?.path.replace(root, '<project>'),
        steps: b.steps.map((x) => `${x.step}=${x.status}`),
    });

    // Hardware view (real detection; read-only).
    await vscode.commands.executeCommand('nexysvhdl.detectBoards');
    step('hardware', { status: service.hardware.status, boards: service.hardware.boards.map((x) => ({ serial: x.serialNumber, product: x.productName })), diagnostics: service.hardware.diagnostics.map((d) => d.message) });

    // Design Schematic.
    await vscode.commands.executeCommand('nexysvhdl.openSchematic');
    const model = buildSchematic(s().index, s().hierarchy.root!)!;
    step('schematic', {
        entity: model.entityName,
        blocks: model.blocks.map((x) => `${x.label} : ${x.entityName}`),
        nets: model.nets.map((n) => `${n.name}: ${n.endpoints.map((e) => `${e.block ?? 'PORT'}.${e.port}`).join(' - ')}`),
        stubs: model.stubs.map((x) => `${x.block}.${x.port} = ${x.text}`),
        tab: await waitFor('schematic tab', () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label.startsWith('Schematic'))?.label, 10_000),
    });

    // RTL Schematic: the inferred hardware, including logic the Design Schematic omits.
    await waitFor('idle before RTL', () => service.busy === undefined);
    if (service.workflow.check.state !== 'passed') await vscode.commands.executeCommand('nexysvhdl.check');
    await vscode.commands.executeCommand('nexysvhdl.openRtlSchematic');
    const rtlState = await waitFor('RTL ready', () => (service.rtl.status === 'ready' ? service.rtl : undefined), 60_000);
    const rtlTop = rtlState.model.modules.get(rtlState.model.top)!;
    const nameOf = (id: string) => rtlTop.nodes.find((n) => n.id === id)!;
    const and = rtlTop.nodes.find((n) => n.rawType === '$and');
    const counterModule = [...rtlState.model.modules.values()].find((m) => m.displayName === 'blink_counter');
    await waitFor('RTL webview rendered', () => (rtl.lastWebviewState?.['nodes'] as number) > 0, 15_000);
    const before = rtl.lastWebviewState!;
    await command('RTL zoom', () => rtl.postCommand({ action: 'zoomIn' }), () => rtl.lastWebviewState!['scale'] !== before['scale']).catch((e: Error) => {
        throw new Error(`${e.message}; webview states: ${JSON.stringify(rtl.stateLog)}; tabs: ${vscode.window.tabGroups.all.map((g) => g.tabs.map((t) => `${t.label}${t.isActive ? '*' : ''}`).join(',')).join(' | ')}`);
    });
    const zoomed = rtl.lastWebviewState!['scale'];
    // Fit needs a laid-out canvas; an occluded test window may never give the webview a size.
    const laidOut = (rtl.lastWebviewState!['cw'] as number) > 0;
    if (laidOut) await command('RTL fit', () => rtl.postCommand({ action: 'fit' }), () => rtl.lastWebviewState!['scale'] !== zoomed);
    const fitResult = laidOut ? rtl.lastWebviewState!['scale'] : 'not run: webview canvas has no size in this (occluded) test window';
    await command('RTL select', () => rtl.postCommand({ action: 'select', id: and?.id }), () => rtl.lastWebviewState!['selected'] === and?.id);
    step('rtlSchematic', {
        tab: await waitFor('RTL tab', () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label.startsWith('RTL'))?.label, 10_000),
        topSummary: rtlTop.summary,
        andInputs: and ? rtlTop.edges.filter((e) => e.to.node === and.id).map((e) => `${nameOf(e.from.node).label}${e.label ? ` (${e.label})` : ''} -> ${e.to.pin}`) : 'no AND',
        andOutput: and ? rtlTop.edges.filter((e) => e.from.node === and.id).map((e) => nameOf(e.to.node).label) : [],
        andSource: and?.source,
        counter: counterModule ? { summary: counterModule.summary, nodes: counterModule.nodes.map((n) => `${n.label}${n.sublabel ? ` (${n.sublabel})` : ''}`) } : 'not found',
        artifacts: (await readdir(join(root, '.nexysvhdl', 'rtl'))).sort(),
        webview: { nodes: before['nodes'], edges: before['edges'], canvas: [rtl.lastWebviewState!['cw'], rtl.lastWebviewState!['ch']], initialScale: before['scale'], zoomedScale: zoomed, fitScale: fitResult, selected: rtl.lastWebviewState!['selected'] },
    });
    const designAfter = buildSchematic(s().index, s().hierarchy.root!)!;
    step('designSchematicLed0', { netsToLed0: designAfter.nets.filter((n) => n.endpoints.some((e) => e.block === undefined && e.port === 'led0')).map((n) => n.name), blinkNet: designAfter.nets.find((n) => n.name === 'blink')?.endpoints.map((e) => `${e.block ?? 'PORT'}.${e.port}`) });

    // Waveform viewer.
    await waitFor('idle before simulate', () => service.busy === undefined);
    await vscode.commands.executeCommand('nexysvhdl.simulate');
    await vscode.commands.executeCommand('nexysvhdl.openWaveform');
    const loaded = await waitFor('waveform loaded', () => (waveform.lastWebviewState?.['loaded'] ? waveform.lastWebviewState : undefined), 20_000);
    const firstIdentity = waveform.shown;
    const span = (st: Record<string, unknown>) => (st['t1'] as number) - (st['t0'] as number);
    const atCursor = await command('cursor', () => waveform.postCommand({ action: 'cursor', time: 95_000_000 }), () => (waveform.lastWebviewState!['cursor'] === 95_000_000 ? waveform.lastWebviewState : undefined));
    const zoomedIn = await command('wave zoom', () => waveform.postCommand({ action: 'zoomIn' }), () => (span(waveform.lastWebviewState!) < span(loaded) ? waveform.lastWebviewState : undefined));
    const panned = await command('wave pan', () => waveform.postCommand({ action: 'pan', fraction: 0.25 }), () => ((waveform.lastWebviewState!['t0'] as number) !== (zoomedIn['t0'] as number) ? waveform.lastWebviewState : undefined));
    const binary = await command('radix', () => waveform.postCommand({ action: 'radix', radix: 'bin' }), () => (waveform.lastWebviewState!['radix'] === 'bin' ? waveform.lastWebviewState : undefined));
    const fitted = await command('wave fit', () => waveform.postCommand({ action: 'fit' }), () => (span(waveform.lastWebviewState!) === span(loaded) ? waveform.lastWebviewState : undefined));
    // A second simulation replaces the waveform (new run, new artifact identity).
    await vscode.commands.executeCommand('nexysvhdl.simulate');
    await waitFor('waveform reloaded', () => waveform.shown && firstIdentity && waveform.shown.run > firstIdentity.run, 20_000);
    step('waveform', {
        tab: vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label.startsWith('Waveform'))?.label,
        identity: firstIdentity,
        visible: loaded['visible'],
        loadedView: [loaded['t0'], loaded['t1']],
        valuesAt95ns: atCursor['values'],
        zoomIn: [zoomedIn['t0'], zoomedIn['t1']],
        pan: [panned['t0'], panned['t1']],
        binaryCount: (binary['values'] as Record<string, string>)['top_tb.dut.u_blink.count[3:0]'],
        fit: [fitted['t0'], fitted['t1']],
        afterResimulation: waveform.shown,
        artifacts: (await readdir(join(root, '.nexysvhdl', 'sim'))).sort(),
    });

    // VHDL language support from NexysVHDL itself (private extensions folder: no other VHDL extension).
    const highlight: Record<string, unknown> = {};
    for (const f of ['src/top.vhd', 'src/blink_counter.vhd', 'sim/top_tb.vhd']) {
        const uri = vscode.Uri.file(join(root, ...f.split('/')));
        const d = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(d, { preview: false });
        const tokens = ((await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', uri)) ?? []) as Array<{ c: string; t: string }>;
        const pick = (word: string) => tokens.find((t) => t.c.trim().toLowerCase() === word)?.t ?? '(not found)';
        highlight[f] = {
            languageId: d.languageId,
            tokens: tokens.length,
            scoped: tokens.filter((t) => t.t !== 'source.vhdl').length,
            entity: pick('entity'), process: pick('process'), signal: pick('signal'), std_logic: pick('std_logic'), rising_edge: pick('rising_edge'),
            comment: tokens.find((t) => t.c.startsWith('--'))?.t ?? '(none)',
        };
    }
    step('syntaxHighlighting', { otherExtensions: vscode.extensions.all.filter((e) => !e.id.startsWith('vscode.') && e.id !== EXTENSION_ID && !e.extensionPath.includes('validation-harness')).map((e) => e.id), files: highlight });

    // Environment and generated files.
    const env = await service.refreshEnvironment();
    step('environment', { headline: env?.headline, items: env?.items.map((i) => `${i.label}: ${i.ok ? 'ok' : 'missing'}`) });
    step('projectRootAfterWorkflow', await tree(root));
}

/**
 * Shows each view in turn for screenshots: writes <report>.ready-<n> and waits
 * for <report>.next-<n> (created by whoever captures the window). Runs on a
 * project that the project phase already set up.
 */
async function showcasePhase(): Promise<void> {
    const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const out = process.env['NEXYS_EDH_REPORT']!;
    const { service, rtl, waveform } = await vscode.extensions.getExtension<NexysVhdlApi>(EXTENSION_ID)!.activate();
    await waitFor('project', () => service.snapshot?.project);
    const pause = async (n: number, what: string) => {
        step(`showcase.${n}`, what);
        await writeFile(`${out}.ready-${n}`, what);
        const { existsSync } = await import('node:fs');
        await waitFor(`capture ${n}`, () => existsSync(`${out}.next-${n}`), 120_000);
    };
    await vscode.commands.executeCommand('workbench.view.extension.nexysvhdl');
    for (const [n, f] of [[1, 'src/top.vhd'], [2, 'src/blink_counter.vhd'], [3, 'sim/top_tb.vhd']] as const) {
        await vscode.window.showTextDocument(vscode.Uri.file(join(root, ...f.split('/'))), { viewColumn: vscode.ViewColumn.One, preview: false });
        await new Promise((r) => setTimeout(r, 1500));
        await pause(n, `editor: ${f}`);
    }
    await vscode.commands.executeCommand('nexysvhdl.check');
    await vscode.commands.executeCommand('nexysvhdl.openSchematic');
    await new Promise((r) => setTimeout(r, 2000));
    await pause(4, 'Design Schematic');
    await vscode.commands.executeCommand('nexysvhdl.openRtlSchematic');
    await waitFor('RTL rendered', () => (rtl.lastWebviewState?.['nodes'] as number) > 0, 60_000);
    await new Promise((r) => setTimeout(r, 1500));
    await pause(5, 'RTL Schematic: top');
    const counter = service.rtl.status === 'ready' ? [...service.rtl.model.modules.keys()].find((m) => m.startsWith('blink_counter')) : undefined;
    if (counter) {
        // Same as clicking the ⤵ on u_blink.
        (rtl as unknown as { onMessage(m: unknown): void }).onMessage({ type: 'drill', module: counter });
        await new Promise((r) => setTimeout(r, 2000));
        await pause(6, 'RTL Schematic: blink_counter');
    }
    await vscode.commands.executeCommand('nexysvhdl.simulate');
    await vscode.commands.executeCommand('nexysvhdl.openWaveform');
    await waitFor('waveform loaded', () => waveform.lastWebviewState?.['loaded'], 20_000);
    await new Promise((r) => setTimeout(r, 1000));
    waveform.postCommand({ action: 'cursor', time: 95_000_000 });
    await new Promise((r) => setTimeout(r, 1000));
    await pause(7, 'Waveform (cursor at 95 ns)');
    waveform.postCommand({ action: 'zoomIn' });
    waveform.postCommand({ action: 'zoomIn' });
    await new Promise((r) => setTimeout(r, 1000));
    await pause(8, 'Waveform zoomed in');
}

export async function run(): Promise<void> {
    const phase = process.env['NEXYS_EDH_PHASE'];
    const out = process.env['NEXYS_EDH_REPORT']!;
    try {
        if (phase === 'create') await createPhase();
        else if (phase === 'showcase') await showcasePhase();
        else await projectPhase();
        report['result'] = 'completed';
    } catch (err) {
        report['result'] = `FAILED: ${(err as Error).stack ?? String(err)}`;
    }
    await writeFile(out, JSON.stringify({ report, log }, null, 2));
    if (String(report['result']).startsWith('FAILED')) throw new Error(String(report['result']));
}
