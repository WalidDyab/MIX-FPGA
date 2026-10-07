import './install-vscode-fake';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createProject } from '../../extension/project/scaffold';
import { NexysVhdlService } from '../../extension/services/nexys-service';
import { DesignView } from '../../extension/views/design-view';
import { WorkflowView } from '../../extension/views/workflow-view';
import { parsePartialVcd, parseVcd } from '../../extension/waveform/vcd-parser';
import { DURATION_UNITS, joinDuration, splitDuration } from '../../extension/waveform/wave-render';
import { renderWaveHtml } from '../../extension/waveform/waveform-html';
import { REPO, repoBoards, tempDir, writeFiles } from '../helpers';
import { FakeBackend } from './fake-backend';
import { DESIGN_FILES } from './fixtures';

async function setup(t: TestContext, backend = new FakeBackend()) {
    const parent = await tempDir(t);
    const r = await createProject({ parentDir: parent, name: 'Sim', board: (await repoBoards()).get('nexys-a7-100t')!, template: 'starter' });
    assert.ok(r.ok);
    const service = new NexysVhdlService({ backend, debounceMs: 5 });
    t.after(() => service.dispose());
    await service.open(r.root);
    return { root: r.root, service, backend };
}
async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond(), 'condition not reached');
}
const readConfig = async (root: string) => JSON.parse(await readFile(join(root, 'nexysvhdl.json'), 'utf8')) as Record<string, any>;

describe('Design → Hierarchy has the same + Add File as Files', () => {
    it('shows it first in both modes, running the very same command (no second implementation)', async (t) => {
        const { root, service } = await setup(t);
        await writeFiles(root, DESIGN_FILES);
        await service.refreshNow();
        const view = new DesignView(service);
        t.after(() => view.dispose());
        const files = view.getChildren()[0]!;
        view.setMode('hierarchy');
        const hierarchy = view.getChildren()[0]!;
        for (const node of [files, hierarchy]) {
            assert.equal(node.label, '+ Add File');
            assert.equal(node.command?.command, 'nexysvhdl.addFile');
            assert.equal(node.description, 'source · testbench · constraint');
        }
        assert.equal(hierarchy.id, files.id);
        assert.deepEqual(hierarchy.command, files.command, 'identical command and arguments');
        assert.equal(view.getChildren()[1]!.label, 'Top', 'the hierarchy follows it, unchanged');
    });

    it('the tree is empty without a project, and the Add File logic exists once', async (t) => {
        const view = new DesignView(new NexysVhdlService({ backend: new FakeBackend() }));
        t.after(() => view.dispose());
        assert.deepEqual(view.getChildren(), []);
        const sources = await readFile(join(REPO, 'extension', 'views', 'design-view.ts'), 'utf8');
        assert.equal([...sources.matchAll(/nexysvhdl\.addFile/g)].length, 1, 'one place defines the node for both modes');
    });
});

describe('Simulate opens the one waveform viewer at once', () => {
    it('Simulate shows the viewer before the simulation starts; Open Waveform only reveals it; Run and Stop are commands', async () => {
        const text = await readFile(join(REPO, 'extension', 'commands', 'commands.ts'), 'utf8');
        const flow = /const simulateFlow = async[\s\S]*?\n    \};/.exec(text)![0];
        assert.ok(flow.indexOf('waveform.show()') >= 0 && flow.indexOf('waveform.show()') < flow.indexOf('service.simulate()'), 'the viewer opens first');
        assert.match(text, /register\('nexysvhdl\.simulate', \(\) => simulateFlow\(\)\)/);
        assert.match(text, /register\('nexysvhdl\.runSimulation', \(arg\?: \{ duration\?: string \| null \}\) => simulateFlow\(arg\?\.duration\)\)/);
        assert.match(text, /register\('nexysvhdl\.stopSimulation'/);
        const open = /register\('nexysvhdl\.openWaveform'[\s\S]*?\n    \}\);/.exec(text)![0];
        assert.doesNotMatch(open, /lastSimulation/, 'the viewer can be opened before any run: it has Run');
        assert.match(open, /waveform\.show\(\)/);
        // The viewer is one panel: show() reveals the existing one.
        const panel = await readFile(join(REPO, 'extension', 'waveform', 'waveform-panel.ts'), 'utf8');
        assert.match(panel, /show\(\): void \{\s*if \(this\.panel\) \{\s*this\.panel\.reveal/);
        assert.equal([...panel.matchAll(/createWebviewPanel\(/g)].length, 1, 'only one place creates a viewer panel');
    });

    it('"Run for" writes the same project setting as the Project view: simulation.stopTime; empty keeps old behavior', async (t) => {
        const { root, service } = await setup(t);
        const before = await readConfig(root);
        assert.equal(before.simulation.stopTime, undefined, 'a project without a duration stays as it is');
        await service.setStopTime('2us');
        assert.equal((await readConfig(root)).simulation.stopTime, '2us');
        await service.setStopTime('5us');
        assert.equal((await readConfig(root)).simulation.stopTime, '5us');
        await service.setStopTime(undefined);
        assert.equal('stopTime' in (await readConfig(root)).simulation, false, 'empty = the testbench decides (no --stop-time)');
        const commands = await readFile(join(REPO, 'extension', 'commands', 'commands.ts'), 'utf8');
        assert.match(commands, /await service\.setStopTime\(normalized\)/);
        assert.doesNotMatch(commands, /runDuration|simulationDuration/, 'no second duration model');
    });

    it('splits and joins the duration field: units are the GHDL ones, empty is allowed, junk is refused', () => {
        assert.deepEqual([...DURATION_UNITS], ['fs', 'ps', 'ns', 'us', 'ms', 'sec']);
        assert.deepEqual(splitDuration('2us'), { number: '2', unit: 'us' });
        assert.deepEqual(splitDuration(' 500 NS '), { number: '500', unit: 'ns' });
        assert.deepEqual(splitDuration('5ms'), { number: '5', unit: 'ms' });
        assert.deepEqual(splitDuration(undefined), { number: '', unit: 'us' });
        assert.deepEqual(splitDuration('banana'), { number: '', unit: 'us' });
        assert.equal(joinDuration('2', 'us'), '2us');
        assert.equal(joinDuration(' 05 ', 'ms'), '5ms');
        assert.equal(joinDuration('', 'ns'), '', 'empty is valid: no fixed duration');
        for (const bad of ['0', '-1', '1.5', 'abc', '1e3']) assert.equal(joinDuration(bad, 'us'), undefined, bad);
        assert.equal(joinDuration('2', 'minutes'), undefined);
        for (const unit of DURATION_UNITS) assert.equal(joinDuration('3', unit), `3${unit}`);
    });
});

describe('Stop Simulation in the service', () => {
    it('Stop ends the run as "stopped by user": lock released, workflow restored, partial waveform kept and shown', async (t) => {
        const backend = new FakeBackend();
        const { root, service } = await setup(t, backend);
        const vcd = join(root, '.nexysvhdl', 'sim', 'waveform.vcd');
        backend.simulateUntilAborted = { vcdPath: vcd };
        const runBefore = service.simulationRun;
        const running = service.simulate();
        await until(() => backend.calls.includes('simulate:top_tb'));
        assert.equal(service.simulating, true);
        assert.equal(service.workflow.simulate.state, 'running');
        // While it runs nothing else can start (Run is disabled in the viewer; the backend refuses too).
        await assert.rejects(service.simulate(), /already running/);
        await assert.rejects(service.build(), /Simulation is still running/);
        assert.equal(service.stopSimulation(), true);
        const outcome = await running;
        assert.equal(outcome.kind, 'done');
        if (outcome.kind !== 'done') return;
        assert.equal(outcome.result.cancelled, true);
        assert.equal(service.simulating, false);
        assert.equal(service.busyAction, undefined, 'the lock is released');
        assert.equal(service.workflow.running, undefined);
        assert.deepEqual(service.workflow.simulate, { state: 'idle', summary: 'Stopped by user' }, 'neither failed nor timed out');
        assert.equal(service.lastSimulation?.vcd?.path, vcd, 'the partial waveform is the latest result');
        assert.equal(service.simulationRun, runBefore + 1, 'so the viewer refreshes from it');
        assert.deepEqual(service.problems.get('vhdl'), [], 'a stop is not a problem');
        assert.equal(service.stopSimulation(), false, 'nothing left to stop');
        // Run is possible again.
        backend.simulateUntilAborted = undefined;
        const again = await service.simulate();
        assert.equal(again.kind, 'done');
        assert.equal(service.workflow.simulate.state, 'passed');
    });

    it('a stop without any waveform leaves the previous waveform alone', async (t) => {
        const backend = new FakeBackend();
        const { service } = await setup(t, backend);
        await service.simulate();
        const previous = service.lastSimulation;
        const run = service.simulationRun;
        backend.simulateUntilAborted = {};
        const running = service.simulate();
        await until(() => service.simulating && backend.calls.length > 1);
        service.stopSimulation();
        await running;
        assert.equal(service.lastSimulation, previous);
        assert.equal(service.simulationRun, run);
        assert.equal(service.workflow.simulate.summary, 'Stopped by user');
    });

    it('Stop only concerns simulations: a running Check or Build is not stopped by it', async (t) => {
        const backend = new FakeBackend();
        const { service } = await setup(t, backend);
        let release!: () => void;
        backend.gate = new Promise((r) => (release = r));
        const check = service.check();
        await until(() => service.busy === 'check');
        assert.equal(service.simulating, false);
        assert.equal(service.stopSimulation(), false);
        release();
        assert.equal((await check).status, 'succeeded');
    });

    it('the Workflow view shows the stopped state and offers the actions again', async (t) => {
        const backend = new FakeBackend();
        const { service } = await setup(t, backend);
        const view = new WorkflowView(service);
        t.after(() => view.dispose());
        backend.simulateUntilAborted = {};
        const running = service.simulate();
        await until(() => service.simulating);
        const busy = view.getChildren().find((n) => n.label === 'Simulate')!;
        assert.equal(busy.contextValue, 'nexysvhdl.action.busy');
        service.stopSimulation();
        await running;
        const after = view.getChildren().find((n) => n.label === 'Simulate')!;
        assert.equal(after.contextValue, 'nexysvhdl.action.simulate');
        assert.equal(after.description, 'Stopped by user');
    });
});

describe('partial waveforms', () => {
    const header = '$timescale 1 ns $end\n$scope module tb $end\n$var reg 1 ! clk $end\n$var reg 4 " bus [3:0] $end\n$upscope $end\n$enddefinitions $end\n';
    it('a dump cut off mid-line is shown up to the last complete line', () => {
        const complete = `${header}#0\n0!\nb0000 "\n#5\n1!\nb0101 "\n#10\n0!\n`;
        assert.equal(parsePartialVcd(complete).partial, false);
        for (const cut of ['b01', 'b0101', 'b0101 ', '#1', '1']) {
            const r = parsePartialVcd(complete + cut);
            assert.ok(r.model.traces.size >= 1, `cut after "${cut}"`);
            assert.ok(r.model.endTime >= 10);
            if (cut === 'b0101') assert.equal(r.partial, true, 'a vector value without its identifier is unfinished');
        }
        assert.throws(() => parseVcd(`${complete}b0101`), /without identifier/, 'the strict parser still refuses it');
        const r = parsePartialVcd(`${complete}b0101`);
        assert.equal(r.partial, true);
        const bus = [...r.model.signals].find((s) => s.name === 'bus')!;
        assert.deepEqual(r.model.traces.get(bus.code)!.values, ['0000', '0101']);
    });

    it('a dump with only its header is an empty but valid waveform; a file that is not a VCD is still an error', () => {
        assert.equal(parsePartialVcd(header).model.endTime, 0);
        assert.throws(() => parsePartialVcd('$timescale bogus $end'), /timescale/);
    });
});

describe('the simulation toolbar in the waveform viewer', () => {
    const html = renderWaveHtml({ nonce: 'n', cspSource: 'vscode-resource:', rendererUri: 'r.js' });

    it('has Run, Stop and "Run for" with the GHDL units, and never calls the duration a period', () => {
        assert.match(html, /id="run"[^>]*>&#9654; Run</);
        assert.match(html, /id="stop"[^>]*disabled>&#9632; Stop</);
        assert.match(html, /Run for: <input id="dur"/);
        for (const unit of DURATION_UNITS) assert.match(html, new RegExp(`<option[^>]*>${unit}</option>`), unit);
        assert.doesNotMatch(html, /Period/, 'a duration is not a clock period');
        const toolbar = /<div id="simbar"[\s\S]*?<\/div>/.exec(html)![0];
        assert.doesNotMatch(toolbar, /Resume|Pause|Continue|Step|Play/i, 'the toolbar never implies a resumable simulator');
        assert.match(html, /Each run starts the testbench again at time 0\. The testbench itself provides all clocks and stimulus\./);
        assert.match(html, /from time 0 for the chosen duration/);
    });

    it('Run is disabled while running, while something else runs, or for an invalid duration; Stop only while a simulation runs', () => {
        assert.match(html, /runBtn\.disabled = sim\.running \|\| !!sim\.other \|\| !valid;/);
        assert.match(html, /stopBtn\.disabled = !sim\.running;/);
        assert.match(html, /durIn\.disabled = durUnit\.disabled = sim\.running;/, 'the duration cannot change mid-run');
        assert.match(html, /function doRun\(\) \{ if \(runBtn\.disabled\) return;/, 'a disabled Run cannot be triggered from the keyboard either');
        assert.match(html, /vscode\.postMessage\(\{ type: 'run', duration: d \}\)/);
        assert.match(html, /vscode\.postMessage\(\{ type: 'stop' \}\)/);
        assert.match(html, /e\.key === 'Enter'\) doRun\(\)/);
    });

    it('a rerun keeps the signals the student chose and the radix and pane-width choices', () => {
        assert.match(html, /const keep = data \? visible\.map\(\(i\) => data\.signals\[i\]\.path\) : \[\];/);
        assert.match(html, /visible = again\.length > 0 \? again : data\.initial\.slice\(\)/);
        // Radix and widths come from stored state (workspace memory) on every load, not from the old page.
        const panel = readFileSync(join(REPO, 'extension', 'waveform', 'waveform-panel.ts'), 'utf8');
        assert.match(panel, /radix: sanitizeRadixState\(this\.memory\?\.get\(RADIX_STATE_KEY\)\), layout: sanitizeLayout\(this\.memory\?\.get\(LAYOUT_STATE_KEY\)\)/);
        assert.match(html, /m\.layout\) \{ layout = W\.sanitizeLayout\(m\.layout\)/);
        assert.match(html, /m\.radix\) \{ rstate = W\.sanitizeRadixState\(m\.radix\)/);
    });

    it('the panel reports the simulation state to the toolbar and stops through the command', () => {
        const panel = readFileSync(join(REPO, 'extension', 'waveform', 'waveform-panel.ts'), 'utf8');
        assert.match(panel, /type: 'simState', running, other, duration, status/);
        assert.match(panel, /Simulation stopped by user/);
        assert.match(panel, /executeCommand\('nexysvhdl\.runSimulation', \{ duration: m\.duration \?\? null \}\)/);
        assert.match(panel, /executeCommand\('nexysvhdl\.stopSimulation'\)/);
        assert.match(panel, /parsePartialVcd/);
    });
});

import { readFileSync } from 'node:fs';
void writeFile;
