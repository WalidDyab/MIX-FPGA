import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
    apioReachedStage,
    apioStageTracker,
    checkPortConstraints,
    type ImplementationProvider,
    type ImplementationRequest,
    type ImplementationResult,
    type ImplementationStage,
    type ProjectFile,
    normalizeXdcForImplementation,
    type SynthesisResult,
    updateProjectFile,
    validateProject,
    type VhdlContext,
    type VhdlProvider,
    verilogTopPorts,
    WorkflowController,
    WorkspaceManager,
    xdcPinAssignments,
} from '../core';
import { FIXTURES, makeProject, repoBoards, writeFiles } from './helpers';

const STUDENT_XDC = `## Clock
set_property -dict { PACKAGE_PIN E3    IOSTANDARD LVCMOS33 } [get_ports { clk }]; # 100 MHz
create_clock -period 10.00 [get_ports { clk }]
## Switches (bus)
set_property -dict { PACKAGE_PIN J15 IOSTANDARD LVCMOS33 } [get_ports { sw[0] }]
set_property PACKAGE_PIN L16 [get_ports {sw[1]}]
#set_property -dict { PACKAGE_PIN M13 IOSTANDARD LVCMOS33 } [get_ports { sw[2] }]
set_property -dict { PACKAGE_PIN H17 IOSTANDARD LVCMOS33 } [get_ports { led }]
`;

describe('direct XDC support (core)', () => {
    it('normalizes get_ports braces for nextpnr-xilinx without touching anything else', () => {
        const n = normalizeXdcForImplementation(STUDENT_XDC);
        assert.match(n, /\[get_ports \{clk\}\]; # 100 MHz/);
        assert.match(n, /\[get_ports \{sw\[0\]\}\]/);
        assert.doesNotMatch(n, /get_ports \{ /);
        assert.match(n, /PACKAGE_PIN E3    IOSTANDARD/, 'only the get_ports braces change');
        assert.match(n, /^#set_property/m);
    });

    it('lists active PACKAGE_PIN assignments, ignoring commented lines', () => {
        assert.deepEqual(xdcPinAssignments(STUDENT_XDC).map((a) => `${a.port}=${a.pin}@${a.line}`), ['clk=E3@2', 'sw[0]=J15@5', 'sw[1]=L16@6', 'led=H17@8']);
    });

    it('reads top-level ports from GHDL Verilog, including vectors', () => {
        const v = 'module counter_x(input clk);\nendmodule\nmodule top\n  (input  clk,\n   input  [1:0] sw,\n   output led);\n  wire x;\nendmodule\n';
        assert.deepEqual(verilogTopPorts(v, 'TOP'), [
            { name: 'clk', direction: 'input' },
            { name: 'sw', direction: 'input', bits: [0, 1] },
            { name: 'led', direction: 'output' },
        ]);
        assert.equal(verilogTopPorts('module other(input a); endmodule', 'top'), undefined);
    });

    it('requires a PACKAGE_PIN for every port bit and warns about pins for unknown ports', () => {
        const ports = [
            { name: 'clk', direction: 'input' as const },
            { name: 'sw', direction: 'input' as const, bits: [0, 1, 2] },
            { name: 'led', direction: 'output' as const },
            { name: 'beep', direction: 'output' as const },
        ];
        const d = checkPortConstraints(ports, STUDENT_XDC, 'constraints/board.xdc');
        assert.deepEqual(d.map((x) => `${x.severity}:${x.code}`), ['error:XDC_PORT_UNCONSTRAINED', 'error:XDC_PORT_UNCONSTRAINED']);
        assert.match(d[0]!.message, /bits sw\[2\] of port "sw"/);
        assert.match(d[1]!.message, /"beep"/);
        assert.deepEqual(d[0]!.location, { file: 'constraints/board.xdc' });
        const unknown = checkPortConstraints([{ name: 'clk', direction: 'input' }], 'set_property PACKAGE_PIN H17 [get_ports {led}]\nset_property PACKAGE_PIN E3 [get_ports {clk}]');
        assert.deepEqual(unknown.map((x) => `${x.severity}:${x.code}:${x.location?.line ?? '-'}`), ['warning:XDC_PORT_UNKNOWN:-']);
    });

    it('validates the constraints setting', async (t) => {
        const boards = await repoBoards();
        const codes = async (overrides: object, files: Record<string, string> = {}) => {
            const p = await makeProject(t, overrides);
            await writeFiles(p.root, files);
            return (await validateProject(p, boards)).diagnostics.map((d) => d.code);
        };
        assert.deepEqual(await codes({ pins: undefined, constraints: 'constraints/a.xdc' }, { 'constraints/a.xdc': '' }), []);
        assert.deepEqual(await codes({ constraints: 'constraints/a.xdc' }, { 'constraints/a.xdc': '' }), ['PROJECT_CONSTRAINTS_AND_PINS']);
        assert.deepEqual(await codes({ pins: undefined, constraints: 'constraints/missing.xdc' }), ['PROJECT_CONSTRAINTS_NOT_FOUND']);
        assert.deepEqual(await codes({ pins: undefined, constraints: 'constraints/a.txt' }, { 'constraints/a.txt': '' }), ['PROJECT_CONSTRAINTS_NOT_XDC']);
        assert.deepEqual(await codes({ pins: undefined, constraints: '../outside.xdc' }), ['PROJECT_PATH_OUTSIDE']);
        assert.deepEqual(await codes({ pins: undefined }), ['PROJECT_NO_PINS']);
    });
});

/** Removes the default pin mapping of VALID_CONFIG (undefined fields are dropped when the project file is written). */
const NO_PINS = { pins: undefined } as unknown as Partial<ProjectFile>;

/** Synthesis mock that writes a netlist with the given header. */
class NetlistVhdl implements VhdlProvider {
    readonly id = 'netlist-mock';
    constructor(private readonly header: string) {}
    async check() {
        return { status: 'succeeded' as const, diagnostics: [], logs: [], durationMs: 1, elaborated: ['top'] };
    }
    async simulate() {
        return { status: 'succeeded' as const, diagnostics: [], logs: [], durationMs: 1, testbench: '', passed: true, messages: [] };
    }
    async synthesize(ctx: VhdlContext): Promise<SynthesisResult> {
        const path = join(ctx.workspace.paths.synth, 'generated.v');
        await writeFile(path, `${this.header}\nendmodule\n`);
        return { status: 'succeeded', diagnostics: [], logs: [], durationMs: 1, top: 'top', modules: ['top'], generatedVerilog: { kind: 'generated-verilog', path, canonical: false } };
    }
}

class StagingImpl implements ImplementationProvider {
    readonly id = 'staging-mock';
    request?: ImplementationRequest;
    async implement(req: ImplementationRequest): Promise<ImplementationResult> {
        this.request = req;
        req.onStage?.('synthesis');
        req.onStage?.('implementation');
        req.onStage?.('bitstream');
        const staged = await req.workspace.stageImplementation([{ name: 'generated.xdc', content: req.xdc }]);
        const bit = join(staged.dir, 'hardware.bit');
        await writeFile(bit, 'mock');
        return { status: 'succeeded', diagnostics: [], logs: [], durationMs: 1, stagedFiles: staged.files, bitstream: { kind: 'bitstream', path: bit, canonical: true }, reachedStage: 'bitstream' };
    }
}

describe('WorkflowController with a project XDC file', () => {
    it('stages the normalized student XDC, leaves the student file unchanged and reports progress', async (t) => {
        const project = await makeProject(t, { ...NO_PINS, constraints: 'constraints/board.xdc' });
        await writeFiles(project.root, { 'constraints/board.xdc': STUDENT_XDC });
        const impl = new StagingImpl();
        const controller = new WorkflowController({ boards: await repoBoards(), workspaces: new WorkspaceManager(), vhdl: new NetlistVhdl('module top(input clk, input [1:0] sw, output led);'), implementation: impl });
        const progress: string[] = [];
        const r = await controller.build(project, { onProgress: (p) => progress.push(p.kind === 'implementation-stage' ? `stage:${p.stage}` : `${p.kind}:${p.step}`) });
        assert.equal(r.success, true, JSON.stringify(r.diagnostics));
        assert.deepEqual(r.constraintsSource, { kind: 'file', file: 'constraints/board.xdc' });
        assert.equal(r.implementationStage, 'bitstream');
        assert.match(impl.request!.xdc, /\[get_ports \{sw\[1\]\}\]/);
        assert.doesNotMatch(impl.request!.xdc, /get_ports \{ /);
        assert.equal(await readFile(join(project.root, 'constraints', 'board.xdc'), 'utf8'), STUDENT_XDC, 'the student file is never modified');
        assert.ok(progress.includes('step-started:constraints') && progress.includes('step-finished:implement'));
        assert.deepEqual(progress.filter((p) => p.startsWith('stage:')), ['stage:synthesis', 'stage:implementation', 'stage:bitstream']);
    });

    it('stops before implementation when a top-level port has no PACKAGE_PIN', async (t) => {
        const project = await makeProject(t, { ...NO_PINS, constraints: 'constraints/board.xdc' });
        await writeFiles(project.root, { 'constraints/board.xdc': STUDENT_XDC });
        const impl = new StagingImpl();
        const controller = new WorkflowController({ boards: await repoBoards(), workspaces: new WorkspaceManager(), vhdl: new NetlistVhdl('module top(input clk, input [2:0] sw, output led);'), implementation: impl });
        const r = await controller.build(project);
        assert.equal(r.success, false);
        assert.equal(r.steps.find((s) => s.step === 'constraints')?.status, 'failed');
        assert.equal(impl.request, undefined, 'implementation never ran');
        assert.ok(r.diagnostics.some((d) => d.code === 'XDC_PORT_UNCONSTRAINED' && d.location?.file === 'constraints/board.xdc'));
    });
});

describe('Apio stage tracking', () => {
    it('recognises Yosys, nextpnr and bitstream commands in Apio output', async () => {
        const log = await readFile(join(FIXTURES, 'apio', 'apio-build-phase2-nextpnr-onward.log'), 'utf8');
        assert.equal(apioReachedStage(log), 'bitstream');
        const failing = await readFile(join(FIXTURES, 'apio', 'apio-build-stray-v-failure.log'), 'utf8');
        assert.equal(apioReachedStage(failing), 'synthesis');
    });

    it('reports each stage once from streamed chunks split mid-line', () => {
        const seen: ImplementationStage[] = [];
        const feed = apioStageTracker((s) => seen.push(s));
        for (const chunk of ['Using env default\nyos', 'ys -p "synth_xilinx"\nnextpnr-xilinx --chipdb x\nnextpnr-xi', 'linx --chipdb again\nfasm2frames --part p\nxc7frames2bit --part_file f\n']) feed(chunk);
        assert.deepEqual(seen, ['synthesis', 'implementation', 'bitstream']);
    });
});

describe('project file writer', () => {
    it('patches nexysvhdl.json in place, keeping unknown fields and skipping no-op writes', async (t) => {
        const project = await makeProject(t);
        const raw = JSON.parse(await readFile(project.file, 'utf8'));
        raw.futureField = { keep: true };
        await writeFile(project.file, JSON.stringify(raw));
        assert.equal(await updateProjectFile(project.file, { top: 'counter', pins: undefined }), true);
        const after = JSON.parse(await readFile(project.file, 'utf8'));
        assert.equal(after.top, 'counter');
        assert.equal('pins' in after, false);
        assert.deepEqual(after.futureField, { keep: true });
        assert.deepEqual(Object.keys(after).slice(0, 4), ['name', 'board', 'language', 'standard'], 'key order is kept');
        assert.equal(await updateProjectFile(project.file, { top: 'counter' }), false);
    });
});
