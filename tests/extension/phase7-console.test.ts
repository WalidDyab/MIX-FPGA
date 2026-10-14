import './install-vscode-fake';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { errorDiag, OutputTeeRunner, type ToolInvocation, type ToolRunner, type ToolRunResult } from '../../core';
import { type ConsoleSink, type ConsoleVerbosity, NexysConsole, simulationReportLine } from '../../extension/services/console';
import { createProject } from '../../extension/project/scaffold';
import { NexysVhdlService } from '../../extension/services/nexys-service';
import { repoBoards, tempDir } from '../helpers';
import { FakeBackend, OK, successfulBuild } from './fake-backend';

class Recorder implements ConsoleSink {
    readonly lines: string[] = [];
    reveals = 0;
    appendLine(line: string): void {
        this.lines.push(line);
    }
    reveal(): void {
        this.reveals++;
    }
    get text(): string {
        return this.lines.join('\n');
    }
}

function consoleWith(verbosity: ConsoleVerbosity = 'normal') {
    const sink = new Recorder();
    let v = verbosity;
    const c = new NexysConsole(sink, () => v);
    return { sink, c, set: (x: ConsoleVerbosity) => (v = x) };
}

async function openService(t: TestContext, backend = new FakeBackend(), verbosity: ConsoleVerbosity = 'normal') {
    const parent = await tempDir(t);
    const r = await createProject({ parentDir: parent, name: 'Demo', board: (await repoBoards()).get('nexys-a7-100t')!, template: 'starter' });
    assert.ok(r.ok);
    const { sink, c, set } = consoleWith(verbosity);
    const service = new NexysVhdlService({ backend, debounceMs: 5, console: c });
    t.after(() => service.dispose());
    await service.open(r.root);
    return { service, backend, sink, root: r.root, set };
}

describe('NexysVHDL Console: formatting and reveal policy', () => {
    it('initialises with the project when it opens, without revealing anything', async (t) => {
        const { sink } = await openService(t);
        assert.match(sink.lines[0]!, /^MIX-FPGA Console — project Demo$/);
        assert.equal(sink.reveals, 0, 'opening a project never pops the panel');
    });

    it('every action reveals the console when it begins; errors bring it back once, not once per line', () => {
        const { sink, c } = consoleWith();
        c.begin('Build', 'Starting build...');
        assert.equal(sink.reveals, 1);
        c.error('Build', 'first');
        c.error('Build', 'second');
        c.warning('Build', 'third');
        assert.equal(sink.reveals, 2, 'one extra reveal for the first error of the action');
        c.endAction();
        c.begin('Check', 'Analysing VHDL files...');
        assert.equal(sink.reveals, 3, 'the next action reveals again: a hidden console is not fought mid-run, only at the next action');
    });

    it('prints the structured block students asked for, with the error layout of the brief', () => {
        const { sink, c } = consoleWith();
        c.begin('Build', 'Synthesis...');
        c.error('Build', 'Top entity "DigitDisplay" could not be elaborated.', { file: 'src/DigitDisplay.vhd', line: 42 });
        c.fail('Build', 'FAIL during synthesis');
        c.endAction();
        assert.deepEqual(sink.lines, ['[Build] Synthesis...', '[Build] ERROR', 'Top entity "DigitDisplay" could not be elaborated.', 'src/DigitDisplay.vhd:42', '[Build] FAIL during synthesis']);
    });

    it('caps long diagnostic lists and points at Problems', () => {
        const { sink, c } = consoleWith();
        c.begin('Check', 'x');
        c.diagnostics('Check', Array.from({ length: 40 }, (_, i) => ({ severity: 'error' as const, message: `bad ${i}` })));
        assert.equal(sink.lines.filter((l) => l === '[Check] ERROR').length, 25);
        assert.match(sink.text, /… and 15 more \(see the Problems panel\)\./);
    });

    it('normal output keeps only testbench reports of a simulation; detailed output streams every tool line, even split across chunks', () => {
        const { sink, c, set } = consoleWith('normal');
        c.begin('Simulate', 'Testbench: tb');
        c.raw('analyzing foo.vhd\nsrc/tb.vhd:12:5:@100ns:(report note): hel');
        c.raw('lo\nnoise line\nsrc/tb.vhd:20:5:@2us:(assertion error): counter wrong\n');
        assert.deepEqual(sink.lines.slice(1), ['[Simulate]   @100ns  note: hello', '[Simulate]   @2us  assert error: counter wrong']);
        c.endAction();
        set('detailed');
        c.begin('Build', 'Starting build...');
        c.raw('yosys: reading\nnextpnr: placing');
        c.raw(' done\n');
        c.endAction();
        assert.ok(sink.lines.includes('  | yosys: reading'));
        assert.ok(sink.lines.includes('  | nextpnr: placing done'));
        assert.equal(simulationReportLine('not a report'), undefined);
    });

    it('a console that nobody reads cannot break a run: the tee runner survives a throwing sink', async () => {
        const seen: string[] = [];
        const inner: ToolRunner = {
            async run(inv: ToolInvocation): Promise<ToolRunResult> {
                inv.onOutput?.('hello\n');
                return { invocation: inv, outcome: 'exited', exitCode: 0, stdout: 'hello\n', stderr: '', durationMs: 1 };
            },
        };
        const tee = new OutputTeeRunner(inner, (text) => {
            seen.push(text);
            throw new Error('console exploded');
        });
        const own: string[] = [];
        const r = await tee.run({ executable: 'x', args: [], onOutput: (t) => own.push(t) });
        assert.equal(r.exitCode, 0);
        assert.deepEqual(seen, ['hello\n']);
        assert.deepEqual(own, ['hello\n'], 'the invocation’s own observer still gets its text');
    });
});

describe('NexysVHDL Console: the workflow actions write to it', () => {
    it('Check: begin, then PASS', async (t) => {
        const { service, sink } = await openService(t);
        await service.check();
        const text = sink.text;
        assert.match(text, /\[Check\] Analysing VHDL files\.\.\.\n\[Check\] PASS/);
        assert.ok(sink.reveals >= 1);
    });

    it('Check with errors: each error with its project-relative location, then FAIL with the count; reveals', async (t) => {
        const backend = new FakeBackend();
        const { service, sink, root } = await openService(t, backend);
        backend.checkResult = {
            status: 'failed',
            diagnostics: [errorDiag('vhdl', 'GHDL_ERROR', "'foo' is not declared", { file: join(root, 'src', 'top.vhd'), line: 12, column: 5 }), errorDiag('vhdl', 'GHDL_ERROR', 'second', { file: 'src/top.vhd', line: 3 })],
            logs: [], durationMs: 1, elaborated: [],
        };
        const before = sink.reveals;
        await service.check();
        assert.match(sink.text, /\[Check\] ERROR\n'foo' is not declared\nsrc\/top\.vhd:12:5\n\[Check\] ERROR\nsecond\nsrc\/top\.vhd:3\n\[Check\] FAIL — 2 errors/);
        assert.ok(sink.reveals >= before + 1);
    });

    it('Check without tools: a plain explanation, not a stack of codes', async (t) => {
        const backend = new FakeBackend();
        backend.checkResult = { status: 'not-configured', diagnostics: [], logs: [], durationMs: 0, elaborated: [] };
        const { service, sink } = await openService(t, backend);
        await service.check();
        assert.match(sink.text, /\[Check\] ERROR\nThe VHDL tools are not set up on this computer\./);
    });

    it('Simulate: testbench, duration, PASS with the stop time; messages are listed when no live output was streamed', async (t) => {
        const { service, sink } = await openService(t);
        await service.setStopTime('5us');
        await service.simulate('top_tb');
        assert.match(sink.text, /\[Simulate\] Testbench: top_tb\n\[Simulate\] Running for 5 us\n\[Simulate\]   @280ns report note: ALL TESTS PASSED\n\[Simulate\] PASS — stopped at 280 ns/);
    });

    it('Simulate: no duplicate report lines when they were streamed live', async (t) => {
        const backend = new FakeBackend();
        const { service, sink } = await openService(t, backend);
        const original = backend.simulate.bind(backend);
        backend.simulate = async (...args) => {
            service.console.raw('src/top_tb.vhd:9:5:@280ns:(report note): ALL TESTS PASSED\n'); // what the tool tee delivers while it runs
            return original(...args);
        };
        await service.simulate('top_tb');
        assert.equal(sink.lines.filter((l) => l.includes('ALL TESTS PASSED')).length, 1);
        assert.match(sink.text, /\[Simulate\] PASS/);
    });

    it('Simulate: never ending testbench and failures are explained; Stop is a calm message, not an error', async (t) => {
        const backend = new FakeBackend();
        const { service, sink } = await openService(t, backend);
        backend.simResult = { ...OK, status: 'failed', testbench: 'top_tb', passed: false, messages: [], diagnostics: [errorDiag('vhdl', 'SIM_NO_END', 'The simulation never ended.')] };
        await service.simulate('top_tb');
        assert.match(sink.text, /\[Simulate\] FAIL — the testbench never ended: use "Run for" or end it with std\.env\.stop/);
        backend.simulateUntilAborted = {};
        const running = service.simulate('top_tb');
        await new Promise((r) => setTimeout(r, 20));
        service.stopSimulation();
        await running;
        assert.match(sink.text, /\[Simulate\] Stopped by user/);
        assert.doesNotMatch(sink.text.split('Stopped by user')[0]!.split('\n').slice(-3).join('\n'), /ERROR/);
    });

    it('Build: stages as they start, timing, and "Bitstream ready"', async (t) => {
        const backend = new FakeBackend();
        const { service, sink, root } = await openService(t, backend);
        backend.buildResult = successfulBuild(join(root, 'hardware.bit'));
        backend.buildProgress = [
            { kind: 'step-started', step: 'check' },
            { kind: 'implementation-stage', stage: 'synthesis' },
            { kind: 'implementation-stage', stage: 'implementation' },
            { kind: 'implementation-stage', stage: 'bitstream' },
        ];
        await service.build();
        const lines = sink.lines.filter((l) => l.startsWith('[Build]'));
        assert.deepEqual(lines.slice(0, 5), ['[Build] Starting build...', '[Build] Checking VHDL...', '[Build] Synthesis...', '[Build] Implementation...', '[Build] Generating bitstream...']);
        assert.ok(lines.some((l) => /^\[Build\] Timing met/.test(l)) || !successfulBuild('x').timing, 'timing line when the build has timing');
        assert.equal(lines[lines.length - 1], '[Build] Bitstream ready');
    });

    it('Build failure: the error, where it failed, and the console is brought back', async (t) => {
        const backend = new FakeBackend();
        const { service, sink, root } = await openService(t, backend);
        const { bitstream: _bit, timing: _timing, ...rest } = successfulBuild(join(root, 'hardware.bit'));
        backend.buildResult = {
            ...rest,
            success: false,
            implementationStage: 'synthesis',
            diagnostics: [errorDiag('implementation', 'BUILD_SYNTH', 'Top entity "DigitDisplay" could not be elaborated.', { file: 'src/DigitDisplay.vhd', line: 42 })],
        };
        await service.build();
        assert.match(sink.text, /\[Build\] ERROR\nTop entity "DigitDisplay" could not be elaborated\.\nsrc\/DigitDisplay\.vhd:42\n\[Build\] FAIL during synthesis/);
    });

    it('Program with no bitstream or no board: a clear warning in the console', async (t) => {
        const { service, sink } = await openService(t);
        const outcome = await service.program();
        assert.equal(outcome.kind, 'blocked');
        assert.match(sink.text, /\[Program\] Programming is not possible yet\n\[Program\] WARNING\nThere is no bitstream yet\. Run Build first\./);
    });

    it('Program: PASS with the board, and a failure lists the programmer’s message', async (t) => {
        const backend = new FakeBackend();
        const { service, sink, root } = await openService(t, backend);
        await mkdir(join(root, '.nexysvhdl', 'impl'), { recursive: true });
        backend.bit = { path: join(root, 'hardware.bit'), modifiedMs: Date.now() + 60_000 };
        backend.detection = { configured: true, boards: [{ selector: 'A', serialNumber: '210', productName: 'Nexys A7' } as never], diagnostics: [] };
        await writeFile(backend.bit.path, 'x');
        await service.program();
        assert.match(sink.text, /\[Program\] Programming .*\.\.\.\n\[Program\] PASS/);
        backend.programResult = { ...OK, status: 'failed', destination: 'volatile', diagnostics: [errorDiag('programming', 'PROGRAM_NO_BOARD', 'No board was found. Connect the Nexys A7 and try again.')] };
        await service.program({ serial: '210' });
        assert.match(sink.text, /\[Program\] ERROR\nNo board was found\. Connect the Nexys A7 and try again\.\n\[Program\] FAIL/);
    });

    it('actions are separated by a blank line and never interleave tags', async (t) => {
        const { service, sink } = await openService(t);
        await service.check();
        await service.check();
        const blocks = sink.text.split('\n\n').filter((b) => b.startsWith('[Check]'));
        assert.equal(blocks.length, 2);
    });
});
