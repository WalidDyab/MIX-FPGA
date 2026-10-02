# Build

**Build** turns your design into a bitstream for the Nexys A7-100T in three stages:

1. **Synthesis** — VHDL → logic (LUTs, flip-flops, …)
2. **Implementation** — placement, routing, pins, timing
3. **Bitstream** — the file that configures the FPGA

**Results** shows timing (PASS/FAIL against your `create_clock`), resource use and the log files. A build takes about 15–30 seconds for small designs and does not need the board.
