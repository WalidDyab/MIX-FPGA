import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoardRegistry, type BoardDefinition, dataPaths, findResource, generateXdc, validateBoardDefinition } from '../core';
import { REPO, repoBoards } from './helpers';

describe('board definition: Nexys A7-100T', () => {
    it('loads from boards/ data without diagnostics', async () => {
        const { registry, diagnostics } = await BoardRegistry.loadDirectory(dataPaths(REPO).boards);
        assert.deepEqual(diagnostics, []);
        assert.deepEqual(registry.ids(), ['de10-lite', 'nexys-a7-100t']);
    });

    it('describes the FPGA and backend ids', async () => {
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        assert.equal(board.name, 'Digilent Nexys A7-100T');
        assert.equal(board.fpga.device, 'XC7A100T-1CSG324C');
        assert.equal(board.fpga.part, 'xc7a100tcsg324-1');
        assert.equal(board.backendIds['apio'], 'nexys-a7-100t');
    });

    it('maps the proven resources to the correct pins and I/O standard', async () => {
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        const expected: Record<string, string> = { CLK100MHZ: 'E3', BTNC: 'N17', SW0: 'J15', LED0: 'H17' };
        for (const [id, pin] of Object.entries(expected)) {
            const r = findResource(board, id);
            assert.ok(r, `${id} present`);
            assert.deepEqual(r.pins, [pin]);
            assert.equal(r.ioStandard, 'LVCMOS33');
        }
        assert.equal(board.resources.length, 4, 'only proven resources are populated');
    });

    it('CLK100MHZ is a 100 MHz clock; other resources are not clocks', async () => {
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        assert.equal(findResource(board, 'CLK100MHZ')!.clock?.frequencyHz, 100_000_000);
        assert.equal(findResource(board, 'LED0')!.clock, undefined);
    });
});

describe('board definition validation', () => {
    it('rejects missing pins, duplicate ids and bad clocks', () => {
        const bad = {
            schemaVersion: 1,
            id: 'x',
            name: 'X',
            vendor: 'V',
            fpga: { family: 'f', device: 'D', part: 'p' },
            backendIds: {},
            resources: [
                { id: 'A', kind: 'led', pins: [], ioStandard: 'LVCMOS33' },
                { id: 'A', kind: 'led', pins: ['B1'], ioStandard: 'LVCMOS33' },
                { id: 'C', kind: 'clock', pins: ['C1'], ioStandard: 'LVCMOS33', clock: { frequencyHz: 0 } },
            ],
        };
        const codes = validateBoardDefinition(bad, 'test').map((d) => d.code);
        assert.ok(codes.includes('BOARD_RESOURCE_INVALID'));
        assert.ok(codes.includes('BOARD_RESOURCE_DUPLICATE'));
    });

    it('rejects an unknown schema version', () => {
        const codes = validateBoardDefinition({ schemaVersion: 2 }, 'test').map((d) => d.code);
        assert.ok(codes.includes('BOARD_SCHEMA_VERSION'));
    });
});

describe('XDC generation from board data', () => {
    it('emits pins, I/O standard and a 10.00 ns clock using the no-space get_ports form', async () => {
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        const { xdc, diagnostics } = generateXdc(board, { clk100mhz: 'CLK100MHZ', btnc: 'BTNC', led0: 'LED0' });
        assert.deepEqual(diagnostics, []);
        assert.match(xdc, /set_property -dict \{ PACKAGE_PIN E3 IOSTANDARD LVCMOS33 \} \[get_ports \{clk100mhz\}\]/);
        assert.match(xdc, /create_clock -name clk100mhz -period 10\.00 \[get_ports \{clk100mhz\}\]/);
        assert.match(xdc, /PACKAGE_PIN N17 IOSTANDARD LVCMOS33 \} \[get_ports \{btnc\}\]/);
        assert.match(xdc, /PACKAGE_PIN H17 IOSTANDARD LVCMOS33 \} \[get_ports \{led0\}\]/);
        assert.doesNotMatch(xdc, /get_ports \{ /, 'no space inside get_ports braces');
        assert.equal((xdc.match(/create_clock/g) ?? []).length, 1, 'only the clock resource gets create_clock');
    });

    it('reports unknown resources, invalid port names and reused resources', async () => {
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        const { xdc, diagnostics } = generateXdc(board, { a: 'LED7', 'bad-name': 'SW0', x: 'LED0', y: 'LED0' });
        assert.equal(xdc, '');
        const codes = diagnostics.map((d) => d.code).sort();
        assert.deepEqual(codes, ['PIN_PORT_INVALID', 'PIN_RESOURCE_REUSED', 'PIN_RESOURCE_UNKNOWN']);
    });

    it('supports future bus resources as data only (e.g. a 2-bit LED group)', () => {
        const board: BoardDefinition = {
            schemaVersion: 1,
            id: 'synthetic',
            name: 'Synthetic',
            vendor: 'test',
            fpga: { family: 'f', device: 'D', part: 'p' },
            backendIds: {},
            resources: [{ id: 'LED', kind: 'led', pins: ['P0', 'P1'], ioStandard: 'LVCMOS33' }],
        };
        const { xdc } = generateXdc(board, { leds: 'LED' });
        assert.match(xdc, /PACKAGE_PIN P0 .*\[get_ports \{leds\[0\]\}\]/);
        assert.match(xdc, /PACKAGE_PIN P1 .*\[get_ports \{leds\[1\]\}\]/);
    });
});
