-- MIX-FPGA Phase 1: DE10-Lite blink. clock -> counter -> LED.
-- 50 MHz / 2^26 : LEDR0 toggles every 2^25 cycles = ~0.67 s (about 0.75 Hz blink).
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity blink is
  port (
    clk_50 : in  std_logic;   -- MAX10_CLK1_50
    ledr0  : out std_logic    -- LEDR0, active high
  );
end entity blink;

architecture rtl of blink is
  signal count : unsigned(25 downto 0) := (others => '0');
begin
  process (clk_50)
  begin
    if rising_edge(clk_50) then
      count <= count + 1;
    end if;
  end process;

  ledr0 <= count(count'high);
end architecture rtl;
