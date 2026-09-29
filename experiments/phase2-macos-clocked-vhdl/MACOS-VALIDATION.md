# Phase 2 — macOS experiment sources

Portable sources from the macOS Phase 2 run recorded in `docs/phase2-macos.md`
(Mac workspace path: `experiments/phase2-clocked-vhdl/`, the path used in that document).

| File | Status |
|---|---|
| `src/counter.vhd` | Mac copy, as validated |
| `src/top.vhd` | Mac copy, as validated |
| `sim/counter_tb.vhd` | Mac copy, as validated (differs from the Windows testbench) |
| `apio.ini` | Mac copy, as validated |
| `nexys-a7-100t.xdc` | Not duplicated. Byte-identical to `../phase2-windows-clocked-vhdl/nexys-a7-100t.xdc` (sha256 `e4a9ae2e75c3fa8e23853680747986ea0461a15be2d471679bc4cf542dfca5a6`) |

Generated and machine-local files (`generated.v`, `_build/`, `_sim/`, `hardware.bit`, `counter_tb.ghw`) are not tracked.
Logs: `notes/phase2-macos-ghdl-sim.log`, `notes/phase2-macos-ghdl-synth.log` (empty: synthesis printed no diagnostics),
`notes/phase2-macos-apio-build.log`, `notes/phase2-macos-apio-rebuild.log`, `notes/phase2-macos-apio-upload.log`.
