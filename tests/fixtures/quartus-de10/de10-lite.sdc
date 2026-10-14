# 50 MHz board clock (MAX10_CLK1_50)
create_clock -name clk_50 -period 20.000 [get_ports clk_50]
derive_clock_uncertainty
