import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { GhdlVhdlProvider, type ToolInvocation, type ToolRunner, type ToolRunResult, WORKSPACE_DIR_NAME, WorkspaceManager } from '../core';
import { FakeRunner, makeProject, writeFiles } from './helpers';

/**
 * ADR-001 regression (found on macOS in Phase 3B): GHDL's LLVM/GCC backends
 * write elaborated executables and `e~<unit>.o` into the *working directory*.
 * With the project root as cwd they landed in the student's tree. The fake
 * runner below behaves like those backends, so this holds on every host.
 */
class LlvmLikeGhdl implements ToolRunner {
    readonly calls: ToolInvocation[] = [];
    async run(inv: ToolInvocation): Promise<ToolRunResult> {
        this.calls.push(inv);
        const cwd = inv.cwd ?? process.cwd();
        const workdir = resolve(cwd, inv.args.find((a) => a.startsWith('--workdir='))?.slice('--workdir='.length) ?? '.');
        const unit = inv.args[3] ?? '';
        const touch = async (dir: string, name: string) => {
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, name), 'x');
        };
        let stdout = '';
        switch (inv.args[0]) {
            case '-a':
                await touch(workdir, 'work-obj08.cf');
                break;
            case '-e':
                // Executable + object in the cwd, as the LLVM backend does without -o.
                await touch(cwd, unit);
                await touch(cwd, `e~${unit}.o`);
                break;
            case '-r':
                stdout = `${unit}.vhd:1:1:@280ns:(report note): ALL TESTS PASSED\n`;
                break;
            case '--synth':
                stdout = 'module top(input clk100mhz, input btnc, output led0);\nendmodule\n';
                break;
        }
        return { invocation: inv, outcome: 'exited', exitCode: 0, stdout, stderr: '', durationMs: 1 };
    }
}

async function listTree(root: string): Promise<string[]> {
    return (await readdir(root, { recursive: true, withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => relative(root, join(e.parentPath, e.name)).split('\\').join('/'))
        .sort();
}

async function setup(t: TestContext) {
    const project = await makeProject(t, { top: 'top', sources: ['src/top.vhd'], simulation: { sources: ['sim/top_tb.vhd'], testbench: 'top_tb' } });
    await writeFiles(project.root, { 'README.txt': 'student notes\n' });
    const { workspace } = await new WorkspaceManager().open(project);
    const before = (await listTree(project.root)).filter((f) => !f.startsWith(`${WORKSPACE_DIR_NAME}/`));
    const runner = new LlvmLikeGhdl();
    const ghdl = new GhdlVhdlProvider('/fake/ghdl', runner);
    const ctx = { project, workspace: workspace! };
    const wsRoot = resolve(project.root, WORKSPACE_DIR_NAME);

    /** Every GHDL run: cwd inside the workspace (never the project root); paths relative to it, never the project location. */
    const assertIsolatedRuns = (expectedCwd: string) => {
        assert.ok(runner.calls.length > 0);
        for (const c of runner.calls) {
            assert.equal(resolve(c.cwd!), resolve(expectedCwd), c.args.join(' '));
            assert.notEqual(resolve(c.cwd!), resolve(project.root));
            for (const a of c.args.filter((x) => x.endsWith('.vhd'))) {
                assert.ok(!isAbsolute(a), a);
                assert.ok(!relative(project.root, resolve(c.cwd!, a)).startsWith('..'), `${a} resolves inside the project`);
            }
            assert.ok(!c.args.some((a) => a.includes(project.root)), 'the project location never reaches GHDL');
            assert.ok(c.args.includes('--workdir=.'));
        }
        runner.calls.length = 0;
    };
    /** The student's tree is exactly what it was; all GHDL output sits under .nexysvhdl/. */
    const assertTreeUnchanged = async () => {
        const all = await listTree(project.root);
        assert.deepEqual(all.filter((f) => !f.startsWith(`${WORKSPACE_DIR_NAME}/`)), before);
    };
    return { project, workspace: workspace!, runner, ghdl, ctx, wsRoot, assertIsolatedRuns, assertTreeUnchanged };
}

describe('GHDL runs only inside the build workspace (ADR-001)', () => {
    it('check: cwd is .nexysvhdl/check and elaboration output stays there', async (t) => {
        const s = await setup(t);
        const r = await s.ghdl.check(s.ctx);
        assert.equal(r.status, 'succeeded');
        s.assertIsolatedRuns(s.workspace.paths.check);
        await s.assertTreeUnchanged();
        const out = await listTree(s.workspace.paths.check);
        assert.ok(out.includes('top') && out.includes('e~top.o') && out.includes('top_tb'), out.join(','));
    });

    it('simulate: elaborates and runs in .nexysvhdl/sim', async (t) => {
        const s = await setup(t);
        const r = await s.ghdl.simulate(s.ctx, { testbench: 'top_tb', waveform: false });
        assert.equal(r.passed, true);
        const ops = s.runner.calls.map((c) => c.args[0]);
        assert.deepEqual(ops, ['-a', '-e', '-r']);
        s.assertIsolatedRuns(s.workspace.paths.sim);
        await s.assertTreeUnchanged();
        assert.ok((await listTree(s.workspace.paths.sim)).includes('top_tb'));
    });

    it('synthesize: runs in .nexysvhdl/synth and writes generated.v there', async (t) => {
        const s = await setup(t);
        const r = await s.ghdl.synthesize(s.ctx);
        assert.equal(r.status, 'succeeded');
        s.assertIsolatedRuns(s.workspace.paths.synth);
        await s.assertTreeUnchanged();
        assert.equal(r.generatedVerilog?.path, join(s.workspace.paths.synth, 'generated.v'));
        assert.match(await readFile(r.generatedVerilog!.path, 'utf8'), /module top/);
    });

    it('maps GHDL workspace-relative paths back to project-relative diagnostics', async (t) => {
        const s = await setup(t);
        const failing = new FakeRunner(() => ({ exitCode: 1, stderr: `${join('..', '..', 'src', 'top.vhd')}:12:5:error: no declaration for "q"\n` }));
        const r = await new GhdlVhdlProvider('/fake/ghdl', failing).check(s.ctx);
        assert.deepEqual(r.diagnostics[0]!.location, { file: 'src/top.vhd', line: 12, column: 5 });
    });

    it('reports diagnostics with project-relative paths although GHDL got absolute ones', async (t) => {
        const s = await setup(t);
        const abs = resolve(s.project.root, 'src', 'top.vhd');
        const failing = new FakeRunner(() => ({ exitCode: 1, stderr: `${abs}:12:5:error: no declaration for "q"\n` }));
        const r = await new GhdlVhdlProvider('/fake/ghdl', failing).check(s.ctx);
        assert.equal(r.status, 'failed');
        assert.deepEqual(r.diagnostics[0]!.location, { file: 'src/top.vhd', line: 12, column: 5 });
    });
});
