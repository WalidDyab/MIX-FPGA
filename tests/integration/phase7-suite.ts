/**
 * Phase 7 validation inside a real VS Code (NOT part of `npm test`; needs VS Code and the installed FPGA toolchain).
 * Run with run-phase6.ts (NEXYS_P6_SUITE=phase7), against the PACKAGED extension installed in a private extensions folder:
 *
 *   NEXYS_P7_STAGE=a   first session: change every NexysVHDL-managed setting, then CLOSE THE WINDOW NORMALLY (no explicit save).
 *   NEXYS_P7_STAGE=e   Empty project: clean Problems at the start, validation begins once sources exist.
 *   NEXYS_P7_STAGE=n   New Project (.nvproj), Open Project, legacy project; s = Design Schematic readability; c = NexysVHDL Console with the real tools.
 *   NEXYS_P7_STAGE=b   second session on the same project and user data: everything must be restored; then workflow/console/schematic
 *                      checks, and a window RELOAD whose result is verified after the extension host restarts.
 *
 * Workspace: a copy of the multi-file mixed-case "DigitDisplay" project. NEXYS_P7_SCRATCH is a folder for markers.
 * The suite turns on the panels' testHooks and stretches ProjectState.debounceMs through the extension's API object, so the ONLY way a
 * change reaches disk before exit is the flush. None of that exists in a normal session.
 */
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { NexysVhdlApi } from '../../extension/extension';
import { EXTENSION_ID, log, report, step, waitFor } from './edh-suite';

const shots = process.env['NEXYS_P7_SHOTS'];
const stage = process.env['NEXYS_P7_STAGE'] ?? 'b';
const scratch = process.env['NEXYS_P7_SCRATCH']!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function shot(name: string): Promise<void> {
    if (!shots) return;
    await mkdir(shots, { recursive: true });
    await rm(join(shots, `${name}.done`), { force: true });
    await writeFile(join(shots, `${name}.shot`), new Date().toISOString());
    await waitFor(`screenshot ${name}`, () => existsSync(join(shots, `${name}.done`)), 30_000).catch(() => undefined);
}
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;

const ALT_TB = `library ieee;
use ieee.std_logic_1164.all;

entity Alt_tb is
end entity Alt_tb;

architecture sim of Alt_tb is
    signal clk : std_logic := '0';
    signal tick : std_logic;
begin
    clk <= not clk after 5 ns;
    dut : entity work.clock_divider generic map (BITS => 3) port map (clk => clk, tick => tick);
    stimulus : process
    begin
        wait for 1 us;
        report "Alt_tb reached 1 us";
        wait;
    end process stimulus;
end architecture sim;
`;
const BROKEN = `library ieee;
use ieee.std_logic_1164.all;
entity broken is
    port (a : in std_logic; y : out std_logic);
end entity broken;
architecture rtl of broken is
begin
    y <= not missing_signal;
end architecture rtl;
`;

export async function run(): Promise<void> {
    const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const ext = vscode.extensions.getExtension<NexysVhdlApi>(EXTENSION_ID)!;
    const out = process.env['NEXYS_EDH_REPORT']!;
    const exec = (cmd: string, ...args: unknown[]) => vscode.commands.executeCommand(cmd, ...args) as Promise<any>;
    const reloadMarker = join(scratch, 'reload-marker.json');
    let closing = false;
    try {
        step('extensionPath', ext.extensionPath);
        step('extensionVersion', (ext.packageJSON as { version: string }).version);
        const { service, waveform, schematic, state } = await ext.activate();
        // Validation-only switches, through the API object (never a setting or environment variable of the packaged extension).
        state.debounceMs = 600_000;
        schematic.testHooks = true;
        waveform.testHooks = true;
        await waitFor('project', () => service.snapshot?.project);
        const cfg = () => readJson(join(root, 'nexysvhdl.json'));
        const idle = () => waitFor('idle', () => service.busyAction === undefined, 240_000);
        const wst = () => (waveform.lastWebviewState ?? {}) as Record<string, any>;
        await exec('workbench.action.closeAuxiliaryBar');
        await exec('workbench.view.extension.nexysvhdl');
        await sleep(1500);

        // ------------------------------------------------------------------ reload leg (after "workbench.action.reloadWindow")
        if (existsSync(reloadMarker)) {
            const expected = await readJson(reloadMarker);
            await rm(reloadMarker);
            const modeNow = (await readJson(join(root, '.nexysvhdl', 'state.json'))).values['nexysvhdl.design.mode'];
            step('reload.restored', { stateFileDesignMode: modeNow, expected: expected['designMode'], stateDesignMode: state.get('nexysvhdl.design.mode') });
            step('reload.top', (await cfg()).top);
            step('result', modeNow === expected['designMode'] && (await cfg()).top === expected['top'] ? 'reload-ok' : 'RELOAD-MISMATCH');
            return;
        }

        if (stage === 'a') {
            // ---- 1. A project with a second testbench, a second XDC and a spare source to remove from the project
            await writeFile(join(root, 'sim', 'Alt_tb.vhd'), ALT_TB);
            await writeFile(join(root, 'constraints', 'alt.xdc'), '# alternative constraints\n');
            await writeFile(join(root, 'src', 'spare.vhd'), 'entity spare is end entity spare;\narchitecture r of spare is begin end architecture r;\n');
            await service.refreshNow();

            // ---- 2. Change everything NexysVHDL manages
            await service.setTop('clock_divider');
            await service.setTestbench('Alt_tb');
            await service.useConstraints('constraints/alt.xdc');
            await exec('nexysvhdl.setSimulationStopTime', { value: '7us' });
            await exec('nexysvhdl.removeFromProject', { path: 'src/spare.vhd', confirm: true });
            await exec('nexysvhdl.design.showHierarchy');
            await sleep(500);

            // Simulate Alt_tb (real GHDL) so the waveform viewer exists; then Display As, pane widths and signal choices.
            await exec('nexysvhdl.runSimulation', { duration: '7us' });
            await idle();
            await waitFor('waveform loaded', () => (wst()['loaded'] ? wst() : undefined), 40_000);
            const all: string[] = wst()['visible'];
            const chosen = all.slice(0, 2);
            waveform.postCommand({ action: 'radix', radix: 'bin' });
            waveform.postCommand({ action: 'signalRadix', path: chosen[0], radix: 'udec' });
            waveform.postCommand({ action: 'paneWidth', pane: 'tree', width: 333 });
            waveform.postCommand({ action: 'paneWidth', pane: 'names', width: 444 });
            waveform.postCommand({ action: 'showSignals', paths: chosen });
            await waitFor('waveform choices applied', () => wst()['radix'] === 'bin' && wst()['layout']?.treeWidth === 333 && wst()['visible']?.length === chosen.length, 15_000);
            const waveChoices = { radix: wst()['radix'], layout: wst()['layout'], visible: wst()['visible'], signalRadix: wst()['radixes']?.[chosen[0]!] };
            step('a.waveform', waveChoices);

            // Design Schematic: Fit Width, scrolled, notes opened.
            schematic.show();
            await sleep(1200);
            schematic.postCommand({ action: 'width' });
            await sleep(500);
            schematic.postCommand({ action: 'scroll', x: 0, y: 0 });
            await waitFor('schematic view reported', () => schematic.lastView?.mode === 'width', 15_000);
            const schView = { mode: schematic.lastView!.mode, scale: schematic.lastView!.scale };
            step('a.schematic', schView);

            const expected = {
                top: 'clock_divider', testbench: 'Alt_tb', constraints: 'constraints/alt.xdc', stopTime: '7us', excluded: ['src/spare.vhd'], designMode: 'hierarchy',
                waveform: waveChoices, schematic: schView,
            };
            await writeFile(join(scratch, 'expected.json'), JSON.stringify(expected, null, 2));
            step('a.expected', expected);

            // ---- 3. Close the window normally, immediately: the stretched debounce means the UI state is still PENDING.
            const stateFile = join(root, '.nexysvhdl', 'state.json');
            const onDiskBefore = existsSync(stateFile) ? (await readJson(stateFile)).values : {};
            step('a.beforeClose', {
                pending: state.pending,
                keysOnDisk: Object.keys(onDiskBefore),
                designModeOnDisk: onDiskBefore['nexysvhdl.design.mode'] ?? null,
                waveformSignalsOnDisk: onDiskBefore['nexysvhdl.waveform.signals'] ?? null,
            });
            step('result', 'stage-a-closing');
            closing = true;
            await writeFile(out, JSON.stringify({ report, log }, null, 2));
            void exec('workbench.action.closeWindow');
            await new Promise(() => undefined); // the window closing ends this process
            return;
        }


        // ================================================================== stage e: an Empty project is a valid starting state
        if (stage === 'e') {
            const problems = () =>
                vscode.languages.getDiagnostics().flatMap(([uri, ds]) => ds.map((d) => ({ file: uri.fsPath.split(/[\\/]/).pop(), severity: d.severity, message: d.message })));
            await exec('workbench.view.extension.nexysvhdl');
            await exec('workbench.actions.view.problems');
            await sleep(2500);
            step('e.fresh', { emptyProject: service.snapshot?.emptyProject ?? false, top: service.project?.config.top, sources: service.project?.config.sources, problems: problems() });
            await shot('90-empty-project-clean');

            // Build and Simulate still refuse: the core validates for itself.
            await exec('nexysvhdl.build');
            await idle();
            step('e.buildRefused', { buildState: service.workflow.build.state, buildSummary: service.workflow.build.summary });

            // Add two entities, no top chosen: normal validation begins.
            await writeFile(join(root, 'src', 'a.vhd'), 'entity a is end entity a;\narchitecture r of a is begin end architecture r;\n');
            await writeFile(join(root, 'src', 'b.vhd'), 'entity b is end entity b;\narchitecture r of b is begin end architecture r;\n');
            await service.refreshNow();
            await sleep(2000);
            step('e.afterSources', { emptyProject: service.snapshot?.emptyProject ?? false, problems: problems() });
            await shot('91-sources-added-validation-begins');
            step('result', 'stage-e-complete');
            return;
        }

        // ================================================================== stage v: Toolchain 1.0 is untouched
        if (stage === 'v') {
            // Re-hashes every installed toolchain file against the validated content (slow: thousands of files).
            const verified = (await exec('nexysvhdl.verifyToolchain')) as { ok: boolean; files?: number };
            step('v.toolchainVerified', { ok: verified?.ok, files: verified?.files });
            step('result', verified?.ok ? 'stage-v-complete' : 'TOOLCHAIN-VERIFY-FAILED');
            return;
        }

        // ================================================================== stage n: New Project, .nvproj, Open Project, legacy project
        if (stage === 'n') {
            const parent = join(scratch, 'My Courses');
            await mkdir(parent, { recursive: true });
            const made = (await exec('nexysvhdl.createProject', { parentDir: parent, name: 'Lab-One', template: 'empty' })) as { ok: boolean; root: string; files: string[] };
            const nv = join(made.root, 'Lab-One.nvproj');
            step('n.created', { ok: made.ok, files: made.files, nvproj: existsSync(nv), content: existsSync(nv) ? JSON.parse(await readFile(nv, 'utf8')) : null });
            const settings = await readFile(join(made.root, 'nexysvhdl.json'), 'utf8');
            step('n.settingsMentionNvproj', /nvproj/.test(settings));

            const { resolveOpenTarget } = require(join(ext.extensionPath, 'dist', 'extension', 'project', 'open-target.js')) as typeof import('../../extension/project/open-target');
            // Open Project resolves a folder, the .nvproj and nexysvhdl.json to the same folder; bad input is explained.
            const resolved: Record<string, unknown> = {};
            for (const [k, p] of Object.entries({ folder: made.root, nvproj: nv, settings: join(made.root, 'nexysvhdl.json') })) resolved[k] = await resolveOpenTarget(p);
            step('n.openResolved', resolved);
            await writeFile(join(parent, 'Broken.nvproj'), '{ not json');
            step('n.brokenProject', { explained: await resolveOpenTarget(join(parent, 'Broken.nvproj')) });

            // A project folder that is MOVED (copied) elsewhere still resolves.
            const moved = join(scratch, 'Archive 2026', 'Lab-One Copy');
            await mkdir(join(scratch, 'Archive 2026'), { recursive: true });
            await cp(made.root, moved, { recursive: true });
            step('n.movedResolves', await resolveOpenTarget(join(moved, 'Lab-One.nvproj')));

            // The open workspace is a legacy project (no .nvproj): it works, and the project file can be added on request without touching anything else.
            const before = (await readFile(join(root, 'nexysvhdl.json'), 'utf8')) + JSON.stringify(await readdir(root));
            step('n.legacyHasNvproj', (await readdir(root)).some((f) => f.endsWith('.nvproj')));
            step('n.legacyProjectView', { hasProject: !!service.snapshot?.project, projectFile: service.snapshot?.projectFile ?? null });
            const added = await exec('nexysvhdl.createProjectFile');
            step('n.createProjectFile', { created: added.created, file: added.file });
            const afterSettings = await readFile(join(root, 'nexysvhdl.json'), 'utf8');
            step('n.legacySettingsUntouched', (before.startsWith(afterSettings) || afterSettings === before.slice(0, afterSettings.length)) && afterSettings.length > 0);
            step('n.snapshotProjectFile', service.snapshot?.projectFile ?? null);
            const again = await exec('nexysvhdl.createProjectFile');
            step('n.createProjectFileAgain', { created: again.created });
            step('result', 'stage-n-complete');
            return;
        }

        // ================================================================== stage s: Design Schematic readability with DigitDisplay
        if (stage === 's') {
            await writeFile(
                join(root, 'src', 'Top2.vhd'),
                `library ieee;
use ieee.std_logic_1164.all;
entity Top2 is
    port (clk : in std_logic; an : out std_logic_vector(7 downto 0); seg : out std_logic_vector(6 downto 0));
end entity Top2;
architecture rtl of Top2 is
begin
    u_dd : entity work.DigitDisplay port map (clk => clk, an => an, seg => seg);
end architecture rtl;
`,
            );
            await service.refreshNow();
            const lastView = () => schematic.lastView;
            const settle = async (mode: string) => waitFor(`schematic mode ${mode}`, () => (lastView()?.mode === mode ? lastView() : undefined), 15_000);
            const tabs = () => vscode.window.tabGroups.all.map((g) => ({ column: g.viewColumn, tabs: g.tabs.map((t) => t.label), active: g.activeTab?.label }));

            // ---- DigitDisplay on its own: opens in the active group, at 100%
            await exec('nexysvhdl.openSchematic');
            await waitFor('first view report', () => lastView(), 15_000);
            await sleep(600);
            const first = lastView()!;
            step('s.open', { groups: tabs(), mode: first.mode, scale: first.scale, metrics: first.metrics });
            await shot('70-schematic-opens-100');

            schematic.postCommand({ action: 'width' });
            await settle('width');
            await sleep(500);
            step('s.fitWidth', { scale: lastView()!.scale, metrics: lastView()!.metrics });
            await shot('71-schematic-fit-width');

            schematic.postCommand({ action: 'all' });
            await settle('all');
            await sleep(500);
            step('s.fitAll', { scale: lastView()!.scale, metrics: lastView()!.metrics });
            await shot('72-schematic-fit-all');

            schematic.postCommand({ action: '100' });
            await settle('100');
            schematic.postCommand({ action: 'zoomIn' });
            schematic.postCommand({ action: 'zoomIn' });
            await settle('custom');
            schematic.postCommand({ action: 'scroll', x: 300, y: 40 });
            await sleep(700);
            step('s.zoomedAndPanned', { scale: lastView()!.scale, x: lastView()!.x, y: lastView()!.y, metrics: lastView()!.metrics });
            await shot('73-schematic-zoom-pan');
            schematic.postCommand({ action: 'reset' });
            await settle('100');
            await sleep(400);
            step('s.reset', { mode: lastView()!.mode, scale: lastView()!.scale, x: lastView()!.x, y: lastView()!.y });

            // ---- Two levels: drill down, breadcrumb back, source navigation, maximize
            await service.setTop('Top2');
            await exec('nexysvhdl.openSchematic');
            await sleep(1200);
            await shot('74-schematic-top2');
            schematic.postCommand({ action: 'click', selector: '.drill' });
            await waitFor('drilled', () => (lastView()?.node && lastView()!.node !== 'Top2' ? lastView() : undefined), 15_000).catch(() => undefined);
            await sleep(1200);
            step('s.drillDown', { node: lastView()?.node, tabs: tabs() });
            await shot('75-schematic-drilled-breadcrumb');
            schematic.postCommand({ action: 'click', selector: 'nav a' });
            await sleep(1200);
            step('s.breadcrumbBack', { node: lastView()?.node });

            schematic.postCommand({ action: 'click', selector: '.block' });
            await waitFor('source opened', () => vscode.window.activeTextEditor?.document.fileName.endsWith('.vhd'), 15_000).catch(() => undefined);
            step('s.sourceNavigation', { file: vscode.window.activeTextEditor?.document.fileName.split(/[\\/]/).pop(), groups: tabs() });
            await sleep(600);
            await shot('76-schematic-source-beside');

            schematic.show();
            await sleep(800);
            schematic.postCommand({ action: 'click', selector: '#maximize' });
            await sleep(1200);
            await shot('77-schematic-maximized');
            schematic.postCommand({ action: 'click', selector: '#maximize' });
            await sleep(800);
            step('result', 'stage-s-complete');
            return;
        }

        // ================================================================== stage c: the NexysVHDL Console with the real tools
        if (stage === 'c' || stage === 'd') {
            const userData = process.env['NEXYS_P7_USERDATA']!;
            /** The text VS Code keeps for the "NexysVHDL Console" output channel (private user-data folder). */
            const consoleText = async (): Promise<string> => {
                const walk = async (dir: string): Promise<string[]> => {
                    const found: string[] = [];
                    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
                        const p = join(dir, e.name);
                        if (e.isDirectory()) found.push(...(await walk(p)));
                        else if (e.name.includes('NexysVHDL Console')) found.push(p);
                    }
                    return found;
                };
                const files = await walk(join(userData, 'logs'));
                const texts = await Promise.all(files.map((f) => readFile(f, 'utf8').catch(() => '')));
                return texts.sort((a, b) => b.length - a.length)[0] ?? '';
            };
            const fromMark = async (mark: number) => (await consoleText()).slice(mark);
            const textWhen = async (_what: string, mark: number, cond: (t: string) => boolean, timeoutMs = 15_000) => {
                const start = Date.now();
                for (;;) {
                    const t = await fromMark(mark);
                    if (cond(t)) return t;
                    if (Date.now() - start > timeoutMs) return t;
                    await sleep(250);
                }
            };
            if (stage === 'd') {
                // Detailed output with the real tools: the raw lines of GHDL, Yosys and nextpnr stream while the action runs.
                await exec('nexysvhdl.toggleConsoleDetail');
                let mark = (await consoleText()).length;
                await exec('nexysvhdl.runSimulation', { duration: '2us' });
                await idle();
                let t = await textWhen('detailed simulate', mark, (x) => /\[Simulate\] (PASS|FAIL)/.test(x));
                step('d.simulate', { rawLines: (t.match(/^\s*\| /gm) ?? []).length, text: t.split(/\r?\n/).slice(0, 14).join(' / ') });
                mark = (await consoleText()).length;
                const building = exec('nexysvhdl.build');
                await sleep(15_000);
                const mid = await fromMark(mark);
                step('d.buildMidRawLines', (mid.match(/^\s*\| /gm) ?? []).length);
                await shot('68-console-detailed-build-running');
                await building;
                await idle();
                t = await textWhen('detailed build', mark, (x) => /\[Build\] (Bitstream ready|FAIL)/.test(x), 30_000);
                const raw = t.split(/\r?\n/).filter((l) => /^\s*\| /.test(l));
                step('d.build', { rawLines: raw.length, firstRaw: raw.slice(0, 6), lastRaw: raw.slice(-4), tail: t.split(/\r?\n/).slice(-6).join(' / ') });
                await sleep(600);
                await shot('69-console-detailed-build-done');
                await exec('nexysvhdl.toggleConsoleDetail');
                step('result', 'stage-d-complete');
                return;
            }
            await exec('workbench.action.closePanel');
            await sleep(500);
            step('c.consoleChannelBefore', (await consoleText()).split(/\r?\n/).slice(0, 3));

            // ---- Check: the console opens by itself and shows the block
            let mark = (await consoleText()).length;
            await exec('nexysvhdl.check');
            await idle();
            let t = await textWhen('check block', mark, (x) => /\[Check\] PASS/.test(x));
            step('c.check', t);
            await sleep(600);
            await shot('60-console-check');

            // ---- Simulate streams the testbench's own report lines
            mark = (await consoleText()).length;
            await exec('nexysvhdl.runSimulation', { duration: '2us' });
            await idle();
            t = await textWhen('simulate block', mark, (x) => /\[Simulate\] (PASS|FAIL)/.test(x));
            step('c.simulate', t);
            await sleep(600);
            await shot('61-console-simulate');

            // ---- Detailed output: the raw tool output streams as well
            await exec('nexysvhdl.toggleConsoleDetail');
            mark = (await consoleText()).length;
            await exec('nexysvhdl.check');
            await idle();
            t = await textWhen('detailed check', mark, (x) => /\[Check\] PASS/.test(x));
            step('c.checkDetailed', { rawLines: (t.match(/^\s*\| /gm) ?? []).length, text: t.split(/\r?\n/).slice(0, 12).join(' / ') });
            await exec('nexysvhdl.toggleConsoleDetail');

            // ---- Build: stages stream while it runs
            mark = (await consoleText()).length;
            const building = exec('nexysvhdl.build');
            await sleep(12_000);
            const midBuild = await fromMark(mark);
            step('c.buildMid', midBuild);
            await shot('62-console-build-running');
            await building;
            await idle();
            t = await textWhen('build block', mark, (x) => /\[Build\] (Bitstream ready|FAIL)/.test(x), 30_000);
            step('c.build', t);
            await sleep(600);
            await shot('63-console-build-done');

            // ---- Program with no board connected
            mark = (await consoleText()).length;
            await exec('nexysvhdl.program', { allowStale: true });
            await idle();
            t = await textWhen('program block', mark, (x) => /\[Program\] (PASS|FAIL|WARNING|ERROR)/.test(x));
            step('c.programNoBoard', t);
            await sleep(600);
            await shot('64-console-program-no-board');

            // ---- A real VHDL error: clear message with file:line, and the panel comes back although it was closed
            await exec('workbench.action.closePanel');
            await sleep(500);
            await writeFile(join(root, 'src', 'broken.vhd'), BROKEN);
            await service.refreshNow();
            mark = (await consoleText()).length;
            await exec('nexysvhdl.check');
            await idle();
            t = await textWhen('check error', mark, (x) => /\[Check\] FAIL/.test(x));
            step('c.checkError', t);
            await sleep(800);
            await shot('65-console-error-reopened');
            await rm(join(root, 'src', 'broken.vhd'), { force: true });
            await service.refreshNow();

            // ---- Closing the console breaks nothing; the next operation reveals it again
            await exec('workbench.action.closePanel');
            await sleep(500);
            await shot('66-console-closed');
            mark = (await consoleText()).length;
            await exec('nexysvhdl.check');
            await idle();
            t = await textWhen('check after close', mark, (x) => /\[Check\] PASS/.test(x));
            step('c.checkAfterClose', t);
            await sleep(800);
            await shot('67-console-revealed-again');
            step('result', 'stage-c-complete');
            return;
        }

        // ================================================================== stage b
        const expected = await readJson(join(scratch, 'expected.json'));
        const c = await cfg();
        step('b.config', {
            top: c.top, testbench: c.simulation?.testbench, constraints: c.constraints, stopTime: c.simulation?.stopTime, exclude: c.exclude,
            sources: c.sources, simulationSources: c.simulation?.sources,
        });
        const stateOnDisk = (await readJson(join(root, '.nexysvhdl', 'state.json'))).values;
        step('b.stateOnDisk', { designMode: stateOnDisk['nexysvhdl.design.mode'], radix: stateOnDisk['nexysvhdl.waveform.radix'], layout: stateOnDisk['nexysvhdl.waveform.layout'], signals: stateOnDisk['nexysvhdl.waveform.signals'], schematic: stateOnDisk['nexysvhdl.schematic.view'] });
        step('b.designMode', state.get('nexysvhdl.design.mode'));
        await exec('nexysvhdl.design.showHierarchy').catch(() => undefined);
        await shot('50-restored-hierarchy-mode');

        // The viewer opens on Simulate: it must come back with the remembered radix, pane widths and signals.
        await exec('nexysvhdl.runSimulation'); // no duration given: the project's stopTime (7us) is used unchanged
        await idle();
        await waitFor('waveform loaded', () => (wst()['loaded'] ? wst() : undefined), 40_000);
        await sleep(800);
        step('b.waveform', { radix: wst()['radix'], layout: wst()['layout'], visible: wst()['visible'], signalRadix: wst()['radixes']?.[expected['waveform'].visible[0]] });
        await shot('51-restored-waveform');
        step('b.stopTimeShownInToolbar', wst()['sim']?.typed);

        schematic.show();
        await waitFor('schematic view restored', () => (schematic.lastView ? schematic.lastView : undefined), 15_000);
        step('b.schematic', { mode: schematic.lastView!.mode, scale: schematic.lastView!.scale });
        await shot('52-restored-schematic');

        // ---- Reload leg preparation: change a managed value, reload the window at once (no explicit save).
        await writeFile(reloadMarker, JSON.stringify({ designMode: 'files', top: 'DigitDisplay' }));
        await service.setTop('DigitDisplay');
        await exec('nexysvhdl.design.showFiles');
        step('b.reloadPending', { pending: state.pending });
        step('result', 'stage-b-reloading');
        closing = true;
        await writeFile(out, JSON.stringify({ report, log }, null, 2));
        void exec('workbench.action.reloadWindow');
        await new Promise(() => undefined);
    } catch (err) {
        step('result', `FAILED: ${(err as Error).stack ?? String(err)}`);
        throw err;
    } finally {
        if (!closing) await writeFile(out, JSON.stringify({ report, log }, null, 2));
        await copyFile(out, `${out}.copy`).catch(() => undefined);
        if (shots && !closing) await writeFile(join(shots, 'finished'), '').catch(() => undefined);
    }
}
