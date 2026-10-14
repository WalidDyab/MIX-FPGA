import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DE10_LITE_PROFILE, combineClocks, parseFmax, parseQuartusMessages, parseSdcClocks, parseStaSummary, parseStageSummary, stageSucceeded, timingStatus } from '../../core/backend';
import { QFIX } from './fake-vm';

const fx = (n: string) => readFile(join(QFIX, n), 'utf8');

describe('Quartus report parsing (real Phase 1 DE10-Lite reports)', () => {
    it('reads device, top entity and vendor-native resources from the fitter summary', async () => {
        const s = parseStageSummary(await fx('blink.fit.summary'), DE10_LITE_PROFILE);
        assert.equal(s.device, '10M50DAF484C7G');
        assert.equal(s.topEntity, 'blink');
        assert.equal(s.family, 'MAX 10');
        assert.deepEqual(s.resources.logic, { used: 27, available: 49760, label: 'Logic Elements', vendorName: 'Total logic elements' });
        assert.equal(s.resources.registers?.used, 26);
        assert.equal(s.resources.memoryBits?.available, 1677312);
        assert.equal(s.resources.dsp?.used, 0);
        assert.equal(s.resources.dsp?.available, 288);
        assert.equal(s.resources.pins?.used, 2);
    });

    it('keeps the synthesis estimate separate (26 logic elements before the fitter)', async () => {
        const s = parseStageSummary(await fx('blink.map.summary'), DE10_LITE_PROFILE);
        assert.equal(s.resources.logic?.used, 26);
        assert.equal(s.resources.logic?.available, undefined);
    });

    it('takes the worst setup and hold slack over all corners', async () => {
        const sta = parseStaSummary(await fx('blink.sta.summary'));
        assert.equal(sta.worstSetupSlackNs, 16.605);
        assert.equal(sta.worstHoldSlackNs, 0.156);
        assert.deepEqual(sta.perClock.get('clk_50'), { setup: 16.605, hold: 0.156 });
    });

    it('reads Fmax (minimum over corners) and the I/O-restricted Fmax', async () => {
        const f = parseFmax(await fx('blink.sta.fmax.rpt'));
        assert.deepEqual(f.get('clk_50'), { fmaxMHz: 294.55, restrictedFmaxMHz: 250 });
    });

    it('derives the target clock from the SDC and reports timing met', async () => {
        const targets = parseSdcClocks(await fx('de10-lite.sdc'));
        assert.equal(targets.get('clk_50'), 50);
        const sta = parseStaSummary(await fx('blink.sta.summary'));
        assert.equal(timingStatus(sta, targets), 'met');
        const c = combineClocks(sta, parseFmax(await fx('blink.sta.fmax.rpt')), targets);
        assert.deepEqual(c, [{ name: 'clk_50', targetMHz: 50, fmaxMHz: 294.55, restrictedFmaxMHz: 250, worstSetupSlackNs: 16.605, worstHoldSlackNs: 0.156 }]);
    });

    it('reports not-met on negative slack, unconstrained without a clock, not-run without a report', () => {
        const neg = parseStaSummary("Type : Slow 1200mV 85C Model Setup 'c'\nSlack : -0.5\nTNS : -1\n");
        assert.equal(timingStatus(neg, new Map([['c', 100]])), 'not-met');
        assert.equal(timingStatus(neg, new Map()), 'unconstrained');
        assert.equal(timingStatus(undefined, new Map()), 'not-run');
    });

    it('accepts only a stage that Quartus itself calls successful', async () => {
        assert.equal(stageSucceeded(await fx('success-lines.log')), true);
        assert.equal(stageSucceeded('Info: Quartus Prime Fitter was unsuccessful. 1 error, 0 warnings\n'), false);
        assert.equal(stageSucceeded('Info: Quartus Prime Fitter was successful. 3 errors, 0 warnings\n'), false);
        assert.equal(stageSucceeded(''), false);
    });

    it('turns Quartus warnings and errors into deduplicated diagnostics', async () => {
        const m = parseQuartusMessages((await fx('fit-messages.log')) + 'Error (20004): bad family\nError (20004): bad family\n');
        assert.ok(m.warnings.some((w) => w.code === 'QUARTUS_W18236'));
        assert.ok(m.warnings.every((w) => w.severity === 'warning'));
        assert.deepEqual(m.errors.map((e) => [e.code, e.message]), [['QUARTUS_E20004', 'bad family (x2)']]);
    });

    it('returns empty results for empty input rather than throwing', () => {
        const s = parseStageSummary('', DE10_LITE_PROFILE);
        assert.deepEqual(s.resources, {});
        assert.equal(parseFmax('').size, 0);
        assert.equal(parseStaSummary('').perClock.size, 0);
    });
});
