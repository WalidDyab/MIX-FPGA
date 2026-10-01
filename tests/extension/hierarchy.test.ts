import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileOrder } from '../../extension/hierarchy/compile-order';
import { DesignIndex, type IndexedFile } from '../../extension/hierarchy/design-index';
import { buildHierarchy, findNode, flatten, type HierarchyNode } from '../../extension/hierarchy/hierarchy';
import { tokenize } from '../../extension/hierarchy/vhdl-lexer';
import { parseVhdl } from '../../extension/hierarchy/vhdl-parser';
import { COUNTER_VHD, DESIGN_FILES, DISPLAY_DRIVER_VHD, TOP_VHD } from './fixtures';

function indexOf(files: Record<string, string>): DesignIndex {
    return new DesignIndex(indexed(files));
}

function indexed(files: Record<string, string>): IndexedFile[] {
    return Object.entries(files).map(([path, text]) => ({ path, role: path.startsWith('sim/') ? 'simulation' : 'source', parsed: parseVhdl(text) }));
}

/** `label:entity` lines, indented by depth, for readable assertions. */
function outline(node: HierarchyNode, depth = 0): string[] {
    const self = `${'  '.repeat(depth)}${node.kind === 'instance' ? `${node.label} : ` : ''}${node.entityName}${node.status === 'ok' ? '' : ` [${node.status}]`}`;
    return [self, ...node.children.flatMap((c) => outline(c, depth + 1))];
}

describe('VHDL lexer', () => {
    it('drops -- and /* */ comments and keeps strings, characters and ticks apart', () => {
        const toks = tokenize(`a <= '1'; -- x : entity work.y\n/* b : entity\n work.z */ s := "q""x"; c'event; t'('0'); v := x"F0";`);
        const texts = toks.map((t) => t.text);
        assert.ok(!texts.includes('y') && !texts.includes('z'), 'comment contents never become tokens');
        assert.deepEqual(toks.filter((t) => t.kind === 'char').map((t) => t.text), ["'1'", "'0'"]);
        assert.deepEqual(toks.filter((t) => t.kind === 'string').map((t) => t.text), ['"q""x"']);
        assert.deepEqual(toks.filter((t) => t.kind === 'bitstring').map((t) => t.text), ['x"F0"']);
        // c'event: identifier, tick, identifier (not a character literal)
        const i = texts.indexOf('c');
        assert.deepEqual(texts.slice(i, i + 3), ['c', "'", 'event']);
    });

    it('reports 1-based line and column of each token', () => {
        const toks = tokenize('entity\n  foo is');
        assert.deepEqual(toks.map((t) => [t.text, t.line, t.col]), [['entity', 1, 1], ['foo', 2, 3], ['is', 2, 7]]);
    });
});

describe('VHDL structural parser', () => {
    it('discovers entities with their ports (multiline, grouped names, mixed case)', () => {
        const top = parseVhdl(TOP_VHD);
        assert.deepEqual(top.entities.map((e) => e.name), ['Top']);
        assert.deepEqual(top.entities[0]!.ports.map((p) => `${p.name}:${p.mode}:${p.type}`), [
            'CLK100MHZ:in:std_logic',
            'btnc:in:std_logic',
            'sw:in:std_logic_vector(3 downto 0)',
            'seg:out:std_logic_vector(6 downto 0)',
            'an:out:std_logic_vector(3 downto 0)',
            'led0:out:std_logic',
        ]);
        const counter = parseVhdl(COUNTER_VHD).entities[0]!;
        assert.deepEqual(counter.ports.map((p) => p.name), ['clk', 'reset', 'enable', 'count'], 'clk, reset : in std_logic gives two ports');
    });

    it('discovers architectures and the entity they belong to', () => {
        assert.deepEqual(parseVhdl(TOP_VHD).architectures.map((a) => [a.name, a.entity]), [['RTL', 'TOP']]);
    });

    it('finds direct entity instantiations with library and explicit architecture', () => {
        const insts = parseVhdl(TOP_VHD).architectures[0]!.instances;
        const clock = insts.find((i) => i.label === 'u_clock')!;
        assert.equal(clock.kind, 'entity');
        assert.equal(clock.library, 'WORK');
        assert.equal(clock.target, 'Clock_Divider');
        assert.ok(clock.hasGenericMap && clock.hasPortMap);
        assert.equal(clock.line, 26);
        const counter = insts.find((i) => i.label === 'U_Counter')!;
        assert.equal(counter.architecture, 'rtl');
        assert.deepEqual(counter.portMap.map((a) => `${a.formal}=>${a.actual}`), ['clk=>CLK100MHZ', 'reset=>btnc', 'enable=>tick', 'count=>count']);
    });

    it('finds component instantiations with and without the component keyword', () => {
        const top = parseVhdl(TOP_VHD).architectures[0]!.instances.find((i) => i.label === 'u_display')!;
        assert.equal(top.kind, 'component');
        assert.equal(top.implicitComponent, true);
        assert.equal(top.target, 'display_driver');
        const dd = parseVhdl(DISPLAY_DRIVER_VHD).architectures[0]!;
        const dec = dd.instances.find((i) => i.label === 'u_decoder')!;
        assert.equal(dec.kind, 'component');
        assert.equal(dec.implicitComponent, false);
        assert.deepEqual(dd.components.map((c) => c.name), ['seven_seg_decoder']);
        const mux = dd.instances.find((i) => i.label === 'u_mux')!;
        assert.deepEqual(mux.portMap.map((a) => [a.formal, a.actual, a.position]), [[undefined, 'clk', 0], [undefined, 'value', 1], [undefined, 'digit', 2], [undefined, 'an', 3]]);
    });

    it('ignores instantiation-like text in comments, block comments and strings, and labelled loops', () => {
        const labels = parseVhdl(TOP_VHD).architectures[0]!.instances.map((i) => i.label);
        assert.deepEqual(labels, ['u_clock', 'U_Counter', 'u_display']);
        const dd = parseVhdl(DISPLAY_DRIVER_VHD).architectures[0]!.instances.map((i) => i.label);
        assert.deepEqual(dd, ['u_mux', 'u_decoder'], 'the labelled for-loop inside a process is not an instance');
    });

    it('records signals, port-map actual names and generate nesting', () => {
        const arch = parseVhdl(`entity g is end; architecture a of g is
            signal bus_s : std_logic_vector(7 downto 0);
        begin
            gen : for i in 0 to 7 generate
                u_bit : entity work.cell port map (d => bus_s(i), q => open, k => '1', m => not bus_s(0));
            end generate gen;
            u_after : entity work.cell port map (d => bus_s(0), q => open, k => '0', m => '0');
        end;`).architectures[0]!;
        assert.deepEqual(arch.signals.map((s) => s.name), ['bus_s']);
        const [bit, after] = arch.instances;
        assert.deepEqual(bit!.generate, ['gen']);
        assert.deepEqual(after!.generate, [], 'generate scope ends at end generate');
        assert.deepEqual(bit!.portMap.map((a) => [a.formal, a.actualName, a.open, a.simple]), [
            ['d', 'bus_s', false, false],
            ['q', undefined, true, false],
            ['k', undefined, false, false],
            ['m', undefined, false, false],
        ]);
    });
});

describe('design hierarchy', () => {
    it('builds the hierarchy from the configured top, case-insensitively, across files', () => {
        const h = buildHierarchy(indexOf(DESIGN_FILES), 'top');
        assert.deepEqual(outline(h.root!), [
            'Top',
            '  u_clock : clock_divider',
            '  U_Counter : counter',
            '  u_display : display_driver',
            '    u_mux : display_mux',
            '    u_decoder : seven_seg_decoder',
        ]);
    });

    it('distinguishes instance labels from entity names and points at the instantiation line', () => {
        const h = buildHierarchy(indexOf(DESIGN_FILES), 'TOP');
        const n = findNode(h.root, 'Top/u_display/u_decoder')!;
        assert.equal(n.label, 'u_decoder');
        assert.equal(n.entityName, 'seven_seg_decoder');
        assert.deepEqual(n.location, { file: 'src/display/display_driver.vhd', line: 22, col: 5 });
        assert.equal(h.root!.location!.file, 'src/top.vhd');
    });

    it('a different top changes the hierarchy root', () => {
        const h = buildHierarchy(indexOf(DESIGN_FILES), 'display_driver');
        assert.deepEqual(outline(h.root!), ['display_driver', '  u_mux : display_mux', '  u_decoder : seven_seg_decoder']);
        assert.ok(h.unreachable.some((e) => e.decl.name === 'Top'));
    });

    it('lists RTL entities not reachable from the top, and testbenches separately', () => {
        const h = buildHierarchy(indexOf(DESIGN_FILES), 'top');
        assert.deepEqual(h.unreachable.map((e) => e.decl.name), ['old_blinker']);
        assert.deepEqual(h.testbenches.map((t) => outline(t).slice(0, 3)), [['top_tb', '  dut : Top', '    u_clock : clock_divider']]);
    });

    it('reports a missing top and unresolved/external instances honestly', () => {
        const files = {
            'src/a.vhd': `entity a is end; architecture r of a is
                component nowhere port (x : in bit); end component;
            begin
                u1 : nowhere port map (x => '0');
                u2 : entity unisim.BUFG port map (I => c, O => d);
                u3 : entity work.ghost;
            end;`,
        };
        assert.equal(buildHierarchy(indexOf(files), 'missing').root, undefined);
        const h = buildHierarchy(indexOf(files), 'a');
        assert.deepEqual(outline(h.root!), ['a', '  u1 : nowhere [unresolved]', '  u2 : BUFG [external]', '  u3 : ghost [unresolved]']);
    });

    it('stops at recursive instantiation', () => {
        const h = buildHierarchy(indexOf({ 'src/r.vhd': 'entity r is end; architecture x of r is begin u : entity work.r; end;' }), 'r');
        assert.deepEqual(outline(h.root!), ['r', '  u : r [recursive]']);
    });

    it('flattens to every node', () => {
        assert.equal(flatten(buildHierarchy(indexOf(DESIGN_FILES), 'top').root!).length, 6);
    });
});

describe('compile order', () => {
    it('puts packages and directly instantiated entities before their users, keeping preferred order otherwise', () => {
        const files = indexed(Object.fromEntries(Object.entries(DESIGN_FILES).filter(([p]) => p.startsWith('src/'))));
        const { order, cycle } = compileOrder(files, ['src/top.vhd', 'src/old_blinker.vhd']);
        const at = (p: string) => order.indexOf(p);
        assert.deepEqual(cycle, []);
        assert.ok(at('src/display/display_pkg.vhd') < at('src/top.vhd'), 'package before its user');
        assert.ok(at('src/clock_divider.vhd') < at('src/top.vhd'));
        assert.ok(at('src/counter.vhd') < at('src/top.vhd'));
        assert.ok(at('src/display/display_mux.vhd') < at('src/display/display_driver.vhd'));
        assert.equal(order.length, files.length);
    });

    it('keeps cyclic files instead of dropping them', () => {
        const files = indexed({
            'src/a.vhd': 'entity a is end; architecture r of a is begin u : entity work.b; end;',
            'src/b.vhd': 'entity b is end; architecture r of b is begin u : entity work.a; end;',
        });
        const { order, cycle } = compileOrder(files);
        assert.deepEqual([...order].sort(), ['src/a.vhd', 'src/b.vhd']);
        assert.equal(cycle.length, 2);
    });
});
