/**
 * Synthetic Yosys JSON netlist (shape of `write_json` after `proc`), small
 * enough to reason about bit by bit. Not tool output: written by hand to
 * cover each RTL element the schematic represents.
 *
 *   sum  = a + b                 ($add)
 *   next = sel ? a : sum         ($mux, A=sum is the "0" input)
 *   y    <= next  (async reset)  ($adff)
 *   eq   = not (a = b) and sel   ($eq, $not, $and)
 *   x2   = a(1 downto 0) xor "01" ($xor with a constant, slice of a)
 *   o4   = ("10" & x2) or b      ($or fed by a concatenation)
 *   f    = $fancy(o4(0))         (unknown cell -> generic)
 *   u_child : child(i => f, o => led)
 */
const W = (n: number) => n.toString(2).padStart(32, '0');

export const SYNTHETIC_NETLIST = {
    creator: 'hand-written test fixture',
    modules: {
        top: {
            attributes: { top: '00000000000000000000000000000001', src: 'generated.v:1.1-40.10' },
            ports: {
                clk: { direction: 'input', bits: [2] },
                rst: { direction: 'input', bits: [3] },
                sel: { direction: 'input', bits: [4] },
                a: { direction: 'input', bits: [5, 6, 7, 8] },
                b: { direction: 'input', bits: [9, 10, 11, 12] },
                y: { direction: 'output', bits: [13, 14, 15, 16] },
                eq: { direction: 'output', bits: [17] },
                led: { direction: 'output', bits: [35] },
            },
            cells: {
                '$add$generated.v:10$1': {
                    hide_name: 1, type: '$add',
                    parameters: { A_SIGNED: W(0), A_WIDTH: W(4), B_SIGNED: W(0), B_WIDTH: W(4), Y_WIDTH: W(4) },
                    attributes: { src: 'generated.v:10.12-10.20' },
                    port_directions: { A: 'input', B: 'input', Y: 'output' },
                    connections: { A: [5, 6, 7, 8], B: [9, 10, 11, 12], Y: [18, 19, 20, 21] },
                },
                '$ternary$generated.v:12$2': {
                    hide_name: 1, type: '$mux', parameters: { WIDTH: W(4) }, attributes: { src: 'generated.v:12.13-12.30' },
                    port_directions: { A: 'input', B: 'input', S: 'input', Y: 'output' },
                    connections: { A: [18, 19, 20, 21], B: [5, 6, 7, 8], S: [4], Y: [22, 23, 24, 25] },
                },
                '$procdff$9': {
                    hide_name: 1, type: '$adff', parameters: { ARST_POLARITY: '1', ARST_VALUE: '0000', CLK_POLARITY: '1', WIDTH: W(4) },
                    attributes: { src: 'generated.v:15.3-16.12' },
                    port_directions: { ARST: 'input', CLK: 'input', D: 'input', Q: 'output' },
                    connections: { ARST: [3], CLK: [2], D: [22, 23, 24, 25], Q: [13, 14, 15, 16] },
                },
                '$eq$generated.v:18$3': {
                    hide_name: 1, type: '$eq', parameters: { A_WIDTH: W(4), B_WIDTH: W(4), Y_WIDTH: W(1) }, attributes: {},
                    port_directions: { A: 'input', B: 'input', Y: 'output' },
                    connections: { A: [5, 6, 7, 8], B: [9, 10, 11, 12], Y: [26] },
                },
                '$not$generated.v:19$4': {
                    hide_name: 1, type: '$not', parameters: { A_WIDTH: W(1), Y_WIDTH: W(1) }, attributes: {},
                    port_directions: { A: 'input', Y: 'output' },
                    connections: { A: [26], Y: [27] },
                },
                '$and$generated.v:20$5': {
                    hide_name: 1, type: '$and', parameters: { A_WIDTH: W(1), B_WIDTH: W(1), Y_WIDTH: W(1) }, attributes: {},
                    port_directions: { A: 'input', B: 'input', Y: 'output' },
                    connections: { A: [27], B: [4], Y: [17] },
                },
                '$xor$generated.v:22$6': {
                    hide_name: 1, type: '$xor', parameters: { A_WIDTH: W(2), B_WIDTH: W(2), Y_WIDTH: W(2) }, attributes: {},
                    port_directions: { A: 'input', B: 'input', Y: 'output' },
                    connections: { A: [5, 6], B: ['1', '0'], Y: [28, 29] },
                },
                '$or$generated.v:24$7': {
                    hide_name: 1, type: '$or', parameters: { A_WIDTH: W(4), B_WIDTH: W(4), Y_WIDTH: W(4) }, attributes: {},
                    port_directions: { A: 'input', B: 'input', Y: 'output' },
                    connections: { A: [28, 29, '0', '1'], B: [9, 10, 11, 12], Y: [30, 31, 32, 33] },
                },
                '$fancy$1': {
                    hide_name: 1, type: '$fancy', parameters: {}, attributes: {},
                    connections: { A: [30], Y: [34] },
                },
                u_child: {
                    hide_name: 0, type: 'child', parameters: {}, attributes: { src: 'generated.v:30.3-32.10' },
                    port_directions: { i: 'input', o: 'output' },
                    connections: { i: [34], o: [35] },
                },
            },
            netnames: {
                a: { hide_name: 0, bits: [5, 6, 7, 8] },
                b: { hide_name: 0, bits: [9, 10, 11, 12] },
                sum: { hide_name: 0, bits: [18, 19, 20, 21] },
                n22: { hide_name: 0, bits: [22, 23, 24, 25] },
                y: { hide_name: 0, bits: [13, 14, 15, 16] },
            },
        },
        child: {
            attributes: {},
            ports: { i: { direction: 'input', bits: [2] }, o: { direction: 'output', bits: [3] } },
            cells: {
                '$not$generated.v:36$8': { hide_name: 1, type: '$not', parameters: { A_WIDTH: W(1), Y_WIDTH: W(1) }, attributes: {}, port_directions: { A: 'input', Y: 'output' }, connections: { A: [2], Y: [3] } },
            },
            netnames: {},
        },
    },
};

/** GHDL-style netlist text whose comments map Verilog lines 10 and 15 to VHDL. */
export function syntheticVerilog(projectRoot: string): string {
    const lines = Array.from({ length: 40 }, () => '');
    lines[8] = `  /*# ${projectRoot}/src/top.vhd:21:17 */`; // line 9, above line 10
    lines[9] = '  assign sum = a + b;';
    lines[13] = `  /*# ${projectRoot}/src/top.vhd:25:9 */`; // line 14, above line 15
    lines[14] = '  always @(posedge clk or posedge rst)';
    lines[10] = '  // line 11: no GHDL comment above line 12';
    lines[11] = '  assign next = sel ? a : sum;';
    return lines.join('\n');
}
