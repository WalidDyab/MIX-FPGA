# Phase 5H: Windows classroom release of MIX-FPGA 0.7.0 (Windows x64)

Branch `phase5h/windows-classroom-release` (from the macOS release state `da79df4`). Engineering record of the Windows Toolchain 1.1, the native installer, the Fresh and Upgrade ZIPs and their validation. **Unsigned. Nothing was published, merged or uploaded. No legal clearance is claimed.** The macOS artifacts and records are untouched.

## Classification

**NOT YET CLASSIFIED AS "READY FOR DIRECT CLASSROOM DISTRIBUTION — UNSIGNED".** Three release gates are open (section 9): (A) a Windows computer with no Quartus has not been taken through the whole Altera flow, (B) a Windows computer with no Digilent software has not been taken through the whole Digilent flow, (C) the SmartScreen behaviour of the unsigned installer has not been observed. Everything else below passed. The classification is the project owner's to decide once those are closed or waived.

## 1. Artifacts

Source commit used for every artifact: **`f8020ab50345950a69ca3eb57872f73055aa9a0d`** (the working tree was clean; `RELEASE-MANIFEST.json` of the folder and of both ZIPs names it). Later commits on the branch only add this record and evidence. Built in the order: commit, VSIX (`scripts/package.mjs`), installer (`scripts/installer/build-installer-windows.mjs`, which embeds the size and SHA-256 of the VSIX and both support archives), classroom folder (`scripts/release/windows-classroom.mjs`).

`MIX-FPGA-0.7.0-Windows-x64-Classroom/` (`.artifacts/classroom-windows/`, git-ignored):

| File | Bytes | SHA-256 |
|---|---|---|
| `MIX-FPGA-0.7.0-Windows-x64-Setup.exe` | 54,784 | `06a98b485889516696155bd3f6631a956744972e0849ae3172d1ea896191143e` |
| `MIX-FPGA-0.7.0-Windows-x64-Fresh.zip` | 1,058,076,879 | `1fbca3a1fb9a882b3bf7bab72ca4d095cc5775677d122ea5684a38288bf2b912` |
| `MIX-FPGA-0.7.0-Windows-x64-Upgrade-from-NexysVHDL.zip` | 987,036,483 | `5d121537e68b0764381562ac7e8b43418643d82bd37e2fd2d5607bb8a7cc5361` |
| `nexysvhdl-0.7.0-win32-x64.vsix` | 602,312 | `bb5c77a9029b5c3a3159ccf73ee1030ee1f041fdc0e13dea65bc7cef50738c5d` |
| `nexysvhdl-toolchain-1.1-win32-x64.tar.gz` | 741,586,531 | `f118e8a1440c651073e074986a2f4ed31eb5c4fbf9a91bf89f833b5db7c1e1d8` |
| `mixfpga-de10-lite-support-1.1-windows-x64.tar.gz` | 47,950,151 | `fca00cb3e81db111fd66ae0a937374acca7c28329224301f1cfba40478725c07` |
| `MIX-FPGA-Nexys-A7-Support-1.1-Windows-x64-Sources.zip` | 244,790,559 | `468e570819cb863231c2c464d0b5282afe59fec9cb27f0f889f24feb6b9572ae` |
| `MIX-FPGA-DE10-Lite-Support-1.1-Windows-x64-Sources.zip` | 23,067,647 | `ecf62f575f72cd54414317fb3b0bd6df19603cc8a2a2d17b590c91d7d5a26476` |
| `README-FIRST.txt`, `INSTALL-FRESH-Windows.md`, `INSTALL-UPGRADE-from-NexysVHDL.md`, `THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_NOTICES-Nexys-A7-Support.md`, `THIRD_PARTY_NOTICES-DE10-Lite-Support.txt`, `LICENSE`, `SHA256SUMS`, `RELEASE-MANIFEST.json` | | in the folder |

Consistency checked after the build: `sha256sum -c SHA256SUMS` on the folder (15 files OK); both ZIPs extracted and their own `SHA256SUMS` verified (0 mismatches); the installer contains the SHA-256 of the VSIX and both archives (the builder refuses a mismatch); the archives are the pinned ones of `payloads-1.1-windows-x64.json`; the final Setup.exe from the folder installed and verified the DE10-Lite support in a fresh isolated root.

The ZIPs and the Setup.exe are wrappers and are not byte-reproducible beyond what the zip writer fixes; the support archives and source packages are.

## 2. Windows Toolchain 1.1

Derived from the validated Toolchain 1.0 (the same official upstream archives and pins) by `scripts/toolchain/assemble.mjs --recipe win32-x64-1.1`; compliance reasoning in `docs/phase5h-windows-compliance.md`.

| | Toolchain 1.0 (record) | Toolchain 1.1 |
|---|---|---|
| Nexys A7 tree | `57f0f0da…820b`, 21,208 files, 3,141,371,862 B | `4e584b73a9592b4746cab90c2cf76999b10cd5fdae018d6863c74a5c5a843a9d`, 21,145 files, 3,125,637,670 B |
| DE10-Lite | internal validation payload | `toolchain-1.1-windows-x64.json`: ghdl 86 files, yosys 362, scripts 1, licenses 25, notices 1 |

Exactly: 144 files removed (GHDL VHDL-87/93, VITAL, UPF libraries; 3 plug-in headers; 111 openFPGALoader bridge bitstreams), 81 added (licence texts), 6 modified (notices, manifest, the two regenerated GHDL indexes, the two placeholder notes). Components: GHDL 6.0.0, Apio 1.6.0, Apio definitions 2026.09.17, OSS CAD Suite 2026.09.15 (Yosys 0.63+173, Icarus 14.0), Verible 2026.09.20, openXC7 2026.09.24 with the xc7a100t chip database; drivers and graphviz are placeholders. **Reproducibility:** re-assembling gave the identical tree hash and re-packing the identical archive hash (`f118e8a1…`).

Readline on Windows: only `yosys.exe` and `vvp.exe` import `libreadline8.dll` (which imports `libtermcap-0.dll`, GPL-2.0-or-later); 571 PE images checked; no Python `readline` module on Windows; treatment and sources as in the compliance document. The `requirement.json` now has one record per platform (`darwin-arm64` unchanged, `win32-x64` new); `requirement-1.0.json` keeps both 1.0 records.

## 3. Product changes

- Windows inherits the Phase 5D behaviour: installed-but-modified state, explicit Repair, declining Repair changes nothing, missing or damaged files stay "Needs repair" (`tests/windows-install/modified.test.ts`, 10 tests).
- Support files chosen by the student (Nexys A7 and DE10-Lite) are checked against the pinned hash before anything is extracted, with student wording for wrong, damaged or cancelled files.
- The Setup page tells a student without Digilent Adept where to get it (link to Digilent's page); the DE10-Lite never mentions Digilent in its rows.
- The elevated helper (section 6).
- `MIX-FPGA-0.7.0-Windows-x64-Setup.exe` (WinForms, `asInvoker`, C# 5, built with the .NET Framework compiler): detects VS Code ≥ 1.120 and the installed extension (Fresh, Upgrade from NexysVHDL x.y.z, Repair/Reinstall), board choice (Nexys A7, DE10-Lite, Both), checks every file against built-in size and SHA-256 and `SHA256SUMS`, installs the VSIX over any NexysVHDL (no uninstall), installs the board support through the Setup code inside the installed extension, verifies every board, stops before Altera's step with a clear message, and can open MIX-FPGA Setup through the extension's own `vscode://emxplore.nexysvhdl/showenvironment` link. A log goes to `%TEMP%\MIX-FPGA-Setup.log`.

## 4. Validation on this PC (isolated roots, private VS Code profile; the real profile and `%LOCALAPPDATA%\MIX-FPGA` were never used)

Evidence files are in `docs/phase5h-evidence/`.

| Scenario | Result |
|---|---|
| Fresh Nexys A7 only (final-style installer, installed VSIX in real VS Code) | Installed, Verify OK; Environment Ready; Check; Simulate 660 ns; RTL schematic; Build 42 s: 57 LUTs, 27 FFs, 409.67 MHz, `hardware.bit` |
| Fresh DE10-Lite only (Quartus 25.1 already on this PC) | 147 MB, Verify OK; Check; Simulate 1320 ns; RTL; Build cold 67.4 s / warm 55.6 s: 28 LE, 26 reg, 311.53 MHz, `top.sof`; Verify Environment OK |
| Add the other board later (Nexys then DE10-Lite) | only the DE10-Lite parts installed; the Nexys tree hash unchanged (`add-de10-later-nexys-untouched.txt`) |
| Upgrade from a real NexysVHDL 0.6.0 baseline (0.6.0 VSIX installed by VS Code, validated Toolchain 1.0 store, project with `.nvproj` and `nexysvhdl.json`, student notes, settings) | detected as "Upgrade from 0.6.0"; 0.7.0 installed over it (0.6.0 marked obsolete by VS Code); Toolchain 1.1 installed; Verify OK; project, `.nvproj`, `nexysvhdl.json`, notes and settings byte-identical; **Toolchain 1.0 store untouched (21,208 files, `57f0f0da…`)**; the existing project opens, Check, Simulate 280 ns, RTL, Build (56 LUTs, 409.67 MHz) |
| Installer failure paths (10) against that baseline | all pass, baseline unchanged each time: VS Code missing; corrupted, wrong-archive, wrong-version (1.0 archive), truncated and missing Nexys support file; corrupted VSIX; disagreeing checksum list; install killed midway (nothing half-published, Toolchain 1.0 and settings untouched); the next run finishes and verifies |
| Modified toolchain, DE10-Lite, real extension | Verify ok with `modified: true`; file unchanged by Verify; declined Repair changes nothing; accepted Repair restores the recorded hash; a missing required file is "Needs repair" (`d1-modified-de10-ui.json`) |
| Modified toolchain, Nexys A7, real extension | PASS in 37 min 39 s (section 5): modified is ok and usable, Verify leaves the file alone, declined Repair changes nothing, accepted Repair restores the recorded hash, a missing file is "Needs repair"; also unit tests (`modified.test.ts`) |
| Physical Nexys A7-100T (SN 210292BCFFE4), through the installed extension | Detect: one board; Program with Digilent `djtgcfg` 2.6.1: succeeded, volatile SRAM, 3.8 s (4.3 s total), no flash; Detect again: one board; `hardware.bit` sha `0354b346…6230`. Process watcher: only the isolated root's `apio.exe`/`yosys.exe` and Digilent `djtgcfg.exe`. **You confirmed: SW0 up blinks LD0 (~0.67 s), SW0 down keeps it off, BTNC restarts it, nothing else reacts.** |
| Physical DE10-Lite, through the installed extension | Detect: one board; Program: `quartus_pgm`, `.sof` (`615c6efa…2ade`, equal to the build record), succeeded, volatile (`PROGRAMMED_SRAM`), 7.1 s, normal non-administrator session; Detect again: one board; nothing from openFPGALoader. **You confirmed: SW0 up blinks LEDR0, KEY0 holds it off, nothing else reacts.** |
| Quartus licence extraction with the hardened helper and Altera's real installer | one Windows prompt answered by you; `--mode win32 --install_lic` only; licence written in 44.5 s; raw SHA-256 `3cf19164…b63b` and normalised `0b1173f8…c62ab` equal the pinned values; nothing installed or accepted; the protected staging copy is removed when the helper ends (`quartus-licence-extraction-real-helper.txt`) |
| Automated suite (`npm test`) | 1,203 tests, 261 suites, **1,147 pass, 0 fail, 56 skipped**; Windows-specific folders (`windows-install`, `windows-de10`, `windows`): 140 of 140 pass. Skips: 51 macOS-only, 1 no final payloads built here, 1 no built package, 1 no assembled candidate here, 1 Altera files not present, 2 others (`automated-suite.txt`) |

## 5. Nexys modified-toolchain verification: timing (investigated)

The first real-extension Nexys "modified" runs produced no report within 25 and then 60 minutes (the extension host logged "unresponsive/responsive"), which looked like a hang. With a progress file written step by step (`NEXYS_EDH_PROGRESS`) the same scenario was run again and **completed correctly in 37 min 39 s (PASS)**:

| Step in the real extension (3 GB tree, 21,145 files) | Elapsed |
|---|---|
| Verify Environment (one library modified: reported "modified", ok, file untouched) | 5 min 45 s |
| Repair, confirmation declined (plan needs a full check; nothing changed) | 2 min 6 s |
| Repair accepted (restores the supported tree; hash equals the recorded one) | 12 min 53 s |
| Verify with a required file missing ("Needs repair", not "modified") | 1 min 56 s |
| Repair of the missing file | 14 min 14 s |

So it was **slow, not hung, not blocked by another process (nothing else heavy ran), and not a defect in the logic** (every state, message and restored hash was right). The same operations outside the extension host: plain Node 35–48 s for Verify and 267 s for Repair; Visual Studio Code's own Node (Electron as Node, which the installer's bridge uses) 129–132 s for Verify. The runtime is the difference: hashing one 742 MB file takes 3.1 s in Node (240 MB/s) and 6.4–7.7 s in Electron (96–115 MB/s), and 21,000 small files add per-file cost on top. Hashing files in parallel was tried and gave no gain in Electron (132 s against 129 s), so it was reverted; integrity checking was not weakened or changed anywhere.

Student impact: these full checks run only when the student asks (Verify, Repair, or the installer's final check), never when MIX-FPGA opens (the Setup page uses the quick check). Verify of the Nexys A7 tools takes about 2 minutes from the installer and up to about 6 minutes from the Setup page; Repair of a whole Nexys tree 13–14 minutes inside the extension. I classify this as acceptable for the classroom but a **known slowness (non-blocking)**; it should be improved later (for example by running the integrity hash in a worker process). The DE10-Lite tools (0.2 GB) take seconds.

## 6. Elevated helper (security review, Phase 5H)

Problems found and fixed in the Phase 4C helper: the script was a file in a user-writable folder (time of check to time of use between the hash check and the run); the Altera files were hashed in a user-writable folder and then run from it (swap race); a request `id` reached a file name unchecked (arbitrary file write as administrator); the licence output was a recursive delete/create inside a user-writable folder. Now: the script is passed in the elevated process's own command line (`-EncodedCommand`, no file, 17,457 characters against the 32,767 limit), with the pinned names, hashes, install folder and component list as literals and strict shape checks; the helper copies the two Altera files into a new folder under the Windows temp folder that only SYSTEM and Administrators can write (random name, ACL by SID), hashes and runs them there, and removes it before it answers `quit`; `id` must match `NNN-xxxxxx`; the control folder must not be a link; only the operations `license`, `install` and `quit` exist, `--accept_eula` appears once, after the recorded acceptance and the staged-copy hash check; it logs only operation names and exit codes. Tests: `tests/windows-install/elevation.test.ts` (15 tests, including a swap of the source file after verification, an escaping request id, malformed pins, and "the staging folder is gone before quit is answered", 34 consecutive clean runs of the file after the fix; two early failed runs could not be reproduced). Residual: a process of the same user can still forge `accepted.json` while a student's own installation session is running (it can only trigger the installation of the pinned, verified Altera installer); the prompt names "Windows PowerShell" until a signed helper exists (future signing work, not a blocker by itself).

## 7. Digilent runtime (Nexys A7), fresh machine

Digilent's software is proprietary and not redistributable. The supported path is documented and surfaced: the Setup page shows *Programmer — Not installed* with Digilent's own page (`https://digilent.com/reference/software/adept/start`) and a link; building and everything except Program work without it; Program reports `djtgcfg.exe not found. Install Digilent Adept Runtime (2.30 or newer) and Adept Utilities`. MIX-FPGA never installs, replaces or changes a USB driver. Verified here only on a PC that already has Digilent Adept (Runtime 2.30.4, Utilities 2.7.1): detection, Detect, Program, and by unit tests the missing-Digilent path (`setup.test.ts`, "without Digilent Adept …"). Digilent's download page is behind a bot check, so the installers could not be fetched for a no-Digilent test.

## 8. Windows SmartScreen (unsigned)

`README-FIRST.txt` and both guides tell the student: if a blue "Windows protected your PC" window appears, choose **More info**, check the name and that the file came from the instructor (compare `Get-FileHash` with `SHA256SUMS`), then **Run anyway**; "Unblock" in the file's Properties if present. They say not to turn SmartScreen or Defender off; the installer and MIX-FPGA change no security setting. **Not observed here:** files created on this PC carry no internet marker.

## 9. Open release gates (not resolved)

- **A. Fresh no-Quartus Windows:** vendor-file verification, licence display, explicit acceptance, the elevated unattended install with the MAX 10 package, the USB-Blaster driver outcome, return to non-administrator operation, and DE10-Lite Build/Program on that computer were **not** tested end to end. A virtual machine for this was started and then stopped and deleted at the owner's request. Covered only in parts: licence extraction with the real installer and the hardened helper (section 4), the unattended-install code path and the acceptance gate by tests with a fake installer, the Quartus "already installed" path with the real Quartus 25.1.
- **B. Fresh no-Digilent Windows:** see section 7.
- **C. SmartScreen:** see section 8.
- Not blocking by themselves: native Quartus builds take about 40–70 s; Nexys full Verify/Repair are slow inside the extension (section 5); the installer must be run from the folder that holds the release files; the helper prompt names Windows PowerShell; the legal conclusions are technical findings only (`docs/phase5h-windows-compliance.md`); no signing was started.
