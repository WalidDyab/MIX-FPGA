# Phase 5F: final macOS clean-student acceptance (2026-10-24)

**Classification: PASS WITH DOCUMENTED NON-BLOCKING ISSUES** (ready for signing/notarization once the issues in section 12 are accepted). Technical acceptance only; no legal clearance is claimed. Nothing was signed, notarized, published or distributed. Evidence (machine reports, logs) is in `docs/phase5f-evidence/`.

## 0. Freeze check
`63748a8` (RC build commit) to `5f106f5` (HEAD): one added file, `docs/phase5e-release-candidate-report.md`. It is not packaged and cannot affect the VSIX, setup, Toolchain 1.1, manifests, hashes or install files, so the existing RC was used. After that commit only `tests/integration/phase4b-suite.ts` (test harness, not shipped) and this evidence changed.

## 1-3. Method and tested artifacts
Student root: a private macOS HOME per scenario (`/Users/nohafahmy/MFU5F-<n>`, so the root is `~/Library/MIX-FPGA` of that HOME), fresh VS Code 1.143.1 user-data and extensions folders, the RC VSIX installed from the RC folder. No `MIXFPGA_HOME`, `MIXFPGA_DEV_PAYLOAD` or repository paths were set (`env -u`). `/Applications/Apio` and `~/.apio` were renamed away for the run and restored afterwards; no `.apio` was created in any test HOME. The reference `~/Library/MIX-FPGA` (Toolchain 1.0) was never touched (no file newer than the run; its VM stayed Stopped). Native VS Code dialogs (quick picks, file pickers, modal messages) were answered by script on the installed extension's own API object; commands, controllers, installers, Lima, Quartus and the Altera licence webview were real. The licence page was answered by a person. Every RC file was verified against `SHA256SUMS` and `RELEASE-MANIFEST.json` (commit `63748a82...`) before and after the run:

| File | SHA-256 |
|---|---|
| `nexysvhdl-0.7.0-darwin-arm64.vsix` | `53d4ce4ac847c4ca4837596550ca358550d85c2be021435a0e5526808b2bc7bc` |
| `nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz` | `f84cedece009be5a04ad44a9c2ff1110fccc1c6725f483a20bb0e139c84f3a73` |
| `MIX-FPGA-Nexys-A7-Support-1.1-Sources.zip` | `cf6b36b988065c2441cd5fbb9a86352a88778c44ef20933dc7fa4bb7f043efda` |
| `mixfpga-de10-lite-support-1.1-macos-arm64.tar.gz` | `19df1593f9266653a4fddbc18cebb4b019e78682271034e0893be264c2d38326` |
| `MIX-FPGA-DE10-Lite-Support-1.1-Sources.zip` | `e85dbbff25f489dd212661671d842673c7f74455c0df9aae0fa3cc1adbd5715a` |

Altera inputs (verified before any installer ran): `QuartusLiteSetup-25.1std.0.1129-linux.run` `518433ec...c4eb` (1,982,715,698 B), `max10-25.1std.0.1129.qdz` `8057844b...19ce9` (302,078,437 B), equal to the pins.

## 4. Clean install
The extension reports Toolchain 1.1 (archive `nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz`, tree `0d0035d3...`) as required; the fresh Setup page shows "Setup required"; first-run welcome and board choice work; the DE10-Lite gate is offered for a Nexys-only root; no repository or developer path appears in any report (grep). Nexys A7 support installed from the RC archive: "Setup finished", Setup headline Ready, VHDL Tools and Programmer Ready, Setup Verify "the environment is ready"; the installed tree hashes to `0d0035d3...` (31,541 files).

## 5. Nexys A7 workflow (real VS Code, RC VSIX)
New Project (starter), Check passed, Simulate passed (660 ns), RTL schematic ready, Build passed in 13 s (57 LUTs, 27 FFs, Timing PASS 372.58 MHz, `hardware.bit` 3.6 MB).

## 6. Physical Nexys A7 Program: PASS
Detect: one board (`Digilent USB Device 210292BCFFE4`, FTDI2232 0403:6010, xc7a100 idcode 0x3631093). Program: "FPGA programmed", destination volatile, 5.3 s, `MACOS_PROGRAMMED_SRAM: FPGA configured (DONE=1). Volatile SRAM configuration...`. Backend: native openFPGALoader 1.1.1 from the Toolchain 1.1 Nexys tree, `openFPGALoader --board <profile> --ftdi-serial 210292BCFFE4 --write-sram --force-terminal-mode hardware.bit` (flash flags are refused in code). Detect again: one board. Bitstream sha256 `e5077f06...abec`. Physical (reported by the tester): SW0 up blinks LED0 about every 0.7 s, SW0 down turns it off, BTNC restarts/holds it.

## 7. DE10-Lite install and Quartus
DE10 support installed from the RC archive (hash-verified, Toolchain 1.1 units, Lima 2.2.1 engine VM). The installed `openfpgaloader` unit has no `share/` directory. Quartus was installed through the supported flow: "Altera's files found" (hash-verified first), the installer's own licence text shown in the real webview (sha256 `0b1173f8...62ab`), explicit acceptance by the tester, then install: Quartus Prime Lite 25.1std.0 Build 1129 with MAX 10 support, device 10M50DAF484C7G (recorded in `quartus.json`). No developer Quartus was used.

## 8. DE10-Lite workflow
New Project, Check passed, Simulate passed (1320 ns), RTL ready; Check/Simulate/RTL left the engine Stopped. Build through Lima and Quartus passed: cold 35.6 s, warm 27.3 s (28 LEs, 26 registers, Timing PASS 311.53 MHz, `top.svf` 1.7 MB). Verify Environment: every step OK including "FPGA engine and Quartus"; Restart FPGA Engine OK.

## 9. Physical DE10-Lite Program: PASS
Detect: one board (`DE10-Lite 91d28408`, USB-Blaster). Program: "FPGA programmed", volatile SRAM, 3.9 s (`PROGRAMMED_SRAM`), `top.svf` sha256 `3b2c8ebc...f6781a`, equal to the build record. Detect again: one board. Physical (reported by the tester): SW0 up blinks LEDR0 about every 0.7 s, SW0 down turns it off, KEY0 held restarts it. SRAM/JTAG only; the missing bridge-bitstream folder caused no problem.

## 10. Modified-toolchain behaviour in the real extension
- **DE10-Lite** (changed `openfpgaloader/lib/libftdi1.2.5.0.dylib`, not deleted): Setup page headline "Ready (modified toolchain)", board "Installed (modified)", VHDL Tools and Programmer "Modified" with the text "This toolchain has been modified and is no longer the verified MIX-FPGA configuration. You can continue using it, or choose Repair to restore the supported version."; New Project created the project and showed that text as a non-blocking note; Verify reported the three modified parts, ok:true, modified:true, file unchanged; declining the Repair dialog left the file unchanged (sha256 equal); explicit Repair restored `fd8cc846...` and the page returned to Ready; removing `yosys/libexec/yosys` showed "Needs repair" (not modified), Verify failed, Repair restored it.
- **Nexys A7** (changed `libreadline.8.2.dylib`, shipped `be7552f0...`): New Project continued; Verify reported "modified", ok:true; declining Repair changed nothing; Repair restored the hash; removing `ghdl/bin/ghdl` made Verify fail (not modified) and Repair restored it. See issue 1 for the Setup page.
- Earlier (Phase 5E, real final payloads): 25/25 checks.

## 11. Combinations, upgrade, failure paths
- Nexys-only (fresh), then add DE10 second (both installed, project creation for both): pass. DE10-only (separate HOME, Quartus installed): pass (the tester accepted that licence by mistake; the root is disposable and the accepted install served as the DE10-only run).
- NexysVHDL upgrade: with a Toolchain 1.0 Nexys store at `~/Library/NexysVHDL` (tree `f0402218...`), the RC shows Nexys "Not installed", installs 1.1 from the support file, and leaves the 1.0 store byte-identical; the 1.0 tools are not reused (documented in INSTALL and CHANGELOG). A project created before works with 1.1 after the install. A board already valid under 1.1 is never reinstalled (Setup reports Installed and asks nothing).
- Failure paths (nothing installed in any case, no installer ran before its hashes validated): Nexys picker cancelled, wrong archive (DE10 file), corrupted archive (one byte): generic "A part of the setup did not finish. Choose Repair..." and no 1.1 folder; DE10 picker cancelled / wrong archive / corrupted archive: specific plain messages and no toolchain or VM; Altera MAX 10 package with one byte changed and installer/package swapped: "The file you chose is not the one Setup needs. Download it again from Altera.", no `quartus.json`; Altera licence declined (Cancel on the real page): "Quartus was not installed because the licence was not accepted.", `quartus.json` records only that the licence was offered; Nexys install killed (SIGKILL) at 5,751 files: nothing visible installed, the next Install completed and the tree hash equals `0d0035d3...`; damaged and changed installed files: Verify/Repair as in section 10.

## 13. Automated suite (release source)
`npm test`: 1152 tests, 257 suites, 1141 pass, 0 fail, 11 skipped (all Toolchain 1.1 and modified-toolchain tests pass).

## 14. Restoration
Apio and `~/.apio` restored; all test VMs stopped (including the leftover Phase 5E one); disposable roots (`MFU5F-1/2/F/U`, the Phase 5E isolated root) removed; RC artifacts re-verified unchanged; reference `~/Library/MIX-FPGA` untouched. `caffeinate` was used to keep the display awake and stopped.

## 12. Non-blocking issues
1. **Nexys Setup page does not show "modified" or a missing tool**: its quick check only reads the install marker (hashing 2.7 GB on every page open was deliberately avoided). Verify and Repair see both (modified: ok with warning; missing: fails). DE10 shows both on the page.
2. **Orphan staging after a hard kill**: a SIGKILLed Nexys install left `toolchains/.staging/<id>` (462 MB) that later installs do not remove.
3. **Nexys archive errors are generic** (cancel, wrong file, corrupt) while the DE10 ones are specific.
4. **Two boards plugged in at once**: the Nexys cable (FTDI 0403:6010) is listed as a DE10-Lite candidate, and Program stops with "which board?" (safe, nothing programmed); unplugging the other board resolves it.
5. Two verified Altera copies (2.2 GB) stay in `staging/installers` after a declined licence (known since Phase 5A).
6. Harness notes: VS Code 1.143.1 gives each extension its own API object, so the acceptance suite now answers dialogs on the extension's object (`tests/integration/phase4b-suite.ts`, not shipped); the VSIX is not byte-reproducible; the app/DMG launcher is outside this set; Windows needs `requirement-1.0.json` (Phase 5E note).
