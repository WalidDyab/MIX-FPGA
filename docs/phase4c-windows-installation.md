# Phase 4C — Windows student installation, board support and upgrade (MIX-FPGA 0.7.0)

Branch `phase4/student-installation`, continued from `7a389b5` ("Phase 4B: add multi-board installation and upgrade flow"). Nothing is committed or pushed in this phase.
Status: non-hardware work complete and validated in isolated roots and a private VS Code profile; **Nexys A7 and DE10-Lite physical acceptance PASSED (user-confirmed)**; fresh-machine items below are open. Internal payloads are not for public distribution while the legal questions L1, L3 and L9 are open.

## 1. Windows baseline (Checkpoint A)
`npm test` on Windows at `7a389b5`: 1090 tests, 1050 pass, **37 fail**, 3 skip. All 37 were macOS-install tests (APFS clones, POSIX mode bits and symbolic links, Lima, `/` paths) with no platform guard. They are now gated `{ skip: ONLY_MACOS }` (`tests/platform.ts`) with their assertions untouched: 1090 / 1050 / 0 / 40 skip. After this phase: **1150 tests, 1110 pass, 0 fail, 40 skip** (60 new Windows tests in `tests/windows-install/`, which also run on a clean machine).

## 2. Package boundaries on Windows
| Component | Core (VSIX, 0.5 MB) | Nexys support | DE10 support | External / system |
|---|---|---|---|---|
| Extension, Setup UI, manifests, payload pins | ✓ | | | |
| NexysVHDL Toolchain 1.0 (GHDL 6.0.0, Apio 1.6.0, oss-cad-suite/Yosys, openXC7, Verible, chip DB) — one validated bundle, 2.93 GB, 21,209 files | | ✓ | | |
| Nexys programmer (Digilent Adept `djtgcfg`) | | uses it | | Digilent / student (not redistributed) |
| MIX-FPGA GHDL 6.0.0 + Yosys 0.63+173 + support scripts + notices (0.14 GB, 493 files) | | | ✓ managed | |
| Quartus Prime Lite 25.1std Build 1129, MAX 10 package (8.82 GB) | | | | external (Altera, student's licence) |
| `quartus_pgm` | | | uses it | external (part of Quartus) |
| Altera USB-Blaster driver | | | uses it | system / vendor, never changed |
| Lima, Rosetta, Linux engine, openFPGALoader | | | **not used** | |

The proven Nexys bundle keeps its own layout and its own GHDL/Yosys; nothing is shared with the DE10 tools (about 0.15 GB duplicated) because correctness beats deduplication.

## 3. Production layout (`%LOCALAPPDATA%\MIX-FPGA`, or `$MIXFPGA_HOME` for tests and lab images)
```
support\nexys-a7\toolchains\win32-x64\1.0\   Nexys A7 support, immutable (store layout of core/toolchain/store)
state\nexys-a7\win32-x64-1.0\                  writable state of the Nexys tools (Apio home): never inside a toolchain folder
toolchains\1.0\windows-x64\{ghdl,yosys,scripts,LICENSES,THIRD_PARTY_NOTICES.txt,manifest.json}   DE10 managed tools, hash-verified
state\{install-state.json,setup.lock,board-support.json,quartus.json,quartus-license.txt,helper\}
staging\jobs\  staging\installers\  downloads\  logs\
```
Runtime tool resolution reads only this layout (no repository, no `toolchains/experimental`, no environment variable but `MIXFPGA_HOME`); tests enforce it. `part-check.tcl` (the MAX 10 / exact-part question asked of Quartus) ships as the hash-verified `scripts` unit of the DE10 toolchain.

## 4. NexysVHDL → MIX-FPGA update
* Extension id `emxplore.nexysvhdl`, `nexysvhdl.*` ids, `.nvproj`, `nexysvhdl.json`, `vscode://emxplore.nexysvhdl/…` unchanged. Compared with the 0.6.0 package: **no command, setting or view removed** (43 commands → 49; the new ones are setup/engine commands). Version 0.6.0 → 0.7.0.
* **Default: read-only reuse.** With no MIX-FPGA Nexys store, the Nexys flow runs from `%LOCALAPPDATA%\NexysVHDL` if its installed marker matches the validated content hash; extra disk 0; writable state goes to the MIX-FPGA state area. A relocated root (`MIXFPGA_HOME`) never consults NexysVHDL.
* **Optional take-over (adoption): a verified real copy.** NTFS cannot share blocks and hard links are refused (repairing the copy could reach the original). Dry run reports the size (2.93 GB, 21,209 files) and the extra disk (the whole tree, 3.2 GB peak); the real run verifies the source file by file, copies, re-verifies, marks "adopted from NexysVHDL", and publishes with one rename. NexysVHDL is only read (tests prove the tree hash unchanged). After the copy no dependence on NexysVHDL remains. Repair of a reused install takes it over (or reinstalls from the archive); it never writes the NexysVHDL folder.
* Production adoption into the real `%LOCALAPPDATA%\MIX-FPGA` has **not** been performed.

## 5. Setup
Same model as macOS (`core/install`: component states `not-installed / installing / ready / repairable / incompatible / failed`, ownership `managed / external / system`; `Verify` is a full check; `Repair` repairs only MIX-FPGA-owned parts). Rows: Board Support (Nexys A7-100T, DE10-Lite), then VHDL Tools, FPGA Engine (Quartus + MAX 10; only for DE10), Programmer, Hardware. A fresh run asks Nexys / DE10 / both; New Project for a board whose support is missing offers to install it first. The student view never shows driver names, `quartus_*` commands, PowerShell, environment variables or install paths (`TECHNICAL_TERMS_WINDOWS` test); all of it is in Details/Console.
* A board counts as chosen only through what MIX-FPGA manages: Quartus being on the computer already (the development machine, a lab image) does not make DE10-Lite "present".
* **Path-length preflight** (detection only): the longest file of each chosen board's tools must fit Windows' limit under the chosen root (`LongPathsEnabled` read with `reg query`); otherwise `PATH_TOO_LONG` before anything is installed. No registry, policy or alias change. This account's root fits with 22 characters to spare; a user name longer than about 25 characters would not on a machine without long paths.
* Existing Quartus 25.1 Build 1129 with MAX 10 (found in the default folders or through the uninstall records) is verified, never reinstalled. Another version beside it is left alone. A Quartus without the MAX 10 part is reported as not usable; MIX-FPGA does not patch someone else's installation.

## 6. Guided Quartus installation (fresh Windows student)
**Validation status, stated precisely:** (a) verification of an existing Quartus 25.1 Build 1129 was real (tools, exact part, smoke build); (b) the real elevated helper with Windows' permission prompt and the real `--mode win32 --install_lic` licence extraction were validated; (c) the unattended-install code path (`--accept_eula 1`) exists and is covered by tests, but a **full fresh Quartus installation was not performed** in Phase 4C; (d) a true no-Quartus Windows machine remains a pre-release validation item (section 10).

The student chooses `QuartusLiteSetup-25.1std.0.1129-windows.exe` and `max10-25.1std.0.1129.qdz`; size and SHA-256 are checked (name is never trusted); verified temporary copies go to `staging\installers`; the originals are never touched. Altera's Windows installer **refuses to start without administrator rights, even to show its licence**, so Windows' own permission prompt appears **once** and one small helper (`platform/windows/install/elevation.ts`) runs with those rights for the whole installation. MIX-FPGA never sees a password; Check, Simulate, Build and Program stay unelevated. The helper can do three things: ask the installer for its licence, install, quit. It re-verifies both Altera files before every run, is started through a command that first checks the helper script's own hash, ends when MIX-FPGA ends, and exits after the install.
* **Licence extraction (real probes, Phase 4C):** `--mode unattended --install_lic` writes **no** licence (installer runs 26 s, nothing written, no system change). `--mode win32 --install_lic <folder>` writes `licenses\license.txt` in **9.6 s** with no window and no system change: 57,560 bytes, raw sha256 `3cf19164…b63b`; normalised to LF 56,500 bytes sha256 `0b1173f8…c62ab`, identical to the macOS licence. Evidence: `.artifacts/logs/P4C-altera-probes/`. The installer did not exit by itself (its process tree is closed by the helper); it logged nothing.
* The student sees the vendor file unchanged with the exact words "I have reviewed and accept the Altera Quartus Prime Software License Agreement." Only then is the acceptance recorded (`state\quartus.json`: product, version, installer hash, licence hash, time) and only then does the helper receive the install request (`--mode unattended --accept_eula 1 --installdir … --disable-components …`). `--accept_eula` appears in one place in the helper, behind the recorded-acceptance check; declining or a refused permission prompt installs nothing and ends the helper.
* Verification afterwards: Build 1129, seven CLI tools including `quartus_pgm`, the exact part `10M50DAF484C7G` from Quartus' own device list, and a tiny design through `quartus_map`/`fit`/`asm`; then the copies are removed.

## 7. Programmer policy (unchanged from Phase 3)
DE10-Lite / Windows → `quartus_pgm` → `.sof` → the standard Altera driver. No openFPGALoader, WinUSB, Zadig or driver change anywhere (a source scan enforces it). Nexys A7 keeps the validated Digilent programmer.

## 8. Validation (all in `D:\MFW\*` isolated roots and private profiles; the real `%LOCALAPPDATA%\MIX-FPGA` untouched)
| Scenario | Result |
|---|---|
| Nexys only, fresh (real VS Code, scripted dialogs) | first-run board choice; 161 s; 2.93 GB / 21,209 files; DE10 gate on New Project; Check, Simulate 660 ns, RTL, Build 30.5 s (57 LUTs, 409.67 MHz); every tool from the new root |
| DE10 only, Quartus present | 60 s; 147 MB / 493 files; no Nexys files; no permission prompt; Check, Simulate 1320 ns, RTL, Build cold 76 s / warm 53.5 s (28 LE, 26 reg, 311.53 MHz, `top.sof`); Verify OK |
| Nexys → add DE10 | 85 s, only DE10 parts installed, Nexys tree untouched |
| DE10 → add Nexys | 236 s, only the Nexys archive installed |
| Nexys → DE10 → Nexys, one install, three launches | each board's constraints, Environment, results labels and tools correct; DE10 tools from `toolchains\…`, Nexys tools from `support\…`; no leakage |
| Verify / Repair | Verify (both boards, 93 s) OK; damaged `yosys` file → Verify finds it, Repair replaces only that unit (no Altera dialogs, no prompt), Verify OK; damaged Nexys tool → Setup page still opens and Repair restores the validated tree hash |
| NexysVHDL 0.6.0 → 0.7.0 (sandbox profile, private `LOCALAPPDATA` with a copy of the NexysVHDL store) | installs in place over 0.6.0; project opens; files byte-identical; Check, Simulate 280 ns, RTL pass; legacy store tree hash unchanged; tool state in the MIX-FPGA state area |
| Process watcher | no process from NexysVHDL's store, the repository or `toolchains/experimental`; Digilent `djtgcfg` and Altera `quartus_*` only where expected |

### Nexys A7-100T physical acceptance (isolated install `D:\MFW\r1`, extension 0.7.0) — PASSED
Detect: exactly one board, Digilent Nexys A7 -100T, serial `210292BCFFE4`, XC7A100T, JTAG device ID `0x13631093`; programmer `C:\Program Files (x86)\Digilent\Adept\Utilities\djtgcfg.exe` (`init -d SN:210292BCFFE4`, `prog -d SN:210292BCFFE4 -index 0 -file …\program\hardware-digilent.bit`; exit 0, "Programming succeeded", 3.9–4.1 s, `volatile`, no flash command). Existing `hardware.bit` (3,825,910 B, sha256 `369cc084…9ec2`, newer than its sources, unchanged before and after; programmed copy `86c23e2e…6e47`), no rebuild. Detect after programming: one board. Process watcher: only the isolated root's `apio.exe` and Digilent's `djtgcfg.exe`; nothing from the repository, `toolchains/experimental`, the real MIX-FPGA root or the real NexysVHDL Toolchain 1.0. Design: `led0 = count(26) AND sw0` (LD0 H17 blinks 0.67 s on/off with SW0 J15 up; BTNC N17 holds the counter at zero). **User confirmed the observed behaviour matches exactly.**

### DE10-Lite physical acceptance (isolated install `D:\MFW\r2`, extension 0.7.0) — PASSED
Detect: exactly one DE10-Lite on `USB-Blaster [USB-0]`, MAX 10 IDCODE `031050DD`; executables `C:\intelFPGA_lite\25.1std\quartus\bin64\quartus_pgm.exe` and `jtagconfig.exe` (the validated external Quartus 25.1). Program: `quartus_pgm -c "USB-Blaster [USB-0]" -m jtag -o p;top.sof@1`, SRAM only (`PROGRAMMED_SRAM`, `volatile`, 9.5 s), no flash operation, unelevated, no permission prompt, no driver change, no openFPGALoader. Existing `top.sof` (sha256 `26d57acb…142b`) equals the build record with inputs unchanged; no rebuild. Detect after programming: one board. Process watcher: nothing from the repository, `toolchains/experimental`, the real MIX-FPGA root or NexysVHDL. Design: `led0 = count(25) AND sw0` (LEDR0 A8 blinks with SW0 C10 up; KEY0 B8 holds the counter at zero). **User confirmed the observed behaviour matches exactly.**

## 9. Storage (measured)
Core 0.5 MB; Nexys A7 support 2.93 GB; DE10 managed tools 0.14 GB; Quartus 25.1 (external, installed by the student) 8.82 GB; state/logs a few KB; per-project build jobs `staging\jobs` (0.01 GB each, the previous job of a project is replaced on the next build). Peaks: Nexys archive install ≈ 3.7 GB (extraction 2.93 GB + the 0.74 GB archive kept by the course); take-over copy ≈ 3.2 GB extra; Quartus installation ≈ 2.1 GB of temporary Altera copies + 8.8 GB.
* **Automatic cleanup (done):** the extracted DE10 payload, the temporary Altera copies, the elevated helper's folder, half-finished staging folders.
* **Optional (student-triggered):** old build jobs, logs, the old NexysVHDL folder after a take-over (never deleted by MIX-FPGA), the Altera downloads.
* **Retained for Repair:** the support archives stay where the course hosts them (not in the MIX-FPGA root).

## 10. Open items
* **Pre-release clean-machine validation (required):** a Windows account with **no Quartus at all** — the `--install_lic` probe ran with Quartus 23.1 and 25.1 already installed; the real unattended install, the firewall rule and driver behaviour of Altera's installer on a clean computer, the licence page in the real VS Code on a clean computer, and MIX-FPGA's own behaviour when the user has no Digilent software.
* The permission prompt currently names "Windows PowerShell"; a signed MIX-FPGA helper would show the product. Release item.
* The elevated helper runs the Altera files from the student-writable `staging\installers` after re-verifying them; running them from an administrator-protected copy closes the small verify-then-run window. Release item.
* Native Quartus builds are slower than macOS (about 40–70 s warm versus 27 s) and vary between sessions.
* Legal L1, L3, L9; the Windows notices are DRAFT with texts MISSING for libffi, termcap and libwinpthread; source offers for GHDL and the GPL libraries.
* Signed VSIX/installer and hosting of the support payloads.
