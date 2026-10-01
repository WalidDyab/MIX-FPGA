/**
 * Course-level structural VHDL used by the extension tests. Includes the
 * traps the indexer must survive: comments containing instantiation-like
 * text, block comments, strings, character literals and attribute ticks,
 * mixed case, multiline headers, a component declaration and a labelled
 * process loop.
 */

export const TOP_VHD = `-- top.vhd
-- u_fake : entity work.ghost port map (a => b);   (commented out: must be ignored)
library IEEE;
use IEEE.STD_LOGIC_1164.ALL;
use work.display_pkg.all;

ENTITY Top IS
    PORT (
        CLK100MHZ : IN  std_logic;
        btnc      : in  std_logic;
        sw        : in  std_logic_vector(3 downto 0);
        seg       : out std_logic_vector(6 downto 0);
        an        : out std_logic_vector(3 downto 0);
        led0      : out std_logic
    );
END ENTITY Top;

architecture RTL of TOP is
    signal tick  : std_logic;
    signal count : unsigned(15 downto 0);
    constant MSG : string := "u_str : entity work.ghost port map (x => y);";
    /* u_block : entity work.ghost
       port map (a => b); */
begin

    u_clock : entity WORK.Clock_Divider
        generic map (DIVISOR => 100_000)
        port map (
            clk  => clk100mhz,
            tick => tick
        );

    U_Counter : entity work.counter(rtl)
        port map (clk => CLK100MHZ, reset => btnc, enable => tick, count => count);

    u_display : display_driver
        port map (
            clk   => clk100mhz,
            value => count,
            seg   => seg,
            an    => an
        );

    led0 <= count(15) when sw(0) = '1' else '0';

end architecture RTL;
`;

export const CLOCK_DIVIDER_VHD = `library ieee;
use ieee.std_logic_1164.all;

entity clock_divider is
    generic ( DIVISOR : positive := 100000 );
    port ( clk : in std_logic; tick : out std_logic );
end clock_divider;

architecture rtl of clock_divider is
begin
    process (clk)
        variable n : natural := 0;
    begin
        if rising_edge(clk) then
            if clk'event and n = DIVISOR - 1 then
                n := 0;
                tick <= '1';
            else
                n := n + 1;
                tick <= '0';
            end if;
        end if;
    end process;
end rtl;
`;

export const COUNTER_VHD = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity counter is
    port (
        clk, reset : in  std_logic;
        enable     : in  std_logic;
        count      : out unsigned(15 downto 0)
    );
end entity;

architecture rtl of counter is
    signal r : unsigned(15 downto 0) := (others => '0');
begin
    process (clk) begin
        if rising_edge(clk) then
            if reset = '1' then r <= (others => '0');
            elsif enable = '1' then r <= r + 1; end if;
        end if;
    end process;
    count <= r;
end architecture;
`;

export const DISPLAY_PKG_VHD = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

package display_pkg is
    component display_driver is
        port (
            clk   : in  std_logic;
            value : in  unsigned(15 downto 0);
            seg   : out std_logic_vector(6 downto 0);
            an    : out std_logic_vector(3 downto 0)
        );
    end component;
end package display_pkg;
`;

export const DISPLAY_DRIVER_VHD = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity display_driver is
    port (
        clk   : in  std_logic;
        value : in  unsigned(15 downto 0);
        seg   : out std_logic_vector(6 downto 0);
        an    : out std_logic_vector(3 downto 0)
    );
end entity display_driver;

architecture structural of display_driver is
    component seven_seg_decoder
        port ( digit : in unsigned(3 downto 0); segments : out std_logic_vector(6 downto 0) );
    end component;
    signal digit : unsigned(3 downto 0);
begin
    u_mux : entity work.display_mux port map (clk, value, digit, an);

    u_decoder : component seven_seg_decoder
        port map (digit => digit, segments => seg);

    scan : process (clk)
    begin
        lbl : for i in 0 to 3 loop
            null;
        end loop lbl;
    end process scan;
end architecture structural;
`;

export const DISPLAY_MUX_VHD = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity display_mux is
    port (
        clk   : in  std_logic;
        value : in  unsigned(15 downto 0);
        digit : out unsigned(3 downto 0);
        an    : out std_logic_vector(3 downto 0)
    );
end entity display_mux;

architecture rtl of display_mux is
begin
    digit <= value(3 downto 0);
    an <= "1110";
end architecture rtl;
`;

export const SEVEN_SEG_VHD = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity seven_seg_decoder is
    port ( digit : in unsigned(3 downto 0); segments : out std_logic_vector(6 downto 0) );
end entity seven_seg_decoder;

architecture rtl of seven_seg_decoder is
begin
    with digit select segments <=
        "1000000" when x"0",
        "1111111" when others;
end architecture rtl;
`;

export const UNUSED_VHD = `library ieee;
use ieee.std_logic_1164.all;

entity old_blinker is
    port ( clk : in std_logic; led : out std_logic );
end entity old_blinker;

architecture rtl of old_blinker is
begin
    led <= clk;
end architecture rtl;
`;

export const TOP_TB_VHD = `library ieee;
use ieee.std_logic_1164.all;

entity top_tb is
end entity top_tb;

architecture sim of top_tb is
    signal clk : std_logic := '0';
    signal seg : std_logic_vector(6 downto 0);
    signal an  : std_logic_vector(3 downto 0);
    signal led : std_logic;
begin
    dut : entity work.top
        port map (CLK100MHZ => clk, btnc => '0', sw => "0001", seg => seg, an => an, led0 => led);
    clk <= not clk after 5 ns;
end architecture sim;
`;

/** The design as project files (src/ + sim/). */
export const DESIGN_FILES: Record<string, string> = {
    'src/top.vhd': TOP_VHD,
    'src/clock_divider.vhd': CLOCK_DIVIDER_VHD,
    'src/counter.vhd': COUNTER_VHD,
    'src/display/display_pkg.vhd': DISPLAY_PKG_VHD,
    'src/display/display_driver.vhd': DISPLAY_DRIVER_VHD,
    'src/display/display_mux.vhd': DISPLAY_MUX_VHD,
    'src/display/seven_seg_decoder.vhd': SEVEN_SEG_VHD,
    'src/old_blinker.vhd': UNUSED_VHD,
    'sim/top_tb.vhd': TOP_TB_VHD,
};
