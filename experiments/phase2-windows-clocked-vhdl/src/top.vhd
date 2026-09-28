library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity top is
    port (
        clk100mhz : in  std_logic;
        btnc      : in  std_logic;
        led0      : out std_logic
    );
end entity top;

architecture rtl of top is

    signal count : unsigned(26 downto 0);

begin

    u_counter : entity work.counter
        generic map (
            WIDTH => 27
        )
        port map (
            clk   => clk100mhz,
            reset => btnc,
            count => count
        );

    led0 <= count(26);

end architecture rtl;
