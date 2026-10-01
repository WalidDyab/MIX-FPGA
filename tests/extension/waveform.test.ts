import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { GhdlVhdlProvider, loadProject, sha256File, VCD_FILE, WorkflowController, WorkspaceManager } from '../../core';
import { createProject } from '../../extension/project/scaffold';
import { NexysVhdlService } from '../../extension/services/nexys-service';
import { extendVector, parseVcd, pruneEmptyScopes } from '../../extension/waveform/vcd-parser';
import { clampView, formatTime, formatValue, indexAt, niceTicks, traceSegments, valueAt } from '../../extension/waveform/wave-render';
import { renderWaveHtml, toWaveData } from '../../extension/waveform/waveform-html';
import { FakeRunner, FIXTURES, repoBoards, tempDir } from '../helpers';
import { FakeBackend, OK } from './fake-backend';

/** Hand-written VCD exercising the subset (not tool output). */
const SAMPLE = `$date today $end
$version hand-written $end
$timescale 10 ns $end
$comment ignored $end
$scope module tb $end
$var wire 1 ! clk $end
$var reg 4 " bus [3:0] $end
$scope module dut $end
$var reg 1 # q $end
$var reg 8 $ count[7:0] $end
$var wire 1 ! clk $end
$upscope $end
$scope module empty $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
$dumpvars
0!
bx "
U#
b0 $
$end
#1
1!
b1 "
#2
0!
b1 "
z#
#3
1!
1!
0!
b101 "
1#
#4
b11111111 $
X#
`;

describe('VCD parser', () => {
    const m = parseVcd(SAMPLE);
    const sig = (path: string) => m.signals.find((s) => s.path === path)!;
    const trace = (path: string) => m.traces.get(sig(path).code)!;

    it('reads the timescale and header', () => {
        assert.equal(m.timescaleFs, 10e6);
        assert.equal(m.timescale, '10 ns');
        assert.equal(m.version, 'hand-written');
        assert.equal(m.endTime, 4);
        assert.equal(parseVcd('$timescale\n  1 fs\n$end\n$enddefinitions $end\n').timescaleFs, 1);
        assert.throws(() => parseVcd('$timescale 3 ns $end'), /unsupported \$timescale/);
    });

    it('reads nested scopes, scalars and vectors (range glued or separate), and aliases', () => {
        assert.deepEqual(m.signals.map((s) => `${s.path}:${s.width}`), ['tb.clk:1', 'tb.bus[3:0]:4', 'tb.dut.q:1', 'tb.dut.count[7:0]:8', 'tb.dut.clk:1']);
        assert.deepEqual([sig('tb.bus[3:0]').msb, sig('tb.bus[3:0]').lsb], [3, 0]);
        assert.equal(sig('tb.dut.count[7:0]').name, 'count');
        assert.equal(sig('tb.dut.clk').code, sig('tb.clk').code, 'aliases share one trace');
        assert.deepEqual(m.root.scopes[0]!.scopes.map((s) => s.name), ['dut', 'empty']);
        assert.deepEqual(pruneEmptyScopes(m.root).scopes[0]!.scopes.map((s) => s.name), ['dut'], 'empty scopes (e.g. GHDL packages) are pruned');
    });

    it('reads value changes with x/z and VHDL values, left-extending vectors', () => {
        assert.deepEqual(trace('tb.bus[3:0]'), { width: 4, times: [0, 1, 3], values: ['xxxx', '0001', '0101'] });
        assert.deepEqual(trace('tb.dut.q'), { width: 1, times: [0, 2, 3, 4], values: ['x', 'z', '1', 'x'] }, 'U and X become x');
        assert.deepEqual(trace('tb.dut.count[7:0]').values, ['00000000', '11111111']);
        assert.equal(extendVector('z1', 4), 'zzz1');
        assert.equal(extendVector('110011', 4), '0011', 'too long: keep the low bits');
    });

    it('collapses redundant transitions and repeated changes at one time', () => {
        // bus: b1 at #1 and again at #2 -> one change; clk: 1,1,0 at #3 after 0 at #2 -> no change at #3.
        assert.deepEqual(trace('tb.clk'), { width: 1, times: [0, 1, 2], values: ['0', '1', '0'] });
        assert.equal(trace('tb.bus[3:0]').times.includes(2), false);
    });

    it('parses the real GHDL waveform of the starter testbench', async () => {
        const vcd = parseVcd(await readFile(join(FIXTURES, 'ghdl', 'top_tb.vcd'), 'utf8'));
        assert.equal(vcd.timescaleFs, 1);
        assert.equal(vcd.endTime, 660_000_000, 'stopped at 660 ns');
        const paths = vcd.signals.map((s) => s.path);
        for (const p of ['top_tb.clk', 'top_tb.btnc', 'top_tb.sw0', 'top_tb.led0', 'top_tb.dut.u_blink.count[3:0]']) assert.ok(paths.includes(p), p);
        const clk = vcd.traces.get(vcd.signals.find((s) => s.path === 'top_tb.clk')!.code)!;
        assert.equal(clk.times[1], 5_000_000, 'the 100 MHz clock toggles every 5 ns');
        assert.deepEqual(vcd.warnings, []);
        const data = toWaveData(vcd);
        assert.deepEqual(data.tree.scopes.map((s) => s.name), ['top_tb'], 'GHDL package scopes are pruned');
        assert.ok(data.initial.map((i) => data.signals[i]!.path).includes('top_tb.led0'));
    });
});

describe('waveform rendering helpers', () => {
    const times = [0, 10, 20, 30, 31, 32, 33, 60];
    const values = ['0', '1', '0', '1', '0', '1', '0', '1'];

    it('looks up the value at the cursor', () => {
        assert.equal(indexAt(times, -1), -1);
        assert.equal(valueAt(times, values, -1), undefined);
        assert.equal(valueAt(times, values, 0), '0');
        assert.equal(valueAt(times, values, 15), '1');
        assert.equal(valueAt(times, values, 20), '0');
        assert.equal(valueAt(times, values, 1000), '1');
    });

    it('formats vectors in binary and hexadecimal, including x/z', () => {
        assert.equal(formatValue('0101', 4, 'bin'), '0101');
        assert.equal(formatValue('0101', 4, 'hex'), '5');
        assert.equal(formatValue('000011011', 9, 'hex'), '01B');
        assert.equal(formatValue('xxxx0001', 8, 'hex'), 'X1');
        assert.equal(formatValue('zzzz', 4, 'hex'), 'Z');
        assert.equal(formatValue('1', 1, 'hex'), '1', 'scalars are not converted');
        assert.equal(formatValue(undefined, 4, 'hex'), '—');
    });

    it('reduces traces to visible segments and merges sub-pixel changes', () => {
        const wide = traceSegments(times, values, 0, 60, 600);
        assert.equal(wide.length, 8);
        assert.deepEqual(wide[1], { x0: 100, x1: 200, value: '1' });
        const narrow = traceSegments(times, values, 0, 60, 60, 2);
        assert.ok(narrow.length < 8);
        assert.ok(narrow.some((s) => s.dense), 'the burst at 30..33 becomes one dense segment');
        const window = traceSegments(times, values, 15, 25, 100);
        assert.deepEqual(window.map((s) => s.value), ['1', '0'], 'starts with the value already active at t0');
        assert.equal(window[0]!.x0, 0);
        // Cost depends on pixels, not events.
        const many = Array.from({ length: 100_000 }, (_, i) => i);
        const vals = many.map((i) => (i % 2 ? '1' : '0'));
        assert.ok(traceSegments(many, vals, 0, 100_000, 800).length <= 400);
    });

    it('formats times, ticks and clamps views', () => {
        assert.equal(formatTime(660_000_000, 1), '660 ns');
        assert.equal(formatTime(5, 1e6), '5 ns');
        assert.equal(formatTime(1250, 1e6), '1.25 us');
        assert.deepEqual(niceTicks(0, 100, 500, 100), [0, 20, 40, 60, 80, 100]);
        assert.deepEqual(clampView(-10, 40, 100), [0, 50]);
        assert.deepEqual(clampView(80, 130, 100), [50, 100]);
    });

    it('builds webview data and a page that loads the shared renderer under a strict CSP', () => {
        const data = toWaveData(parseVcd(SAMPLE));
        assert.deepEqual(data.signals.map((s) => s.name), ['clk', 'bus[3:0]', 'q', 'count[7:0]', 'clk']);
        assert.deepEqual(data.initial, [0, 1, 2, 3, 4]);
        assert.deepEqual(data.traces[data.signals[1]!.code], { times: [0, 1, 3], values: ['xxxx', '0001', '0101'] });
        const html = renderWaveHtml({ nonce: 'abc', cspSource: 'vscode-resource:', rendererUri: 'vscode-resource:/wave-render.js' });
        assert.match(html, /script-src 'nonce-abc' vscode-resource:;/);
        assert.match(html, /<script nonce="abc" src="vscode-resource:\/wave-render.js"><\/script>/);
        assert.match(html, /id="fit"[\s\S]*id="zin"[\s\S]*id="zout"/);
    });
});

describe('waveform artifact from the shared simulation backend', () => {
    async function newProject(t: TestContext) {
        const parent = await tempDir(t);
        const r = await createProject({ parentDir: parent, name: 'Wave', board: (await repoBoards()).get('nexys-a7-100t')! });
        assert.ok(r.ok);
        const loaded = await loadProject(r.root);
        assert.ok(loaded.ok);
        return loaded.project;
    }

    it('Simulate asks GHDL for a VCD in .nexysvhdl/sim and returns it (with hash) in the SimulationResult', async (t) => {
        const project = await newProject(t);
        const srcBefore = await readdir(join(project.root, 'src'));
        const runner = new FakeRunner((inv) => {
            const vcd = inv.args.find((a) => a.startsWith('--vcd='));
            if (vcd) writeFileSync(vcd.slice('--vcd='.length), SAMPLE);
            return inv.args[0] === '-r' ? { stdout: 'top_tb.vhd:1:1:@660ns:(report note): ALL TESTS PASSED\n' } : {};
        });
        const controller = new WorkflowController({ boards: await repoBoards(), workspaces: new WorkspaceManager(), vhdl: new GhdlVhdlProvider('/fake/ghdl', runner) });
        const r = await controller.simulate(project);
        const simDir = join(project.root, '.nexysvhdl', 'sim');
        const run = runner.calls.find((c) => c.args[0] === '-r')!;
        assert.ok(run.args.includes(`--vcd=${join(simDir, VCD_FILE)}`));
        assert.ok(run.args.some((a) => a.startsWith('--wave=')), 'the GHW waveform is still written');
        assert.equal(r.vcd?.path, join(simDir, 'waveform.vcd'));
        assert.equal(r.vcd?.kind, 'waveform');
        assert.equal(r.vcd?.sha256, await sha256File(join(simDir, 'waveform.vcd')));
        assert.deepEqual(await readdir(join(project.root, 'src')), srcBefore);
        assert.ok(!(await readdir(join(project.root, 'sim'))).some((f) => f.endsWith('.vcd')), 'nothing beside the testbench');
    });

    it('a second simulation gives a new waveform identity in the service', async (t) => {
        const parent = await tempDir(t);
        const created = await createProject({ parentDir: parent, name: 'Wave2', board: (await repoBoards()).get('nexys-a7-100t')! });
        assert.ok(created.ok);
        const backend = new FakeBackend();
        const service = new NexysVhdlService({ backend, debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(created.root);
        const vcd = (sha: string) => ({ kind: 'waveform' as const, path: join(created.root, '.nexysvhdl', 'sim', 'waveform.vcd'), canonical: false, sha256: sha });
        backend.simResult = { ...OK, testbench: 'top_tb', passed: true, messages: [], vcd: vcd('aaa') };
        await service.simulate();
        const first = { run: service.simulationRun, result: service.lastSimulation, at: service.lastSimulationAt };
        backend.simResult = { ...OK, testbench: 'top_tb', passed: true, messages: [], vcd: vcd('bbb') };
        await service.simulate();
        assert.equal(first.run, 1);
        assert.equal(service.simulationRun, 2);
        assert.notEqual(service.lastSimulation, first.result);
        assert.equal(service.lastSimulation?.vcd?.sha256, 'bbb');
        assert.ok(service.lastSimulationAt! >= first.at!);
    });
});
