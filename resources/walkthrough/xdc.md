# Edit the XDC constraints

For the Nexys A7, MIX-FPGA uses **ordinary Xilinx XDC files** — the same format you know from Vivado. There is no separate pin editor.

```tcl
set_property -dict { PACKAGE_PIN E3  IOSTANDARD LVCMOS33 } [get_ports { clk }]
create_clock -period 10.00 [get_ports { clk }]
set_property -dict { PACKAGE_PIN H17 IOSTANDARD LVCMOS33 } [get_ports { led0 }]
```

- Every **top-level port name** in your VHDL must appear in the XDC with a `PACKAGE_PIN`, spelled the same way.
- You can paste lines from your course XDC or from the Digilent Nexys A7 master XDC; uncomment only the pins your design uses and rename the ports to match your entity.
- Several XDC files can live in `constraints/`; the one marked **IN USE** is used by Build (right-click → *Use This Constraints File*).
- If a port has no pin, Build stops before implementation and Problems points at the port.
