import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
    activeOperation,
    ApioImplementationProvider,
    busyMessage,
    countPrimitives,
    GhdlVhdlProvider,
    type ImplementationProvider,
    type ImplementationRequest,
    type ImplementationResult,
    listVerilogModules,
    normalizeStopTime,
    parseGhdlOutput,
    type RtlProvider,
    type RtlRequest,
    resolveTopModule,
    rtlYosysScript,
    type SimulationOptions,
    type SimulationResult,
    type SynthesisResult,
    type VhdlCheckResult,
    type VhdlContext,
    type VhdlProvider,
    validateProject,
    verilogTopPorts,
    withProjectLock,
    WorkflowController,
    WorkspaceManager,
} from '../core';
import { writeFile } from 'node:fs/promises';
import { FakeRunner, makeProject, repoBoards, writeFiles } from './helpers';

const ok = { status: 'succeeded' as const, diagnostics: [], logs: [], durationMs: 1 };

/** What GHDL printed for the pilot's `DigitDisplay` design (module name keeps the VHDL spelling). */
const DIGIT_DISPLAY_VERILOG = 'module DigitDisplay(input sw, output led);\nendmodule\n';

describe('mixed-case top entity (pilot bug: DigitDisplay -> GHDL_SYNTH_NO_TOP)', () => {
    it('resolves the VHDL top case-insensitively and returns the spelling GHDL emitted', () => {
        assert.equal(resolveTopModule(['DigitDisplay', 'counter'], 'digitdisplay'), 'DigitDisplay');
        assert.equal(resolveTopModule(['DigitDisplay'], 'DIGITDISPLAY'), 'DigitDisplay');
        assert.equal(resolveTopModule(['digitdisplay'], 'DigitDisplay'), 'digitdisplay', 'the old all-lower-case output still works');
        assert.equal(resolveTopModule(['top', 'Top'], 'Top'), 'Top', 'an exact match wins');
        assert.equal(resolveTopModule(['other'], 'DigitDisplay'), undefined);
    });

    for (const configured of ['DigitDisplay', 'digitdisplay', 'DIGITDISPLAY']) {
        it(`synthesize succeeds for a top configured as "${configured}" and reports the emitted module`, async (t) => {
            const project = await makeProject(t, { top: configured, sources: ['src/DigitDisplay.vhd'] });
            const { workspace } = await new WorkspaceManager().open(project);
            const runner = new FakeRunner((inv) => (inv.args[0] === '--synth' ? { stdout: DIGIT_DISPLAY_VERILOG } : {}));
            const r = await new GhdlVhdlProvider('/fake/ghdl', runner).synthesize({ project, workspace: workspace! });
            assert.equal(r.status, 'succeeded', JSON.stringify(r.diagnostics));
            assert.equal(r.topModule, 'DigitDisplay');
            assert.deepEqual(r.modules, ['DigitDisplay']);
            assert.match(readFileSync(r.generatedVerilog!.path, 'utf8'), /module DigitDisplay\b/, 'the netlist is kept as GHDL wrote it');
        });
    }

    it('still reports GHDL_SYNTH_NO_TOP when the module really is missing, naming what was found', async (t) => {
        const project = await makeProject(t, { top: 'DigitDisplay' });
        const { workspace } = await new WorkspaceManager().open(project);
        const runner = new FakeRunner((inv) => (inv.args[0] === '--synth' ? { stdout: 'module other(input a);\nendmodule\n' } : {}));
        const r = await new GhdlVhdlProvider('/fake/ghdl', runner).synthesize({ project, workspace: workspace! });
        assert.equal(r.status, 'failed');
        assert.equal(r.diagnostics.find((d) => d.code === 'GHDL_SYNTH_NO_TOP')?.message.includes('other'), true);
    });

    it('reads the top ports whatever the case, for the XDC port check', () => {
        const ports = verilogTopPorts(DIGIT_DISPLAY_VERILOG, 'DigitDisplay');
        assert.deepEqual(ports?.map((p) => p.name), ['sw', 'led']);
        assert.deepEqual(verilogTopPorts(DIGIT_DISPLAY_VERILOG, 'digitdisplay')?.map((p) => p.name), ['sw', 'led']);
    });

    it('gives Yosys the exact module spelling (Verilog names are case-sensitive)', () => {
        assert.match(rtlYosysScript('generated.v', 'DigitDisplay'), /hierarchy -check -top DigitDisplay;/);
        assert.deepEqual(listVerilogModules(DIGIT_DISPLAY_VERILOG), ['DigitDisplay']);
    });

    it('the Yosys netlist of a mixed-case top is counted from the exact module name', () => {
        const json = JSON.stringify({ modules: { DigitDisplay: { attributes: { top: 1 }, cells: { a: { type: '$lut' }, b: { type: '$lut' } } } } });
        assert.deepEqual(countPrimitives(json, 'DigitDisplay'), { $lut: 2 });
    });

    it('Apio gets the exact module as top-module (and the old lower-case default is kept without one)', async (t) => {
        const project = await makeProject(t, { top: 'DigitDisplay' });
        const { workspace } = await new WorkspaceManager().open(project);
        const boards = await repoBoards();
        const ini: string[] = [];
        const runner = new FakeRunner((inv) => {
            ini.push(readFileSync(join(inv.cwd!, 'apio.ini'), 'utf8'));
            return { exitCode: 1 };
        });
        const provider = new ApioImplementationProvider('/fake/apio', runner);
        const verilog = join(workspace!.paths.synth, 'generated.v');
        await writeFile(verilog, DIGIT_DISPLAY_VERILOG);
        const req = { project, board: boards.get('nexys-a7-100t')!, workspace: workspace!, verilog: { kind: 'generated-verilog' as const, path: verilog, canonical: false }, xdc: '' };
        await provider.implement({ ...req, topModule: 'DigitDisplay' });
        await provider.implement(req);
        assert.match(ini[0]!, /top-module = DigitDisplay\n/);
        assert.match(ini[1]!, /top-module = digitdisplay\n/);
    });

    it('Build and RTL hand the emitted spelling to every downstream step', async (t) => {
        const project = await makeProject(t, { top: 'digitdisplay' });
        let implTop: string | undefined;
        let rtlTop: string | undefined;
        const vhdl = new ScriptedVhdl({ synthTopModule: 'DigitDisplay', verilog: DIGIT_DISPLAY_VERILOG });
        const impl: ImplementationProvider = {
            id: 'impl',
            async implement(req: ImplementationRequest): Promise<ImplementationResult> {
                implTop = req.topModule;
                return { ...ok, stagedFiles: [] };
            },
        };
        const rtl: RtlProvider = {
            id: 'rtl',
            async elaborate(req: RtlRequest) {
                rtlTop = req.top;
                return { ...ok };
            },
        };
        const controller = new WorkflowController({ boards: await repoBoards(), workspaces: new WorkspaceManager(), vhdl, implementation: impl, rtl });
        const build = await controller.build(project);
        assert.ok(build.steps.find((s) => s.step === 'constraints')?.status === 'succeeded', JSON.stringify(build.diagnostics));
        assert.equal(implTop, 'DigitDisplay');
        await controller.rtl(project);
        assert.equal(rtlTop, 'DigitDisplay');
    });
});

// --------------------------------------------------------------------------

/** A VHDL front end whose operations can be held open, made to fail or to throw. */
class ScriptedVhdl implements VhdlProvider {
    readonly id = 'scripted';
    readonly calls: string[] = [];
    gate: Promise<void> | undefined;
    checkStatus: 'succeeded' | 'failed' = 'succeeded';
    throwOn: 'check' | 'simulate' | 'synthesize' | undefined;
    simOptions: SimulationOptions | undefined;
    constructor(private readonly opts: { synthTopModule?: string; verilog?: string } = {}) {}
    async check(): Promise<VhdlCheckResult> {
        this.calls.push('check');
        await this.gate;
        if (this.throwOn === 'check') throw new Error('boom');
        return { ...ok, status: this.checkStatus, elaborated: [], ...(this.checkStatus === 'failed' ? { diagnostics: [{ severity: 'error' as const, source: 'vhdl' as const, code: 'MOCK', message: 'bad' }] } : {}) };
    }
    async simulate(_ctx: VhdlContext, o: SimulationOptions): Promise<SimulationResult> {
        this.calls.push('simulate');
        this.simOptions = o;
        await this.gate;
        if (this.throwOn === 'simulate') throw new Error('boom');
        return { ...ok, testbench: o.testbench, passed: true, messages: [] };
    }
    async synthesize(ctx: VhdlContext): Promise<SynthesisResult> {
        this.calls.push('synthesize');
        await this.gate;
        if (this.throwOn === 'synthesize') throw new Error('boom');
        const path = join(ctx.workspace.paths.synth, 'generated.v');
        await writeFile(path, this.opts.verilog ?? 'module top(); endmodule\n');
        return { ...ok, top: ctx.project.config.top, ...(this.opts.synthTopModule ? { topModule: this.opts.synthTopModule } : {}), modules: [], generatedVerilog: { kind: 'generated-verilog', path, canonical: false } };
    }
}

async function controllerWith(vhdl: VhdlProvider, impl?: ImplementationProvider, rtl?: RtlProvider) {
    return new WorkflowController({ boards: await repoBoards(), workspaces: new WorkspaceManager(), vhdl, ...(impl ? { implementation: impl } : {}), ...(rtl ? { rtl } : {}) });
}

const holdOpen = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    return { gate, release };
};
const tick = () => new Promise((r) => setTimeout(r, 15));

describe('single-flight guard (pilot bug: four simultaneous Builds collided on .nexysvhdl/synth, EBUSY)', () => {
    it('four simultaneous Builds start exactly one; the others answer "Build is already running."', async (t) => {
        const project = await makeProject(t);
        const vhdl = new ScriptedVhdl();
        const { gate, release } = holdOpen();
        vhdl.gate = gate;
        const controller = await controllerWith(vhdl);
        const runs = [1, 2, 3, 4].map(() => controller.build(project));
        await tick();
        assert.equal(activeOperation(project.root), 'build');
        release();
        const results = await Promise.all(runs);
        assert.equal(vhdl.calls.filter((c) => c === 'check').length, 1, 'only one pipeline ran');
        const refused = results.filter((r) => r.diagnostics.some((d) => d.code === 'PIPELINE_BUSY'));
        assert.equal(refused.length, 3);
        for (const r of refused) {
            assert.equal(r.success, false);
            assert.equal(r.diagnostics[0]!.message, 'Build is already running.');
            assert.deepEqual(r.steps, [], 'a refused request touches nothing');
        }
        assert.equal(activeOperation(project.root), undefined);
    });

    it('Check, Simulate, Build and RTL exclude each other, and name what is running', async (t) => {
        const project = await makeProject(t);
        const vhdl = new ScriptedVhdl();
        const { gate, release } = holdOpen();
        vhdl.gate = gate;
        const controller = await controllerWith(vhdl);
        const build = controller.build(project);
        await tick();
        const check = await controller.check(project);
        const sim = await controller.simulate(project);
        const rtl = await controller.rtl(project);
        for (const r of [check, sim, rtl]) {
            assert.equal(r.status, 'failed');
            assert.equal(r.diagnostics[0]!.code, 'PIPELINE_BUSY');
            assert.equal(r.diagnostics[0]!.message, 'Build is already running.');
        }
        release();
        await build;
        assert.deepEqual(vhdl.calls.filter((c) => c === 'synthesize' || c === 'simulate'), ['synthesize'], 'the refused Simulate and RTL ran nothing');
    });

    it('different projects do not block each other', async (t) => {
        const a = await makeProject(t);
        const b = await makeProject(t);
        const { gate, release } = holdOpen();
        const vhdl = new ScriptedVhdl();
        vhdl.gate = gate;
        const controller = await controllerWith(vhdl);
        const runA = controller.check(a);
        const runB = controller.check(b);
        await tick();
        assert.equal(activeOperation(a.root), 'check');
        assert.equal(activeOperation(b.root), 'check');
        release();
        assert.equal((await runA).status, 'succeeded');
        assert.equal((await runB).status, 'succeeded');
    });

    it('the lock is released after success, a failed result, a thrown exception and cancellation', async (t) => {
        const project = await makeProject(t);
        const vhdl = new ScriptedVhdl();
        const controller = await controllerWith(vhdl);

        assert.equal((await controller.check(project)).status, 'succeeded');
        assert.equal(activeOperation(project.root), undefined, 'after success');

        vhdl.checkStatus = 'failed';
        assert.equal((await controller.check(project)).status, 'failed');
        assert.equal(activeOperation(project.root), undefined, 'after a failure result');

        vhdl.checkStatus = 'succeeded';
        vhdl.throwOn = 'check';
        await assert.rejects(controller.check(project), /boom/);
        assert.equal(activeOperation(project.root), undefined, 'after an exception');
        vhdl.throwOn = 'synthesize';
        await assert.rejects(controller.build(project), /boom/);
        assert.equal(activeOperation(project.root), undefined, 'after an exception inside a build');

        vhdl.throwOn = undefined;
        const abort = new AbortController();
        const { gate, release } = holdOpen();
        vhdl.gate = gate;
        const cancelled = controller.build(project, { signal: abort.signal });
        await tick();
        abort.abort();
        release();
        await cancelled;
        assert.equal(activeOperation(project.root), undefined, 'after cancellation');

        vhdl.gate = undefined;
        assert.equal((await controller.build(project)).diagnostics.some((d) => d.code === 'PIPELINE_BUSY'), false, 'the project is usable again');
    });

    it('withProjectLock itself: claims synchronously, frees on every exit, per normalized path', async () => {
        const root = join(process.cwd(), 'lock-demo');
        const seen: string[] = [];
        const first = withProjectLock(root, 'check', async () => 'a', () => 'busy');
        const second = withProjectLock(root, 'build', async () => 'b', (running) => `busy:${running}`);
        assert.equal(await first, 'a');
        assert.equal(await second, 'busy:check', 'the claim was taken before the first await');
        await assert.rejects(withProjectLock(root, 'check', async () => Promise.reject(new Error('x')), () => 'busy'), /x/);
        assert.equal(activeOperation(root), undefined);
        assert.equal(await withProjectLock(root.toUpperCase(), 'check', async () => 'again', () => 'busy'), 'again');
        seen.push(busyMessage('build'), busyMessage('rtl'));
        assert.deepEqual(seen, ['Build is already running.', 'RTL schematic generation is already running.']);
    });
});

// --------------------------------------------------------------------------

describe('simulation stop time (GHDL --stop-time)', () => {
    it('normalizes and rejects stop times', () => {
        assert.equal(normalizeStopTime('1us'), '1us');
        assert.equal(normalizeStopTime(' 500 NS '), '500ns');
        assert.equal(normalizeStopTime('010ms'), '10ms');
        assert.equal(normalizeStopTime('2sec'), '2sec');
        for (const bad of ['', '0ns', '1', 'ns', '1.5us', '-1ns', '1 minute', '1us;rm', '1e3ns']) assert.equal(normalizeStopTime(bad), undefined, bad);
    });

    it('validation accepts a valid stop time and refuses an invalid one', async (t) => {
        const good = await makeProject(t, { simulation: { sources: ['sim/top_tb.vhd'], testbench: 'top_tb', stopTime: '2us' } });
        assert.equal((await validateProject(good, await repoBoards())).valid, true);
        const bad = await makeProject(t, { simulation: { sources: ['sim/top_tb.vhd'], testbench: 'top_tb', stopTime: '2 parsecs' } });
        const v = await validateProject(bad, await repoBoards());
        assert.equal(v.valid, false);
        assert.ok(v.diagnostics.some((d) => d.code === 'PROJECT_STOP_TIME_INVALID'));
    });

    it('existing projects (no stopTime) run GHDL exactly as before: no --stop-time', async (t) => {
        const project = await makeProject(t);
        const { workspace } = await new WorkspaceManager().open(project);
        const runner = new FakeRunner();
        await new GhdlVhdlProvider('/fake/ghdl', runner).simulate({ project, workspace: workspace! }, { testbench: 'top_tb', waveform: true, vcd: true });
        const run = runner.calls.find((c) => c.args[0] === '-r')!;
        assert.ok(!run.args.some((a) => a.startsWith('--stop-time')));
    });

    it('passes the normalized project stop time to GHDL, for Simulate and for Build with simulation', async (t) => {
        const project = await makeProject(t, { simulation: { sources: ['sim/top_tb.vhd'], testbench: 'top_tb', stopTime: ' 1 US ' } as never });
        const vhdl = new ScriptedVhdl();
        const controller = await controllerWith(vhdl);
        // The controller validates first: a stop time with stray spaces is still a valid one.
        const lastSim = () => vhdl.simOptions;
        await controller.simulate(project);
        assert.equal(lastSim()?.stopTime, '1us');
        vhdl.simOptions = undefined;
        await controller.build(project, { simulate: true });
        assert.equal(lastSim()?.stopTime, '1us');

        const { workspace } = await new WorkspaceManager().open(project);
        const runner = new FakeRunner();
        await new GhdlVhdlProvider('/fake/ghdl', runner).simulate({ project, workspace: workspace! }, { testbench: 'top_tb', waveform: false, stopTime: '1us' });
        assert.ok(runner.calls.find((c) => c.args[0] === '-r')!.args.includes('--stop-time=1us'));
    });

    it('reads where a --stop-time run stopped', () => {
        assert.equal(parseGhdlOutput('simulation stopped by --stop-time @1us\n').stoppedAt, '1us');
        assert.equal(parseGhdlOutput('simulation stopped @280ns\n').stoppedAt, '280ns', 'std.env.stop output unchanged');
    });

    it('explains a testbench that never ends instead of only saying "timed-out"', async (t) => {
        const project = await makeProject(t);
        const { workspace } = await new WorkspaceManager().open(project);
        const runner = new FakeRunner((inv) => (inv.args[0] === '-r' ? { outcome: 'timed-out', exitCode: null } : {}));
        const r = await new GhdlVhdlProvider('/fake/ghdl', runner).simulate({ project, workspace: workspace! }, { testbench: 'top_tb', waveform: false });
        assert.equal(r.passed, false);
        const hint = r.diagnostics.find((d) => d.code === 'SIM_NO_END');
        assert.match(hint!.message, /std\.env\.stop/);
        assert.match(hint!.message, /Stop Time/i);
    });
});

describe('project files are untouched by the new fields', () => {
    it('a simulation block without stopTime keeps validating', async (t) => {
        const project = await makeProject(t);
        await writeFiles(project.root, {});
        assert.equal((await validateProject(project, await repoBoards())).valid, true);
    });
});
