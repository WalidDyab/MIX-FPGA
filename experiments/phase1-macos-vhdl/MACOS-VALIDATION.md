# Phase 1 — macOS experiment sources

Portable sources from the macOS Phase 1 run recorded in `docs/phase1-macos.md`
(Mac workspace path: `experiments/phase1-macos-vhdl/`).

| File | Status |
|---|---|
| `apio.ini` | Mac copy, as validated |
| `nexys-a7-100t.xdc` | Mac copy, as validated |
| `top.vhd` | Not duplicated. Byte-identical to `../phase1-windows-vhdl/top.vhd` (sha256 `905ce6f9de8c9887d2451f5b14e0c392f13c049bf421ad78da65c8bf94114072`) |

Generated and machine-local files (`generated.v`, `_build/`, `hardware.bit`) are not tracked.
Logs: `notes/phase1-macos-apio-build.log`, `notes/phase1-macos-apio-upload.log`.
