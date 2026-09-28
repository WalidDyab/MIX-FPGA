library ieee;
use ieee.std_logic_1164.all;

entity top is
    port (
        sw  : in  std_logic;
        led : out std_logic
    );
end entity top;

architecture rtl of top is
begin
    led <= sw;
end architecture rtl;
