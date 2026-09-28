import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { countPrimitives, listVerilogModules, parseApioBuildLog, parseGhdlOutput, parseNextpnrReport, renderApioIni, summarizeTiming } from '../core';
import { FIXTURES } from './helpers';

const fixture = (...p: string[]) => readFile(join(FIXTURES, ...p), 'utf8');

describe('GHDL output parser (real GHDL 6.0.0 output)', () => {
    it('turns analysis errors and warnings into located diagnostics, including paths with spaces', async () => {
        const { diagnostics } = parseGhdlOutput(await fixture('ghdl', 'analyze-errors.txt'));
        assert.deepEqual(
            diagnostics.map((d) => [d.severity, d.location?.file, d.location?.line, d.location?.column]),
            [
                ['error', 'src dir/bad.vhd', 4, 45],
                ['error', 'bad2.vhd', 8, 8],
                ['warning', 'ok.vhd', 3, 10],
                ['error', undefined, undefined, undefined],
            ],
        );
        assert.equal(diagnostics[1]!.message, 'no declaration for "b"');
        assert.match(diagnostics[3]!.message, /cannot find entity or configuration nosuch/);
    });

    it('extracts runtime assertions/reports and classifies severities', async () => {
        const { runtime, diagnostics } = parseGhdlOutput(await fixture('ghdl', 'sim-assert-failure.txt'));
        assert.deepEqual(runtime.map((m) => [m.kind, m.level, m.time, m.text]), [
            ['assertion', 'error', '0ms', 'boom'],
            ['report', 'note', '0ms', 'hello'],
            ['assertion', 'failure', '5ns', 'fatal'],
        ]);
        assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 4); // 2 assertions + 2 ghdl:error lines
    });

    it('recognises a passing testbench and its stop time', async () => {
        const parsed = parseGhdlOutput(await fixture('ghdl', 'sim-pass.txt'));
        assert.equal(parsed.stoppedAt, '280ns');
        assert.equal(parsed.runtime[0]!.text, 'ALL TESTS PASSED (28 checks, ends at 280000000 fs)');
        assert.equal(parsed.diagnostics.filter((d) => d.severity === 'error').length, 0);
    });

    it('lists Verilog modules (hierarchy check)', () => {
        assert.deepEqual(listVerilogModules('module counter_Brtl_27\n  (input clk);\nendmodule\n\nmodule top\n  (input a);\nendmodule\n'), ['counter_Brtl_27', 'top']);
    });
});

describe('Apio / nextpnr report parsers (real Phase 2 Windows output)', () => {
    it('reads utilization and fmax from the nextpnr report JSON', async () => {
        const { utilization, clocks } = parseNextpnrReport(await fixture('apio', 'nextpnr-report-phase2.json'));
        assert.deepEqual(utilization.luts, { used: 56, available: 126800 });
        assert.deepEqual(utilization.flipFlops, { used: 27, available: 126800 });
        assert.deepEqual(utilization.carry, { used: 7, available: 15850 });
        assert.equal(utilization.dsp?.used, 0);
        assert.equal(utilization.bram?.used, 0);
        assert.deepEqual(utilization.io, { used: 3, available: 630 });
        assert.deepEqual(clocks, [{ clock: 'clk100mhz', targetMHz: 100, achievedMHz: 409.67, passed: true }]);
    });

    it('reads part, post-route fmax, critical path and worst slack from the build log', async () => {
        const facts = parseApioBuildLog(await fixture('apio', 'apio-build-phase2-nextpnr-onward.log'));
        assert.equal(facts.success, true);
        assert.equal(facts.part, 'xc7a100tcsg324-1');
        assert.deepEqual(facts.maxFrequency, [{ clock: '$iopadmap$clk100mhz', achievedMHz: 409.67, targetMHz: 100, passed: true }]);
        assert.equal(facts.criticalPathNs, 2.4);
        assert.equal(facts.worstSlackNs, 7.559);
        assert.deepEqual(facts.diagnostics, []);
        const timing = summarizeTiming(facts.maxFrequency, facts);
        assert.equal(timing.passed, true);
    });

    it('reports the real stray-.v duplicate-module failure as an error', async () => {
        const facts = parseApioBuildLog(await fixture('apio', 'apio-build-stray-v-failure.log'));
        assert.equal(facts.success, false);
        assert.ok(facts.diagnostics.some((d) => d.severity === 'error' && /Re-definition of module/.test(d.message)));
    });

    it('turns warning lines into warning diagnostics (inline sample)', () => {
        const facts = parseApioBuildLog('Warning: No clocks found in design\n[SUCCESS] Took 1 seconds\n');
        assert.deepEqual(facts.diagnostics.map((d) => [d.severity, d.message]), [['warning', 'No clocks found in design']]);
    });

    it('counts primitives through user submodules (synthetic netlist)', async () => {
        assert.deepEqual(countPrimitives(await fixture('yosys', 'mini-netlist.json')), { FDRE: 4, CARRY4: 2, IBUF: 1, OBUF: 1 });
    });

    it('renders apio.ini with an explicit constraint file', () => {
        const ini = renderApioIni('nexys-a7-100t', 'top');
        assert.match(ini, /^board = nexys-a7-100t$/m);
        assert.match(ini, /^top-module = top$/m);
        assert.match(ini, /^constraint-file = generated\.xdc$/m);
    });
});
