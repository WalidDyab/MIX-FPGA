/**
 * Phase 6 validation inside a real VS Code Extension Development Host (NOT part
 * of `npm test`; needs VS Code and the installed FPGA toolchain). Started by
 * tests/integration/run-phase6.ts. Never programs a board.
 *
 *   NEXYS_EDH_REPORT=<file>   JSON report written here
 *   NEXYS_P6_SHOTS=<folder>   optional: before each named stage a `<name>.shot` marker is
 *                             written and the suite waits for `<name>.done` (a screenshot helper)
 *   NEXYS_P6_FULL=1           also run a real 4x simultaneous Build (about 90 s)
 *
 * The workspace must be a copy of the mixed-case "DigitDisplay" project.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { NexysVhdlApi } from '../../extension/extension';
import { EXTENSION_ID, log, report, step, stub, waitFor } from './edh-suite';

const shots = process.env['NEXYS_P6_SHOTS'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(name: string): Promise<void> {
    if (!shots) return;
    await mkdir(shots, { recursive: true });
    await writeFile(join(shots, `${name}.shot`), new Date().toISOString());
    await waitFor(`screenshot ${name}`, () => existsSync(join(shots, `${name}.done`)), 30_000).catch(() => undefined);
}

const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;

export async function run(): Promise<void> {
    const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const ext = vscode.extensions.getExtension<NexysVhdlApi>(EXTENSION_ID)!;
    const out = process.env['NEXYS_EDH_REPORT']!;
    try {
        step('extensionPath', ext.extensionPath);
        step('extensionVersion', (ext.packageJSON as { version: string }).version);
        const { service, waveform } = await ext.activate();
        await waitFor('project', () => service.snapshot?.project);
        const s = () => service.snapshot!;
        const cfg = () => readJson(join(root, 'nexysvhdl.json'));
        const pkg = ext.packageJSON as { contributes: { views: Record<string, Array<{ id: string }>>; themes: Array<{ label: string }>; commands: Array<{ command: string }> } };

        // ---- 1. the Design view replaces Project Files and Design Hierarchy; mixed-case top is understood
        step('views', pkg.contributes.views['nexysvhdl']!.map((v) => v.id));
        step('top', { configured: s().project!.config.top, validation: s().validation.map((d) => d.code), hierarchyRoot: s().hierarchy.root?.entityName });
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        await vscode.commands.executeCommand('workbench.view.extension.nexysvhdl');
        await vscode.commands.executeCommand('nexysvhdl.design.focus');
        await sleep(4000);
        await shot('01-design-files');
        await vscode.commands.executeCommand('nexysvhdl.design.showHierarchy');
        await sleep(800);
        await shot('02-design-hierarchy');
        await vscode.commands.executeCommand('nexysvhdl.design.showFiles');
        step('design.contextKeysRegistered', ['nexysvhdl.design.showFiles', 'nexysvhdl.design.showHierarchy', 'nexysvhdl.addFile'].every((c) => pkg.contributes.commands.some((x) => x.command === c)));

        // ---- 2. optional appearance: first-use question, workspace scope only, and back
        const workbench = () => vscode.workspace.getConfiguration('workbench').inspect<string>('colorTheme')!;
        const before = workbench();
        step('appearance.before', { global: before.globalValue ?? null, workspace: before.workspaceValue ?? null });
        await shot('03-appearance-prompt'); // the first-use notification, as the student sees it
        await vscode.commands.executeCommand('notifications.clearAll');
        await vscode.commands.executeCommand('nexysvhdl.useClassroomAppearance');
        await waitFor('workspace theme written', () => workbench().workspaceValue === 'NexysVHDL Classroom');
        await sleep(1200);
        step('appearance.afterClassroom', { global: workbench().globalValue ?? null, workspace: workbench().workspaceValue, themeContributed: pkg.contributes.themes.map((t) => t.label) });
        await shot('04-classroom-appearance');
        await vscode.commands.executeCommand('nexysvhdl.useMyAppearance');
        await waitFor('workspace theme removed', () => workbench().workspaceValue === undefined);
        step('appearance.afterMine', { global: workbench().globalValue ?? null, workspace: workbench().workspaceValue ?? null });
        await vscode.commands.executeCommand('nexysvhdl.useClassroomAppearance'); // keep it for the remaining screenshots

        // ---- 3. + Add File: the real pickers, then the scripted flows
        const pick = vscode.commands.executeCommand('nexysvhdl.addFile');
        await sleep(1000);
        await shot('05-add-file-what');
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        await sleep(1000);
        await shot('06-add-file-how');
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await pick;

        const add = (script: Record<string, unknown>) => vscode.commands.executeCommand('nexysvhdl.addFile', script) as Promise<Record<string, unknown> | undefined>;
        const created = await add({ kind: 'source', mode: 'new', name: 'Alu' });
        step('addFile.newSource', created);
        step('addFile.openedInEditor', vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('Alu.vhd'));
        await waitFor('Alu in sources', () => s().project!.config.sources.includes('src/Alu.vhd'));
        const tb = await add({ kind: 'simulation', mode: 'new', name: 'Alu_tb' });
        step('addFile.newTestbench', tb);
        step('addFile.testbenchText', (await readFile(join(root, 'sim', 'Alu_tb.vhd'), 'utf8')).includes('std.env.stop;'));
        await shot('07-new-file-in-design');

        // collisions and formats
        step('addFile.collisionCancel', (await add({ kind: 'source', mode: 'new', name: 'alu', collision: 'cancel' })) ?? 'cancelled');
        step('addFile.collisionRename', await add({ kind: 'source', mode: 'new', name: 'alu', collision: 'rename', renameTo: 'Alu2' }));
        await writeFile(join(root, '..', 'outside.vhdl'), 'entity o is end;');
        await writeFile(join(root, '..', 'outside_ok.vhd'), 'entity outside_ok is end entity;\narchitecture a of outside_ok is begin end architecture;\n');
        await writeFile(join(root, '..', 'extra.xdc'), '## extra\n');
        const warnings: string[] = [];
        stub('showWarningMessage', async (m: string) => {
            warnings.push(m);
            return undefined;
        });
        let refused = '';
        try {
            await add({ kind: 'source', mode: 'copy', from: join(root, '..', 'outside.vhdl') });
        } catch (e) {
            refused = (e as Error).message;
        }
        step('addFile.vhdlRefused', { thrown: refused, warnings: [...warnings] });
        step('addFile.copy', await add({ kind: 'source', mode: 'copy', from: join(root, '..', 'outside_ok.vhd') }));
        step('addFile.copyIsPhysical', (await readFile(join(root, 'src', 'outside_ok.vhd'), 'utf8')).includes('outside_ok'));
        const activeBefore = (await cfg())['constraints'];
        step('addFile.xdcCopyAsk', await add({ kind: 'constraints', mode: 'copy', from: join(root, '..', 'extra.xdc'), activate: false }));
        step('addFile.xdcStaysActive', (await cfg())['constraints'] === activeBefore);
        step('addFile.xdcSwitch', await add({ kind: 'constraints', mode: 'new', name: 'second', activate: true }));
        step('addFile.xdcNowActive', (await cfg())['constraints']);
        step('addFile.sourcesInJson', (await cfg())['sources']);
        step('addFile.noExternalPaths', !JSON.stringify(await cfg()).match(/[A-Za-z]:\\|\.\.\//));
        // put the project back as it was
        for (const f of ['src/Alu.vhd', 'src/Alu2.vhd', 'src/outside_ok.vhd', 'sim/Alu_tb.vhd', 'constraints/second.xdc', 'constraints/extra.xdc']) await rm(join(root, ...f.split('/')), { force: true });
        await vscode.commands.executeCommand('nexysvhdl.useConstraintsFile', { payload: activeBefore });
        await service.refreshNow();

        // ---- 4. simulation length
        const quick = vscode.commands.executeCommand('nexysvhdl.setSimulationStopTime');
        await sleep(1000);
        await shot('08-simulation-length');
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await quick;
        step('stopTime.default', (await cfg())['simulation'].stopTime ?? null);
        await vscode.commands.executeCommand('nexysvhdl.setSimulationStopTime', { value: '2us' });
        step('stopTime.afterSet', (await cfg())['simulation'].stopTime);
        await vscode.commands.executeCommand('nexysvhdl.simulate');
        step('stopTime.simulation', { passed: service.lastSimulation?.passed, stoppedAt: service.lastSimulation?.stoppedAt, state: service.workflow.simulate });

        // ---- 5. waveform: Display As, remembered per workspace
        await vscode.commands.executeCommand('nexysvhdl.openWaveform');
        const loaded = await waitFor('waveform loaded', () => (waveform.lastWebviewState?.['loaded'] ? waveform.lastWebviewState : undefined), 25_000);
        const visible = loaded['visible'] as string[];
        const count = visible.find((p) => p.endsWith('count[16:0]'))!;
        const value = visible.find((p) => p.endsWith('u_mux.value[31:0]'))!;
        const radixes = () => (waveform.lastWebviewState?.['radixes'] ?? {}) as Record<string, string>;
        const send = async (path: string, radix: string) => {
            for (let i = 0; i < 20 && radixes()[path] !== radix; i++) {
                waveform.postCommand({ action: 'signalRadix', path, radix });
                await sleep(150);
            }
        };
        await send(count, 'udec');
        await send(value, 'udec');
        await waitFor('radix state', () => radixes()[count] === 'udec' && radixes()[value] === 'udec');
        waveform.postCommand({ action: 'cursor', time: 1_500_000_000 });
        await sleep(800);
        const shown = waveform.lastWebviewState!['values'] as Record<string, string>;
        step('waveform.displayAs', { radixes: { [count]: radixes()[count], [value]: radixes()[value] }, count: shown[count], value: shown[value], valueIsExact: shown[value] === '1985229328' });
        await shot('09-waveform-display-as');
        const stored = (waveform as unknown as { memory?: vscode.Memento }).memory?.get('nexysvhdl.waveform.radix');
        step('waveform.remembered', stored);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await sleep(500);
        waveform.dispose();
        await vscode.commands.executeCommand('nexysvhdl.openWaveform');
        await waitFor('waveform reloaded', () => (waveform.lastWebviewState?.['loaded'] ? waveform.lastWebviewState : undefined), 25_000);
        await waitFor('radix restored', () => radixes()[count] === 'udec', 10_000);
        step('waveform.restoredAfterReopen', { [count]: radixes()[count], [value]: radixes()[value] });

        // ---- 6. one pipeline operation at a time, through the real commands
        const starts: string[] = [];
        let was: string | undefined;
        const sub = service.onDidChange(() => {
            const now = service.workflow.running;
            if (now && now !== was) starts.push(now);
            was = now;
        });
        const refusedMessages: string[] = [];
        stub('showWarningMessage', async (m: string) => {
            refusedMessages.push(m);
            return undefined;
        });
        const dup = await Promise.allSettled([1, 2, 3, 4].map(() => vscode.commands.executeCommand('nexysvhdl.check')));
        await waitFor('idle', () => service.busyAction === undefined, 60_000);
        step('concurrency.fourChecks', { started: starts.filter((x) => x === 'check').length, settled: dup.map((d) => d.status), warnings: [...refusedMessages] });
        if (process.env['NEXYS_P6_FULL']) {
            starts.length = 0;
            refusedMessages.length = 0;
            const builds = [1, 2, 3, 4].map(() => vscode.commands.executeCommand('nexysvhdl.build'));
            await waitFor('build running', () => service.busyAction === 'build');
            await vscode.commands.executeCommand('nexysvhdl.simulate');
            await vscode.commands.executeCommand('nexysvhdl.openRtlSchematic');
            await vscode.commands.executeCommand('nexysvhdl.program');
            await vscode.commands.executeCommand('workbench.view.extension.nexysvhdl');
            await sleep(800);
            await shot('10-busy-while-building');
            await Promise.all(builds);
            await waitFor('idle after builds', () => service.busyAction === undefined, 240_000);
            step('concurrency.fourBuilds', {
                buildsStarted: starts.filter((x) => x === 'build').length,
                otherStartsDuringBuild: starts.filter((x) => x !== 'build'),
                success: service.lastBuild?.success,
                steps: service.lastBuild?.steps.map((x) => `${x.step}=${x.status}`),
                warnings: [...new Set(refusedMessages)],
                top: service.lastBuild?.generatedVerilog ? 'netlist produced' : 'none',
            });
        }
        sub.dispose();
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
