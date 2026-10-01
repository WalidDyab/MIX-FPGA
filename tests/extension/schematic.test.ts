import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DesignIndex } from '../../extension/hierarchy/design-index';
import { buildHierarchy } from '../../extension/hierarchy/hierarchy';
import { parseVhdl } from '../../extension/hierarchy/vhdl-parser';
import { buildSchematic } from '../../extension/schematic/schematic-model';
import { assignColumns, layoutSchematic, renderSchematicSvg } from '../../extension/schematic/schematic-svg';
import { DESIGN_FILES } from './fixtures';

function design(files: Record<string, string> = DESIGN_FILES, top = 'top') {
    const index = new DesignIndex(Object.entries(files).map(([path, text]) => ({ path, role: path.startsWith('sim/') ? 'simulation' : 'source', parsed: parseVhdl(text) })));
    return { index, root: buildHierarchy(index, top).root! };
}

describe('design schematic model', () => {
    it('shows the top entity, its child blocks with instance labels, and its ports', () => {
        const { index, root } = design();
        const m = buildSchematic(index, root)!;
        assert.equal(m.entityName, 'Top');
        assert.deepEqual(m.ports.map((p) => `${p.name}:${p.mode}`), ['CLK100MHZ:in', 'btnc:in', 'sw:in', 'seg:out', 'an:out', 'led0:out']);
        assert.deepEqual(m.blocks.map((b) => `${b.label}:${b.entityName}:${b.childCount}`), ['u_clock:clock_divider:0', 'U_Counter:counter:0', 'u_display:display_driver:2']);
        assert.deepEqual(m.blocks[0]!.location, { file: 'src/top.vhd', line: 26, col: 5 });
    });

    it('draws only connections the port maps state, matching names case-insensitively', () => {
        const { index, root } = design();
        const m = buildSchematic(index, root)!;
        const nets = Object.fromEntries(m.nets.map((n) => [n.name, n.endpoints.map((e) => `${e.block ?? 'PORT'}.${e.port}:${e.mode}`)]));
        assert.deepEqual(nets['CLK100MHZ'], ['PORT.CLK100MHZ:in', 'u_clock.clk:in', 'U_Counter.clk:in', 'u_display.clk:in']);
        assert.deepEqual(nets['tick'], ['u_clock.tick:out', 'U_Counter.enable:in']);
        assert.deepEqual(nets['count'], ['U_Counter.count:out', 'u_display.value:in']);
        assert.deepEqual(nets['seg'], ['PORT.seg:out', 'u_display.seg:out']);
        // led0 and sw are used only by an assignment in the architecture: no invented wires.
        assert.equal(nets['led0'], undefined);
        assert.equal(nets['sw'], undefined);
        assert.ok(m.notes.some((n) => /Only port-map connections/.test(n)));
    });

    it('resolves positional associations through the entity port order and shows a lower level', () => {
        const { index, root } = design();
        const m = buildSchematic(index, root, 'Top/u_display')!;
        assert.deepEqual(m.path.map((p) => p.label), ['Top', 'u_display : display_driver']);
        const nets = Object.fromEntries(m.nets.map((n) => [n.name, n.endpoints.map((e) => `${e.block ?? 'PORT'}.${e.port}`)]));
        assert.deepEqual(nets['digit'], ['u_mux.digit', 'u_decoder.digit']);
        assert.deepEqual(nets['value'], ['PORT.value', 'u_mux.value']);
    });

    it('keeps literals and expressions as labelled stubs, never as nets', () => {
        const files = {
            'src/t.vhd': `entity t is port (a : in bit; y : out bit); end;
            architecture r of t is signal s : bit; begin
                u1 : entity work.g port map (i => '1', j => not a, o => s);
                u2 : entity work.g port map (i => s, j => a, o => y);
            end;`,
            'src/g.vhd': 'entity g is port (i, j : in bit; o : out bit); end; architecture r of g is begin o <= i and j; end;',
        };
        const { index, root } = design(files, 't');
        const m = buildSchematic(index, root)!;
        assert.deepEqual(m.stubs.map((s) => `${s.block}.${s.port}=${s.text}`), ["u1.i='1'", 'u1.j=not a']);
        assert.deepEqual(m.nets.map((n) => n.name).sort(), ['a', 's', 'y']);
    });

    it('places blocks in data-flow columns and renders clickable SVG blocks', () => {
        const { index, root } = design();
        const m = buildSchematic(index, root)!;
        const cols = assignColumns(m);
        assert.equal(cols.get('u_clock'), 0);
        assert.equal(cols.get('U_Counter'), 1);
        assert.equal(cols.get('u_display'), 2);
        const layout = layoutSchematic(m);
        const xs = layout.blocks.map((b) => b.x);
        assert.ok(xs[0]! < xs[1]! && xs[1]! < xs[2]!);
        for (const b of layout.blocks) {
            assert.ok(b.x > layout.frame.x && b.x + b.width < layout.frame.x + layout.frame.width, 'blocks stay inside the entity frame');
        }
        const svg = renderSchematicSvg(m);
        assert.match(svg, /^<svg /);
        assert.match(svg, /data-file="src\/top.vhd" data-line="26"/);
        assert.match(svg, /class="drill" data-hid="Top\/u_display"/);
        assert.equal((svg.match(/class="block /g) ?? []).length, 3);
    });

    it('describes an entity without instances honestly', () => {
        const { index, root } = design({ 'src/x.vhd': 'entity x is port (a : in bit); end; architecture r of x is begin end;' }, 'x');
        const m = buildSchematic(index, root)!;
        assert.deepEqual(m.blocks, []);
        assert.match(m.notes[0]!, /instantiates no blocks/);
        assert.match(renderSchematicSvg(m), /<svg/);
    });
});
