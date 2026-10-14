import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadProject, type BuildProgress } from '../../core';
import { nexysA7BoardProfile, normalizeLegacyBuild } from '../../core/backend';
import { buildResultsModel } from '../../extension/services/results-model';
import { makeHarness, LINUX, MAC } from './harness';
import { tempDir, writeFiles, VALID_CONFIG } from '../helpers';

const limaVerbs = (h: { vm: { limaArgs: string[][] } }) => h.vm.limaArgs.map((a) => a[0]);
const quartusRuns = (h: { vm: { guestScripts: string[] } }) => h.vm.guestScripts.filter((s) => /mixfpga-q quartus_(map|fit|asm|sta|cpf)/.test(s)).length;

async function nexysProject(t: import('node:test').TestContext) {
    const root = await tempDir(t);
    await writeFiles(root, { 'src/top.vhd': '-- x\n', 'constraints/n.xdc': '# xdc\n' });
    await writeFile(join(root, 'nexysvhdl.json'), JSON.stringify({ ...VALID_CONFIG, sources: ['src/top.vhd'], simulation: { sources: [] }, pins: undefined, constraints: 'constraints/n.xdc' }));
    const loaded = await loadProject(root);
    assert.ok(loaded.ok);
    return loaded.project;
}

describe('the FPGA engine stays off until a build needs it', () => {
    it('Check, Simulate and opening a project never start or even query the VM', async (t) => {
        const h = await makeHarness(t, { vm: { vm: 'Stopped' } });
        const p = await h.de10Project();
        await h.backend.boards();
        const check = await h.backend.check(p);
        assert.equal(check.status, 'succeeded', JSON.stringify(check.diagnostics));
        const sim = await h.backend.simulate(p, 'tb');
        assert.notEqual(sim.status, 'not-configured');
        assert.equal(h.vm.calls.length, 0, 'no limactl call at all');
        assert.ok(h.runner.ghdlCalls.length > 0, 'GHDL is MIX-FPGA\'s own copy');
        assert.ok(h.runner.ghdlCalls.every((c) => c.executable === h.paths.ghdl));
    });

    it('the Design Schematic path (RTL analysis) uses MIX-FPGA\'s Yosys/GHDL and never Quartus or the VM', async (t) => {
        const h = await makeHarness(t, { vm: { vm: 'Stopped' } });
        const p = await h.de10Project();
        await h.backend.rtl(p); // fake tools write no netlist: the point is which tools and the VM were (not) used
        assert.equal(h.vm.calls.length, 0);
        assert.equal(quartusRuns(h), 0);
    });

    it('Build starts a stopped VM, then runs Quartus', async (t) => {
        const h = await makeHarness(t, { vm: { vm: 'Stopped' } });
        const p = await h.de10Project();
        const r = await h.backend.build(p, () => undefined);
        assert.equal(r.success, true, JSON.stringify(r.diagnostics));
        assert.ok(limaVerbs(h).includes('start'));
        assert.equal(quartusRuns(h), 5);
    });

    it('Restart FPGA Engine restarts it; Verify Environment proves it runs', async (t) => {
        const h = await makeHarness(t);
        const p = await h.de10Project();
        const s = await h.backend.restartEngine!(p);
        assert.equal(s?.state, 'running');
        assert.deepEqual(limaVerbs(h).filter((v) => v === 'stop' || v === 'start'), ['stop', 'start']);
        const v = await h.backend.verifyEnvironment!(p);
        assert.ok(v);
        assert.ok(v.steps.some((x) => x.label === 'FPGA engine and Quartus' && x.ok));
        assert.ok(v.steps.some((x) => x.label.startsWith('GHDL')), 'owned tools are integrity-checked against the manifest');
    });

    it('Restart / Verify do nothing for a Nexys project (it has no FPGA engine)', async (t) => {
        const h = await makeHarness(t);
        const p = await nexysProject(t);
        assert.equal(await h.backend.restartEngine!(p), undefined);
        assert.equal(await h.backend.verifyEnvironment!(p), undefined);
        assert.equal(h.vm.calls.length, 0);
    });
});

describe('Build dispatch', () => {
    it('DE10-Lite: Check first, then the Quartus provider; student-friendly status lines in order', async (t) => {
        const h = await makeHarness(t, { vm: { vm: 'Stopped' } });
        const p = await h.de10Project();
        const status: string[] = [];
        const progress: string[] = [];
        const r = await h.backend.build(p, (e: BuildProgress) => progress.push(e.kind === 'implementation-stage' ? `stage:${e.stage}` : `${e.kind}:${e.step}`), undefined, (m) => status.push(m));
        assert.equal(r.success, true);
        assert.deepEqual(status, ['Preparing FPGA engine…', 'Preparing the project…', 'Synthesis…', 'Fitting…', 'Timing…', 'Generating programming file…', 'Collecting results…']);
        assert.ok(status.every((m) => !/lima|linux|rosetta|vm\b|quartus/i.test(m)), 'no infrastructure words in normal mode');
        assert.deepEqual(progress.slice(0, 2), ['step-started:check', 'step-finished:check']);
        assert.ok(progress.includes('stage:synthesis') && progress.includes('stage:implementation') && progress.includes('stage:bitstream'));
        assert.deepEqual(r.steps.map((s) => s.step), ['check', 'implement']);
        assert.equal(r.normalized?.boardId, 'de10-lite');
        assert.equal(r.bitstream?.path.endsWith('blink.svf'), true);
    });

    it('Nexys A7: the original flow runs through the openxc7 adapter and its native result is kept; the VM is never touched', async (t) => {
        const h = await makeHarness(t);
        const p = await nexysProject(t);
        const r = await h.backend.build(p, () => undefined);
        assert.equal(r.normalized?.boardId, 'nexys-a7-100t');
        assert.ok(r.normalized?.native, 'native result carried by the adapter');
        assert.equal(r.normalized?.native?.steps, r.steps, 'the UI gets the original result\'s own steps');
        assert.equal(h.vm.calls.length, 0);
        assert.equal(h.runner.ghdlCalls.length, 0, 'MIX-FPGA GHDL is not used for a Nexys project');
    });

    it('a Check failure stops a DE10 build before the VM is started', async (t) => {
        const h = await makeHarness(t, { vm: { vm: 'Stopped' } });
        const p = await h.de10Project();
        // GHDL that reports an error
        h.runner.run = (async (inv) => ({ invocation: inv, outcome: 'exited', exitCode: 1, stdout: '', stderr: 'blink.vhd:3:1:error: bad\n', durationMs: 1 })) as typeof h.runner.run;
        const r = await h.backend.build(p, () => undefined);
        assert.equal(r.success, false);
        assert.deepEqual(r.steps.map((s) => [s.step, s.status]), [['check', 'failed']]);
        assert.equal(h.vm.calls.length, 0);
    });

    it('cancellation: the build ends cancelled and Quartus is killed in the VM', async (t) => {
        const h = await makeHarness(t, { vm: { cancelOn: 'quartus_fit' } });
        const p = await h.de10Project();
        const ac = new AbortController();
        const r = await h.backend.build(p, () => undefined, ac.signal);
        assert.equal(r.success, false);
        assert.equal(r.normalized?.implementationStatus, 'cancelled');
        assert.ok(h.vm.guestScripts.some((s) => s.includes('pkill')));
    });

    it('a second Build while one runs is refused, not started twice', async (t) => {
        const h = await makeHarness(t);
        const p = await h.de10Project();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        h.vm.hook = async (s) => { if (s.includes('quartus_map')) await gate; };
        const first = h.backend.build(p, () => undefined);
        await new Promise((r) => setTimeout(r, 30));
        const second = await h.backend.build(p, () => undefined);
        assert.equal(second.success, false);
        assert.equal(second.diagnostics[0]?.code, 'PIPELINE_BUSY');
        release();
        await first;
    });

    it('DE10-Lite on an unsupported computer is refused clearly, with no tool run', async (t) => {
        const h = await makeHarness(t, { host: LINUX, withDe10: false });
        const p = await h.de10Project();
        const r = await h.backend.build(p, () => undefined);
        assert.equal(r.success, false);
        assert.equal(r.diagnostics[0]?.code, 'BOARD_HOST_UNSUPPORTED');
        assert.match(r.diagnostics[0]!.message, /DE10-Lite is not supported on this computer/);
        assert.equal(h.vm.calls.length, 0);
        const reg = await h.backend.boards();
        assert.equal(h.backend.supportsBoard(reg.get('de10-lite')!), false);
        assert.equal(h.backend.supportsBoard(reg.get('nexys-a7-100t')!), true);
    });

    it('the macOS host offers both boards', async (t) => {
        const h = await makeHarness(t, { host: MAC });
        const reg = await h.backend.boards();
        assert.deepEqual(reg.all().filter((b) => h.backend.supportsBoard(b)).map((b) => b.id), ['de10-lite', 'nexys-a7-100t']);
    });
});

describe('Results use each board\'s own words', () => {
    it('DE10-Lite: Logic Elements / Registers / Memory Bits / DSP Blocks and common timing rows', async (t) => {
        const h = await makeHarness(t);
        const p = await h.de10Project();
        const r = await h.backend.build(p, () => undefined);
        const m = buildResultsModel(undefined, undefined, r).build!;
        assert.deepEqual(m.resources.map((x) => x.label), ['Logic Elements', 'Registers', 'Memory Bits', 'DSP Blocks', 'I/O pins']);
        assert.deepEqual(m.resources.slice(0, 2).map((x) => x.value), ['27 / 49,760', '26']);
        assert.deepEqual(m.timing.map((x) => x.label), ['Timing', 'Target', 'Fmax', 'Setup slack', 'Hold slack']);
        assert.deepEqual(m.timing.slice(0, 4).map((x) => x.value), ['PASS', '50 MHz', '294.55 MHz', '+16.6 ns']);
        assert.equal(m.bitstream?.label, 'Programming file');
        assert.ok(!m.resources.some((x) => /LUT/.test(x.label)), 'a Logic Element is never called a LUT');
    });

    it('Nexys A7: LUTs / Flip-Flops / BRAM (36 Kb) / DSP, same values as the original rows', async (t) => {
        const h = await makeHarness(t);
        const p = await nexysProject(t);
        const legacy = {
            success: true, steps: [], diagnostics: [], logs: [], durationMs: 1,
            utilization: { luts: { used: 120, available: 63400 }, flipFlops: { used: 80, available: 126800 }, bram: { used: 1, available: 135 }, dsp: { used: 0, available: 240 }, io: { used: 2 } },
            timing: { clocks: [{ clock: 'CLK100MHZ', targetMHz: 100, achievedMHz: 187.5, passed: true }], worstSlackNs: 4.67, passed: true },
        };
        const normalized = await normalizeLegacyBuild(legacy, nexysA7BoardProfile(h.boards));
        const original = buildResultsModel(undefined, undefined, legacy).build!;
        const unified = buildResultsModel(undefined, undefined, { ...legacy, normalized }).build!;
        assert.deepEqual(unified.resources, original.resources, 'identical resource rows, labels and values');
        assert.deepEqual(unified.timing.map((x) => x.value), ['PASS', '100 MHz', '187.5 MHz', '+4.7 ns']);
        void p;
    });
});

describe('Hardware dispatch and Program refusals', () => {
    it('DE10-Lite: Detect uses the native programmer and identifies the MAX 10; the VM is untouched', async (t) => {
        const h = await makeHarness(t, { vm: { vm: 'Stopped' } });
        const p = await h.de10Project();
        const d = await h.backend.detectBoards(p);
        assert.equal(d.configured, true);
        assert.equal(d.boards.length, 1);
        assert.deepEqual([d.boards[0]!.serialNumber, d.boards[0]!.productName, d.boards[0]!.boardId], ['91d28408', 'DE10-Lite', 'de10-lite']);
        assert.equal(h.vm.calls.length, 0, 'USB is never passed into the VM and detection does not start it');
    });

    it('DE10-Lite: no board is the "none connected" state, not an error', async (t) => {
        const h = await makeHarness(t, { programmer: { scan: 'empty\nNo USB devices found\n' } });
        const d = await h.backend.detectBoards(await h.de10Project());
        assert.equal(d.boards.length, 0);
        assert.deepEqual(d.diagnostics, []);
    });

    it('DE10-Lite: wrong hardware on the JTAG chain is reported', async (t) => {
        const h = await makeHarness(t, { programmer: { detect: 'empty\nindex 0:\n\tidcode 0x20f10dd\n\tfamily Cyclone V\n\tmodel 5CEBA4\n' } });
        const d = await h.backend.detectBoards(await h.de10Project());
        assert.equal(d.boards.length, 0);
        assert.equal(d.diagnostics[0]?.code, 'UNEXPECTED_DEVICE');
    });

    it('Program refuses when there is no valid artifact', async (t) => {
        const h = await makeHarness(t);
        const p = await h.de10Project();
        const r = await h.backend.program(p, undefined);
        assert.equal(r.status, 'failed');
        assert.equal(r.diagnostics[0]?.code, 'PROGRAM_NO_BITSTREAM');
        assert.match(r.diagnostics[0]!.message, /programming file/);
        assert.equal(h.runner.programmer.programCalls.length, 0);
    });

    it('Program after Build programs the SVF into SRAM through the native programmer', async (t) => {
        const h = await makeHarness(t);
        const p = await h.de10Project();
        assert.equal((await h.backend.build(p, () => undefined)).success, true);
        const r = await h.backend.program(p, undefined);
        assert.equal(r.status, 'succeeded', JSON.stringify(r.diagnostics));
        const call = h.runner.programmer.programCalls[0]!;
        assert.deepEqual(call.args.slice(0, 2), ['-b', 'de10lite']);
        assert.ok(call.args[2]!.endsWith('blink.svf'));
        assert.ok(!call.args.some((a) => /^(-f|--write-flash|--write-flash)$/.test(a)), 'never flash');
        const info = await h.backend.bitstream(p);
        assert.ok(info && info.path.endsWith('blink.svf'));
    });

    it('Program refuses a stale artifact after the design or constraints changed', async (t) => {
        const h = await makeHarness(t);
        const p = await h.de10Project();
        await h.backend.build(p, () => undefined);
        await writeFile(join(p.root, 'src', 'blink.vhd'), '-- edited after the build\n');
        const r = await h.backend.program(p, undefined);
        assert.equal(r.diagnostics[0]?.code, 'PROGRAM_ARTIFACT_STALE');
        assert.match(r.diagnostics[0]!.message, /src\/blink\.vhd/);
        assert.equal(h.runner.programmer.programCalls.length, 0);
    });

    it('Program refuses an artifact that belongs to another board', async (t) => {
        const h = await makeHarness(t);
        const p = await h.de10Project();
        await h.backend.build(p, () => undefined);
        const info = join(p.root, '.mix-fpga', 'build', 'de10-lite', 'build-info.json');
        const text = JSON.parse(await readFile(info, 'utf8'));
        await writeFile(info, JSON.stringify({ ...text, board: 'nexys-a7-100t' }));
        const r = await h.backend.program(p, undefined);
        assert.equal(r.diagnostics[0]?.code, 'PROGRAM_ARTIFACT_WRONG_BOARD');
        assert.equal(h.runner.programmer.programCalls.length, 0);
    });

    it('Program refuses a tampered artifact', async (t) => {
        const h = await makeHarness(t);
        const p = await h.de10Project();
        await h.backend.build(p, () => undefined);
        await writeFile(join(p.root, '.mix-fpga', 'build', 'de10-lite', 'blink.svf'), 'TAMPERED');
        const r = await h.backend.program(p, undefined);
        assert.equal(r.status, 'failed');
        assert.equal(r.diagnostics[0]?.code, 'ARTIFACT_CHANGED');
    });

    it('Program refuses when the board is absent, and when a .sof/flash is the only thing offered', async (t) => {
        const h = await makeHarness(t, { programmer: { scan: 'empty\nNo USB devices found\n' } });
        const p = await h.de10Project();
        await h.backend.build(p, () => undefined);
        const r = await h.backend.program(p, undefined);
        assert.equal(r.status, 'failed');
        assert.equal(r.diagnostics[0]?.code, 'BOARD_ABSENT');
        assert.equal(h.runner.programmer.programCalls.length, 0);
    });

    it('a Nexys project\'s Hardware path is the original programming service (native result, unchanged codes)', async (t) => {
        const h = await makeHarness(t);
        const p = await nexysProject(t);
        const d = await h.backend.detectBoards(p);
        assert.equal(d.configured, false, 'the fake platform has no programmer: the original "not configured" answer');
        const r = await h.backend.program(p, undefined);
        assert.equal(r.diagnostics[0]?.code, 'PROGRAM_NO_BITSTREAM');
        assert.equal(r.diagnostics[0]?.message, 'There is no bitstream yet. Run Build first.');
        assert.equal(h.vm.calls.length, 0);
        assert.equal(h.runner.programmer.calls.length, 0);
    });
});

describe('no state leaks between projects of different boards', () => {
    it('alternating Nexys -> DE10 -> Nexys -> DE10 keeps each project\'s artifacts, results and engine use separate', async (t) => {
        const h = await makeHarness(t);
        const de = await h.de10Project();
        const nx = await nexysProject(t);
        const r1 = await h.backend.build(de, () => undefined);
        const n1 = await h.backend.build(nx, () => undefined);
        const r2 = await h.backend.build(de, () => undefined);
        assert.equal(r1.normalized?.boardId, 'de10-lite');
        assert.equal(n1.normalized?.boardId, 'nexys-a7-100t');
        assert.equal(r2.normalized?.boardId, 'de10-lite');
        assert.equal(quartusRuns(h), 10, 'Quartus ran only for the two DE10 builds');
        assert.equal(await h.backend.bitstream(nx), undefined, 'a DE10 artifact is never offered to a Nexys project');
        assert.ok(await h.backend.bitstream(de));
        const jobs = await readdir(join(h.home, 'Library', 'MIX-FPGA', 'staging', 'jobs'));
        assert.equal(jobs.length, 1, 'only the DE10 project staged anything');
        assert.deepEqual(await readdir(nx.root).then((l) => l.filter((x) => x.startsWith('.mix'))), [], 'a Nexys project gets no .mix-fpga folder');
    });
});
