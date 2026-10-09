/**
 * Simulation workspace refinements, validated inside a real VS Code (NOT part of `npm test`; needs
 * VS Code and the installed FPGA toolchain). Run with run-phase6.ts:
 *   NEXYS_P6_SUITE=phase6c NEXYSVHDL_P6_EXTENSIONS_DIR=<installed extensions> NEXYSVHDL_P6_HOST_DIR=<empty host> ...
 * Covers: + Add File in Hierarchy, Simulate opening the viewer at once, Run for, Stop, re-runs from time 0,
 * std.env.stop vs wait;, no duplicate viewers, radix/splitter/signal choices surviving re-runs.
 * Workspace: a copy of the mixed-case "DigitDisplay" project (free-running clock, ends with `wait;`).
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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
/** Running GHDL processes (the program itself; the simulation runs in-process or as a child of it). -1 if they cannot be listed. */
const ghdlProcesses = (): number => {
    try {
        if (process.platform === 'win32') return (execSync('tasklist /FI "IMAGENAME eq ghdl.exe" /NH', { encoding: 'utf8' }).match(/ghdl\.exe/gi) ?? []).length;
        // macOS: `ps -axo comm=` prints each executable's full path; count those named ghdl (the toolchain's, whatever the folder).
        return execSync('ps -axo comm=', { encoding: 'utf8' }).split('\n').filter((l) => /(^|\/)ghdl(-[a-z]+)?$/.test(l.trim())).length;
    } catch {
        return -1;
    }
};
const STOP_TB = `library ieee;
use ieee.std_logic_1164.all;

entity Stop_tb is
end entity Stop_tb;

architecture sim of Stop_tb is
    signal clk : std_logic := '0';
begin
    clk <= not clk after 5 ns;
    stimulus : process
    begin
        wait for 1 us;
        report "ALL TESTS PASSED";
        std.env.stop;
        wait;
    end process stimulus;
end architecture sim;
`;

export async function run(): Promise<void> {
    const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const ext = vscode.extensions.getExtension<NexysVhdlApi>(EXTENSION_ID)!;
    const out = process.env['NEXYS_EDH_REPORT']!;
    try {
        step('extensionPath', ext.extensionPath);
        const { service, waveform } = await ext.activate();
        await waitFor('project', () => service.snapshot?.project);
        const cfg = () => readJson(join(root, 'nexysvhdl.json'));
        const run = (cmd: string, ...args: unknown[]) => vscode.commands.executeCommand(cmd, ...args) as Promise<any>;
        const viewers = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label.startsWith('Waveform')).length;
        const st = () => (waveform.lastWebviewState ?? {}) as Record<string, any>;
        const idle = () => waitFor('idle', () => service.busyAction === undefined, 150_000);
        const loadedWave = () => waitFor('waveform loaded', () => (waveform.lastWebviewState?.['loaded'] ? waveform.lastWebviewState : undefined), 30_000);
        const clickRun = async (n: string, unit: string) => {
            for (let i = 0; i < 30 && !(st()['sim']?.typed === `${n}${unit}`); i++) {
                waveform.postCommand({ action: 'setDuration', number: n, unit });
                await sleep(200);
            }
            const before = service.simulationRun;
            waveform.postCommand({ action: 'clickRun' });
            await waitFor('run started', () => service.simulating || service.simulationRun > before, 20_000);
        };
        await run('workbench.action.closeAuxiliaryBar');
        await run('workbench.view.extension.nexysvhdl');
        await sleep(1500);

        // ---- 1. Hierarchy shows + Add File
        await run('nexysvhdl.design.showHierarchy');
        await sleep(800);
        await shot('30-hierarchy-add-file');
        await run('nexysvhdl.design.showFiles');

        // ---- 2. Simulate opens the viewer immediately (testbench that ends itself with std.env.stop)
        await writeFile(join(root, 'sim', 'Stop_tb.vhd'), STOP_TB);
        await service.refreshNow();
        await service.setTestbench('Stop_tb');
        step('simulate.viewerBefore', { visible: waveform.visible, tabs: viewers() });
        const t0 = Date.now();
        const firstSim = run('nexysvhdl.simulate');
        await waitFor('viewer opened by Simulate', () => waveform.visible, 10_000);
        step('simulate.viewerOpensAtOnce', { visibleWhileSimulating: waveform.visible, simulating: service.simulating, msUntilVisible: Date.now() - t0, tabs: viewers() });
        await firstSim;
        await idle();
        await loadedWave();
        step('simulate.stdEnvStop', { passed: service.lastSimulation?.passed, stoppedAt: service.lastSimulation?.stoppedAt, stopTimeInProject: (await cfg())['simulation'].stopTime ?? null, viewers: viewers() });

        // ---- 3. Run for 2 us on the free-running testbench that ends with wait;
        await service.setTestbench('DigitDisplay_tb');
        await clickRun('2', 'us');
        await idle();
        const w2 = await loadedWave();
        const end2 = w2['t1'] as number;
        step('runFor.2us', { stoppedAt: service.lastSimulation?.stoppedAt, passed: service.lastSimulation?.passed, stopTimeInProject: (await cfg())['simulation'].stopTime, viewEndFs: end2, status: (w2 as Record<string, any>)['sim']?.status, viewers: viewers() });
        await shot('31-toolbar-after-run');

        // ---- radix + splitter + signals chosen now must survive the re-run
        const visible = w2['visible'] as string[];
        const count = visible.find((p) => p.endsWith('count[16:0]'))!;
        for (let i = 0; i < 20 && st()['radixes']?.[count] !== 'udec'; i++) {
            waveform.postCommand({ action: 'signalRadix', path: count, radix: 'udec' });
            await sleep(150);
        }
        for (let i = 0; i < 20 && st()['treeWidthPx'] === w2['treeWidthPx']; i++) {
            waveform.postCommand({ action: 'paneWidth', pane: 'tree', width: 300 });
            await sleep(150);
        }
        const chosen = { radix: st()['radixes']?.[count], layout: st()['layout'], visibleCount: (st()['visible'] as string[]).length };

        // ---- 4. a longer duration reruns from time 0
        const run2 = service.simulationRun;
        await clickRun('5', 'us');
        await idle();
        const w5 = await waitFor('longer waveform', () => (waveform.lastWebviewState?.['loaded'] && service.simulationRun > run2 && (waveform.lastWebviewState['t1'] as number) > end2 ? waveform.lastWebviewState : undefined), 30_000);
        step('runFor.5us', { stoppedAt: service.lastSimulation?.stoppedAt, runs: service.simulationRun - run2, t0: w5['t0'], viewEndFs: w5['t1'], longerThan2us: (w5['t1'] as number) > end2, stopTimeInProject: (await cfg())['simulation'].stopTime });
        step('rerun.keepsChoices', { before: chosen, after: { radix: st()['radixes']?.[count], layout: st()['layout'], visibleCount: (st()['visible'] as string[]).length } });

        // ---- 5. std.env.stop ends before the requested duration
        await service.setTestbench('Stop_tb');
        const run3 = service.simulationRun;
        await clickRun('5', 'us');
        await idle();
        await waitFor('stop_tb waveform', () => service.simulationRun > run3, 20_000);
        step('runFor.stdEnvStopEarly', { requested: '5us', stoppedAt: service.lastSimulation?.stoppedAt, passed: service.lastSimulation?.passed, state: service.workflow.simulate });

        // ---- 6. wait; with a clock ends at the selected duration (step 3), and with a different one again
        await service.setTestbench('DigitDisplay_tb');
        const run4 = service.simulationRun;
        await clickRun('1', 'us');
        await idle();
        await waitFor('1us waveform', () => service.simulationRun > run4, 20_000);
        step('runFor.waitEndsAtDuration', { requested: '1us', stoppedAt: service.lastSimulation?.stoppedAt, passed: service.lastSimulation?.passed });

        // ---- 7. Stop Simulation: no stop time at all, so the clock runs until Stop
        const before = { ghdl: ghdlProcesses() };
        for (let i = 0; i < 30 && st()['sim']?.typed !== 'us'; i++) {
            waveform.postCommand({ action: 'setDuration', number: '', unit: 'us' });
            await sleep(200);
        }
        waveform.postCommand({ action: 'clickRun' });
        await waitFor('simulation running', () => service.simulating, 20_000);
        await sleep(3500);
        await waitFor('toolbar shows running', () => st()['sim']?.running === true, 10_000);
        const running = { ghdl: ghdlProcesses(), toolbar: st()['sim'], busyAction: service.busyAction, workflow: service.workflow.simulate };
        await shot('32-toolbar-running');
        // A second Run while running must not start another GHDL.
        waveform.postCommand({ action: 'clickRun' });
        await sleep(500);
        step('stop.whileRunning', { before, running, ghdlAfterSecondRunClick: ghdlProcesses() });
        const stopRun = service.simulationRun;
        waveform.postCommand({ action: 'clickStop' });
        await waitFor('simulation stopped', () => !service.simulating, 30_000);
        await idle();
        await sleep(1500);
        const stoppedWave = await waitFor('partial waveform shown', () => (waveform.lastWebviewState?.['loaded'] && service.simulationRun > stopRun ? waveform.lastWebviewState : undefined), 20_000).catch(() => undefined);
        step('stop.afterStop', {
            cancelled: service.lastSimulation?.cancelled,
            statusText: service.workflow.simulate.summary,
            state: service.workflow.simulate.state,
            lockReleased: service.busyAction === undefined,
            workflowRunning: service.workflow.running ?? null,
            ghdlProcessesLeft: ghdlProcesses(),
            partialVcdKept: !!service.lastSimulation?.vcd,
            partialWaveformShown: !!stoppedWave,
            partialViewEndFs: stoppedWave?.['t1'] ?? null,
            toolbar: st()['sim'],
            errorDiagnostics: (service.problems.get('vhdl') ?? []).filter((d) => d.severity === 'error').length,
            viewers: viewers(),
        });
        await shot('33-toolbar-stopped-partial');

        // ---- run works again after Stop; then no duplicate viewers after repeated Simulate / Open Waveform
        const run5 = service.simulationRun;
        await clickRun('2', 'us');
        await idle();
        await waitFor('run after stop', () => service.simulationRun > run5, 30_000);
        step('stop.runAgainWorks', { stoppedAt: service.lastSimulation?.stoppedAt, passed: service.lastSimulation?.passed });
        await run('nexysvhdl.openWaveform');
        await run('nexysvhdl.openWaveform');
        await run('nexysvhdl.simulate');
        await idle();
        await run('nexysvhdl.openWaveform');
        step('viewers.final', { waveformTabs: viewers(), allTabs: vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label) });
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
