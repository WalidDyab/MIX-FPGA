import { type BoardDefinition, PROJECT_FOLDERS, type ProjectFile } from '../../core';
import { STARTER_TESTBENCH, STARTER_TOP } from './templates';

/**
 * DE10-Lite (Quartus) starter files. Same shape as the Nexys A7 starter: a blinking LED with an
 * enable switch and a restart button, a testbench, and board constraints written as ordinary
 * readable text. Pins and I/O standards come from the board data (Terasic DE10-Lite User Manual).
 */
export const DE10_STARTER_PORTS = [
    { port: 'clk', resource: 'MAX10_CLK1_50', index: 0, comment: '50 MHz board clock' },
    { port: 'key0', resource: 'KEY0', index: 0, comment: 'button KEY0 (reads 0 while pressed): restart' },
    { port: 'sw0', resource: 'SW', index: 0, comment: 'switch SW0: enable blinking' },
    { port: 'led0', resource: 'LEDR', index: 0, comment: 'LEDR0' },
] as const;

/** Project-relative paths of the DE10-Lite starter files. */
export function de10Paths(board: BoardDefinition) {
    return {
        top: `${PROJECT_FOLDERS.sources}/${STARTER_TOP}.vhd`,
        testbench: `${PROJECT_FOLDERS.simulation}/${STARTER_TESTBENCH}.vhd`,
        qsf: `${PROJECT_FOLDERS.constraints}/${board.id}.qsf`,
        sdc: `${PROJECT_FOLDERS.constraints}/${board.id}.sdc`,
    };
}

export function de10StarterProjectFile(name: string, board: BoardDefinition): ProjectFile {
    const paths = de10Paths(board);
    return {
        name,
        board: board.id,
        language: 'vhdl',
        standard: '2008',
        top: STARTER_TOP,
        sources: [paths.top],
        simulation: { sources: [paths.testbench], testbench: STARTER_TESTBENCH },
    };
}

export function de10StarterTopVhdl(projectName: string, board: BoardDefinition): string {
    const width = Math.max(...DE10_STARTER_PORTS.map((p) => p.port.length));
    const ports = DE10_STARTER_PORTS.map((p, i) => {
        const sep = i < DE10_STARTER_PORTS.length - 1 ? ';' : ' ';
        const mode = p.port === 'led0' ? 'out' : 'in ';
        return `        ${p.port.padEnd(width)} : ${mode} std_logic${sep}  -- ${p.comment}`;
    }).join('\n');
    return `-- ${STARTER_TOP}.vhd: starter design for ${projectName} (${board.displayName ?? board.name}).
--
-- LEDR0 blinks while switch SW0 is on. Holding button KEY0 (it reads 0 while
-- pressed) restarts the blink counter. The ports are connected to FPGA pins
-- in constraints/${board.id}.qsf; the clock is declared in constraints/${board.id}.sdc.

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ${STARTER_TOP} is
    generic (
        -- LEDR0 toggles every 2**BLINK_BITS clock cycles (2**25 / 50 MHz = 0.67 s).
        BLINK_BITS : positive := 25
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
            if key0 = '0' then
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

export function de10StarterTestbenchVhdl(): string {
    return `-- ${STARTER_TESTBENCH}.vhd: testbench for ${STARTER_TOP}. Run it with "MIX-FPGA: Simulate".
--
-- A small BLINK_BITS makes the LED toggle every few clock cycles, so the
-- whole test takes well under a microsecond of simulated time.

library ieee;
use ieee.std_logic_1164.all;

entity ${STARTER_TESTBENCH} is
end entity ${STARTER_TESTBENCH};

architecture sim of ${STARTER_TESTBENCH} is

    constant CLK_PERIOD : time     := 20 ns;  -- 50 MHz
    constant BITS       : positive := 3;      -- LEDR0 toggles every 8 cycles

    signal clk     : std_logic := '0';
    signal key0    : std_logic := '0';        -- pressed (reads 0): restart
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
            key0 => key0,
            sw0  => sw0,
            led0 => led0
        );

    clk <= not clk after CLK_PERIOD / 2 when running else '0';

    stimulus : process
        variable checks   : natural := 0;
        variable seen_on  : boolean := false;
        variable seen_off : boolean := false;
    begin
        -- Hold the button (restart) for two clock cycles, then release it.
        wait for 2 * CLK_PERIOD;
        key0 <= '1';

        -- 1. SW0 off: LEDR0 must stay off.
        for i in 1 to 4 * 2**BITS loop
            wait until falling_edge(clk);
            checks := checks + 1;
            assert led0 = '0'
                report "LEDR0 is on while SW0 is off" severity error;
        end loop;

        -- 2. SW0 on: LEDR0 must blink, i.e. be seen both on and off.
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
            report "LEDR0 does not blink while SW0 is on" severity error;

        report "ALL TESTS PASSED (" & integer'image(checks) & " checks)";
        running <= false;
        std.env.stop;
        wait;
    end process stimulus;

end architecture sim;
`;
}

function resourcePin(board: BoardDefinition, resource: string, index: number): { pin: string; standard: string } {
    const r = board.resources.find((x) => x.id === resource);
    const pin = r?.pins[index];
    if (!r || pin === undefined) throw new Error(`${board.name} has no "${resource}" resource (pin ${index}) for the starter design.`);
    return { pin, standard: r.ioStandard };
}

/**
 * The starter QSF: device, then active pin assignments for the starter ports, then every other
 * board resource commented out. `starterPorts: false` is the blank file of "Add File" (all commented).
 */
export function de10StarterQsf(projectName: string, board: BoardDefinition, options: { starterPorts?: boolean } = {}): string {
    const used = options.starterPorts === false ? [] : DE10_STARTER_PORTS;
    const lines = [
        `# ${board.displayName ?? board.name} constraints for project ${projectName}`,
        '#',
        '# set_global_assignment -name DEVICE selects the FPGA on this board; do not change it.',
        '# Each pair of lines below connects a top-level VHDL port to an FPGA pin:',
        '#   set_location_assignment   the FPGA pin wired to that part of the board',
        '#   IO_STANDARD               the I/O voltage standard',
        '# To use another board resource, remove the leading "#" and put your port name after "-to".',
        '# The clock is declared in the .sdc file next to this one.',
        '',
        `set_global_assignment -name FAMILY "${board.fpga.family}"`,
        `set_global_assignment -name DEVICE ${board.fpga.device}`,
        '',
        '# Leave pins you do not use floating, not driven.',
        'set_global_assignment -name RESERVE_ALL_UNUSED_PINS_WEAK_PULLUP "AS INPUT TRI-STATED WITH WEAK PULL-UP"',
    ];
    for (const u of used) {
        const { pin, standard } = resourcePin(board, u.resource, u.index);
        lines.push('', `# ${u.port}: ${u.comment}`, `set_location_assignment PIN_${pin} -to ${u.port}`, `set_instance_assignment -name IO_STANDARD "${standard}" -to ${u.port}`);
    }
    const taken = new Set(used.map((u) => `${u.resource}:${u.index}`));
    for (const r of board.resources) {
        r.pins.forEach((pin, i) => {
            if (taken.has(`${r.id}:${i}`)) return;
            const name = r.pins.length === 1 ? r.id.toLowerCase() : `${r.id.toLowerCase()}[${i}]`;
            lines.push('', `# ${r.id}${r.pins.length > 1 ? `[${i}]` : ''}${r.description && i === 0 ? `: ${r.description}` : ''}`, `# set_location_assignment PIN_${pin} -to ${name}`, `# set_instance_assignment -name IO_STANDARD "${r.ioStandard}" -to ${name}`);
        });
    }
    return lines.join('\n') + '\n';
}

export function de10StarterSdc(board: BoardDefinition, options: { starterPorts?: boolean } = {}): string {
    const clock = board.resources.find((r) => r.clock);
    const period = clock?.clock ? (1e9 / clock.clock.frequencyHz).toFixed(3) : '20.000';
    const active = options.starterPorts !== false;
    const prefix = active ? '' : '# ';
    return [
        `# ${board.displayName ?? board.name} clock constraint.`,
        '#',
        '# create_clock tells the tools the clock period, so they can check timing.',
        '# -name is the clock name shown in the timing results; get_ports names the clock port of your top entity.',
        '',
        `${prefix}create_clock -name clk -period ${period} [get_ports { clk }]`,
        `${prefix}derive_clock_uncertainty`,
        '',
    ].join('\n');
}
