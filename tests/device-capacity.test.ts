import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { applyDeviceCapacity, BoardRegistry, parseNextpnrReport } from '../core';
import { buildResultsModel } from '../extension/services/results-model';
import { successfulBuild } from './extension/fake-backend';
import { FIXTURES, repoBoards, tempDir, writeFiles } from './helpers';

const report = async () => parseNextpnrReport(await readFile(join(FIXTURES, 'apio', 'nextpnr-report-phase2.json'), 'utf8'));

describe('device capacity (Results: what students compare with Vivado)', () => {
    it('Nexys A7-100T board metadata carries the XC7A100T/CSG324 data-sheet capacity', async () => {
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        const c = board.fpga.capacity!;
        assert.deepEqual({ luts: c.luts, flipFlops: c.flipFlops, slices: c.slices, bram36: c.bram36, dsp: c.dsp, userIo: c.userIo, bufg: c.globalClockBuffers }, {
            luts: 63_400, flipFlops: 126_800, slices: 15_850, bram36: 135, dsp: 240, userIo: 210, bufg: 32,
        });
        assert.equal(c.luts, c.slices! * 4, '4 LUT6 per 7-series slice');
        assert.match(c.source, /DS180/);
    });

    it('nextpnr reports 126,800 SLICE_LUTX bels (two per LUT6 site) — not the LUT capacity', async () => {
        const { utilization } = await report();
        assert.deepEqual(utilization.luts, { used: 56, available: 126_800 }, 'the raw placer figure');
        assert.deepEqual(utilization.device!['SLICE_LUTX'], { used: 56, available: 126_800 });
    });

    it('applyDeviceCapacity shows the data-sheet capacity and keeps the placer figures as detail', async () => {
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        const u = applyDeviceCapacity((await report()).utilization, board.fpga.capacity!);
        assert.deepEqual(u.luts, { used: 56, available: 63_400 });
        assert.deepEqual(u.flipFlops, { used: 27, available: 126_800 });
        assert.deepEqual(u.io, { used: 3, available: 210 }, 'user I/O of the CSG324 package, not nextpnr\'s 630 pads');
        assert.deepEqual(u.bram, { used: 0, available: 135 });
        assert.deepEqual(u.dsp, { used: 0, available: 240 });
        assert.deepEqual(u.device!['SLICE_LUTX'], { used: 56, available: 126_800 }, 'engineering detail unchanged');
        assert.match(u.capacitySource!, /DS180/);
    });

    it('counts block RAM in 36 Kb blocks (RAMB18 = half)', () => {
        const u = applyDeviceCapacity({ device: { RAMB36E1_RAMB36E1: { used: 2, available: 135 }, RAMB18E1_RAMB18E1: { used: 3, available: 270 } } }, { luts: 1, flipFlops: 1, bram36: 135, dsp: 1, userIo: 1, source: 's' });
        assert.deepEqual(u.bram, { used: 3.5, available: 135 });
    });

    it('Results shows "56 / 63,400" LUTs, never the 126,800 bel count', async () => {
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        const build = { ...successfulBuild('/p/hardware.bit'), utilization: applyDeviceCapacity((await report()).utilization, board.fpga.capacity!) };
        const rows = buildResultsModel(undefined, undefined, build).build!.resources.map((r) => `${r.label}: ${r.value}`);
        assert.deepEqual(rows, ['LUTs: 56 / 63,400', 'Flip-Flops: 27 / 126,800', 'BRAM (36 Kb): 0 / 135', 'DSP: 0 / 240', 'I/O pins: 3 / 210']);
        assert.ok(!rows.join().includes('126,800 ') && !rows[0]!.includes('126'));
    });

    it('rejects a board whose capacity is incomplete', async (t) => {
        const dir = await tempDir(t, 'nexys-board-');
        const board = JSON.parse(await readFile(join(FIXTURES, '..', '..', 'boards', 'nexys-a7-100t', 'board.json'), 'utf8'));
        board.id = 'broken';
        board.fpga.capacity = { luts: 63400, flipFlops: 0, bram36: 135, dsp: 240, userIo: 210 };
        await writeFiles(join(dir, 'broken'), { 'board.json': JSON.stringify(board) });
        const { diagnostics } = await BoardRegistry.loadDirectory(dir);
        assert.ok(diagnostics.some((d) => d.code === 'BOARD_CAPACITY_INVALID' && /flipFlops/.test(d.message)));
        assert.ok(diagnostics.some((d) => d.code === 'BOARD_CAPACITY_INVALID' && /source/.test(d.message)));
    });
});
