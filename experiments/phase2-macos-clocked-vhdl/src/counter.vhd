library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity counter is
    generic (
        WIDTH : positive := 27
    );
    port (
        clk   : in  std_logic;
        reset : in  std_logic;
        count : out unsigned(WIDTH-1 downto 0)
    );
end entity counter;

architecture rtl of counter is
    signal count_reg : unsigned(WIDTH-1 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if reset = '1' then
                count_reg <= (others => '0');
            else
                count_reg <= count_reg + 1;
            end if;
        end if;
    end process;

    count <= count_reg;
end architecture rtl;
