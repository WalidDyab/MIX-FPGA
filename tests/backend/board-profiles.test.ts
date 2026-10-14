import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DE10_LITE_PROFILE, ProviderRegistry, nexysA7BoardProfile, profileFromBoardDefinition, type BoardProfile, type ImplementationProvider, type ProgrammingProvider } from '../../core/backend';
import { validateBoardDefinition } from '../../core';
import { repoBoards } from '../helpers';

describe('board profiles come from board data', () => {
    it('Nexys A7-100T: XDC, openxc7, platform programmer, bitstream, LUT-world labels', async () => {
        const p = nexysA7BoardProfile(await repoBoards());
        assert.equal(p.id, 'nexys-a7-100t');
        assert.equal(p.displayName, 'Nexys A7-100T');
        assert.equal(p.fpga.device, 'XC7A100T-1CSG324C');
        assert.equal(p.constraintFormat, 'xdc');
        assert.equal(p.implementationProviderId, 'openxc7');
        assert.equal(p.programmingProviderId, 'platform-default');
        assert.equal(p.programmingFormat, 'bit');
        assert.deepEqual(p.metricLabels, { logic: 'LUTs', registers: 'Flip-Flops', memory: 'BRAM (36 Kb)', dsp: 'DSP' });
        assert.equal(p.hosts, undefined, 'the original flow is not host-restricted by board data');
    });

    it('DE10-Lite: QSF+SDC, Quartus in Lima, native JTAG, SVF, exact MAX 10 part', async () => {
        const def = (await repoBoards()).get('de10-lite')!;
        const p = profileFromBoardDefinition(def);
        assert.equal(p.displayName, 'DE10-Lite');
        assert.equal(p.fpga.device, '10M50DAF484C7G');
        assert.equal(p.fpga.family, 'MAX 10');
        assert.equal(p.fpga.jtagIdcode, 0x031050dd);
        assert.equal(p.constraintFormat, 'qsf-sdc');
        assert.equal(p.implementationProviderId, 'quartus-lima');
        assert.equal(p.programmingProviderId, 'native-jtag');
        assert.equal(p.programmingFormat, 'svf');
        assert.deepEqual(p.metricLabels, { logic: 'Logic Elements', registers: 'Registers', memory: 'Memory Bits', dsp: 'DSP Blocks' });
        assert.deepEqual(p.hosts, ['macos-arm64']);
    });

    it('the Phase 1 constant and the board data describe the same DE10-Lite', async () => {
        const fromData = profileFromBoardDefinition((await repoBoards()).get('de10-lite')!);
        assert.deepEqual(fromData, DE10_LITE_PROFILE);
    });

    it('DE10-Lite pins match the Terasic manual (clock P11, LEDR0 A8, ten LEDs and switches)', async () => {
        const def = (await repoBoards()).get('de10-lite')!;
        const r = (id: string) => def.resources.find((x) => x.id === id)!;
        assert.deepEqual(r('MAX10_CLK1_50').pins, ['P11']);
        assert.equal(r('MAX10_CLK1_50').clock?.frequencyHz, 50_000_000);
        assert.equal(r('LEDR').pins[0], 'A8');
        assert.equal(r('LEDR').pins.length, 10);
        assert.equal(r('SW').pins.length, 10);
        assert.deepEqual(r('KEY0').pins, ['B8']);
    });

    it('rejects malformed backend blocks', () => {
        const bad = { schemaVersion: 1, id: 'x', name: 'X', vendor: 'v', fpga: { part: 'p', device: 'd' }, backendIds: {}, resources: [], backend: { constraints: 'tcl', implementation: '', programming: 'p', programmingFormat: 'hex', jtagIdcode: '31050dd' } };
        const codes = validateBoardDefinition(bad, 'x').map((d) => d.code);
        assert.equal(codes.filter((c) => c === 'BOARD_BACKEND_INVALID').length, 4);
    });
});

describe('provider dispatch is centralized in the registry', () => {
    const impl = (id: string): ImplementationProvider => ({ id, supports: () => true, build: async () => { throw new Error('not called'); } });
    const prog = (id: string): ProgrammingProvider => ({ id, availability: async () => ({ available: true, detail: '' }), detect: async () => { throw new Error('x'); }, program: async () => { throw new Error('x'); } });
    const nexys = { ...DE10_LITE_PROFILE, id: 'nexys-a7-100t', displayName: 'Nexys A7-100T', implementationProviderId: 'openxc7', programmingProviderId: 'platform-default', constraintFormat: 'xdc' as const } satisfies BoardProfile;
    const { hosts: _h, ...nexysNoHosts } = nexys;

    it('maps each board to its own providers', () => {
        const r = new ProviderRegistry('macos-arm64').addImplementation(impl('openxc7')).addImplementation(impl('quartus-lima')).addProgramming(prog('platform-default')).addProgramming(prog('native-jtag'));
        const a = r.implementation(nexysNoHosts);
        const b = r.implementation(DE10_LITE_PROFILE);
        assert.ok(a.ok && a.provider.id === 'openxc7');
        assert.ok(b.ok && b.provider.id === 'quartus-lima');
        const pa = r.programming(nexysNoHosts);
        const pb = r.programming(DE10_LITE_PROFILE);
        assert.ok(pa.ok && pa.provider.id === 'platform-default');
        assert.ok(pb.ok && pb.provider.id === 'native-jtag');
    });

    it('refuses a board on a host it does not support, with a student-readable reason', () => {
        const r = new ProviderRegistry('win32-x64').addImplementation(impl('quartus-lima')).addProgramming(prog('native-jtag'));
        const x = r.implementation(DE10_LITE_PROFILE);
        assert.ok(!x.ok);
        assert.equal(x.diagnostic.code, 'BOARD_HOST_UNSUPPORTED');
        assert.match(x.diagnostic.message, /DE10-Lite is not supported on this computer/);
        assert.ok(!r.programming(DE10_LITE_PROFILE).ok);
    });

    it('reports a missing provider instead of guessing', () => {
        const r = new ProviderRegistry('macos-arm64');
        const x = r.implementation(DE10_LITE_PROFILE);
        assert.ok(!x.ok && x.diagnostic.code === 'IMPLEMENTATION_PROVIDER_MISSING');
        const c = r.constraint(DE10_LITE_PROFILE);
        assert.ok(!c.ok && c.diagnostic.code === 'CONSTRAINT_PROVIDER_MISSING');
    });
});
