import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseVcd } from '../../extension/waveform/vcd-parser';
import { type Segment, traceSegments, valueAt } from '../../extension/waveform/wave-render';

/**
 * Zoomed-out rendering must be transition-preserving: whatever the scale, the segments may lose
 * detail but never state a level the signal did not hold. `truthful` checks that against the data.
 */
function truthful(times: readonly number[], values: readonly string[], t0: number, t1: number, width: number, segs: readonly Segment[]): void {
    const tOf = (x: number) => t0 + (x / width) * (t1 - t0);
    for (const g of segs) {
        if (g.dense || g.x1 - g.x0 < 1e-6) continue;
        for (const f of [0.001, 0.25, 0.5, 0.75, 0.999]) {
            const t = tOf(g.x0 + (g.x1 - g.x0) * f);
            assert.equal(valueAt(times, values, t), g.value, `a plain segment [${g.x0}, ${g.x1}] claims '${g.value}' at t=${t}`);
        }
    }
}

const denseCount = (segs: readonly Segment[]) => segs.filter((s) => s.dense).length;

describe('digital waveform zoom-out keeps transitions', () => {
    it('reproduces the reported shape from a VCD: one-cycle pulse, then 0 for the rest of the run', () => {
        const vcd = parseVcd(['$timescale 1 fs $end', '$scope module tb $end', '$var wire 1 ! period_1_out $end', '$var wire 1 " period_2_out $end', '$upscope $end', '$enddefinitions $end',
            '#0', '0!', '0"', '#1000000', '1!', '#1010000', '0!', '1"', '#1020000', '0"', '#900000000'].join('\n'));
        const tr = vcd.traces.get('!')!;
        assert.deepEqual(tr.times, [0, 1_000_000, 1_010_000]);
        assert.deepEqual(tr.values, ['0', '1', '0']);
        // The whole 900 ns run on 1000 px: the 10 ns pulse is 0.011 px wide.
        const segs = traceSegments(tr.times, tr.values, 0, 900_000_000, 1000);
        truthful(tr.times, tr.values, 0, 900_000_000, 1000, segs);
        assert.equal(denseCount(segs), 1, 'the pulse is shown as activity');
        const d = segs.find((s) => s.dense)!;
        assert.deepEqual([d.entry, d.value, d.changes], ['0', '0', 2]);
        assert.deepEqual(d.states, ['0', '1']);
        const last = segs[segs.length - 1]!;
        assert.deepEqual([last.dense, last.value, last.x1], [undefined, '0', 1000], 'it ends low, not stuck high or shaded to the end');
        assert.ok(last.x0 < 4, 'the quiet stretch after the pulse is a plain low level');
        // The cursor reads the data, whatever the zoom: before, during, after.
        for (const [t, v] of [[999_999, '0'], [1_000_000, '1'], [1_005_000, '1'], [1_010_000, '0'], [500_000_000, '0']] as const) assert.equal(valueAt(tr.times, tr.values, t), v);
        // period_2_out: the same, one cycle later.
        const p2 = vcd.traces.get('"')!;
        assert.deepEqual(p2.values, ['0', '1', '0']);
        assert.equal(denseCount(traceSegments(p2.times, p2.values, 0, 900_000_000, 1000)), 1);
    });

    it('a pulse between long quiet levels is bracketed by true levels', () => {
        const times = [0, 1000, 5000, 5001, 9000], values = ['0', '1', '0', '1', '0'];
        const segs = traceSegments(times, values, 0, 10_000, 100); // 100 time units per pixel
        truthful(times, values, 0, 10_000, 100, segs);
        assert.deepEqual(segs.map((s) => [s.dense ?? false, s.value]), [[false, '0'], [false, '1'], [true, '1'], [false, '1'], [false, '0']]);
    });

    it('low-going pulse 1 -> 0 -> 1 stays visible', () => {
        const times = [0, 400_000, 400_010], values = ['1', '0', '1'];
        const segs = traceSegments(times, values, 0, 1_000_000, 500);
        truthful(times, values, 0, 1_000_000, 500, segs);
        const d = segs.find((s) => s.dense)!;
        assert.ok(d, 'the low pulse is activity');
        assert.deepEqual([d.entry, d.value, d.changes, d.states], ['1', '1', 2, ['1', '0']]);
        assert.equal(segs[segs.length - 1]!.value, '1');
    });

    it('0 -> 1 -> 0 -> 1 -> 0 inside one pixel is activity, not a constant', () => {
        const times = [0, 100, 101, 102, 103], values = ['0', '1', '0', '1', '0'];
        const segs = traceSegments(times, values, 0, 10_000, 100);
        truthful(times, values, 0, 10_000, 100, segs);
        const d = segs.find((s) => s.dense)!;
        assert.equal(d.changes, 4);
        assert.equal(segs.filter((s) => !s.dense && s.x0 < d.x0 && s.x1 > d.x1).length, 0, 'no plain level spans the cluster');
    });

    it('transitions on, just before and just after a pixel boundary are all kept', () => {
        // 10 time units per pixel, minPx 2 -> bucket boundaries every 20 units.
        for (const edge of [200, 199.999, 200.001, 199, 201]) {
            const times = [0, edge, edge + 1], values = ['0', '1', '0'];
            const segs = traceSegments(times, values, 0, 1000, 100);
            truthful(times, values, 0, 1000, 100, segs);
            assert.equal(denseCount(segs), 1, `pulse at ${edge}`);
        }
        // Two changes that straddle a bucket boundary but are less than a pixel apart still cluster.
        assert.equal(denseCount(traceSegments([0, 19.9, 20.1], ['0', '1', '0'], 0, 1000, 100)), 1);
        // A lone edge on a boundary stays an exact step.
        const lone = traceSegments([0, 200], ['0', '1'], 0, 1000, 100);
        assert.deepEqual(lone.map((s) => [s.x0, s.x1, s.value]), [[0, 20, '0'], [20, 100, '1']]);
    });

    it('a very large zoom-out of a short pulse keeps the logical interpretation', () => {
        const times = [0, 5_000_000, 5_010_000, 3_000_000_000_000], values = ['0', '1', '0', '1'];
        const segs = traceSegments(times, values, 0, 4_000_000_000_000, 300);
        truthful(times, values, 0, 4_000_000_000_000, 300, segs);
        assert.equal(denseCount(segs), 1);
        assert.equal(segs[segs.length - 1]!.value, '1', 'the real late rise is still there');
    });

    it('activity covers only its own cluster, never a quiet interval (16 pulses, 60 us apart)', () => {
        // The shape of the TWO_PERIOD_COUNTER_PROJECT outputs: 10 ns pulses every 60 us for 1 ms, timescale 1 fs.
        const times = [0], values = ['0'];
        for (let k = 0; k < 16; k++) times.push(50_095_000_000 + k * 60_000_000_000, 50_105_000_000 + k * 60_000_000_000), values.push('1', '0');
        const segs = traceSegments(times, values, 0, 1_000_000_000_000, 1000);
        truthful(times, values, 0, 1_000_000_000_000, 1000, segs);
        const dense = segs.filter((s) => s.dense);
        assert.equal(dense.length, 16);
        assert.ok(dense.every((s) => s.x1 - s.x0 <= 2 + 1e-9 && s.value === '0' && s.entry === '0'), 'each mark is about 2 px and leaves low');
        assert.ok(segs.filter((s) => !s.dense).every((s) => s.value === '0'), 'every level between the marks is low');
        // The cursor reads the data: before, inside and after a pulse.
        for (const [t, v] of [[50_090_000_000, '0'], [50_100_000_000, '1'], [50_110_000_000, '0']] as const) assert.equal(valueAt(times, values, t), v);
    });

    it('zoom in -> out -> in returns the identical rendering', () => {
        const times = Array.from({ length: 2000 }, (_, i) => i * 37 + (i % 7)), values = times.map((_, i) => (i % 2 ? '1' : '0'));
        const inSegs = () => traceSegments(times, values, 10_000, 10_400, 800);
        const first = inSegs();
        traceSegments(times, values, 0, 100_000, 800);
        traceSegments(times, values, 0, 1_000_000, 800);
        assert.deepEqual(inSegs(), first);
        assert.equal(denseCount(first), 0, 'zoomed in, the exact step waveform is drawn');
        truthful(times, values, 10_000, 10_400, 800, first);
    });

    it('zoomed in, every change is its own exact edge', () => {
        const segs = traceSegments([0, 10, 12, 30], ['0', '1', '0', '1'], 0, 40, 400); // 10 px per unit
        assert.deepEqual(segs.map((s) => [s.x0, s.x1, s.value, s.dense ?? false]), [[0, 100, '0', false], [100, 120, '1', false], [120, 300, '0', false], [300, 400, '1', false]]);
    });

    it('keeps metavalue transitions: nothing collapses into 0 or 1', () => {
        const times = [0, 1000, 1001, 1002, 50_000], values = ['0', 'x', '1', 'x', '0'];
        const segs = traceSegments(times, values, 0, 100_000, 100, 2, ['0', 'u', '1', 'z', '0']);
        truthful(times, values, 0, 100_000, 100, segs);
        const d = segs.find((s) => s.dense)!;
        assert.deepEqual(d.states, ['0', 'x', '1']);
        assert.deepEqual([d.value, d.raw], ['x', 'z'], 'the level leaving the cluster keeps its metavalue');
        const unknown = traceSegments([0, 5000], ['x', '0'], 0, 10_000, 100, 2, ['w', '0']);
        assert.deepEqual(unknown.map((s) => [s.value, s.raw]), [['x', 'w'], ['0', '0']]);
    });
});

describe('bus waveform zoom-out stays truthful', () => {
    it('several values compressed into a few pixels are one activity region, never one value', () => {
        const times = [0, 5000, 5001, 5002, 5003, 9000], values = ['0000', '0001', '0010', '0011', '0100', '1111'];
        const segs = traceSegments(times, values, 0, 10_000, 100);
        truthful(times, values, 0, 10_000, 100, segs);
        const d = segs.find((s) => s.dense)!;
        assert.equal(d.changes, 4);
        assert.ok(['0000', '0001', '0010', '0011', '0100'].every((v) => d.states!.includes(v)));
        assert.deepEqual(segs.filter((s) => !s.dense).map((s) => s.value), ['0000', '0100', '1111']);
    });

    it('is truthful against random traces at many zoom levels', () => {
        let seed = 12345;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        for (let round = 0; round < 40; round++) {
            const n = 1 + Math.floor(rnd() * 300);
            let t = 0;
            const times: number[] = [], values: string[] = [];
            for (let i = 0; i < n; i++) { t += rnd() < 0.3 ? 1 : 1 + Math.floor(rnd() * 500); times.push(t); values.push(String(i % 5)); }
            for (const [a, b, w] of [[0, t + 10, 50], [0, t + 10, 800], [t / 3, t / 2, 400], [0, 40, 640], [t * 0.4, t * 0.4 + 3, 900]] as const) {
                const segs = traceSegments(times, values, a, b, w);
                truthful(times, values, a, b, w, segs);
                assert.ok(segs.every((g) => g.x0 <= g.x1 + 1e-9), 'segments never run backwards');
                assert.deepEqual(traceSegments(times, values, a, b, w), segs, 'deterministic');
            }
        }
    });
});

describe('waveform level-of-detail performance', () => {
    it('draws 3 million changes in a bounded number of segments, fast', () => {
        const n = 3_000_000;
        const times = new Array<number>(n), values = new Array<string>(n);
        for (let i = 0; i < n; i++) { times[i] = i * 10; values[i] = i % 2 ? '1' : '0'; }
        const start = process.hrtime.bigint();
        let total = 0;
        for (let k = 0; k < 50; k++) total += traceSegments(times, values, 0, n * 10, 1600).length;
        const ms = Number(process.hrtime.bigint() - start) / 1e6 / 50;
        assert.ok(total / 50 <= 802, 'segments are bounded by the canvas width');
        assert.ok(ms < 50, `a 3M-change trace renders in ${ms.toFixed(2)} ms per frame`);
        console.log(`    3M-change trace, 1600 px: ${ms.toFixed(3)} ms per traceSegments call`);
    });
});
