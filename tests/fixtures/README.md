# Test fixtures

Real tool output captured on the Windows reference machine unless marked otherwise.

| File | Origin |
|---|---|
| `apio/nextpnr-report-phase2.json` | `hardware.pnr` from the Phase 2 Windows build (nextpnr-xilinx 0eae9fb) |
| `apio/apio-build-phase2-nextpnr-onward.log` | Phase 2 `apio build --verbose` log from the nextpnr step onward (`notes/phase2-windows-apio-build.log`, blank lines removed) |
| `apio/apio-build-stray-v-failure.log` | Real Phase 2 failure caused by a stray `.v` file (`notes/phase2-windows-compare/`) |
| `ghdl/*.txt` | GHDL 6.0.0 output captured while writing the parser (analysis errors, runtime assertions, a passing testbench) |
| `yosys/mini-netlist.json` | **Synthetic** minimal Yosys JSON netlist for the primitive-counting algorithm; not real FPGA data |
