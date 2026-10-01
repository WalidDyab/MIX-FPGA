import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { ApioYosysRtlProvider, GhdlVhdlProvider, loadProject, rtlYosysScript, WorkflowController, WorkspaceManager } from '../../core';
import { createProject } from '../../extension/project/scaffold';
import { renderRtlHtml } from '../../extension/rtl/rtl-html';
import { buildRtlModel, classifyCell, entityForModule, ghdlSourceMap, parseYosysJson, type RtlModuleView, type RtlNode } from '../../extension/rtl/rtl-model';
import { layoutRtl, renderRtlSvg, rtlColumns } from '../../extension/rtl/rtl-svg';
import { NexysError, NexysVhdlService } from '../../extension/services/nexys-service';
import { FakeRunner, FIXTURES, repoBoards, tempDir } from '../helpers';
import { FakeBackend, OK } from './fake-backend';
import { SYNTHETIC_NETLIST, syntheticVerilog } from './rtl-fixtures';

const ROOT = join('/', 'proj', 'demo');

function synthetic(): RtlModuleView {
    const model = buildRtlModel(parseYosysJson(JSON.stringify(SYNTHETIC_NETLIST)), { verilog: syntheticVerilog(ROOT), projectRoot: ROOT, entities: ['top', 'child'] });
    return model.modules.get('top')!;
}

const byRaw = (v: RtlModuleView, type: string) => v.nodes.find((n) => n.rawType === type)!;
const inEdges = (v: RtlModuleView, n: RtlNode) => v.edges.filter((e) => e.to.node === n.id);
const nodeOf = (v: RtlModuleView, id: string) => v.nodes.find((n) => n.id === id)!;
/** "driver.pin -> pin" descriptions of the edges into a node. */
const feeds = (v: RtlModuleView, n: RtlNode) => inEdges(v, n).map((e) => `${nodeOf(v, e.from.node).label}${e.slice ?? ''} -> ${e.to.pin}`).sort();

async function realEdhDemo() {
    // Real EdhDemo netlist (Yosys RTL JSON + GHDL Verilog); GHDL's absolute paths re-rooted for this host.
    const root = join('/', 'work', 'EdhDemo');
    const verilog = (await readFile(join(FIXTURES, 'rtl', 'edhdemo-generated.v'), 'utf8')).replace(/C:\\proj\\EdhDemo\\(\w+)\\([\w.]+)/g, (_m, dir: string, file: string) => join(root, dir, file));
    const json = await readFile(join(FIXTURES, 'rtl', 'edhdemo-rtl.json'), 'utf8');
    return buildRtlModel(parseYosysJson(json), { top: 'top', verilog, projectRoot: root, entities: ['top', 'blink_counter'] });
}

describe('RTL model from a Yosys JSON netlist', () => {
    it('parses the netlist and decodes binary parameters', () => {
        const v = synthetic();
        assert.equal(byRaw(v, '$add').parameters!['Y_WIDTH'], 4);
        assert.throws(() => parseYosysJson('{"creator":"x"}'), /no "modules"/);
    });

    it('represents top-level input and output ports with their widths', () => {
        const v = synthetic();
        const ports = v.nodes.filter((n) => n.kind === 'input' || n.kind === 'output').map((n) => `${n.kind}:${n.label}:${n.width}`);
        assert.deepEqual(ports, ['input:clk:1', 'input:rst:1', 'input:sel:1', 'input:a:4', 'input:b:4', 'output:y:4', 'output:eq:1', 'output:led:1']);
    });

    it('represents registers with clock, reset, width and edge', () => {
        const v = synthetic();
        const reg = byRaw(v, '$adff');
        assert.equal(reg.kind, 'register');
        assert.equal(reg.label, 'Register');
        assert.equal(reg.sublabel, '4 bits · rising edge');
        assert.equal(reg.description, 'register with asynchronous reset');
        assert.deepEqual(reg.pins.map((p) => `${p.label}:${p.dir}`).sort(), ['D:in', 'Q:out', 'clk:in', 'rst:in']);
        assert.deepEqual(feeds(v, reg), ['MUX -> D', 'clk -> CLK', 'rst -> ARST']);
        assert.equal(v.edges.find((e) => e.from.node === reg.id)!.to.node, 'port:y');
    });

    it('represents multiplexers with labelled 0/1/sel inputs', () => {
        const v = synthetic();
        const mux = byRaw(v, '$mux');
        assert.equal(mux.label, 'MUX');
        assert.deepEqual(mux.pins.filter((p) => p.dir === 'in').map((p) => p.label), ['0', '1', 'sel']);
        assert.deepEqual(feeds(v, mux), ['+ -> A', 'a -> B', 'sel -> S']);
    });

    it('represents arithmetic and comparison operators with student symbols', () => {
        const v = synthetic();
        assert.equal(byRaw(v, '$add').label, '+');
        assert.equal(byRaw(v, '$add').kind, 'arith');
        assert.deepEqual(feeds(v, byRaw(v, '$add')), ['a -> A', 'b -> B']);
        assert.equal(byRaw(v, '$eq').label, '=');
        assert.equal(byRaw(v, '$eq').kind, 'compare');
        assert.equal(classifyCell('$sub', new Set()).label, '−');
        assert.equal(classifyCell('$lt', new Set()).label, '<');
    });

    it('represents logic gates', () => {
        const v = synthetic();
        assert.deepEqual(['$and', '$not', '$xor', '$or'].map((t) => `${byRaw(v, t).label}/${byRaw(v, t).kind}`), ['AND/logic', 'NOT/logic', 'XOR/logic', 'OR/logic']);
        assert.deepEqual(feeds(v, byRaw(v, '$and')), ['NOT -> A', 'sel -> B']);
        assert.equal(classifyCell('$reduce_or', new Set()).kind, 'reduce');
    });

    it('represents constants, slices, concatenations and named nets', () => {
        const v = synthetic();
        // a(1 downto 0) xor "01": a slice of the input and a constant.
        assert.deepEqual(feeds(v, byRaw(v, '$xor')), ["2'b01 -> B", 'a[1:0] -> A']);
        // ("10" & x2) or b: the OR's A input is a concatenation of the XOR output and a constant.
        const or = byRaw(v, '$or');
        const concatEdge = inEdges(v, or).find((e) => e.to.pin === 'A')!;
        const concat = nodeOf(v, concatEdge.from.node);
        assert.equal(concat.kind, 'concat');
        assert.deepEqual(feeds(v, concat), ["2'b10 -> in1", 'XOR -> in0']);
        assert.deepEqual(concat.pins.filter((p) => p.dir === 'in').map((p) => p.label), ['[3:2]', '[1:0]']);
        // The adder output is the named signal "sum"; GHDL temporaries (n22) are never labels.
        assert.equal(v.edges.find((e) => e.from.node === byRaw(v, '$add').id)!.label, 'sum');
        assert.equal(v.edges.find((e) => e.from.node === byRaw(v, '$mux').id)!.label, undefined);
    });

    it('shows unsupported cells as generic blocks with their raw type', () => {
        const v = synthetic();
        const g = byRaw(v, '$fancy');
        assert.equal(g.kind, 'generic');
        assert.equal(g.label, '$fancy');
        assert.match(g.description, /generic block/);
        assert.match(renderRtlSvg(v), /class="node kind-generic"/);
    });

    it('keeps module instances and allows drilling into netlist modules', () => {
        const v = synthetic();
        const inst = v.nodes.find((n) => n.kind === 'instance')!;
        assert.equal(inst.label, 'u_child');
        assert.equal(inst.module, 'child');
        assert.equal(entityForModule('blink_counter_Brtl_26', ['top', 'blink', 'blink_counter']), 'blink_counter');
        assert.equal(entityForModule('other', ['top']), undefined);
    });

    it('maps cells to VHDL only where GHDL marked the statement, never otherwise', () => {
        const v = synthetic();
        assert.deepEqual(byRaw(v, '$add').source, { file: 'src/top.vhd', line: 21, col: 17 });
        assert.deepEqual(byRaw(v, '$adff').source, { file: 'src/top.vhd', line: 25, col: 9 });
        assert.equal(byRaw(v, '$mux').source, undefined, 'no GHDL comment directly above its line');
        assert.equal(byRaw(v, '$eq').source, undefined, 'no src attribute');
        const outside = ghdlSourceMap('  /*# /elsewhere/x.vhd:1:1 */\n  assign a = b;', ROOT);
        assert.equal(outside.size, 0, 'files outside the project are not linked');
    });
});

describe('RTL schematic of the real EdhDemo netlist', () => {
    it('shows the AND that combines SW0 with the blink_counter output into LED0', async () => {
        const model = await realEdhDemo();
        const top = model.modules.get('top')!;
        const and = byRaw(top, '$and');
        assert.equal(and.label, 'AND');
        assert.deepEqual(feeds(top, and), ['sw0 -> B', 'u_blink -> A']);
        assert.equal(top.edges.find((e) => e.from.node === and.id)!.to.node, 'port:led0');
        assert.equal(and.source?.file, 'src/top.vhd');
        assert.equal(and.source?.line, 32);
        assert.equal(top.nodes.find((n) => n.kind === 'instance')!.sublabel, 'blink_counter');
    });

    it('shows the counter as register + adder + reset multiplexer with feedback', async () => {
        const model = await realEdhDemo();
        const c = model.modules.get('blink_counter_Brtl_26')!;
        assert.equal(c.displayName, 'blink_counter');
        assert.deepEqual(c.summary, { '+': 1, Register: 1, MUX: 1 });
        const reg = byRaw(c, '$dff');
        assert.equal(reg.sublabel, '27 bits · rising edge');
        assert.deepEqual(feeds(c, byRaw(c, '$add')), ["27'h0000001 -> B", 'Register -> A']);
        assert.deepEqual(feeds(c, byRaw(c, '$mux')), ["+ -> A", "27'h0000000 -> B", 'reset -> S']);
        const q = c.edges.find((e) => e.to.node === 'port:q')!;
        assert.equal(`${q.label}${q.slice}`, 'count[26]', 'the output is bit 26 of the counter');
        // Register -> adder -> mux -> register: the loop is drawn as feedback.
        const cols = rtlColumns(c);
        assert.ok(cols.get(byRaw(c, '$add').id)! > cols.get(reg.id)! || cols.get(byRaw(c, '$mux').id)! < cols.get(reg.id)!);
        assert.match(renderRtlSvg(c), /class="wire bus feedback"/);
    });

    it('lays out inputs left, outputs right, and renders a page with legend and details', async () => {
        const model = await realEdhDemo();
        const top = model.modules.get('top')!;
        const layout = layoutRtl(top);
        const xOf = (id: string) => layout.placed.get(id)!.x;
        assert.ok(xOf('port:sw0') < xOf(byRaw(top, '$and').id) && xOf(byRaw(top, '$and').id) < xOf('port:led0'));
        const html = renderRtlHtml({ nonce: 'n0nce', state: { kind: 'ready' }, view: top, path: [{ module: 'top', label: 'top' }] });
        assert.match(html, /<h2>Legend<\/h2>/);
        assert.match(html, /"rawType":"\$and"/);
        assert.match(html, /script-src 'nonce-n0nce'/);
        assert.doesNotMatch(renderRtlHtml({ nonce: 'x', state: { kind: 'running' } }), /<svg/);
    });
});

describe('RTL analysis in the shared core', () => {
    async function project(t: TestContext) {
        const parent = await tempDir(t);
        const r = await createProject({ parentDir: parent, name: 'Rtl', board: (await repoBoards()).get('nexys-a7-100t')! });
        assert.ok(r.ok);
        return r.root;
    }

    async function tree(dir: string, prefix = ''): Promise<string[]> {
        const out: string[] = [];
        for (const e of await readdir(dir, { withFileTypes: true })) {
            if (e.name === '.nexysvhdl') continue;
            out.push(`${prefix}${e.name}`);
            if (e.isDirectory()) out.push(...(await tree(join(dir, e.name), `${prefix}${e.name}/`)));
        }
        return out.sort();
    }

    it('writes only into .nexysvhdl/rtl, runs GHDL synthesis and generic Yosys RTL, and never places/routes', async (t) => {
        const root = await project(t);
        const before = await tree(root);
        const runner = new FakeRunner((inv) => {
            if (inv.args[0] === '--synth') return { stdout: 'module top(input clk, input btnc, input sw0, output led0);\nendmodule\n' };
            if (inv.args[0] === 'raw') {
                mkdirSync(inv.cwd!, { recursive: true });
                writeFileSync(join(inv.cwd!, 'rtl.json'), JSON.stringify(SYNTHETIC_NETLIST));
            }
            return {};
        });
        const controller = new WorkflowController({
            boards: await repoBoards(),
            workspaces: new WorkspaceManager(),
            vhdl: new GhdlVhdlProvider('/fake/ghdl', runner),
            rtl: new ApioYosysRtlProvider('/fake/apio', runner),
        });
        const loaded = await loadProject(root);
        assert.ok(loaded.ok);
        const r = await controller.rtl(loaded.project);
        assert.equal(r.status, 'succeeded', JSON.stringify(r.diagnostics));
        const rtlDir = join(root, '.nexysvhdl', 'rtl');
        assert.equal(r.netlist!.path, join(rtlDir, 'rtl.json'));
        assert.equal(r.verilog!.path, join(rtlDir, 'generated.v'));
        assert.deepEqual(runner.calls.map((c) => c.cwd), [rtlDir, rtlDir]);
        const yosys = runner.calls[1]!;
        assert.deepEqual(yosys.args.slice(0, 4), ['raw', '--', 'yosys', '-q']);
        const script = yosys.args[5]!;
        assert.equal(script, rtlYosysScript('generated.v', 'top'));
        assert.match(script, /\bproc\b/);
        assert.doesNotMatch(script, /synth_xilinx|synth\b|techmap|flatten|nextpnr|place|route|bit/i);
        assert.ok(!runner.calls.some((c) => c.args.includes('build')), 'apio build (implementation) is never run');
        assert.deepEqual(await tree(root), before, 'the student tree is untouched');
    });

    it('is not configured without the tools, and stops at a failed synthesis', async (t) => {
        const root = await project(t);
        const loaded = await loadProject(root);
        assert.ok(loaded.ok);
        const nothing = new WorkflowController({ boards: await repoBoards(), workspaces: new WorkspaceManager() });
        assert.equal((await nothing.rtl(loaded.project)).status, 'not-configured');
        const failing = new FakeRunner((inv) => (inv.args[0] === '--synth' ? { exitCode: 1, stderr: 'src/top.vhd:3:1:error: oops\n' } : {}));
        const c = new WorkflowController({ boards: await repoBoards(), workspaces: new WorkspaceManager(), vhdl: new GhdlVhdlProvider('/g', failing), rtl: new ApioYosysRtlProvider('/a', failing) });
        const r = await c.rtl(loaded.project);
        assert.equal(r.status, 'failed');
        assert.equal(failing.calls.length, 1, 'Yosys is not run after a failed synthesis');
    });
});

describe('RTL schematic in the extension service', () => {
    async function open(t: TestContext) {
        const parent = await tempDir(t);
        const r = await createProject({ parentDir: parent, name: 'RtlSvc', board: (await repoBoards()).get('nexys-a7-100t')! });
        assert.ok(r.ok);
        const backend = new FakeBackend();
        const service = new NexysVhdlService({ backend, debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(r.root);
        return { root: r.root, service, backend };
    }

    it('is unavailable until Check passes, with a clear diagnostic', async (t) => {
        const { service, backend } = await open(t);
        await assert.rejects(service.generateRtl(), (e: Error) => e instanceof NexysError && /Run Check first/.test(e.message));
        backend.checkResult = { ...OK, status: 'failed', elaborated: [], diagnostics: [{ severity: 'error', source: 'vhdl', code: 'E', message: 'bad' }] };
        await service.check();
        await assert.rejects(service.generateRtl(), NexysError);
        assert.ok(!backend.calls.includes('rtl'));
    });

    it('generates lazily after a passed Check, maps sources, and becomes stale when the VHDL changes', async (t) => {
        const { root, service, backend } = await open(t);
        await service.check();
        assert.ok(!backend.calls.includes('rtl'), 'Check alone does not synthesize');
        const states: string[] = [];
        service.onDidChange((k) => k === 'rtl' && states.push(service.rtl.status));
        const rtl = await service.generateRtl();
        assert.deepEqual(states, ['running', 'ready']);
        assert.equal(rtl.status, 'ready');
        if (rtl.status !== 'ready') return;
        const add = rtl.model.modules.get('top')!.nodes.find((n) => n.rawType === '$add')!;
        assert.deepEqual(add.source, { file: 'src/top.vhd', line: 21, col: 17 });
        assert.equal(service.rtlStale, false);
        await appendFile(join(root, 'src', 'top.vhd'), '\n-- edited\n');
        await service.refreshNow();
        assert.equal(service.rtlStale, true, 'never silently stale');
    });

    it('reports a failed RTL analysis without a model', async (t) => {
        const { service, backend } = await open(t);
        await service.check();
        backend.rtlResult = { status: 'failed', top: 'top', logs: [], durationMs: 1, diagnostics: [{ severity: 'error', source: 'implementation', code: 'RTL_FAILED', message: 'RTL analysis failed: ERROR: x.' }] };
        const r = await service.generateRtl();
        assert.equal(r.status, 'failed');
        assert.equal(r.status === 'failed' && r.message, 'RTL analysis failed: ERROR: x.');
    });
});
