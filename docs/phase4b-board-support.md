# Phase 4B — board support, upgrade from NexysVHDL, fresh installation (macOS)

Status: implemented; validated in isolated roots and a sandboxed VS Code profile; DE10-Lite and Nexys A7-100T hardware acceptance PASSED. Not committed. Internal payloads are not for public distribution while L1, L3 and L9 are open.

## Architecture
* **Core** (the VSIX, about 0.5 MB): projects, board registry, workflow UI, waveform and schematic views, Setup / Board Support manager, state handling, the manifest and payload pins (`toolchains/mixfpga/toolchain-1.0-macos-arm64.json`, `payloads-1.0.json`). No FPGA binaries.
* **Nexys A7 support** (2.76 GB, 31,699 files): the NexysVHDL Toolchain 1.0 bundle exactly as validated (GHDL, Apio + oss-cad-suite with Yosys and openFPGALoader, Verible, openXC7, xc7a100t chip database). Store: `<MIX-FPGA root>/support/nexys-a7` (`$MIXFPGA_HOME` or `~/Library/MIX-FPGA`).
* **DE10-Lite support** (0.25 GB tools + engine + Quartus): MIX-FPGA Toolchain 1.0 (GHDL, Yosys, openFPGALoader, Lima, engine scripts, notices) in `toolchains/1.0/macos-arm64`, a managed Linux engine under Rosetta, and Altera's Quartus Prime Lite 25.1 Build 1129 + MAX 10 installed from the student's own download.
* **Shared:** nothing outside the VSIX is needed by both boards. GHDL, Yosys and openFPGALoader exist in both support sets (about 150 MB): the Nexys copies sit inside the proven Apio bundle and were not refactored (risk rule).
* Board support is two entries (`platform/macos/install/boards.ts`), each a list of Setup components; Setup installs only the chosen ones, resumes after interruption, and shows **Board Support** (Installed / Not installed / Setup not finished / Needs repair) above **Environment**. Creating a project for a board without support asks to install it first.

## Update from NexysVHDL
* Extension id `emxplore.nexysvhdl`, `.nvproj`, `nexysvhdl.json`, `nexysvhdl.*` command/setting ids, the `vscode://emxplore.nexysvhdl/…` launcher URI and the "NexysVHDL Classroom" theme name are unchanged. Compared with the installed 0.6.0: no command, setting or view removed. Version bumped 0.6.0 → **0.7.0** so it installs as the update.
* With no MIX-FPGA Nexys store, the Nexys flow reuses `~/Library/NexysVHDL` read-only, but only if its installed marker equals the validated content hash. Writable tool state always goes to the MIX-FPGA store. Under `MIXFPGA_HOME` NexysVHDL is never consulted.
* **Take-over:** the NexysVHDL store is verified file by file (31,699 files) and copied as an APFS clone (`cp -c`), verified again, marked "adopted from NexysVHDL", published by one rename. Nothing under `~/Library/NexysVHDL` is written. Done on the development Mac.

## Validation (all in `~/MF/*`, `~/MFU`, private VS Code profiles; `~/Library/MIX-FPGA` untouched except the approved Nexys take-over)
| Scenario | Result |
|---|---|
| Nexys-only fresh install (real VS Code, scripted dialogs) | first-run board choice, install, Board Support page, DE10-Lite gate in New Project, clean Build 13.1 s (57 LUTs, 372.58 MHz); every tool from the new store; no engine created |
| DE10-only fresh install | Ubuntu image download, Lima create from the verified local image, Linux setup (all real), Quartus + MAX 10 after the student ticked the real Altera licence page; Check, Simulate, RTL, Build cold 37 s / warm 28 s |
| Add Nexys later (DE10-only → both) | DE10 untouched, nothing re-downloaded |
| Nexys → DE10 → Nexys, same install | identity, constraint type (XDC vs QSF/SDC), programmer rows, results, engine state all correct; no leakage |
| NexysVHDL 0.6.0 → MIX-FPGA 0.7.0 (sandbox profile, private home with a clone of the NexysVHDL store) | update installs over 0.6.0; project opens; Check/Simulate/RTL pass; project files byte-identical; Nexys A7 Installed (reused), DE10-Lite offered; installing it from New Project ran the licence step and created the project; then Nexys and DE10 Build from the same install |
| Verify + Repair through the Setup UI (damaged file) | Verify detects it; Repair (new global action) restores it; Verify passes |
| **DE10-Lite hardware acceptance** (extension 0.7.0, `MIXFPGA_HOME=~/MF/r2`, clean DE10 install; board connected) | Detect: exactly one DE10-Lite (USB-Blaster `91d28408`); `openFPGALoader --detect` from the r2 install: IDCODE `0x031050dd`, Altera MAX 10 10M50D. Program with the validated `top.svf` (sha256 `9d51ef21…99458d`, unchanged since the build, no rebuild): `openFPGALoader -b de10lite` from `~/MF/r2/toolchains/1.0/macos-arm64/openfpgaloader/libexec`, SRAM only (`volatile`, `PROGRAMMED_SRAM`), about 3.9 s, flash untouched. Post-program Detect: one board in 6 of 6 runs after the fix. **Physical check by the user: LEDs, SW0 and KEY0 behave correctly → PASSED.** |
| **Nexys A7-100T hardware acceptance** (extension 0.7.0, `MIXFPGA_HOME=~/MF/r2`, Nexys support of the clean install; board connected) | Detect: exactly one board (Digilent `210292BCFFE4`). Program with the already-built `hardware.bit` (3,825,910 bytes, sha256 `60db725a…1cea`, no rebuild): `openFPGALoader --board nexys_a7_100 --ftdi-serial 210292BCFFE4 --write-sram` from `~/MF/r2/support/nexys-a7/…/oss-cad-suite/libexec`, SRAM only (`volatile`, DONE=1, xc7a100 idcode `0x3631093`), about 5.3 s, flash untouched. Post-program Detect: one board. Process watcher: 0 processes from NexysVHDL, `toolchains/experimental` or the real `~/Library/MIX-FPGA`. **Physical check by the user: PASSED.** |
| Process watcher in every session | 0 processes from `toolchains/experimental`; 0 from the real `~/Library/MIX-FPGA`; NexysVHDL's store used only in the update-reuse case |

Bugs found by the clean runs and fixed: licence extraction killed its own shell on a clean engine (`pkill -f`); Verify found damage the page could not repair; the start-up "install FPGA toolchain" prompt ignored board support.

Bugs found by the hardware run and fixed: **board-scan concurrency.** After every Program the extension starts its own board scan; a second Detect started during that scan (a student clicking Refresh, or the acceptance test) ran a second `openFPGALoader` on the same USB-Blaster at the same time, and the loser reported "none" (2 of 6 early runs; the programmer itself never lost the board: 12/12 CLI program+detect, 15/15 raw scans). `NexysService.detectBoards()` (`extension/services/nexys-service.ts`) now runs one scan at a time and a request made during a scan joins it; unit test "overlapping detections share one scan" in `tests/extension/service.test.ts`. After the fix: 6 of 6 hardware runs detected the board after programming.

Final suite: 1090 tests, 1089 pass, 0 fail, 1 skipped.

## Not validated / pending
* **True fresh-Mac / fresh-macOS-account validation, including the Rosetta install path: pending** (Rosetta was already present; the Rosetta step is covered only by isolated tests).
* **Legal review L1, L3, L9: open.** Not resolved by guessing; payloads must not be distributed publicly until they are closed.
* "Both chosen at once" on a real engine (covered by isolated tests; the real runs did Nexys → add DE10, and DE10 → add Nexys).
* Native dialogs were answered by script (no desktop-control tool); the Altera licence page was real and operated by a person.
* Installed-extension mode cannot intercept dialogs; the post-update Setup runs used the same code in development mode with the same private home.
* Release work: final DMG, signing, payload hosting, VSIX allowlist now carries only the manifest and pins; legal review L1, L3, L9 (see above).

## Storage (measured)
Common: 0.5 MB. Nexys support: 2.77 GB (archive extract peak about 3.4 GB; take-over by clone about 0 GB). DE10 support: 0.25 GB tools + engine 12.2 GB allocated (60 GiB is a sparse limit) + Ubuntu image 0.61 GB (+1.9 GB Lima conversion in the Lima cache); peak about 17 GB with the temporary 2.3 GB Altera copies. After setup, MIX-FPGA already removes the copied Altera files and the extracted payload; the Ubuntu image and Lima cache (about 2.5 GB), old build jobs and the support archives are the optional/user-triggered cleanups (archives kept for Repair unless the course hosts them).
