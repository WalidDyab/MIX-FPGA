library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity counter_tb is
end entity counter_tb;

architecture sim of counter_tb is

    constant WIDTH      : positive := 4;
    constant CLK_PERIOD : time     := 10 ns;   -- 100 MHz

    signal clk     : std_logic := '0';
    signal reset   : std_logic := '1';
    signal count   : unsigned(WIDTH-1 downto 0);
    signal running : boolean   := true;

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

    clk <= not clk after CLK_PERIOD / 2 when running else '0';

    stimulus : process
        variable errors : natural := 0;
        variable checks : natural := 0;

        -- Sample on the falling edge, half a period after the rising edge that updated count.
        procedure check(expected : natural; what : string) is
        begin
            wait until falling_edge(clk);
            checks := checks + 1;
            if count /= to_unsigned(expected mod 2**WIDTH, WIDTH) then
                report what & ": expected " & integer'image(expected mod 2**WIDTH) &
                       ", got " & integer'image(to_integer(count))
                    severity error;
                errors := errors + 1;
            end if;
        end procedure;

    begin
        -- 1. Reset held for two rising edges: count must be zero.
        check(0, "reset, edge 1");
        check(0, "reset, edge 2");

        -- 2. Release reset; count 1..20, which wraps 15 -> 0 at step 16.
        reset <= '0';
        for i in 1 to 20 loop
            check(i, "count step " & integer'image(i));
        end loop;

        -- 3. Assert reset again: count returns to zero and holds there.
        reset <= '1';
        for i in 1 to 3 loop
            check(0, "reset hold, edge " & integer'image(i));
        end loop;

        -- 4. Release reset: counting restarts from zero.
        reset <= '0';
        for i in 1 to 3 loop
            check(i, "restart step " & integer'image(i));
        end loop;

        assert errors = 0
            report "TEST FAILED: " & integer'image(errors) & " error(s)"
            severity failure;
        report "ALL TESTS PASSED (" & integer'image(checks) & " checks, ends at " &
               time'image(now) & ")";

        running <= false;
        std.env.stop;
        wait;
    end process;

end architecture sim;
