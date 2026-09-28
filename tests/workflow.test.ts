import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
    type ImplementationProvider,
    type ImplementationRequest,
    type ImplementationResult,
    type SimulationResult,
    type SynthesisResult,
    type VhdlCheckResult,
    type VhdlContext,
    type VhdlProvider,
    WorkflowController,
    WorkspaceManager,
} from '../core';
import { makeProject, repoBoards } from './helpers';

const ok = { status: 'succeeded' as const, diagnostics: [], logs: [], durationMs: 1 };

/** Mock VHDL front end; values are placeholders, not real tool output. */
class MockVhdl implements VhdlProvider {
    readonly id = 'mock-vhdl';
    readonly calls: string[] = [];
    constructor(private readonly opts: { checkFails?: boolean; simPasses?: boolean } = {}) {}
    async check(): Promise<VhdlCheckResult> {
        this.calls.push('check');
        return this.opts.checkFails
            ? { ...ok, status: 'failed', elaborated: [], diagnostics: [{ severity: 'error', source: 'vhdl', code: 'MOCK', message: 'bad' }] }
            : { ...ok, elaborated: ['top'] };
    }
    async simulate(_ctx: VhdlContext, o: { testbench: string }): Promise<SimulationResult> {
        this.calls.push(`simulate:${o.testbench}`);
        return { ...ok, testbench: o.testbench, passed: this.opts.simPasses ?? true, messages: [] };
    }
    async synthesize(ctx: VhdlContext): Promise<SynthesisResult> {
        this.calls.push('synthesize');
        const path = join(ctx.workspace.paths.synth, 'generated.v');
        await writeFile(path, 'module top(); endmodule\n');
        return { ...ok, top: 'top', modules: ['top'], generatedVerilog: { kind: 'generated-verilog', path, canonical: false } };
    }
}

/** Mock implementation backend; stages like a real provider must, reports mock numbers. */
class MockImpl implements ImplementationProvider {
    readonly id = 'mock-impl';
    request?: ImplementationRequest;
    constructor(private readonly timingPasses = true) {}
    async implement(req: ImplementationRequest): Promise<ImplementationResult> {
        this.request = req;
        const staged = await req.workspace.stageImplementation([
            { name: 'generated.v', sourcePath: req.verilog.path },
            { name: 'generated.xdc', content: req.xdc },
        ]);
        const bit = join(staged.dir, 'hardware.bit');
        await writeFile(bit, 'mock');
        return {
            ...ok,
            stagedFiles: staged.files,
            bitstream: { kind: 'bitstream', path: bit, canonical: true },
            timing: { clocks: [{ clock: 'clk', targetMHz: 100, achievedMHz: this.timingPasses ? 200 : 50, passed: this.timingPasses }], passed: this.timingPasses },
        };
    }
}

async function controller(vhdl?: VhdlProvider, implementation?: ImplementationProvider) {
    return new WorkflowController({
        boards: await repoBoards(),
        workspaces: new WorkspaceManager(),
        ...(vhdl ? { vhdl } : {}),
        ...(implementation ? { implementation } : {}),
    });
}

const stepStatus = (r: { steps: readonly { step: string; status: string }[] }) => Object.fromEntries(r.steps.map((s) => [s.step, s.status]));

describe('WorkflowController with mocked providers', () => {
    it('runs check -> simulate -> synthesize -> constraints -> implement and returns a BuildResult', async (t) => {
        const project = await makeProject(t);
        const vhdl = new MockVhdl();
        const impl = new MockImpl();
        const result = await (await controller(vhdl, impl)).build(project, { simulate: true });
        assert.equal(result.success, true, JSON.stringify(result.diagnostics));
        assert.deepEqual(vhdl.calls, ['check', 'simulate:top_tb', 'synthesize']);
        assert.deepEqual(stepStatus(result), {
            validate: 'succeeded', workspace: 'succeeded', check: 'succeeded', simulate: 'succeeded',
            synthesize: 'succeeded', constraints: 'succeeded', implement: 'succeeded',
        });
        assert.equal(result.board?.part, 'xc7a100tcsg324-1');
        assert.ok(result.bitstream?.canonical);
        assert.match(impl.request!.xdc, /PACKAGE_PIN J15 .*\{sw\}/, 'constraints come from board data + project pins');
    });

    it('hands the implementation provider a workspace outside the student source tree', async (t) => {
        const project = await makeProject(t);
        const impl = new MockImpl();
        await (await controller(new MockVhdl(), impl)).build(project);
        for (const f of impl.request ? await impl.request.workspace.listStaged() : []) {
            assert.ok(!f.startsWith(join(project.root, 'src')), f);
        }
        assert.ok(impl.request!.workspace.paths.impl.startsWith(join(project.root, '.nexysvhdl')));
    });

    it('stops at the first failing step', async (t) => {
        const vhdl = new MockVhdl({ checkFails: true });
        const result = await (await controller(vhdl, new MockImpl())).build(await makeProject(t));
        assert.equal(result.success, false);
        assert.deepEqual(vhdl.calls, ['check']);
        assert.equal(stepStatus(result)['check'], 'failed');
        assert.equal(result.diagnostics.at(-1)!.code, 'MOCK');
    });

    it('treats a failing testbench as a failed build', async (t) => {
        const vhdl = new MockVhdl({ simPasses: false });
        const result = await (await controller(vhdl, new MockImpl())).build(await makeProject(t), { simulate: true });
        assert.equal(result.success, false);
        assert.equal(stepStatus(result)['simulate'], 'failed');
        assert.ok(!vhdl.calls.includes('synthesize'));
    });

    it('treats failed timing as a failed build even though a bitstream exists', async (t) => {
        const result = await (await controller(new MockVhdl(), new MockImpl(false))).build(await makeProject(t));
        assert.equal(result.success, false);
        assert.ok(result.bitstream);
        assert.equal(result.timing?.passed, false);
    });

    it('reports a missing VHDL provider as not-configured, never success', async (t) => {
        const result = await (await controller()).build(await makeProject(t));
        assert.equal(result.success, false);
        assert.equal(stepStatus(result)['check'], 'not-configured');
        assert.equal(result.diagnostics.at(-1)!.code, 'VHDL_PROVIDER_NOT_CONFIGURED');
    });

    it('reports a missing implementation provider as not-configured after synthesis', async (t) => {
        const result = await (await controller(new MockVhdl())).build(await makeProject(t));
        assert.equal(result.success, false);
        assert.equal(stepStatus(result)['implement'], 'not-configured');
        assert.ok(result.generatedVerilog);
        assert.equal(result.bitstream, undefined);
    });

    it('does not call any provider for an invalid project', async (t) => {
        const vhdl = new MockVhdl();
        const result = await (await controller(vhdl, new MockImpl())).build(await makeProject(t, { top: '' }));
        assert.equal(stepStatus(result)['validate'], 'failed');
        assert.deepEqual(vhdl.calls, []);
    });

    it('check() and simulate() use the provider and honour not-configured', async (t) => {
        const project = await makeProject(t);
        const vhdl = new MockVhdl();
        const c = await controller(vhdl);
        assert.equal((await c.check(project)).status, 'succeeded');
        assert.equal((await c.simulate(project)).testbench, 'top_tb');
        assert.equal((await (await controller()).check(project)).status, 'not-configured');
    });
});
