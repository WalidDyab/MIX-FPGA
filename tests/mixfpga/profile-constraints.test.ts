import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BOARD_PROFILES, DE10_LITE_PROFILE, QsfSdcConstraintProvider, describeEnvironment, profileFromBoardDefinition } from '../../core/backend';
import { repoBoards, writeFiles, tempDir } from '../helpers';
import { makeDe10Project } from './fake-vm';

describe('board profiles', () => {
    it('identifies the DE10-Lite and its exact MAX 10 part', () => {
        assert.equal(DE10_LITE_PROFILE.id, 'de10-lite');
        assert.equal(DE10_LITE_PROFILE.fpga.device, '10M50DAF484C7G');
        assert.equal(DE10_LITE_PROFILE.fpga.family, 'MAX 10');
        assert.equal(DE10_LITE_PROFILE.fpga.jtagIdcode, 0x031050dd);
        assert.equal(DE10_LITE_PROFILE.constraintFormat, 'qsf-sdc');
        assert.equal(DE10_LITE_PROFILE.programmingFormat, 'svf');
        assert.equal(BOARD_PROFILES['de10-lite'], DE10_LITE_PROFILE);
    });

    it('labels metrics in each vendor\'s own words (Logic Elements are not LUTs)', async () => {
        assert.equal(DE10_LITE_PROFILE.metricLabels.logic, 'Logic Elements');
        const nexys = profileFromBoardDefinition((await repoBoards()).get('nexys-a7-100t')!);
        assert.equal(nexys.metricLabels.logic, 'LUTs');
        assert.equal(nexys.constraintFormat, 'xdc');
        assert.equal(nexys.fpga.device, 'XC7A100T-1CSG324C');
    });

    it('leaves the existing Nexys A7 board data untouched (registry still lists only its boards)', async () => {
        const ids = (await repoBoards()).ids();
        assert.deepEqual(ids, ['nexys-a7-100t']);
    });
});

describe('QSF + SDC constraint provider', () => {
    const p = new QsfSdcConstraintProvider();

    it('accepts a QSF for the right device plus an SDC, in a path with spaces', async (t) => {
        const root = await makeDe10Project(t);
        const set = await p.collect(root);
        assert.deepEqual(set.files.map((f) => f.kind), ['qsf', 'sdc']);
        assert.deepEqual(await p.validate(set, DE10_LITE_PROFILE), []);
    });

    it('rejects a QSF for a different device', async (t) => {
        const root = await makeDe10Project(t, '10M08SAE144C8G');
        const d = await p.validate(await p.collect(root), DE10_LITE_PROFILE);
        assert.equal(d[0]?.code, 'CONSTRAINTS_WRONG_DEVICE');
    });

    it('reports a missing QSF and SDC', async (t) => {
        const root = await tempDir(t);
        await writeFiles(root, { 'src/a.vhd': '' });
        const d = await p.validate(await p.collect(root), DE10_LITE_PROFILE);
        assert.deepEqual(d.map((x) => x.code).sort(), ['CONSTRAINTS_NO_QSF', 'CONSTRAINTS_NO_SDC']);
    });
});

describe('environment summary', () => {
    const running = { state: 'running' as const, problems: [] };
    it('shows simple words for a ready DE10-Lite and keeps infrastructure in Details', () => {
        const e = describeEnvironment({ board: DE10_LITE_PROFILE, vhdlReady: true, engine: running, programmerAvailable: true, details: [{ label: 'Engine', value: 'Lima' }] });
        assert.deepEqual(e.rows.map((r) => `${r.label}=${r.value}`), ['Board=DE10-Lite', 'FPGA=MAX 10 10M50DAF484C7G', 'VHDL=Ready', 'Simulation=Ready', 'Implementation Engine=Ready', 'Programmer=Ready']);
        assert.equal(e.allReady, true);
        assert.equal(e.details.length, 1);
        assert.ok(e.rows.every((r) => !/lima|rosetta|linux/i.test(r.value)));
    });
    it('is not ready when the engine is unhealthy or the programmer is missing', () => {
        const bad = describeEnvironment({ board: DE10_LITE_PROFILE, vhdlReady: true, engine: { state: 'unhealthy', problems: [{ severity: 'error', code: 'X', message: 'm', source: 'toolchain' }] }, programmerAvailable: false });
        assert.equal(bad.allReady, false);
        assert.equal(bad.rows.find((r) => r.label === 'Implementation Engine')!.value, 'Not ready');
        assert.equal(bad.rows.find((r) => r.label === 'Programmer')!.value, 'Not ready');
    });
    it('says the engine starts on first use when the VM is just stopped', () => {
        const e = describeEnvironment({ board: DE10_LITE_PROFILE, vhdlReady: true, engine: { state: 'stopped', problems: [] }, programmerAvailable: true });
        assert.equal(e.rows.find((r) => r.label === 'Implementation Engine')!.value, 'Starting on first use');
    });
});
