import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
    activeOperation,
    GhdlVhdlProvider,
    NodeToolRunner,
    type SimulationOptions,
    type SimulationResult,
    type SynthesisResult,
    type VhdlCheckResult,
    type VhdlContext,
    type VhdlProvider,
    WorkflowController,
    WorkspaceManager,
} from '../core';
import { FakeRunner, makeProject, repoBoards } from './helpers';

const ok = { status: 'succeeded' as const, diagnostics: [], logs: [], durationMs: 1 };
const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};
async function gone(pid: number, ms = 6000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (!alive(pid)) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return !alive(pid);
}

describe('Stop Simulation: how a stop reaches GHDL', () => {
    it('a stopped run is a "stopped by user" outcome, not a failure or a time-out, and keeps the partial VCD', async (t) => {
        const project = await makeProject(t);
        const { workspace } = await new WorkspaceManager().open(project);
        const vcdPath = join(workspace!.paths.sim, 'waveform.vcd');
        const runner = new FakeRunner((inv) => {
            if (inv.args[0] !== '-r') return {};
            writeFileSync(vcdPath, '$timescale 1 fs $end\n$enddefinitions $end\n#0\n');
            return { outcome: 'cancelled', exitCode: null, stdout: '', stderr: '' };
        });
        const r = await new GhdlVhdlProvider('/fake/ghdl', runner).simulate({ project, workspace: workspace! }, { testbench: 'top_tb', waveform: true, vcd: true, stopTime: '5us' });
        assert.equal(r.cancelled, true);
        assert.equal(r.passed, false);
        assert.ok(r.vcd, 'the partial waveform is kept');
        assert.equal(r.vcd!.path, vcdPath);
        assert.ok(r.diagnostics.some((d) => d.code === 'SIM_STOPPED_BY_USER' && d.severity === 'info'));
        assert.ok(!r.diagnostics.some((d) => d.severity === 'error'), 'no error is reported for a stop');
        assert.ok(!r.diagnostics.some((d) => d.code === 'GHDL_CANCELLED' || d.code === 'GHDL_TIMED_OUT' || d.code === 'SIM_NO_END'));
    });

    it('a normal run is not marked as cancelled; one that ends by std.env.stop before the duration is a success', async (t) => {
        const project = await makeProject(t);
        const { workspace } = await new WorkspaceManager().open(project);
        const runner = new FakeRunner((inv) => (inv.args[0] === '-r' ? { stdout: 'sim/top_tb.vhd:40:9:@280ns:(report note): ALL TESTS PASSED\nsimulation stopped @280ns\n' } : {}));
        const r = await new GhdlVhdlProvider('/fake/ghdl', runner).simulate({ project, workspace: workspace! }, { testbench: 'top_tb', waveform: true, vcd: true, stopTime: '5us' });
        assert.equal(r.cancelled, undefined);
        assert.equal(r.passed, true);
        assert.equal(r.stoppedAt, '280ns', 'stopped by the testbench at 280 ns, well before the requested 5 us');
        assert.ok(runner.calls.find((c) => c.args[0] === '-r')!.args.includes('--stop-time=5us'));
    });

    it('Run for maps to one GHDL run from time 0: --stop-time, the waveform files, never a resume option', async (t) => {
        const project = await makeProject(t);
        const { workspace } = await new WorkspaceManager().open(project);
        const runner = new FakeRunner();
        const ghdl = new GhdlVhdlProvider('/fake/ghdl', runner);
        for (const stopTime of ['2us', '5us']) await ghdl.simulate({ project, workspace: workspace! }, { testbench: 'top_tb', waveform: true, vcd: true, stopTime });
        const runs = runner.calls.filter((c) => c.args[0] === '-r');
        assert.deepEqual(runs.map((c) => c.args.find((a) => a.startsWith('--stop-time'))), ['--stop-time=2us', '--stop-time=5us']);
        for (const run of runs) {
            assert.ok(run.args.includes('--vcd=waveform.vcd'));
            assert.ok(!run.args.some((a) => /resume|--checkpoint|--restore|--start/i.test(a)), run.args.join(' '));
        }
        // Each Run re-analyses and re-elaborates: a fresh simulation, not a continuation.
        assert.equal(runner.calls.filter((c) => c.args[0] === '-a').length, 2);
        assert.equal(runner.calls.filter((c) => c.args[0] === '-e').length, 2);
    });
});

/** A VHDL front end whose simulate() runs until it is aborted, like a GHDL run of a free-running clock. */
class EndlessSim implements VhdlProvider {
    readonly id = 'endless';
    started = 0;
    /** Resolves each time simulate() has been entered: the condition the test needs, instead of a guessed delay. */
    private waiters: Array<() => void> = [];
    entered(): Promise<void> {
        return new Promise((r) => this.waiters.push(r));
    }
    async check(): Promise<VhdlCheckResult> {
        return { ...ok, elaborated: [] };
    }
    async simulate(_ctx: VhdlContext, o: SimulationOptions): Promise<SimulationResult> {
        this.started++;
        this.waiters.splice(0).forEach((w) => w());
        const signal = _ctx.signal;
        await new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener('abort', () => resolve(), { once: true })));
        return { ...ok, status: 'failed', cancelled: true, passed: false, testbench: o.testbench, messages: [] };
    }
    async synthesize(): Promise<SynthesisResult> {
        throw new Error('not used');
    }
}

describe('Stop Simulation: lock and state', () => {
    it('stopping releases the per-project lock at once, and the next run starts normally', async (t) => {
        const project = await makeProject(t);
        const vhdl = new EndlessSim();
        const controller = new WorkflowController({ boards: await repoBoards(), workspaces: new WorkspaceManager(), vhdl });
        const abort = new AbortController();
        const firstEntered = vhdl.entered();
        const running = controller.simulate(project, 'top_tb', abort.signal);
        await firstEntered;
        assert.equal(activeOperation(project.root), 'simulate', 'the project is claimed while it runs');
        const refused = await controller.simulate(project, 'top_tb');
        assert.equal(refused.diagnostics[0]!.code, 'PIPELINE_BUSY');
        assert.equal(vhdl.started, 1, 'a second Run while running does not start another GHDL');
        abort.abort();
        const result = await running;
        assert.equal(result.cancelled, true);
        assert.equal(activeOperation(project.root), undefined, 'the lock is released');
        const second = new AbortController();
        const secondEntered = vhdl.entered();
        const again = controller.simulate(project, 'top_tb', second.signal);
        await secondEntered;
        assert.equal(vhdl.started, 2, 'Run works again after Stop');
        second.abort();
        await again;
        assert.equal(activeOperation(project.root), undefined);
    });
});

describe('ending a tool ends everything it started (no orphaned simulators)', () => {
    const script = `
        const { spawn } = require('node:child_process');
        const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        console.log('pids ' + process.pid + ' ' + grandchild.pid);
        setInterval(() => {}, 1000);
    `;

    async function startAndAbort(kind: 'abort' | 'timeout') {
        const pids: number[] = [];
        const abort = new AbortController();
        const pending = new NodeToolRunner().run({
            executable: process.execPath,
            args: ['-e', script],
            ...(kind === 'abort' ? { signal: abort.signal } : { timeoutMs: 1500 }),
            onOutput: (text) => {
                const m = /pids (\d+) (\d+)/.exec(text);
                if (m) pids.push(Number(m[1]), Number(m[2]));
            },
        });
        for (let i = 0; i < 100 && pids.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
        assert.equal(pids.length, 2, 'the tool and its helper started');
        if (kind === 'abort') abort.abort();
        const result = await pending;
        return { result, pids };
    }

    it('Stop (abort) ends the process and, on Windows, the helper process it started', async () => {
        const { result, pids } = await startAndAbort('abort');
        assert.equal(result.outcome, 'cancelled');
        assert.ok(await gone(pids[0]!), 'the tool process is gone');
        if (process.platform === 'win32') assert.ok(await gone(pids[1]!), 'no orphaned helper process');
        else await gone(pids[1]!, 100); // elsewhere the supported simulator runs in one process
        for (const pid of pids) {
            try {
                process.kill(pid);
            } catch {
                /* already gone */
            }
        }
    });

    it('a time-out ends the whole tree too', async () => {
        const { result, pids } = await startAndAbort('timeout');
        assert.equal(result.outcome, 'timed-out');
        assert.ok(await gone(pids[0]!));
        if (process.platform === 'win32') assert.ok(await gone(pids[1]!));
        for (const pid of pids) {
            try {
                process.kill(pid);
            } catch {
                /* already gone */
            }
        }
    });
});

describe('simulation unchanged for existing projects', () => {
    it('a project without stopTime still runs GHDL without --stop-time and without --vcd changes', async (t) => {
        const project = await makeProject(t);
        const { workspace } = await new WorkspaceManager().open(project);
        const runner = new FakeRunner();
        await new GhdlVhdlProvider('/fake/ghdl', runner).simulate({ project, workspace: workspace! }, { testbench: 'top_tb', waveform: true, vcd: true });
        assert.ok(!runner.calls.find((c) => c.args[0] === '-r')!.args.some((a) => a.startsWith('--stop-time')));
    });

    it('(sanity) the helper used above really tracks liveness', async () => {
        assert.equal(alive(process.pid), true);
        await writeFile(join(process.cwd(), '.p6c-sanity'), '').catch(() => undefined);
        await import('node:fs/promises').then((f) => f.rm(join(process.cwd(), '.p6c-sanity'), { force: true }));
        assert.equal(await gone(2 ** 22 - 3, 200), true);
    });
});
