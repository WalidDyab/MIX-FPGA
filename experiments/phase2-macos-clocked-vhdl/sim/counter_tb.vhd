library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use std.env.all;

entity counter_tb is
end entity counter_tb;

architecture sim of counter_tb is
    constant WIDTH      : positive := 4;
    constant CLK_PERIOD : time     := 10 ns;

    signal clk   : std_logic := '0';
    signal reset : std_logic := '1';
    signal count : unsigned(WIDTH-1 downto 0);
    signal done  : boolean   := false;
begin
    dut : entity work.counter
        generic map (
            WIDTH => WIDTH
        )
        port map (
            clk   => clk,
            reset => reset,
            count => count
        );

    clk <= not clk after CLK_PERIOD / 2 when not done else '0';

    stimulus : process
    begin
        -- 1. Reset drives count to zero
        reset <= '1';
        wait until rising_edge(clk);
        wait until rising_edge(clk);
        wait for 1 ns;
        assert count = 0
            report "Reset did not clear count" severity failure;

        -- 2/3. Release reset; count increments 1, 2, ... 20 (wraps past 15)
        reset <= '0';
        for i in 1 to 20 loop
            wait until rising_edge(clk);
            wait for 1 ns;
            assert count = to_unsigned(i mod 2**WIDTH, WIDTH)
                report "Count mismatch at step " & integer'image(i) &
                       ": expected " & integer'image(i mod 2**WIDTH) &
                       ", got " & integer'image(to_integer(count))
                severity failure;
        end loop;

        -- 4. Assert reset again; count returns to zero and holds
        reset <= '1';
        wait until rising_edge(clk);
        wait for 1 ns;
        assert count = 0
            report "Second reset did not clear count" severity failure;
        wait until rising_edge(clk);
        wait for 1 ns;
        assert count = 0
            report "Count did not hold at zero during reset" severity failure;

        -- Release again; counting restarts from zero
        reset <= '0';
        wait until rising_edge(clk);
        wait for 1 ns;
        assert count = 1
            report "Count did not restart from zero after reset" severity failure;

        report "counter_tb: ALL TESTS PASSED" severity note;
        done <= true;
        stop;
        wait;
    end process;
end architecture sim;
