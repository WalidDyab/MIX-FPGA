# Phase 1 — Windows VHDL → bitstream proof-of-concept

Date: 2026-09-28
Goal: prove `VHDL → GHDL → Verilog → Apio/openXC7 → hardware.bit → Nexys A7-100T` on Windows.
Design: `SW0 → LED0` (`led <= sw`).

## Environment

| Item | Value |
|---|---|
| OS | Windows 11 Home 10.0.26200, AMD64 |
| Apio | 1.6.0 (pyinst-windows-amd64-2026-09-15), `C:\Users\user\.apio\bin\apio.exe` (unchanged) |
| Apio oss-cad-suite | release 2026-09-15, Yosys 2026-03-24 (no GHDL plugin in the Windows build) |
| Apio openXC7 | release 2026-09-24, nextpnr-xilinx 0eae9fb, chipdb `xc7a100tcsg324.bin` |
| GHDL | 6.0.0 (mcode backend, GNAT 15.2.0), official `ghdl-mcode-6.0.0-ucrt64.zip` |
| Vivado | 2024.1, `C:\Xilinx\Vivado\2024.1` (used only for programming; unchanged) |

GHDL was not installed. Its official Windows zip was extracted to
`D:\WSClaude\NexysVHDL\tools\ghdl-6.0.0\` and is called by full path. There was no installer, PATH change, registry change or driver change.
Zip SHA-256: `76e160ceec35834c73ada6e4e484416d13aed4b64cbc7c74c5cca53a7ef60e41`.

## Project structure

```
experiments\phase1-windows-vhdl\
    top.vhd              VHDL source (hand-written)
    generated.v          produced by GHDL — do not edit
    apio.ini             board = nexys-a7-100t, top-module = top
    nexys-a7-100t.xdc    sw → J15, led → H17, LVCMOS33
    _build\ghdl\         GHDL work library (work-obj08.cf)
    _build\default\      Apio outputs (hardware.bit, .json, .fasm, .frames, .pnr)
    _build\apio-build.log
    _build\vivado\       program.tcl + program.log
```

## Commands used

```sh
G=D:\WSClaude\NexysVHDL\tools\ghdl-6.0.0\bin\ghdl.exe
# run from experiments\phase1-windows-vhdl
$G -a      --std=08 --workdir=_build/ghdl top.vhd                   # analyze   → OK
$G -e      --std=08 --workdir=_build/ghdl top                       # elaborate → OK
$G --synth --std=08 --workdir=_build/ghdl --out=verilog top > generated.v
C:\Users\user\.apio\bin\apio.exe build --verbose                    # → _build\default\hardware.bit
```

`generated.v` (verbatim GHDL output):

```verilog
module top
  (input  sw,
   output led);
  assign led = sw; //(module output)
endmodule
```

Apio then ran these stages (from the verbose log):

```
yosys -p "synth_xilinx -arch xc7 -top top ; write_json _build\default\hardware.json" -DSYNTHESIZE generated.v
nextpnr-xilinx --chipdb ...\openxc7\chipdb\xc7a100tcsg324.bin --xdc nexys-a7-100t.xdc --json ... --fasm ... --report ...
fasm2frames --part xc7a100tcsg324-1 --db-root ...\prjxray-db\artix7 hardware.fasm > hardware.frames
xc7frames2bit --part_name xc7a100tcsg324-1 ... --output_file _build\default\hardware.bit
```

Apio consumed only `generated.v`. It ignores `top.vhd`.

## Build result

- Yosys: 2 cells (1 IBUF, 1 OBUF), 0 LUT, 0 FF.
- nextpnr: `sw` → IOB_X0Y101 (J15), `led` → IOB_X0Y114 (H17). Placement OK. router2 converged on iteration 1 (19 wires, 0 overuse).
- Timing: none applies, because the design is combinational with no clocks.
- Warnings: only `No clocks found in design` (×2, expected). **2 warnings, 0 errors.**
- FASM: only the two LVCMOS33 IOBs, the ILOGIC/OLOGIC pass-through and the route between them.
- Apio time: 12.9 s. Wall-clock time for the full `apio build`: 14.6 s.
- Artifact: `D:\WSClaude\NexysVHDL\experiments\phase1-windows-vhdl\_build\default\hardware.bit` (3,825,910 bytes).

## Corrections required

- Installed GHDL, because it was absent and Apio's Windows oss-cad-suite does not include it.
- Vivado batch mode refused to run from a very long temp path (`Common 17-1373`). Fixed by running it from `_build\vivado` with `-tempDir`.
- The first programming attempt found no JTAG target because the board was not connected. It was fixed by connecting and powering the board. No driver changes.

## Programming

Method: Vivado 2024.1 batch Tcl (`_build\vivado\program.tcl`). It uses the existing hw_server and Digilent driver, the same path as Hardware Manager. No USB/JTAG driver changes, no Zadig, no openFPGALoader.

```
cd _build\vivado
vivado -mode batch -nojournal -nolog -tempDir . -source program.tcl
```

Result: target `localhost:3121/xilinx_tcf/Digilent/210292BCFFE4A`, device `xc7a100t_0`.
Result: `End of startup status: HIGH` and `DONE_STATUS: 1`. Programming succeeded.

## Physical result

Confirmed by the user on the real board: **SW0 OFF → LED0 OFF, SW0 ON → LED0 ON.** Phase 1 (Windows): **PASS**.
