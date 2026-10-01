import { type BoardDefinition, findResource, PROJECT_FOLDERS, type ProjectFile } from '../../core';

/** Ports of the starter design and the board resources they use. */
export const STARTER_PORTS = [
    { port: 'clk', resource: 'CLK100MHZ', mode: 'in', comment: '100 MHz board clock' },
    { port: 'btnc', resource: 'BTNC', mode: 'in', comment: 'centre button: restart' },
    { port: 'sw0', resource: 'SW0', mode: 'in', comment: 'switch 0: enable blinking' },
    { port: 'led0', resource: 'LED0', mode: 'out', comment: 'LED 0' },
] as const;

export const STARTER_TOP = 'top';
export const STARTER_TESTBENCH = 'top_tb';

export function constraintsFileName(board: BoardDefinition): string {
    return `${board.id}.xdc`;
}

/** Project-relative paths of the starter files. */
export function starterPaths(board: BoardDefinition) {
    return {
        top: `${PROJECT_FOLDERS.sources}/${STARTER_TOP}.vhd`,
        testbench: `${PROJECT_FOLDERS.simulation}/${STARTER_TESTBENCH}.vhd`,
        constraints: `${PROJECT_FOLDERS.constraints}/${constraintsFileName(board)}`,
    };
}

export function starterProjectFile(name: string, board: BoardDefinition): ProjectFile {
    const paths = starterPaths(board);
    return {
        name,
        board: board.id,
        language: 'vhdl',
        standard: '2008',
        top: STARTER_TOP,
        sources: [paths.top],
        simulation: { sources: [paths.testbench], testbench: STARTER_TESTBENCH },
        constraints: paths.constraints,
    };
}

export function starterTopVhdl(projectName: string, board: BoardDefinition): string {
    const width = Math.max(...STARTER_PORTS.map((p) => p.port.length));
    const ports = STARTER_PORTS.map((p, i) => {
        const sep = i < STARTER_PORTS.length - 1 ? ';' : ' ';
        return `        ${p.port.padEnd(width)} : ${p.mode === 'in' ? 'in ' : 'out'} std_logic${sep}  -- ${p.comment}`;
    }).join('\n');
    return `-- ${STARTER_TOP}.vhd: starter design for ${projectName} (${board.name}).
--
-- LED0 blinks while switch SW0 is on. Holding the centre button (BTNC)
-- restarts the blink counter. The ports are connected to FPGA pins in
-- constraints/${constraintsFileName(board)}.

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ${STARTER_TOP} is
    generic (
        -- LED0 toggles every 2**BLINK_BITS clock cycles (2**26 / 100 MHz = 0.67 s).
        BLINK_BITS : positive := 26
    );
    port (
${ports}
    );
end entity ${STARTER_TOP};

architecture rtl of ${STARTER_TOP} is
    signal count : unsigned(BLINK_BITS downto 0) := (others => '0');
begin

    counter : process (clk)
    begin
        if rising_edge(clk) then
            if btnc = '1' then
                count <= (others => '0');
            else
                count <= count + 1;
            end if;
        end if;
    end process counter;

    led0 <= count(BLINK_BITS) and sw0;

end architecture rtl;
`;
}

export function starterTestbenchVhdl(): string {
    return `-- ${STARTER_TESTBENCH}.vhd: testbench for ${STARTER_TOP}. Run it with "NexysVHDL: Simulate".
--
-- A small BLINK_BITS makes the LED toggle every few clock cycles, so the
-- whole test takes well under a microsecond of simulated time.

library ieee;
use ieee.std_logic_1164.all;

entity ${STARTER_TESTBENCH} is
end entity ${STARTER_TESTBENCH};

architecture sim of ${STARTER_TESTBENCH} is

    constant CLK_PERIOD : time     := 10 ns;  -- 100 MHz
    constant BITS       : positive := 3;      -- LED0 toggles every 8 cycles

    signal clk     : std_logic := '0';
    signal btnc    : std_logic := '1';
    signal sw0     : std_logic := '0';
    signal led0    : std_logic;
    signal running : boolean   := true;

begin

    dut : entity work.${STARTER_TOP}
        generic map (
            BLINK_BITS => BITS
        )
        port map (
            clk  => clk,
            btnc => btnc,
            sw0  => sw0,
            led0 => led0
        );

    clk <= not clk after CLK_PERIOD / 2 when running else '0';

    stimulus : process
        variable checks   : natural := 0;
        variable seen_on  : boolean := false;
        variable seen_off : boolean := false;
    begin
        -- Hold the button (reset) for two clock cycles.
        wait for 2 * CLK_PERIOD;
        btnc <= '0';

        -- 1. SW0 off: LED0 must stay off.
        for i in 1 to 4 * 2**BITS loop
            wait until falling_edge(clk);
            checks := checks + 1;
            assert led0 = '0'
                report "LED0 is on while SW0 is off" severity error;
        end loop;

        -- 2. SW0 on: LED0 must blink, i.e. be seen both on and off.
        sw0 <= '1';
        for i in 1 to 4 * 2**BITS loop
            wait until falling_edge(clk);
            if led0 = '1' then
                seen_on := true;
            else
                seen_off := true;
            end if;
        end loop;
        checks := checks + 1;
        assert seen_on and seen_off
            report "LED0 does not blink while SW0 is on" severity error;

        report "ALL TESTS PASSED (" & integer'image(checks) & " checks)";
        running <= false;
        std.env.stop;
        wait;
    end process stimulus;

end architecture sim;
`;
}

/**
 * The starter XDC, generated from board data: active lines for the starter
 * design's ports, followed by every other board resource commented out.
 * Written in ordinary Vivado style so students can read and edit it.
 */
export function starterXdc(projectName: string, board: BoardDefinition): string {
    const used = new Map<string, string>(STARTER_PORTS.map((p) => [p.resource, p.port]));
    for (const r of used.keys()) {
        if (!findResource(board, r)) throw new Error(`${board.name} has no "${r}" resource for the starter design.`);
    }
    const lines = [
        `## ${board.name} constraints for project ${projectName}`,
        '##',
        '## Each set_property line connects a top-level VHDL port to an FPGA pin:',
        '##   PACKAGE_PIN  the FPGA pin wired to that part of the board',
        '##   IOSTANDARD   the I/O voltage standard (LVCMOS33 = 3.3 V CMOS)',
        '## create_clock tells the tools the clock period, so they can check timing.',
        '##',
        '## To use another board resource, remove the leading "#" from its lines and',
        '## write your port name inside get_ports { }. Every port of the top entity',
        '## needs a PACKAGE_PIN. Bits of a vector port are written name[0], name[1], ...',
    ];
    const resources = [...board.resources].sort((a, b) => Number(used.has(b.id)) - Number(used.has(a.id)));
    for (const r of resources) {
        const port = used.get(r.id);
        const prefix = port ? '' : '#';
        const name = port ?? r.id.toLowerCase();
        lines.push('', `## ${r.id}${r.description ? `: ${r.description}` : ''}`);
        r.pins.forEach((pin, i) => {
            const target = r.pins.length === 1 ? name : `${name}[${i}]`;
            lines.push(`${prefix}set_property -dict { PACKAGE_PIN ${pin} IOSTANDARD ${r.ioStandard} } [get_ports { ${target} }]`);
        });
        if (r.clock) lines.push(`${prefix}create_clock -period ${(1e9 / r.clock.frequencyHz).toFixed(2)} [get_ports { ${name} }]`);
    }
    return lines.join('\n') + '\n';
}

export function starterGitignore(): string {
    return `# Everything NexysVHDL generates (GHDL libraries, netlists, bitstreams, logs)
.nexysvhdl/

# Waveforms and editor/OS noise
*.ghw
*.vcd
*.fst
.DS_Store
Thumbs.db
`;
}
