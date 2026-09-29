# Phase 2 — macOS: clocked, multi-file VHDL

Date: 2026-09-28
Result: **PASS**. All 26 success criteria are met, and the user confirmed the physical test.

Flow proven:

```
src/counter.vhd + src/top.vhd ─(GHDL 6.0.0 --synth)→ generated.v
  → Apio 1.7.0 / openXC7 2026.09.25 → Yosys → nextpnr-xilinx (100 MHz timing) → fasm2frames → xc7frames2bit
  → hardware.bit → apio upload / openFPGALoader (SRAM) → Nexys A7-100T
sim/counter_tb.vhd ─(GHDL simulation)→ PASS + counter_tb.ghw
```

No Vivado, Rosetta, Windows or VM was used, and no USB drivers were changed.

## 1. Environment

The environment is the same as Phase 1: MacBook Air (Mac16,12), Apple M4, macOS 27.0 (26A428), `arm64`. All tools are native arm64 builds.

## 2. Tool versions

| Tool | Version |
|---|---|
| GHDL | 6.0.0 (6.0.0.r0.ge589c698c), LLVM 22.1.0 backend. Official aarch64 release in `tools/ghdl`. Apio's bundled GHDL is not used. |
| Apio | 1.7.0 (`pyinst-darwin-arm64-2026-09-27`), `/Applications/Apio/apio` |
| openXC7 package | 2026.09.25 (nextpnr-xilinx e860c9c8, prjxray-db a90f27c1) |
| oss-cad-suite package | 2026.09.15 |
| Yosys | 0.63+173 (git 66306a8ca) |
| openFPGALoader | v1.1.1 |

## 3. Pinned openXC7 configuration

This is the Phase 1 pin, reused unchanged:

```sh
export APIO_REMOTE_CONFIG_URL="file://$HOME/WSClaude/NexysVHDL/tools/apio-remote-config/apio-{major}.{minor}.x.jsonc"
```

That file is the upstream remote config with the openxc7 tag set to `2026-09-25`. Every Apio command in this phase ran with the variable set; each run printed `Active env options [APIO_REMOTE_CONFIG_URL]`. `apio packages list` reported `openxc7 2026.09.25 OK` both before and after the builds, so no upgrade happened.

## 4. Project structure

```
experiments/phase2-clocked-vhdl/
├── src/counter.vhd        portable
├── src/top.vhd            portable
├── sim/counter_tb.vhd     portable
├── nexys-a7-100t.xdc      portable
├── apio.ini               portable (board = nexys-a7-100t, top-module = top)
├── generated.v            GHDL output, regenerated on each platform
├── _sim/                  GHDL work library, simulation executables, counter_tb.ghw
└── _build/default/        Apio output
```

The GHDL work files are kept in `_sim/`, not `_build/`, because `apio clean` deletes all of `_build/`.

Design summary:
- `counter`: `generic WIDTH : positive := 27`, `numeric_std` unsigned register, `+ 1` on each rising edge, synchronous active-high reset to all zeros.
- `top`: instantiates `entity work.counter generic map (WIDTH => 27)`. `clk100mhz` drives clk, `btnc` drives reset, and `led0 <= count(26)`.

## 5. Testbench

Commands (working dir `experiments/phase2-clocked-vhdl`):

```sh
G=~/WSClaude/NexysVHDL/tools/ghdl/bin/ghdl
$G -a --std=08 --workdir=_sim src/counter.vhd src/top.vhd sim/counter_tb.vhd
$G -e --std=08 --workdir=_sim -o _sim/top_elab top
$G -e --std=08 --workdir=_sim -o _sim/counter_tb counter_tb
_sim/counter_tb --wave=_sim/counter_tb.ghw
```

- Analysis passed for all three files. Elaboration passed for `top` (WIDTH=27 hierarchy) and for `counter_tb` (WIDTH=4).
- The testbench uses WIDTH=4 and a 10 ns clock. It checks, in order:
  1. reset clears the count to 0;
  2. after release the count is 1…20, which covers the wrap past 15;
  3. a second reset clears the count to 0 and holds it there for 2 cycles;
  4. after release the count restarts at 1.
- Result: `counter_tb: ALL TESTS PASSED`, then `simulation stopped @246ns` via `std.env.stop`, exit code 0.
- Negative control: a copy of the counter changed to `+ 2` (built in scratch; real sources untouched) fails with `Count mismatch at step 1: expected 1, got 2`, exit code 1.
- Waveform: `experiments/phase2-clocked-vhdl/_sim/counter_tb.ghw`, 1,141 bytes.
- Log: `notes/phase2-macos-ghdl-sim.log`. It contains 6 harmless `ld: warning … built for newer 'macOS' version (28.0)` lines, which are link warnings for the simulation executables only.

## 6. GHDL multi-file synthesis

GHDL 6.0.0 `--help synth` documents `--synth [OPTIONS] { FILE } -e [UNIT]`. The command used:

```sh
$G --synth --std=08 --out=verilog src/counter.vhd src/top.vhd -e top > generated.v
```

It exited 0 with no diagnostics. `generated.v` is 981 bytes, sha256 `acdd85cd…f048`, and regenerating it gives the same bytes.

## 7. generated.v sanity check

- **Hierarchy:** GHDL keeps it. `module counter_Brtl_27` is the counter specialised for WIDTH=27, and `module top` instantiates it as `u_counter`.
- **Ports:** `top` has `clk100mhz`, `btnc` and `led0`.
- **Counter logic:**
  - `assign n9 = count_reg + 27'b…1`
  - `assign n11 = reset ? 27'b0 : n9` (synchronous reset mux)
  - `always @(posedge clk) n14 <= n11`
- **Output:** `led0 = count[26]`.
- **`initial` blocks:** there are two, `count_reg = 0` and `n14 = 0`. They come from the VHDL signal initializer `:= (others => '0')`. They are power-up values, which Yosys maps to flip-flop INIT=0; they are not simulation-only behaviour.
- No unresolved VHDL constructs remain. The `/*# src/... */` comments carry relative source locations only.

## 8. Yosys result

- Yosys read only `generated.v`: `yosys -p "synth_xilinx -arch xc7 -top top ; write_json …" -DSYNTHESIZE generated.v`. No `.vhd` file entered the Apio flow.
- Hierarchy is preserved in the stats: `counter_Brtl_27` has 27 FDRE, 7 CARRY4 and 1 INV; `top` has 2 IBUF, 1 OBUF and 1 BUFG.
- LUTs: Yosys reports 0 LUT cells. The increment maps entirely onto CARRY4 plus one INV for bit 0.
- nextpnr packs 56 SLICE_LUTX from `56x LUT1`. These are route-through and carry-select LUTs created while packing.
- There are no unexpected primitives, and `CHECK` finds 0 problems.
- Sanity checks against nextpnr net fanouts:
  - the clock net `$iopadmap$clk100mhz` reaches 27 FFs through the BUFG;
  - `$iopadmap$btnc` fans out to 27 FF R pins, so the reset is kept;
  - `count[26]` drives `led0`.
- Warnings: 1 × `ABC: Warning: The network is combinational`. This is informational: ABC runs only on the combinational part of the design.

## 9. Placement and routing

- Pads:
  - `clk100mhz` → RIOB33_X57Y125.IOB_Y0 = IOB_X1Y126 = **E3**
  - `btnc` → LIOB33_X0Y81.IOB_Y0 = IOB_X0Y82 = **N17**
  - `led0` → LIOB33_X0Y113.IOB_Y0 = IOB_X0Y114 = **H17**

  All three agree with prjxray `package_pins.csv`.
- The BUFGCTRL was placed at X0Y0 through dedicated routing. The 3 IOs were placed by constraint and the remaining cells by HeAP and SA.
- Utilisation: 56 LUT, 27 FF, 7 CARRY4, 3 PAD, 1 BUFGCTRL.
- Routing: router2 iter 1 had overused=2; iter 2 had overused=0. Router2 took 0.74 s. The router1 legality check routed 0 arcs, then reported "Routing complete" and "Program finished normally".
- Warnings: the 3 XDC option warnings (§10). Errors: 0.

## 10. Clock recognition

XDC line: `create_clock -add -name sys_clk_pin -period 10.00 -waveform {0 5} [get_ports {clk100mhz}]`

nextpnr prints `Warning: ignoring unsupported XDC option '-add' / '-name' / '-waveform'`. It still uses `-period`:

```
Derived frequency constraint of 100.0 MHz for net $iopadmap$clk100mhz
```

The clock is recognised, so no XDC change was needed. The line stays Vivado-standard and is portable to Windows. The three warnings are expected and harmless: the default waveform is `{0 5}` for a 10 ns period anyway.

## 11. Timing

| | |
|---|---|
| Constraint | 100 MHz (10.000 ns) |
| Fmax after placement | 468.82 MHz |
| **Fmax after routing** | **372.58 MHz — PASS at 100.00 MHz** |
| Critical path | 2.68 ns (2.00 ns logic, 0.69 ns routing): FF `count[1]` → LUT → 7-stage CARRY4 chain → FF D (`n9[25]`) |
| Worst endpoint slack | ≈ 7.3 ns (slack histogram starts at 7316 ps) |
| Violations | none |

`_build/default/hardware.pnr` (JSON) has the keys `fmax`, `utilization` and `critical_paths`. It contains `"fmax": {"$iopadmap$clk100mhz": {"achieved": 372.578…, "constraint": 100}}`.

## 12–14. Bitstream

- Path: `~/WSClaude/NexysVHDL/experiments/phase2-clocked-vhdl/_build/default/hardware.bit`
- Size: 3,825,910 bytes
- Header part: `xc7a100tcsg324-1`
- SHA-256 of the programmed file: `f1eec86ebec4322318a5270d6704fd759aa55167276541cbc312792ec8b14b60`
- Build time: 4.4–4.6 s (Apio-reported), about 5 s wall clock

## 15. Deterministic rebuild

Two consecutive `apio clean && apio build` runs with identical inputs and tools gave:

| File | Result |
|---|---|
| generated.v (regenerated) | identical |
| hardware.json | identical |
| hardware.fasm | identical |
| hardware.frames | identical |
| hardware.bit | **file hash differs** |
| hardware.bit configuration payload | identical, sha256 `113535ae…4b7f` |

The only difference is the `.bit` header field `d`, which holds the build time in UTC (`17:38:58` vs `17:39:16`). xc7frames2bit writes the date and time into the header. **The implementation is deterministic.** To compare bitstreams, compare the FASM or the payload, not the file hash.

Correction to the Phase 1 record: the "identical after rebuild" bit hash noted there most likely happened because `apio upload` didn't regenerate the bit file. SCons skips xc7frames2bit when the FASM content is unchanged, and the same thing happened in this phase's upload. Phase 1 files are left unmodified.

## 16. Programming

`apio upload`, with the pin set:

- Device check: `DEVICE [0403:6010] [1:4] [Digilent] [Digilent USB Device] [210292BCFFE4]`
- `openFPGALoader --board nexys_a7_100 --detect`: idcode `0x3631093`, Xilinx, artix a7 100t, xc7a100
- Command Apio ran: `openFPGALoader --force-terminal-mode --verify --board nexys_a7_100 _build/default/hardware.bit`
- Output: `Load SRAM … Done`, `ir: 1 isc_done 1 isc_ena 0 init 1 done 1`, then `[SUCCESS] Took 8.82 seconds`
- SRAM only. `--verify` applies only to flash writes, so openFPGALoader did no readback for this SRAM load. DONE=1 is the confirmation.
- Log: `notes/phase2-macos-apio-upload.log`

## 17. Physical result

Expected behaviour: LED0 toggles every 2^26 / 100 MHz = 0.671 s (period ≈ 1.34 s). Holding BTNC keeps LED0 off. After BTNC is released, LED0 turns on after about 0.67 s and keeps blinking.

User confirmation, verbatim: **"perfect. all right"**. Result: **PASS**.

## 18. Portability

These files are to be copied unchanged to Windows:
- `src/counter.vhd`
- `src/top.vhd`
- `sim/counter_tb.vhd`
- `nexys-a7-100t.xdc`
- `apio.ini`

All five are pure ASCII, LF line endings, with a trailing newline and no tabs. They contain no absolute or home paths, no `file://`, no shell syntax, no macOS/Apple/Darwin references, and no tool paths.

`generated.v` is not portable by design: each platform regenerates it. Its content should nonetheless match across platforms with the same GHDL version.

## 19. Warnings and issues

1. nextpnr-xilinx ignores `create_clock` options `-add`, `-name` and `-waveform`, and uses `-period`. Harmless.
2. ABC prints "network is combinational". Informational.
3. GHDL simulation links print `ld: warning … newer 'macOS' version (28.0) than being linked (15.5)`. Harmless.
4. The `.bit` file hash changes on every rebuild because of the timestamp in the header (§15).
5. `apio upload` checks for the board and re-runs Yosys and nextpnr before programming; it only regenerates the bit when the FASM changes.
6. The openXC7 pin (Phase 1 Issue 1) is still required.
7. For simulation, use a separate GHDL work dir outside `_build/`, because `apio clean` deletes it.

## 20. Recommendations for Windows Phase 2

- Copy the 5 portable files unchanged, with LF line endings. Disable git `autocrlf` for them, or use a `.gitattributes`.
- Regenerate `generated.v` with GHDL 6.0.0: `ghdl --synth --std=08 --out=verilog src/counter.vhd src/top.vhd -e top > generated.v`. Then compare it with the Mac copy (sha256 `acdd85cd…f048`); they should match.
- Run the testbench with the same `-a`/`-e`/run sequence. Windows GHDL builds may be mcode-based, where `--elab-run` or `-r` replaces running an executable.
- Record the Windows Apio and openXC7 versions. If they differ from Mac (1.7.0 / 2026.09.25), compare the FASM rather than the bit hash, and expect small P&R differences if the nextpnr revision differs.
- Expected Windows results: 27 FDRE, 7 CARRY4, Fmax ≈ 372 MHz with the same nextpnr revision, and a physical blink period of about 1.34 s.
