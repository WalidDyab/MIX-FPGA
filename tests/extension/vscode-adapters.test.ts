import './install-vscode-fake';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import type { Diagnostic } from '../../core';
import { collectProblems, squiggleEnd } from '../../extension/diagnostics/problems';
import { ProblemsPublisher, toVsDiagnostic } from '../../extension/diagnostics/vscode-diagnostics';
import { createProject } from '../../extension/project/scaffold';
import { NexysVhdlService } from '../../extension/services/nexys-service';
import type { Node } from '../../extension/views/base';
import { FilesView } from '../../extension/views/files-view';
import { HardwareView } from '../../extension/views/hardware-view';
import { HierarchyView } from '../../extension/views/hierarchy-view';
import { ResultsView } from '../../extension/views/results-view';
import { WorkflowView } from '../../extension/views/workflow-view';
import { repoBoards, tempDir, writeFiles } from '../helpers';
import { FakeBackend, successfulBuild } from './fake-backend';
import { DESIGN_FILES } from './fixtures';
import { collections, DiagnosticSeverity } from './vscode-fake';

const ghdlError: Diagnostic = { severity: 'error', source: 'vhdl', code: 'GHDL_ERROR', message: "';' is expected instead of 'end'", location: { file: 'src/top.vhd', line: 12, column: 5 } };

async function setup(t: TestContext) {
    const parent = await tempDir(t);
    const r = await createProject({ parentDir: parent, name: 'Views', board: (await repoBoards()).get('nexys-a7-100t')! });
    assert.ok(r.ok);
    const backend = new FakeBackend();
    const service = new NexysVhdlService({ backend, debounceMs: 5 });
    t.after(() => service.dispose());
    await service.open(r.root);
    return { root: r.root, service, backend };
}

/** label/description lines of a tree, indented. */
function render(nodes: Node[], view: { getChildren(n?: Node): Node[] }, depth = 0): string[] {
    return nodes.flatMap((n) => [`${'  '.repeat(depth)}${String(n.label)}${n.description ? ` | ${n.description}` : ''}`, ...render(view.getChildren(n), view, depth + 1)]);
}
const tree = (view: { getChildren(n?: Node): Node[] }) => render(view.getChildren(), view);

describe('Problems integration', () => {
    it('maps structured diagnostics to files with 0-based ranges, dropping testbench notes', () => {
        const root = join('C:', 'proj');
        const problems = collectProblems(
            root,
            new Map([
                ['vhdl', [ghdlError, { severity: 'info', source: 'vhdl', code: 'GHDL_REPORT_NOTE', message: 'ALL TESTS PASSED', location: { file: 'sim/tb.vhd', line: 40 } }]],
                ['project', [{ severity: 'error', source: 'project', code: 'PROJECT_MISSING_TOP', message: 'Top entity is missing' }, ghdlError]],
            ]),
        );
        assert.deepEqual([...problems.keys()].sort(), [join(root, 'nexysvhdl.json'), join(root, 'src', 'top.vhd')].sort());
        assert.deepEqual(problems.get(join(root, 'src', 'top.vhd')), [{ severity: 'error', message: ghdlError.message, code: 'GHDL_ERROR', source: 'NexysVHDL (vhdl)', line: 11, column: 4 }], 'duplicates are merged');
        assert.equal(problems.get(join(root, 'nexysvhdl.json'))![0]!.line, 0);
    });

    it('converts entries to vscode.Diagnostic with severity, code and a token-wide squiggle', () => {
        const d = toVsDiagnostic({ severity: 'warning', message: 'm', code: 'C', source: 'NexysVHDL (vhdl)', line: 3, column: 4 }, '    count <= x;');
        assert.equal(d.severity, DiagnosticSeverity.Warning);
        assert.equal(d.code, 'C');
        assert.equal(d.source, 'NexysVHDL (vhdl)');
        assert.deepEqual([d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character], [3, 4, 3, 9]);
        const whole = toVsDiagnostic({ severity: 'error', message: 'm', code: 'C', source: 's', line: 0 }, 'abc');
        assert.deepEqual([whole.range.start.character, whole.range.end.character], [0, 3]);
        assert.equal(squiggleEnd('a ; b', 2), 3, 'a delimiter gets a one-character squiggle');
    });

    it('publishes to a DiagnosticCollection and clears problems fixed by the next Check', async (t) => {
        const { root, service, backend } = await setup(t);
        const publisher = new ProblemsPublisher(service);
        t.after(() => publisher.dispose());
        const collection = collections[collections.length - 1]!;
        backend.checkResult = { status: 'failed', diagnostics: [ghdlError], logs: [], durationMs: 1, elaborated: [] };
        await service.check();
        const top = collection.entries.get(join(root, 'src', 'top.vhd'))!;
        assert.equal(top.length, 1);
        assert.equal(top[0]!.message, ghdlError.message);
        assert.equal(top[0]!.range.start.line, 11);
        backend.checkResult = { status: 'succeeded', diagnostics: [], logs: [], durationMs: 1, elaborated: ['top'] };
        await service.check();
        assert.equal(collection.entries.get(join(root, 'src', 'top.vhd')), undefined);
    });
});

describe('tree views', () => {
    it('Project Files marks TOP and the XDC in use', async (t) => {
        const { service } = await setup(t);
        const view = new FilesView(service);
        assert.deepEqual(tree(view), ['Sources', '  top.vhd | TOP', 'Simulation', '  top_tb.vhd | TESTBENCH', 'Constraints', '  nexys-a7-100t.xdc | IN USE']);
    });

    it('Design Hierarchy shows instance labels, entity types, TOP, unused entities and testbenches', async (t) => {
        const { root, service } = await setup(t);
        await writeFiles(root, DESIGN_FILES);
        await service.refreshNow();
        const lines = tree(new HierarchyView(service));
        assert.deepEqual(lines.slice(0, 6), ['Top | TOP', '  u_clock : clock_divider', '  U_Counter : counter', '  u_display : display_driver', '    u_mux : display_mux', '    u_decoder : seven_seg_decoder']);
        assert.ok(lines.includes('Not used by top | 1'));
        assert.ok(lines.includes('  old_blinker | src/old_blinker.vhd'));
        assert.ok(lines.includes('Testbenches'));
        const nodes = new HierarchyView(service).getChildren();
        assert.equal(nodes[0]!.command?.command, 'nexysvhdl.openLocation');
        const decoder = nodes[0]!.children![2]!.children![1]!;
        assert.deepEqual(decoder.command!.arguments, [root, 'src/display/display_driver.vhd', 22, 5]);
    });

    it('Workflow shows Build as Synthesis / Implementation / Bitstream and the result summary', async (t) => {
        const { root, service, backend } = await setup(t);
        const view = new WorkflowView(service);
        assert.deepEqual(tree(view), [
            'Check',
            'Simulate',
            'Build',
            '  Synthesis | VHDL → logic netlist',
            '  Implementation | placement · routing · timing',
            '  Bitstream | → hardware.bit',
            'Program',
        ]);
        backend.buildResult = successfulBuild(join(root, '.nexysvhdl', 'impl', '_build', 'default', 'hardware.bit'));
        await service.build();
        assert.deepEqual(tree(view), [
            'Check | No VHDL errors',
            '  Open Design Schematic | structure',
            '  Open RTL Schematic | inferred hardware',
            'Simulate',
            'Build | BUILD COMPLETE',
            '  Synthesis | 56 LUTs · 27 FFs',
            '  Implementation | Timing PASS · 372.58 MHz',
            '  Bitstream | hardware.bit · 3.6 MB',
            'Program',
        ]);
    });

    it('Results shows timing and resources from the BuildResult only', async (t) => {
        const { root, service, backend } = await setup(t);
        const build = successfulBuild(join(root, 'hardware.bit'));
        backend.buildResult = { ...build, utilization: { luts: { used: 56, available: 63400 }, flipFlops: { used: 27 } } };
        await service.build();
        const lines = tree(new ResultsView(service));
        assert.deepEqual(lines.slice(0, 11), [
            'Build | BUILD COMPLETE',
            '  Timing | PASS',
            '  Target | 100 MHz',
            '  Achieved | 372.58 MHz',
            '  Worst slack | 7.3 ns',
            '  Resources',
            '    LUTs | 56 / 63400',
            '    Flip-Flops | 27',
            '    BRAM | not reported',
            '    DSP | not reported',
            '  Bitstream | hardware.bit',
        ]);
    });

    it('Hardware lists several boards for an explicit choice', async (t) => {
        const { service, backend } = await setup(t);
        const view = new HardwareView(service);
        assert.deepEqual(tree(view), ['Not checked yet | click to detect']);
        await service.detectBoards();
        assert.deepEqual(tree(view), ['No Nexys A7 detected', 'Connect your board by USB and turn it on.']);
        backend.detection = {
            configured: true,
            boards: ['210292BCFFE4', '210292ABCDEF'].map((s) => ({ selector: `SN:${s}`, serialNumber: s, productName: 'Nexys A7 -100T', boardId: 'nexys-a7-100t' })),
            diagnostics: [{ severity: 'warning', source: 'programming', code: 'JTAG', message: 'Board detected by USB, but the FPGA/JTAG chain is unavailable. Check that the board power switch is ON.' }],
        };
        await service.detectBoards();
        assert.deepEqual(tree(view), [
            '2 Nexys A7 boards | choose one',
            '210292BCFFE4 | Nexys A7 -100T',
            '210292ABCDEF | Nexys A7 -100T',
            'Board detected by USB, but the FPGA/JTAG chain is unavailable. Check that the board power switch is ON.',
        ]);
        service.selectBoard('210292ABCDEF');
        assert.equal(tree(view)[0], '2 Nexys A7 boards | using 210292ABCDEF');
    });
});
