# Phase 1 — macOS (Apple silicon) validation

Date: 2026-09-28
Result: **PASS** (all 14 success criteria met; physical test confirmed by user)

Flow proven:

```
top.vhd → GHDL 6.0.0 → generated.v → Apio 1.7.0 / openXC7
       → Yosys → nextpnr-xilinx → fasm2frames → xc7frames2bit → hardware.bit
       → openFPGALoader (USB/JTAG, SRAM) → Nexys A7-100T
```

No Vivado, no Windows/VM, no Rosetta, no USB driver changes, no Homebrew.

## Environment

| Item | Value |
|---|---|
| Machine | MacBook Air (Mac16,12), Apple M4, 16 GB |
| macOS | 27.0 (build 26A428), Darwin 27.0.0 |
| `uname -m` | `arm64` |
| Rosetta 2 | Not installed (only `/Library/Apple/usr/libexec/oah/RosettaLinux`, the Linux-VM component). Not installed for this work. |
| Homebrew | Not installed; not needed |
| Apio | 1.7.0 (`pyinst-darwin-arm64-2026-09-27`), `/Applications/Apio/apio`, Mach-O arm64 |
| Apio packages | definitions 2026.09.17, **openxc7 2026.09.25** (pinned, see Issue 1), oss-cad-suite 2026.09.15, verible 2026.09.20 — all darwin-arm64 |
| Yosys | 0.63+173 (git 66306a8ca), aarch64-apple-darwin |
| nextpnr-xilinx | e860c9c8 |
| prjxray-db | a90f27c1 |
| openFPGALoader | v1.1.1 (from Apio oss-cad-suite), arm64 |
| GHDL | 6.0.0 (6.0.0.r0.ge589c698c), LLVM 22.1.0 backend, GNAT 14.2.0, arm64 |

All tool binaries verified with `file` as `Mach-O 64-bit executable arm64`.

## GHDL installation

The GHDL shipped inside Apio's oss-cad-suite (`~/.apio/packages/oss-cad-suite/bin/ghdl`) is arm64 but
**fails to launch on macOS 27**: `dyld: duplicate LC_RPATH '@executable_path/../lib/'`. It was not used or modified.

Installed instead the official GHDL release, project-local:

```sh
cd ~/WSClaude/NexysVHDL/tools/downloads
curl -sSL -O https://github.com/ghdl/ghdl/releases/download/v6.0.0/ghdl-llvm-6.0.0-macos15-aarch64.tar.gz
# sha256 69beb5913a490b5971980bd045af6a63b6f52e861b444fa990bffac436587478
tar xzf ghdl-llvm-6.0.0-macos15-aarch64.tar.gz -C ..
ln -sfn ghdl-llvm-6.0.0-macos15-aarch64 ../ghdl
```

Executable: `~/WSClaude/NexysVHDL/tools/ghdl/bin/ghdl`. No PATH/shell config changes. Downloaded with curl, so
no quarantine attribute and no Gatekeeper prompt.

## Commands

Working dir: `~/WSClaude/NexysVHDL/experiments/phase1-macos-vhdl`

```sh
G=~/WSClaude/NexysVHDL/tools/ghdl/bin/ghdl
mkdir -p _build/ghdl
$G -s --std=08 --workdir=_build/ghdl top.vhd                         # syntax: OK
$G -a --std=08 --workdir=_build/ghdl top.vhd                         # analyze: OK
$G -e --std=08 --workdir=_build/ghdl -o _build/ghdl/top_sim top      # elaborate: OK
$G --synth --std=08 --workdir=_build/ghdl --out=verilog top > generated.v

export APIO_REMOTE_CONFIG_URL="file://$HOME/WSClaude/NexysVHDL/tools/apio-remote-config/apio-{major}.{minor}.x.jsonc"
apio packages install     # once: restores openxc7 2026.09.25
apio build
apio devices scan-usb
~/.apio/packages/oss-cad-suite/bin/openFPGALoader --scan-usb
~/.apio/packages/oss-cad-suite/bin/openFPGALoader --board nexys_a7_100 --detect
apio upload
```

Elaboration printed a harmless linker warning (`object file was built for newer 'macOS' version (28.0) than being
linked (15.5)`); the simulation executable ran fine. It only affects GHDL simulation executables, not synthesis.

## Generated Verilog (from GHDL, unedited)

```verilog
module top
  (input  sw,
   output led);
  assign led = sw; //(module output)
endmodule
```

Top `top`, input `sw`, output `led`, `led = sw`, no simulation-only or unresolved constructs.

## Project files

- `top.vhd` — as specified (VHDL-2008)
- `generated.v` — GHDL output
- `apio.ini` — `board = nexys-a7-100t`, `top-module = top`
- `nexys-a7-100t.xdc` — `sw` → J15, `led` → H17, both LVCMOS33

## Build result

`apio build`: SUCCESS in 10.9 s (≈12 s wall). 0 warnings, 0 errors. Full log: `notes/phase1-macos-apio-build.log`.

- Yosys `synth_xilinx -arch xc7`: 1 IBUF, 1 OBUF, 0 LCs, CHECK 0 problems
- nextpnr-xilinx `--device xc7a100tcsg324-1`: 2 cells placed by constraint; router2 iter 1, 0 overuse;
  "Routing complete", "Program finished normally". No Fmax (no timing paths — expected)
- `fasm2frames --part xc7a100tcsg324-1` → `xc7frames2bit --part_name xc7a100tcsg324-1`: OK
- FASM sites: `LIOB33_X0Y101.IOB_Y1` (input, LVCMOS33) and `LIOB33_X0Y113.IOB_Y0` (output, LVCMOS33, DRIVE 12);
  consistent with prjxray `package_pins.csv`: J15 = IOB_X0Y101, H17 = IOB_X0Y114

Bitstream:
- `~/WSClaude/NexysVHDL/experiments/phase1-macos-vhdl/_build/default/hardware.bit`
- 3,825,910 bytes; header part `xc7a100tcsg324-1`, generator `xc7frames2bit`
- sha256 `838b23052c28dda88bd34e9b916d8820c9ab5ad2596df7df2ad8da113a0cbfa3` (identical after the rebuild in `apio upload` — deterministic)

## USB / JTAG

- `apio devices scan-usb`: `0403:6010`, Digilent, "Digilent USB Device", serial 210292BCFFE4, FT2232H (bus 1 dev 4, through an HP USB-C Travel Hub G2)
- `openFPGALoader --scan-usb`: FTDI2232 probe, same device
- `openFPGALoader --board nexys_a7_100 --detect`: idcode `0x3631093`, Xilinx Artix-7 xc7a100, irlength 6, JTAG 6 MHz
- No permissions prompt, no driver install, no kext. macOS gives libusb user-space access to the FTDI directly (no Zadig/WinUSB step as on Windows)

## Programming

`apio upload` worked directly. It invoked:

```
openFPGALoader --force-terminal-mode --verify --board nexys_a7_100 _build/default/hardware.bit
```

Output: `Load SRAM … 100%`, `Done`, `isc_done 1 … init 1 done 1`; SUCCESS in 8.65 s. SRAM only — no `-f`/`--write-flash`;
the configuration is lost at power-off. Log: `notes/phase1-macos-apio-upload.log`.

## Physical result

User confirmed: SW0 OFF → LED0 OFF, SW0 ON → LED0 ON. **PASS.**

## Issues and platform-specific findings

1. **Apio auto-update broke the toolchain (upstream issue).** Apio refreshes its remote config daily and auto-updated
   openxc7 from 2026.09.25 to 2026.09.27. The 09-27 package's `XILINX-PARTS-INDEX.json` uses schema 8, but Apio 1.7.0
   (2026-09-27 build) expects 7 → `Error: Unexpected schema version 8, expected 7`.
   Workaround (no Apio modification): a pinned copy of the upstream remote config with openxc7 tag `2026-09-25`
   in `tools/apio-remote-config/apio-1.7.x.jsonc` (upstream original kept alongside), selected through Apio's documented
   `APIO_REMOTE_CONFIG_URL` env var. **Every Apio command must set this variable**, otherwise Apio will reinstall the
   broken package. Revisit when Apio/openxc7 are realigned upstream.
2. **Apio's bundled GHDL doesn't launch on macOS 27** (duplicate LC_RPATH rejected by dyld). The official GHDL 6.0.0 aarch64 release is used instead.
3. **The nextpnr-xilinx XDC parser is stricter than Vivado's:** `[get_ports { sw }]` (spaces inside braces) crashes with
   `Assertion failure: str.back() == '}'`. Use `[get_ports {sw}]`. The Windows XDC may need the same form to be portable.
4. `apio clean` removes `_build/`, including the GHDL work library in `_build/ghdl` (harmless; regenerated on demand).
5. `apio upload` rebuilds if needed and requires the board to be present (it checks VID:PID 0403:6010 first).

## Limitations

- Combinational, single-file, no clock — no timing verification exercised.
- The Apio toolchain is a daily pre-release channel; versions can drift (see Issue 1).
