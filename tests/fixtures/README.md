# Test fixtures

Real tool output captured on the Windows reference machine unless marked otherwise.

| File | Origin |
|---|---|
| `apio/nextpnr-report-phase2.json` | `hardware.pnr` from the Phase 2 Windows build (nextpnr-xilinx 0eae9fb) |
| `apio/apio-build-phase2-nextpnr-onward.log` | Phase 2 `apio build --verbose` log from the nextpnr step onward (`notes/phase2-windows-apio-build.log`, blank lines removed) |
| `apio/apio-build-stray-v-failure.log` | Real Phase 2 failure caused by a stray `.v` file (`notes/phase2-windows-compare/`) |
| `ghdl/*.txt` | GHDL 6.0.0 output captured while writing the parser (analysis errors, runtime assertions, a passing testbench) |
| `yosys/mini-netlist.json` | **Synthetic** minimal Yosys JSON netlist for the primitive-counting algorithm; not real FPGA data |

## ghdl/numeric-types.vcd (Phase 6)

Real GHDL 6.0.0 output (`ghdl -r --std=08 t --vcd=o.vcd`, Windows x64 toolchain 1.0) of a 12-line testbench holding an `integer` (-5, then 2147483647), a `natural`, `signed(7 downto 0)` = -3, a 64-bit `unsigned` of all ones, a `std_logic_vector` going `UUUU` → `01LH` → `0101`, a `std_logic` going `U` → `W` → `1`, a boolean, a real and an enumeration. It records what GHDL writes for the waveform viewer's Display As: integers are `$var integer 32` with binary values, metavalues are upper-case letters, enumerations are not dumped. Used by `tests/extension/phase6-ui.test.ts`.
