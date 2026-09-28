# Phase 2 — Windows clocked, multi-file VHDL

Date: 2026-09-28
Goal: run the same portable Phase 2 design (VHDL-2008 counter + hierarchy + testbench) through the Windows toolchain and onto the Nexys A7-100T, programmed with Digilent `djtgcfg`, not Vivado.
Experiment: `experiments\phase2-windows-clocked-vhdl\`
Raw logs: `notes\phase2-windows-*.log`, `notes\phase2-windows-compare\`, `notes\phase2-windows-vivado\`

**Result: PASS, all 26 criteria met.**

## 1–2. Environment and tool versions

| Item | Windows (this run) | Mac Phase 2 (reference) |
|---|---|---|
| OS | Windows 11 Home 10.0.26200, x64 | macOS, Apple silicon |
| GHDL | 6.0.0 (mcode, GNAT 15.2.0), portable at `tools\ghdl-6.0.0` | 6.0.0 |
| Apio | 1.6.0 (2026-09-15) | 1.7.0 |
| openXC7 package | 2026-09-24 | 2026.09.25 (pinned) |
| Yosys | 0.63+173 (66306a8ca) | 0.63+173 |
| nextpnr-xilinx | 0eae9fb | e860c9c8 |
| djtgcfg | v2.6.1 banner (Adept Utilities 2.7.1) | — |
| Adept Runtime | dmgr 2.11.12 ("Digilent Software 1.9.18" in Programs; runtime 2.30.4) | — |
| Vivado | 2024.1, used for a detect-only check | — |

Nothing was updated. Yosys cannot be run standalone (it's missing `libreadline8.dll` on PATH), so its version came from `apio raw -- yosys -V`.

## 3. Project structure

```
phase2-windows-clocked-vhdl\
    src\counter.vhd         portable (generic WIDTH, numeric_std, sync reset)
    src\top.vhd             portable (entity work.counter, WIDTH => 27, led0 <= count(26))
    sim\counter_tb.vhd      portable (self-checking, WIDTH => 4)
    nexys-a7-100t.xdc       portable (E3 / N17 / H17, create_clock 10.00 ns)
    apio.ini                portable (board nexys-a7-100t, top-module top)
    generated.v             GHDL output (regenerated per platform)
    _sim\work\              GHDL sim library        _sim\counter_tb.ghw   waveform
    _sim\synth\             GHDL synth library
    _build\default\         Apio outputs (hardware.bit …)
    _build\program\hardware-digilent.bit   header-normalized programming copy
```

## 4–5. Simulation

```
ghdl -a --std=08 --workdir=_sim/work src/counter.vhd src/top.vhd sim/counter_tb.vhd   (rc 0 each)
ghdl -e --std=08 --workdir=_sim/work top          (rc 0)
ghdl -e --std=08 --workdir=_sim/work counter_tb   (rc 0)
ghdl -r --std=08 --workdir=_sim/work counter_tb --wave=_sim/counter_tb.ghw --assert-level=error
```

- `sim/counter_tb.vhd:75:9:@280ns:(report note): ALL TESTS PASSED (28 checks, ends at 280000000 fs)`
- Output ends with `simulation stopped @280ns` (`std.env.stop`), rc 0.
- The 28 checks cover: 2 under reset (=0), counts 1..20 with wrap 15→0 at step 16, 3 reset-and-hold (=0), and restart 1..3. The testbench samples on the falling edge after each rising edge.
- Mac ended at about 246 ns. Windows ends at 280 ns because the reset-hold and restart segments add 6 checks.
- Waveform: `_sim\counter_tb.ghw`, 1,106 bytes.
- **Fault injection:** faulty copies were compiled into `_sim\fault\` and then deleted. `src\` was never edited, and its hash was confirmed unchanged.
  - `+ 2` increment → `count step 1: expected 1, got 2` @30 ns, rc 1.
  - Reset ignored → `reset, edge 1: expected 0, got 1` @10 ns, rc 1.

numeric_std, `unsigned + 1`, the WIDTH generic (4 in sim, 27 in synthesis) and `entity work.counter` all resolve, and both tops elaborate.

## 6–7. GHDL synthesis and `generated.v`

```
ghdl --synth --std=08 --workdir=_sim/synth --out=verilog src/counter.vhd src/top.vhd -e top > generated.v   (rc 0)
```

- 41 lines. **Hierarchy preserved**: `module counter_Brtl_27` (same name as Mac), instantiated as `u_counter` in `module top`.
- Ports `clk100mhz`, `btnc`, `led0`. `reg [26:0] count_reg`, `n9 = count_reg + 27'b…1`, `n11 = reset ? 0 : n9`, `always @(posedge clk) n14 <= n11`, `led0 = count[26]`.
- The `initial … = 0` blocks come from the VHDL signal initializer and become FF INIT values; they don't hurt synthesis. There are no unresolved constructs.
- **SHA-256 `c3f7f40fd66357f3b70d36d71fdf4810f180d8c14e8ed6b7eee730a5f95d1eca`**. A second run into a fresh work library gave an identical hash.
- No Mac `generated.v` hash is available on this machine, so no hash comparison was possible. The structural comparison (module names, ports, register width, arithmetic, reset mux) matches the Mac description.

## 8. Yosys

Command (from the log): `yosys -p "synth_xilinx -arch xc7 -top top ; write_json …" -DSYNTHESIZE generated.v`. Only `generated.v` is read; no `.vhd` is read.

| Primitive | Windows | Mac |
|---|---|---|
| FDRE | 27 | 27 |
| CARRY4 | 7 | 7 |
| INV | 1 | 1 |
| IBUF | 2 | 2 |
| OBUF | 1 | 1 |
| BUFG | 1 | 1 |

The hierarchy is kept (`counter_Brtl_27` is a submodule of `top`). CHECK pass: `Found and reported 0 problems`. The only warning is an ABC note: `The network is combinational`.

## 9. Placement and routing

- Pins, verified against prjxray `package_pins.csv`: clk100mhz → IOB_X1Y126 = **E3** (MRCC), btnc → IOB_X0Y82 = **N17**, led0 → IOB_X0Y114 = **H17**.
- Clock: IBUF → BUFGCTRL_X0Y16, "based on dedicated routing". The FASM shows CLK_BUFG / CLK_HROW / BUFHCE, so the clock runs on the global clock network.
- Packed: 56 SLICE_LUTX, 27 SLICE_FFX, 7 CARRY4 (1 chain), 1 BUFGCTRL, 2 IN / 1 OUT IOB. **These match the Mac (56 LUT, 27 FF).**
- router2: **1 iteration** (Mac: 2), `wires=421 overused=0 overuse=0 archfail=0`, 1.52 s.
- nextpnr warnings: **none**. The Mac reported ignored `-add/-name/-waveform`; this nextpnr (0eae9fb) prints nothing about them. Errors: none.

## 10–11. Clock and timing

- `derived 100.0 MHz for net '$iopadmap$clk100mhz'` (from `create_clock -period 10.00`).
- Post-route: **`Max frequency for clock '$iopadmap$clk100mhz': 409.67 MHz (PASS at 100.00 MHz)`**. Pre-route estimate: 188.82 MHz.
- `hardware.pnr`: `fmax: {clk100mhz: {achieved: 409.67, constraint: 100.0}}`.
- Critical path (count[1] → CARRY4 chain → FF D): 1.8 ns logic + 0.7 ns routing, **2.44 ns** including setup.
- Worst slack (histogram, ps): **+7.559 ns**. Mac: about 2.68 ns and +7.3 ns at 372.58 MHz.
- **Timing PASS.**

## 12–13. Bitstream and deterministic rebuild

- `D:\WSClaude\NexysVHDL\experiments\phase2-windows-clocked-vhdl\_build\default\hardware.bit`
- **3,825,910 bytes** (same as Mac). Part `xc7a100tcsg324-1` (fasm2frames and xc7frames2bit `--part`).
- Canonical (rebuild) SHA-256: `eb422f1b5e321c31b4fdd12a103ab04c4acfc5232b5ebf8b9bd91e16c75ab185`.
- Build time: 13.7 s by Apio (15.3 s wall). Clean rebuild: 10.4 s (11.8 s wall).

Build 1 was saved to `notes\phase2-windows-compare\build1\`, followed by `apio clean` and `apio build`:

| Artifact | Result |
|---|---|
| generated.v (2 GHDL runs) | identical |
| hardware.json / .fasm / .frames | identical |
| hardware.bit (whole file) | differs: `a9c44f84…` vs `eb422f1b…` |
| hardware.bit payload (last 3,825,788 B) | **identical**: `225048fbe3665b30bc25a36571ac9984e94f125f1257d50b14d231232566b003` |
| header fields a, b, c, e | identical |
| header field d (time) | `18:14:42` vs `18:16:37`, the only difference |

The build is fully deterministic; only the timestamp differs. Header field `a` contains the Windows relative path `_build\default\hardware.frames` (metadata only, and it will differ from the Mac file).

## 14–16. Digilent programming copy and djtgcfg

The Phase 1B normalizer was reused in place, unmodified (SHA-256 `6bd2de5e…`):

```
python ..\phase1b-windows-programmer\normalize_bit_header.py _build\default\hardware.bit _build\program\hardware-digilent.bit
b: 'xc7a100tcsg324-1' -> '7a100tcsg324'
payload 3825788 bytes copied and verified identical
```

- The copy is 3,825,906 bytes, SHA-256 `70f017f8…90cd449`. Its payload SHA-256 is `225048fb…66b003`, identical to the original.
- The canonical `hardware.bit` hash was unchanged afterwards.
- The copy lives in `_build\program\`, so `apio clean` removes it. It is regenerable.

`notes\phase2-windows-djtgcfg.log`:

```
djtgcfg enum                                  → NexysA7, "Digilent Nexys A7 -100T", SN 210292BCFFE4, rc 0
djtgcfg init -d SN:210292BCFFE4               → rc 1 "failed to initialize scan chain"   (board power switch OFF)
  … board powered on …
djtgcfg init -d SN:210292BCFFE4               → Device ID 13631093, Device 0: XC7A100T, rc 0
djtgcfg prog -d SN:210292BCFFE4 -index 0 -file …\_build\program\hardware-digilent.bit
  stdout: Programming device. Do not touch your board. … / Programming succeeded.
  stderr: (empty)      rc 0      4.02 s      non-elevated
```

FPGA SRAM only, no flash, no Vivado, no driver change.

## 17. Physical result (user-confirmed)

1. LED0 blinks visibly (≈0.67 s on / 0.67 s off; 2²⁶ / 100 MHz).
2. Holding BTNC resets the counter.
3. LED0 stays OFF while BTNC is held.
4. Releasing BTNC restarts from zero.
5. Blinking resumes.

**PASS.**

Optional Vivado check (detect only, no reprogram; `notes\phase2-windows-vivado\detect.log`): `xc7a100t_0` found, DONE = 1.

## 18. Portability

The five portable files contain no drive letters, backslashes, PowerShell or batch syntax, `.exe` names or tool paths. They are pure ASCII, with no BOM and LF line endings.

| File | SHA-256 |
|---|---|
| src/counter.vhd | `0264219d1f01be58de143b290f2808fe3539fe2c12aa443e6dfde6cc961ee2ea` |
| src/top.vhd | `055b0276ab3aaf8df306b66bb9730a1f12490c85b3561f83f7e99f699ff38d4a` |
| sim/counter_tb.vhd | `8252d17777de431796a033967910199171656f285907f7ff4182a19c6d540e76` |
| nexys-a7-100t.xdc | `e4a9ae2e75c3fa8e23853680747986ea0461a15be2d471679bc4cf542dfca5a6` |
| apio.ini | `0e03c35226c826b6820706a32e29c5a377f4cea87de48f42c8afe2604f93f4ce` |

These hashes can be compared directly with the Mac copies. The `[get_ports {clk100mhz}]` no-space form works on Windows as well.

## 19. Comparison with Mac Phase 2

| Aspect | Same? | Note |
|---|---|---|
| VHDL behavior / generic / hierarchy | yes | same sources; testbench PASS on both |
| GHDL output structure | yes | `counter_Brtl_27` on both. Hash not compared (no Mac hash here) |
| Yosys primitives | **identical** | same Yosys 0.63+173 |
| nextpnr packing | **identical** | 56 LUT / 27 FF |
| Pins / 100 MHz constraint | yes | E3/N17/H17, 100.0 MHz derived |
| Routing iterations | 1 vs 2 | nextpnr 0eae9fb vs e860c9c8 |
| Fmax / slack | 409.67 MHz, +7.56 ns vs 372.58 MHz, +7.3 ns | different nextpnr revision / placement. Both PASS |
| XDC warnings | none vs ignored `-add/-name/-waveform` | nextpnr revision |
| Bitstream size | 3,825,910 on both | payload not compared across OS |
| Programming | djtgcfg (header-normalized copy) vs Mac method | per-platform backend |
| Physical | PASS on both | |

## 20. Warnings and issues

1. **Apio collects every `*.v` in the project tree recursively.** A comparison copy (`_compare\generated.run2.v`) caused `ERROR: Re-definition of module counter_Brtl_27`. It was moved to `notes\` (the log is `notes\phase2-windows-compare\apio-rebuild-attempt1-stray-v.log`). The future tool must keep stray `.v` files out of the project directory, or put generated Verilog somewhere Apio is told about explicitly.
2. The board power switch was off at the first djtgcfg attempt. `enum` succeeds but `init` fails with `failed to initialize scan chain`, which is a useful diagnostic for students ("board on USB but not powered").
3. The `.bit` header part-name normalization is still required for djtgcfg (Phase 1B finding, reused unchanged).
4. The ABC note `The network is combinational` is harmless.
5. Yosys can't be run standalone outside Apio (DLL path), which is irrelevant when invoked through Apio.
6. A line-ending check using `grep -c $'\r'` under Git-Bash gave a false CRLF result. Raw-byte inspection showed the files are LF.

## 21. Recommendation for Phase 3

**PASS. Proceed to Phase 3.** The same portable VHDL/XDC/apio.ini produced functionally identical results on Windows and macOS.

Carry into Phase 3:
- Keep the generated Verilog in a controlled location and guard against stray `.v` files.
- Build the header normalization into the Windows programming step.
- Surface the djtgcfg `enum`-OK / `init`-fail case as "board not powered".
- Consider pinning the openXC7 and nextpnr versions across platforms if identical timing numbers matter for teaching material.
