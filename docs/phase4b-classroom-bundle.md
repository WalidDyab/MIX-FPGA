# Phase 4B — Self-contained classroom distribution (Windows and macOS)

Date: 2026-10-02
Windows: branch `phase4/classroom-bundle`, from `main` at `2d4d446` (Phase 4A), merged as `b1ecb1d`. Host: Windows 11 Home 10.0.26200 x64, Node 24.13.0, VS Code 1.140.0.
macOS: branch `phase4/classroom-bundle-macos`, from `main` at `b1ecb1d`. Not committed; for review. Host: macOS 27.0 (26A428), Apple M4 (arm64), Node 24.21.0, VS Code 1.140.0. See §17.

**Status.** The three readiness areas are independent; one does not imply another.

| Readiness area | Windows status | Meaning |
|---|---|---|
| **Software/runtime** | **READY** | Packages are built: VSIX 0.5.0 plus the separately versioned Toolchain 1.0.<br>Installed-package validation passed on standard paths **and** on hostile paths (spaces, accented Latin, CJK in the profile, toolchain store and project folders), §10 and §16.<br>Tools come only from the bundle, and external tools stay untouched (process trace + snapshots).<br>A UI-only update reuses Toolchain 1.0. Results show data-sheet capacities. |
| **Redistribution/license** | **NOT READY** | Open items, §7:<br>- the GPL/LGPL corresponding-source mechanism;<br>- the Graphviz EPL version;<br>- provenance of `serial_install.exe` in the drivers package.<br>(NexysVHDL's own license: **resolved**, Apache-2.0, §17.15.)<br>Do not distribute outside a controlled pilot until these are resolved. |
| **Physical Program** | **DEFERRED** | No board was connected. Detection through the installed package works; the djtgcfg backend was physically validated in Phases 3B/3C. |

| Readiness area | macOS (darwin-arm64) status | Meaning |
|---|---|---|
| **Software/runtime** | **READY** | VSIX 0.5.0 plus Toolchain 1.0 for darwin-arm64, built from official archives (deterministic content hash `f0402218…`).<br>Installed-package validation passed with standard and hostile (space, accented Latin, CJK) profile/project paths **and a hostile HOME** (§17.14), a hostile environment and decoy tools; every FPGA executable came from `~/Library/NexysVHDL/toolchains/darwin-arm64/1.0/`; `~/.apio` and the other installations stayed unchanged; UI-only update reused Toolchain 1.0. Needs **no** Homebrew, Python, Xcode Command Line Tools or USB driver (§17). |
| **Redistribution/license** | **NOT READY** | NexysVHDL's own license is resolved (Apache-2.0, §17.15). Still open: the GPL/LGPL corresponding-source mechanism (shared) and the Mac-specific notices/obligations (§17.10). |
| **Physical Program** | **DEFERRED** | No board was connected. Detection through the packaged extension and the bundled openFPGALoader works; the same openFPGALoader 1.1.1 build was physically validated on this Mac in Phase 3B. |

## 1. Goals and non-goals

Goal: students install VS Code, NexysVHDL and its FPGA toolchain, plus the official Digilent support on Windows if it is missing for programming. They install no GHDL, Apio, Yosys, nextpnr, openXC7, Python, Node or Git, and need no repository.

Non-goals (unchanged): graphical XDC/pin editor, external-toolchain mode, PATH or system-tool fallback, Verilog, other boards, waveform/RTL redesign, Marketplace, auto-update, telemetry, accounts. Raw XDC stays the classroom workflow.

## 2. Architecture: two separately versioned artifacts (ADR-007)

```
nexysvhdl-0.5.0-win32-x64.vsix               extension only, 228 KiB, 124 files
        │ requires (toolchains/bundle/requirement.json: version + content hash per platform)
        ▼
nexysvhdl-toolchain-1.0-win32-x64.tar.gz     toolchain 1.0, 725 MiB; installed once per user
        │ Install FPGA Toolchain…  (extract → verify content hash → publish with one rename)
        ▼
%LOCALAPPDATA%\NexysVHDL\
  toolchains\win32-x64\1.0\                  immutable (21,465 files, 3.0 GB) + .nexysvhdl-installed.json
  state\win32-x64-1.0\apio-home\             Apio's writable state (only cached-remote-config.json)
```

- **Version independence** (the clarification received during this phase):
  - extension 0.5.x requires toolchain 1.0;
  - a UI-only update (0.5.0 → 0.5.1) reuses the installed 1.0 with no copy or download (validated, §10.4);
  - toolchain 1.1 would install beside 1.0;
  - an installed version is never modified, and a conflicting folder of the same version is refused.
- **Data root:**
  - Windows `%LOCALAPPDATA%\NexysVHDL`: Local, not Roaming, so a 3 GB toolchain never travels with a roaming classroom profile; shared by every VS Code flavour and profile.
  - macOS `~/Library/NexysVHDL`: not "Application Support", because Apio refuses paths with spaces.
- **The classroom distribution** `NexysVHDL-0.5.0-win32-x64.zip` (690 MiB) contains the VSIX, the toolchain archive, `INSTALL.md`, `THIRD_PARTY_NOTICES.md` and `SHA256SUMS.txt`. The two parts ship together but have separate lifecycles.

### Code structure

| Layer | New / changed |
|---|---|
| `core/toolchain/bundle.ts` | `BundleManifest`, `loadBundledToolchain()` (manifest, platform/arch, executables inside the bundle, Apio package consistency, Apio path rules), `BundledToolLocator`, `BundledToolRunner`, `bundleEnvironment()`, `bundleCompatibilityManifest()`, `inspectBundledTools()` |
| `core/toolchain/store.ts` | per-user store: `installedToolchain()`, `installToolchainArchive()` (staging, hash check, atomic publish, never overwrite), `verifyInstalledToolchain()` |
| `core/toolchain/tar.ts` | deterministic tar.gz writer; safe streaming reader (regular files/dirs only, no links, no `..`/absolute/drive paths, checksums, pax long names); `treeHash()` |
| `platform/` | registry host facts (`userDataRoot`, `systemPath`); `PlatformContext.classroom`; Windows: bundled locator + `DigilentSystemLocator` (Program Files only), `programmerSetup`; macOS: bundled-only adapter (locator restricted to bundle paths, bundled openFPGALoader) |
| `runtime/context.ts` | `ContextOverrides.classroom`: resolves the installed toolchain, wraps the runner, never adds `ConfiguredToolLocator`/discovery; compatibility against the bundle's own versions |
| `runtime/classroom.ts`, `environment.ts` | requirement loading, install/verify, tool labels; classroom inspection (bundled tools + platform programmer) |
| `extension/` | classroom mode at activation; Install FPGA Toolchain…, Verify FPGA Toolchain, Getting Started, Third-Party Notices; setup model (`SetupRow`, `boardRow`); new Show Environment; welcome views; walkthrough |

The extension never constructs paths to tools and never branches on the platform. `tests/extension/architecture.test.ts` still enforces this, and the student labels "Digilent USB/JTAG Support" and tool names come from platform/runtime data. The developer CLI keeps Phase 3 discovery; it is not shipped.

## 3. Bundled-only policy and isolation

In classroom mode:
- GHDL and Apio come only from `<data root>\toolchains\<target>\<version>`.
- On Windows the programmer comes only from the official Digilent folders (`Program Files (x86)\Digilent\AdeptUtilities`, `Program Files\...`).
- There is no PATH search, and `NEXYSVHDL_*` and project `toolchain.tools` are ignored.
- A missing toolchain means "Not Installed": nothing is "found elsewhere".

Every tool process gets:

| Variable | Value |
|---|---|
| `APIO_HOME` | `<data root>\state\win32-x64-1.0\apio-home` |
| `APIO_PACKAGES` | `<toolchain>\apio\packages` (Apio requires "packages" in the path) |
| `APIO_REMOTE_CONFIG_URL` | `file://<toolchain>/apio/remote-config/apio-{major}.{minor}.x.jsonc` (every package pinned to the installed version) |
| `PATH` | `<toolchain>\shims;%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem` |
| `PYTHONDONTWRITEBYTECODE` | `1` |
| removed | any inherited `PATH`/`Path`, `APIO_*`, `PYTHON*` |

These are Apio's documented options (`apio/utils/env_options.py` at the validated commit `9fbb279c`); nothing undocumented is used.

**Why it holds:**
- Apio "fixes" packages whose version differs from its remote config: it deletes them, deletes unknown entries and downloads replacements.
- The loader verifies on every start that `installed_packages.json`, the pinned config and the manifest agree exactly and that the packages folder has no unknown entries. Otherwise Apio is disabled (`BUNDLE_APIO_INCONSISTENT`), so Apio never sees anything to repair.
- With a `file://` config and every package present, Apio makes no network access.

### Findings that shaped this

1. **The validated Windows build used the developer's system Python.** openXC7's `fasm2frames.cmd`/`bit2fasm.cmd`/`xc7pll.cmd` run a bare `python`. Apio's PATH (openxc7 bin/lib, oss-cad-suite bin/lib) contains no `python.exe`, so the command resolved to `C:\Python314\python.exe` (evidence: `cpython-314` bytecode in `~/.apio/packages/openxc7`).
   - Fix: a NexysVHDL-authored `shims\python.cmd` runs the CPython **3.11.6** that ships inside the official oss-cad-suite package.
   - Proof: with a sanitized PATH, `fasm2frames` on the same `hardware.fasm` produced a byte-identical `hardware.frames` (SHA-256 `0c4e6307…a6d532`) to the validated 3.14.3 run.
2. **Running the tools wrote into the packages.** The validated `~/.apio/packages` contained 80 runtime `__pycache__` files (and a regenerated gdk-pixbuf `loaders.cache` holding a user path). `PYTHONDONTWRITEBYTECODE=1` plus the immutable store prevent this. Verify Toolchain after a full workflow confirms it (§10).
3. **Apio refreshes `~/.apio/cached-remote-config.json` daily.** Phase 4A had silently rewritten it on 2026-10-02 00:32. NexysVHDL now writes only its private copy.

## 4. Toolchain 1.0 for Windows: exact versions (verified)

Versions are as validated in Phases 1–4A, each checked against the installed metadata and the official archives:

| Component | Version | Evidence |
|---|---|---|
| GHDL | 6.0.0 (mcode, UCRT64) | zip SHA-256 `76e160ce…` = Phase 1 record; 120/120 files identical to `tools/ghdl-6.0.0` |
| Apio | 1.6.0 (release 2026-09-15, commit `9fbb279c`) | `BUILD-INFO.json`; 128/128 files identical to `~/.apio/bin` |
| Apio definitions | 2026.09.17 | `installed_packages.json` |
| oss-cad-suite (Yosys 0.63+173, yosys-release-tag 2026-03-24) | 2026.09.15 | probe `apio raw -- yosys -V` |
| openXC7 | **2026-09-24**, parts-index **schema 5** | `BUILD-INFO.json`, `XILINX-PARTS-INDEX.json` |
| nextpnr-xilinx | **0eae9fb** (`0eae9fbb19dfb83cdd30d5048d8b0ba744180ad0`) | openxc7 BUILD-INFO; probe |
| chipdb xc7a100tcsg324 | 2026-09-24 | asset SHA-256 `bc74f32f…` and chipdb SHA-256 `2dcf4be7…` match the parts index |
| drivers / graphviz / verible | 2026.09.15 / 2026.09.15 / 2026.09.20 | required by Apio's package check; not used by NexysVHDL |
| Programmer (system, not bundled) | Adept Utilities 2.7.1 (djtgcfg 2.6.1), Adept Runtime 2.30.4 | detected |

The summary in the task brief matched; no correction was needed.

**Provenance.** The toolchain is assembled only from the official release archives in `toolchains/bundle/win32-x64.json`. Each URL is GitHub `ghdl/ghdl` or `fpgawars/*`, and each archive is checked by size and SHA-256. A full file-by-file comparison with the validated installation (`scripts/toolchain/compare.mjs`) found **21,195 identical package files**. The only differences:
- `installed_packages.json`: timestamps;
- 80 `__pycache__` files present only in the validated install (runtime-generated);
- one regenerated `loaders.cache`;
- one rewritten `_distutils_hack` `.pyc`.

Assembly is deterministic: two independent assemblies gave the same content hash.

## 5. Toolchain manifest

`toolchain/win32-x64/toolchain-manifest.json` is generated by `scripts/toolchain/assemble.mjs` and ships in the archive. It records:
- `bundleVersion` 1.0, platform/arch, `displayPlatform`;
- the versions table;
- the executables (relative path + SHA-256);
- the Apio version, platform id, packages folder, pinned remote config and per-package versions;
- the environment policy and the shims;
- the programmer (system, not bundled, validated versions, install guide);
- per component: version, license, license evidence, source link, archive URL + SHA-256, file count, bytes and content tree hash;
- the recipe SHA-256.

`toolchains/bundle/requirement.json` (in the VSIX) holds:
- `bundleVersion` 1.0;
- win32-x64 validated, content tree hash `43b3fb80d30f7f87a61364ce636a57da1dcfd44ee07033746ca5854f133eaef9`, 21,465 files, 3,170,712,308 bytes;
- darwin-arm64 pending.

The tree hash covers sorted `path\0size\0sha256` lines, independent of timestamps.

## 6. Build and packaging commands

```sh
npm run toolchain:assemble -- --target win32-x64 [--download]   # verified official archives -> toolchain/win32-x64/
npm run toolchain:pack -- --target win32-x64 --update-requirement
npm run package:win                                             # VSIX + distribution folder + zip
npm run toolchain:install                                       # developers/lab admins: same installer as the extension
npm run package:mac                                             # Mac step
```

`package:win` fails on any of:
- a requirement/archive/assembled-toolchain mismatch;
- missing notices or license texts;
- a typecheck/build failure;
- any of the 23 required runtime resources missing;
- excluded content in the VSIX (TS sources, maps, tests, CLI, toolchain, archives, scratch, `.nexysvhdl`, VCD/GHW/bit);
- a privacy finding.

`pack` refuses to change the content of an already-released toolchain version.

## 7. License audit

| Component | Declared license | Notes / obligation |
|---|---|---|
| GHDL 6.0.0 | GPL-2.0-or-later; libgnat GPL-3.0 + GCC Runtime Library Exception; libgcc (exception); libwinpthread (MIT/BSD-style); zlib | Binary zip has **no license file**: GHDL's COPYING and the exception/zlib texts are shipped in `licenses/` |
| Apio 1.6.0 | GPL-2.0 (LICENSE in bundle); Python 3.14 PSF; package licenses in `_internal/*.dist-info` | GPL source offer |
| oss-cad-suite | per-tool `license/LICENSE.*` (47), Yosys ISC, includes GPL tools (Icarus, GTKWave, …) and Python 3.11 | GPL source offer for each GPL tool |
| openXC7 / nextpnr-xilinx / prjxray / prjxray-db | ISC / ISC / CC0-1.0; Python PSF | texts shipped in `licenses/` |
| drivers | Zadig GPL-3.0, libwdi LGPL-3.0, libusb/libftdi LGPL-2.1/GPL-2.0 | no license files in the package (texts shipped); `serial_install.exe` provenance to confirm with FPGAwars |
| graphviz | EPL (upstream is EPL-2.0 today) | exact version for this build **to confirm** |
| verible | Apache-2.0 | text shipped |

`THIRD_PARTY_NOTICES.md` exists at the repository/VSIX root (summary) and in the toolchain (per component, with license text locations, source links and archive hashes). NexysVHDL's own extension contains no third-party code.

**Open obligation (blocking redistribution, not classroom testing).** The toolchain redistributes GPL/LGPL binaries. For GPLv2 §3, linking to upstream source is generally not enough on its own: the corresponding source must accompany the binaries or be offered through a written offer. NexysVHDL's own license is now **Apache-2.0** (`LICENSE`, `NOTICE`, `package.json`; §17.15); it covers NexysVHDL's own code only, never the redistributed toolchain components.

**Recommendation:** publish a "corresponding source" archive per toolchain version (the upstream source tarballs at the exact tags/commits listed in the manifest) next to each classroom download, and have the license position reviewed. Until then, **do not call the artifact ready for redistribution.**

**Digilent:** no Digilent software is bundled, mirrored or downloaded. The recipe test also asserts this.

## 8. Digilent (Windows)

- Detection reuses the Phase 3 Adept code (`inspectAdept`, `DigilentProgrammer`), restricted to the official install folders.
- **Present:** `djtgcfg 2.6.1 (Adept Utilities 2.7.1), Adept Runtime 2.30.4` → "Digilent USB/JTAG Support — Ready".
- **Missing:** "Setup Required", with the official guide <https://digilent.com/reference/software/adept/start>.
- A missing board is "Board — Not Connected", never "programmer missing" (`boardRow`).
- Nothing is installed, changed or downloaded. The driver store was identical before and after validation.

## 9. Student experience

- **Empty workspace:**
  - Project view welcome: Create NexysVHDL Project · Open NexysVHDL Project · Getting Started · Show Environment;
  - if the toolchain is missing: Install FPGA Toolchain…;
  - Explorer welcome on an empty window;
  - one notification on first activation when the toolchain is missing.
- **Show Environment** (native QuickPick):
  - rows: Extension Ready (version), Bundled FPGA Toolchain Ready — 1.0 (Windows x64), Digilent USB/JTAG Support Ready/Setup Required, Board Connected/Not Connected;
  - a Status line;
  - tool versions;
  - actions: install toolchain / Digilent guide / Verify Toolchain / Getting Started / Third-Party Notices / engineering details (paths, hashes, Apio environment) in the log.
- **Getting Started walkthrough** (native, 10 steps): setup, project, edit VHDL, edit XDC, Check, Simulate, Waveform, RTL, Build, Connect and Program.
- **Docs:** `docs/student-install-windows.md`, `docs/student-install-macos.md` (marked pending), `docs/student-quick-start.md` (raw XDC as in Vivado, port-name matching, reuse of course/master XDC), `CHANGELOG.md`.
- **Starter project:** unchanged from Phase 4A (VHDL-2008, raw XDC, self-checking testbench); validated below.

## 10. Installed-package validation

Driver: `tests/integration/run-installed.ts`, suite `tests/integration/installed-suite.ts`.

**Setup:**
- Private `--user-data-dir` and `--extensions-dir` and a private `LOCALAPPDATA`, all in `%TEMP%\nxv`, outside the repository.
- NexysVHDL installed with `code --install-extension <vsix>`.
- PATH reduced to `System32;Windows;Wbem;<VS Code>`.
- Hostile environment: `APIO_HOME=%USERPROFILE%\.apio`, `PYTHONPATH=C:\Python314\Lib`, `NEXYSVHDL_GHDL=C:\does-not-exist\ghdl.exe`.
- NexysVHDL is **not** loaded with `--extensionDevelopmentPath`. The test entry point runs in a separate, empty "validation harness" extension, which VS Code requires for `--extensionTestsPath`.
- Helper modules are loaded from the installed extension.
- Commands are driven through their own handlers. `installToolchain` and `createProject` accept an optional scripted argument (archive path / `{parentDir, name}`), because a dialog of another extension cannot be stubbed; the interactive dialogs were exercised in the Phase 4A EDH.

### 10.1 Setup phase (empty window)

- Before installation: "Setup required — Install the FPGA toolchain…"; toolchain *Not Installed*; Digilent *Ready*.
- Getting Started opened (Welcome tab).
- **Install FPGA Toolchain** from the distribution archive: `installed` 1.0 in **135 s** (52.6 s from the command-line script). A second install returned `already-installed`.
- After: *Ready — Ready for design, build and programming*.
- Tools: GHDL 6.0.0, Apio 1.6.0, openXC7 2026-09-24, Yosys 0.63+173, nextpnr-xilinx 0eae9fb, all `compatible`, all with paths in `…\NexysVHDL\toolchains\win32-x64\1.0\`; programmer 2.7.1 from Program Files.
- Create Project (scripted) made `StudentDemo/` outside the repository with the standard tree; a duplicate was refused (`ALREADY_EXISTS`).

### 10.2 Project phase (the created project)

| Item | Result |
|---|---|
| Activation on open / project detection | yes / StudentDemo, top `top`, no validation problems |
| Project Files | `src/top.vhd TOP`, `sim/top_tb.vhd`, `constraints/nexys-a7-100t.xdc IN USE`; new file appeared via watcher |
| Design Hierarchy (automatic / manual refresh) | `top → u_blink : blink_counter` after save; same after Refresh; click opens line 28 |
| Set Top | `blink_counter` written and restored |
| Check / Problems | passed (top, top_tb); removed `;` → 2 errors at 32:26 in Problems; cleared after fix |
| Simulate | passed, `ALL TESTS PASSED (33 checks)` @ 660 ns |
| Waveform | 14 signals; cursor 95 ns `count[3:0]=8`/`1000`; zoom/pan/fit; reload on re-simulation (new sha256) |
| Design Schematic | `u_blink : blink_counter`, nets clk, btnc→reset, blink |
| RTL Schematic | AND(`u_blink`, `sw0`) → `led0` linked to `src/top.vhd:32:19`; counter `+` / MUX / Register (27 bits) |
| Build stages (live) | `running/idle/idle → passed/running/idle → passed/passed/running` → all passed |
| Results | **57 LUT, 27 FF**, 7 CARRY4, BRAM 0, DSP 0, 4 I/O, 1 BUFG; timing **PASS 409.67 MHz** (target 100), slack +7.559 ns; bitstream 3,825,910 B; constraints from the XDC file |
| Hardware view | detection ran (official djtgcfg): no board connected |
| VHDL highlighting | `.vhd` → `vhdl`, NexysVHDL grammar scopes (91/157, 101/173, 231/415 tokens) |
| Project root afterwards | only student files + `.nexysvhdl/` |
| Verify Toolchain after the workflow | **ok, 21,465 files unchanged** |

The Phase 4A numbers are reproduced exactly.

### 10.3 Proof that binaries came from the installed toolchain

- **External process watcher** (`scripts/validation/watch-processes.ps1`, Win32_Process every 200 ms). Every FPGA tool executable ran from `…\Temp\nxv\LocalAppData\NexysVHDL\toolchains\win32-x64\1.0\`:
  - `ghdl\bin\ghdl.exe` and `apio\bin\apio.exe`;
  - `apio\packages\oss-cad-suite\bin\yosys.exe`;
  - `apio\packages\openxc7\bin\nextpnr-xilinx.exe` (`--chipdb …\1.0\apio\packages\openxc7\chipdb\xc7a100tcsg324.bin`);
  - `…\openxc7\bin\xc7frames2bit.exe`;
  - `…\oss-cad-suite\lib\python3.exe` (started as `shims\..\apio\packages\oss-cad-suite\lib\python3.exe` for fasm2frames).

  The only other one was `C:\Program Files (x86)\Digilent\AdeptUtilities\djtgcfg.exe enum`. `C:\Python314` never ran. One short-lived process had no readable path (watcher limitation).
- **Environment report:** every tool path and method is `NexysVHDL bundled toolchain`.
- **Module trace:** 102 NexysVHDL modules were loaded, all from the installed extension folder; none from the repository; no `.ts` file.
- **Core run** (before packaging, same runtime): every runner invocation was inside the bundle, with `PATH = shims;System32;Windows;Wbem`.

### 10.4 UI-only update reuses the toolchain

- A 0.5.1 VSIX (same content, new version) was installed over 0.5.0. VS Code loaded `emxplore.nexysvhdl-0.5.1` and removed the 0.5.0 folder.
- Toolchain *Ready* immediately, at the same folder `…\toolchains\win32-x64\1.0`.
- The install marker is unchanged in content (SHA-256 `f842d8b3…`) and timestamp (installed 08:35:46Z). Nothing was copied or downloaded.

### 10.5 External tools untouched

`scripts/validation/snapshot.mjs`: path, size, mtime and SHA-256 of every file, taken before and after all phases.

| Location | Result |
|---|---|
| `%USERPROFILE%\.apio` (21,424 files) — although `APIO_HOME` pointed there | **unchanged** (content and timestamps) |
| `Program Files (x86)\Digilent` (47), `Program Files\Digilent` (1), `System32\dmgr.dll`, `djtg.dll`, `dpcomm.dll` | unchanged |
| `tools/ghdl-6.0.0` (120) | unchanged |
| real `%LOCALAPPDATA%\NexysVHDL` | never created |
| driver store (`pnputil /enum-drivers`, incl. Digilent FTDI 2.12.36.4) | unchanged |

Apio's private state after everything: only `apio-home\cached-remote-config.json` (1,940 B).

### 10.6 Repository independence

Everything below loaded from `%TEMP%\nxv\extensions\emxplore.nexysvhdl-0.5.x\`:
- runtime JavaScript;
- the grammar (`resources\vhdl\vhdl.tmLanguage.json`);
- board data (`boards/`, through `packageRoot()` of the installed `dist/`);
- templates (compiled `dist/extension/project/templates.js`);
- the toolchain requirement.

FPGA executables loaded from the per-user store. The repository was not renamed.

## 11. Sizes

| Item | Size |
|---|---|
| VSIX | **228 KiB** (124 files) |
| Installed extension | **0.88 MB** |
| Toolchain archive | **725.0 MiB** (760,207,001 B, SHA-256 `423c1a37…cc96b31`) |
| Installed toolchain | **3.0 GB** (3,170,712,308 B, 21,465 files) |
| Classroom zip | 689.6 MiB |

Largest parts of the installed toolchain:

| Part | Size | Biggest contents |
|---|---|---|
| oss-cad-suite | 1,923 MiB | bin 960 (nextpnr-ice40/ecp5/machxo2/nexus, z3, cvc4/5, surfer, …); lib 521 (Python 3.11 257); share 468 |
| openXC7 | 797 MiB | prjxray-db zynq7 259, artix7 187, spartan7 104; `nextpnr-xilinx.exe` 200 |
| chipdb | 152 MiB | |
| GHDL | 72 MiB | |
| Apio | 32 MiB | |
| graphviz | 20 MiB | |
| verible | 17 MiB | |
| drivers | 8 MiB | |
| definitions | 3 MiB | |

**Bloat:** none is accidental; this is the official package set Apio requires. Most of it is unused by the Nexys A7 flow (other FPGA families' nextpnr, formal solvers, other prjxray families). Apio checks only package presence and versions, so a pruned toolchain 1.1 could plausibly drop more than 2 GB. That would be a modified redistribution needing full revalidation and a fresh license review, so it was **not** done (no blind optimization).

## 12. Tests

`npm test`: **406 / 406** (342 baseline + 47 Phase 4B + 17 follow-up, §16.3); `npm run typecheck` clean.

| File | Covers |
|---|---|
| `tests/toolchain-bundle.test.ts` | Loader:<br>- absolute executables;<br>- private Apio state;<br>- PATH/APIO/PYTHON sanitization;<br>- wrong platform;<br>- missing manifest/executables;<br>- paths escaping the bundle;<br>- Apio mismatch/orphan disables Apio (never repairs);<br>- space in path keeps Check/Simulate.<br>Locator (no PATH/overrides); runner (env + one-time home creation); expected versions.<br>tar:<br>- round trip with long/non-ASCII/empty files;<br>- deterministic bytes;<br>- traversal, symlink, damaged and truncated archives refused;<br>- tree hash = build-script definition;<br>- 24 MiB streaming.<br>Store:<br>- install/verify;<br>- reuse untouched;<br>- side-by-side 1.0 + 1.1;<br>- hash mismatch;<br>- wrong platform/version/junk;<br>- no overwrite of an existing version;<br>- modification detected;<br>- pending/unsupported;<br>- requirement validation. |
| `tests/classroom.test.ts` | Composition root:<br>- bundled-only resolution ignoring `NEXYSVHDL_*`, project paths and PATH;<br>- no fallback when not installed (zero processes);<br>- unsupported host;<br>- data roots;<br>- macOS bundled adapter incl. programmer.<br>Digilent present/missing (no PATH fallback); setup summary (Digilent missing vs ready, bundled programmer, board vs programmer). |
| `tests/package.test.ts` | Identity/version/engine vs `@types/vscode`; no runtime dependencies; commands registered and linked; welcome views; walkthrough (10 steps + pages); runtime resources; scripts; `.vscodeignore` allowlist; compiled JS needs no TypeScript/npm; requirement and recipes (Windows pinned + official URLs, no Digilent, macOS draft refused); license texts; privacy scan of shipped sources. |

Unit tests run no external process and need no hardware (process trap, fake runners, fake bundles).

## 13. macOS: the plan before the Mac step (done, see §17)

Same branch, same code. On an Apple-silicon Mac:

1. **Complete `toolchains/bundle/darwin-arm64.json`** (draft; the assembler refuses it):
   - official archive URLs, sizes and SHA-256 for GHDL `ghdl-llvm-6.0.0-macos15-aarch64` (SHA-256 `69beb591…` known), Apio 1.7.0 (validated build `pyinst-darwin-arm64-2026-09-27`; find the official bundle archive), the darwin-arm64 Apio packages (definitions 2026-09-17, drivers/graphviz/oss-cad-suite 2026-09-15, verible 2026-09-20, openxc7 **2026-09-25**, parts-index schema 7) and the chipdb asset 20260925;
   - `installedAt`, licenses;
   - compare with `~/.apio/packages` and `tools/ghdl` (`scripts/toolchain/compare.mjs`); set `status: validated`.
2. **Python for openXC7's scripts:** find what `fasm2frames` runs on macOS (a clean Mac's `/usr/bin/python3` is only the Command Line Tools stub). Add a shim to a bundled interpreter if needed, and prove a byte-identical `hardware.frames`.
3. `npm run toolchain:assemble -- --target darwin-arm64 --download`, `npm run toolchain:pack -- --target darwin-arm64 --update-requirement`, `npm run package:mac`.
4. Installed-package validation with a private profile and `HOME`-relative data root (adapt `run-installed.ts`: it is Windows-specific today). Check:
   - no Homebrew/PATH tools (process trace);
   - snapshot `~/.apio` before/after;
   - Check, RTL, Simulate, Waveform, Build, Hardware, and Program if a board is available;
   - Verify Toolchain after the workflow.
5. Confirm the Mac bundled adapter paths:
   - openFPGALoader from `apio/packages/oss-cad-suite/bin/openFPGALoader`;
   - architecture check;
   - `~/Library/NexysVHDL` writable;
   - Gatekeeper/quarantine behaviour of extracted binaries (the installer extracts with Node, so no quarantine attribute is expected; verify).
6. Update `docs/student-install-macos.md` from "pending".

## 14. Known limitations and concerns

1. **Redistribution not cleared** (§7): GPL/LGPL corresponding-source step, graphviz license version, drivers `serial_install.exe` provenance. (NexysVHDL's own license: resolved, Apache-2.0.)
2. ~~User folders with spaces or non-ASCII characters~~: **fixed** (§16.1). The remaining limits:
   - a VHDL *file name* GHDL cannot record (e.g. CJK) gets a clear Check error;
   - on a machine that forbids creating `%ProgramData%\NexysVHDL\links`, an affected account gets `BUNDLE_PATH_ALIAS_FAILED` (Check and Simulate still work).
3. **Two-step install:** VSIX, then Install FPGA Toolchain… from the downloaded archive (135 s in the extension host). There is no download URL (no hosting decided).
4. **The toolchain stays on disk after uninstall** (documented). There is no "remove unused toolchain versions" command yet.
5. **Long paths:** the deepest file is 147 characters below `apio/packages`, so the total path is about 215 characters plus the user-name length under `%LOCALAPPDATA%`. That is below 260 for typical names; not tested with a long user name.
6. ~~Results LUT capacity `/126800`~~: **fixed** (§16.2). Results show `57 / 63,400` from the device metadata.
7. **Installed validation drives two commands with a scripted argument** instead of their dialogs (§10). VS Code workspace trust was disabled for automation; the package declares that untrusted workspaces are not supported.
8. **Developer flow:** running the extension from source (F5) now also needs the toolchain installed (`npm run toolchain:install`). The Phase 4A EDH suite was updated (`emxplore.nexysvhdl`, modules from the extension under test) but not re-run in this phase.
9. **Extension packaging:** unbundled (102 JS files; vsce suggests bundling, not needed at 228 KiB). Compiled files still carry `sourceMappingURL` comments while the `.map` files are excluded (harmless).

## 15. Physical Program

**DEFERRED.** No Nexys A7 was connected during this validation: Hardware view → "none". The Windows djtgcfg backend was physically validated in Phases 3B/3C. Detection through the installed package worked (`djtgcfg enum`, official install).

To complete: connect the board, open the project in the installed profile, Build → Program, and confirm LED0 blinks with SW0 on and BTNC restarts it.

## 16. Follow-up fixes before freeze (2026-10-02)

### 16.1 Profile and project paths with spaces and non-English characters

**Investigation.** The restriction does not come from one place.

| Component | Behaviour with a hostile path | Evidence |
|---|---|---|
| Apio 1.6.0 | Fatal `Unsupported character [space] in apio home dir` for any `APIO_HOME`/`APIO_PACKAGES` path outside ASCII 33–127 | A deliberate policy check, `_check_apio_dir()` in `apio/utils/util.py` (commit `9fbb279c`). Apio issue #515: added because the *Gowin* `gowin_pack` mangles Unicode; Unicode *project* folders are explicitly supported |
| GHDL 6.0.0 | Analysis succeeds, but the absolute source path it was given is written into `work-obj08.cf`. The `.cf` reader then rejects some non-ASCII bytes ("invalid character not allowed, even in a string"), so elaborate/run/synth fail | Probe matrix:<br>- spaces: OK;<br>- `ó`: OK (UTF-8 bytes in the Latin-1 range);<br>- CJK: fails (UTF-8 bytes 0x80–0x9F);<br>- the GHDL executable's own location: irrelevant;<br>- **workspace-relative sources: OK** in a "José García 学生 / Mis Proyectos ñ" project |
| Yosys, nextpnr-xilinx, fasm2frames (Python), xc7frames2bit | Work in a project folder with spaces/ñ/CJK when Apio's own paths are ASCII | `apio build` of the Phase 2 design in such a folder: SUCCESS, bitstream produced |
| Node installer | Unicode-safe | Toolchain 1.0 installed into "…\José García 学生\AppData Local\…" in 62.6 s |

So the restriction is not inherent to Apio, Yosys or nextpnr for project folders. Apio refuses non-ASCII *home/packages* paths by policy, and GHDL cannot record some non-ASCII source paths.

**Fix (bundled mode, no change to Apio or the toolchain):**

1. **ASCII alias for the toolchain and Apio state** (`platform/windows/path-alias.ts`; core hook `LoadBundleOptions.pathAlias`).
   - **When:** only when a real folder would be refused, i.e. it contains a space or a character outside ASCII 33–127.
   - **What:** NexysVHDL creates a directory junction `%ProgramData%\NexysVHDL\links\<sha256(target)[:16]>` pointing at the user's own toolchain/state folder.
   - Every tool path, `APIO_HOME`, `APIO_PACKAGES`, the remote config URL and the shim PATH then use the alias.
   - **Requirements met:**
     - no administrator rights (junctions are not symlinks; Users may create folders in `%ProgramData%` and own them);
     - no 8.3 names;
     - no change to the account;
     - not `~/.apio`.
   - **Unchanged:** the files stay in `%LOCALAPPDATA%\NexysVHDL` (immutable Toolchain 1.0 and private state). Verify Toolchain still hashes the real folder.
   - **Safety:** an existing entry under that name is used only if it already resolves to the same target. Another user's folder or a planted junction is never used (the next name is tried). Failures are reported as `BUNDLE_PATH_ALIAS_FAILED`.
   - **Why not `C:\Users\Public`:** other interactive users may modify subfolders there.
2. **GHDL is given only workspace-relative paths.**
   - Arguments become `--workdir=.`, `../../src/top.vhd`, `--wave=top_tb.ghw` and `--vcd=waveform.vcd`; diagnostics are mapped back to project-relative paths.
   - RTL source links resolve GHDL's relative `/*# file:line:col */` comments from the RTL folder.
   - The student's project location (any characters) never reaches GHDL.
   - A source *file name* GHDL cannot record (non-ASCII) gets a located Check error, `GHDL_FILE_NAME_UNSUPPORTED`, instead of GHDL's cryptic `.cf` error. (Non-ASCII VHDL *identifiers* are invalid VHDL anyway.)

### 16.2 Results: LUT capacity

**Investigation.** nextpnr-xilinx's `--report` gives `SLICE_LUTX: 56/126800` for the XC7A100T. `SLICE_LUTX` is a placer **bel** type: each 7-series LUT6 site is modelled as two bels (the 6-input and 5-input halves), so the count is 15,850 slices × 4 LUT6 × 2 = 126,800.

The device has **63,400 LUTs** (AMD/Xilinx DS180, Artix-7 feature summary: 15,850 slices × 4). The same report's `PAD: 3/630` counts every pad of the die model; the CSG324 package has **210** user I/O. Flip-flops (126,800), CARRY4 (15,850), DSP48E1 (240), RAMB36 (135) and BUFGCTRL (32) already matched the data sheet.

**Fix.**
- `boards/nexys-a7-100t/board.json` → `fpga.capacity` holds `{ luts 63400, flipFlops 126800, slices 15850, bram36 135, dsp 240, userIo 210, globalClockBuffers 32 }`, with the data-sheet source. The board registry validates it (`BOARD_CAPACITY_INVALID`).
- `applyDeviceCapacity()` (core, pure) is applied by the Apio provider. It sets each capacity from the metadata, counts BRAM used in 36 Kb blocks (RAMB36 + RAMB18/2), and keeps nextpnr's raw figures in `utilization.device` for engineering views.
- Results show `LUTs 57 / 63,400`, `Flip-Flops 27 / 126,800`, `BRAM (36 Kb) 0 / 135`, `DSP 0 / 240`, `I/O pins 4 / 210`.
- "Used" LUTs remain nextpnr's placed LUT cells. Two LUT5 cells packed into one LUT6 site count as 2 here and as 1 in Vivado, so for such designs the figure is an upper bound.
- This was an extension-only change: Toolchain 1.0 is untouched.

### 16.3 Tests

There are 17 new tests; the total is **406/406** and typecheck is clean.

| File | Covers |
|---|---|
| `tests/hostile-paths.test.ts` (10) | Alias:<br>- junction naming and reuse;<br>- planted/foreign entry never used;<br>- missing/non-ASCII ProgramData and junction failure reported.<br>Loader:<br>- without an alias Apio is disabled;<br>- with it every tool path, `APIO_*` and PATH is ASCII while `root` stays the real folder;<br>- alias failure reported.<br>Classroom mode calls the hook for a hostile data root. GHDL never receives the project location from a "José García 学生 / Mis Proyectos ñ" project; a CJK file name gets a located Check error without running GHDL; RTL relative source comments resolve. |
| `tests/device-capacity.test.ts` (6) | - board capacity = DS180 values (LUTs = 4 × slices);<br>- the raw nextpnr report really says 126,800 bels;<br>- the overlay gives 63,400 / 210 / 135 / 240 and keeps the raw figures;<br>- BRAM in 36 Kb blocks;<br>- Results rows `LUTs: 56 / 63,400` (never 126,800);<br>- invalid capacity rejected. |
| `tests/ghdl-workspace.test.ts` (+1, updated) | GHDL arguments are workspace-relative and never contain the project root; relative GHDL diagnostics map to project-relative files |
| Updated expectations | `tests/extension/waveform.test.ts` (relative `--vcd`, cwd = sim workspace) and `tests/extension/vscode-adapters.test.ts` (number formatting, "BRAM (36 Kb)") |

### 16.4 Installed-package regression after the fixes

The VSIX was rebuilt: 232.4 KiB, 126 files, all `package:win` gates passed. Toolchain 1.0 was **not** rebuilt (same archive SHA-256 `423c1a37…`, same content hash `43b3fb80…`). Both runs used a private profile, a reduced PATH, hostile `APIO_HOME`/`PYTHONPATH`/`NEXYSVHDL_GHDL`, the process trace and Verify Toolchain.

| | Standard paths (`%TEMP%\nxv`) | **Hostile paths** (`%TEMP%\nxv hostile\José García 学生\…` for the profile, extensions folder, LOCALAPPDATA store and project) |
|---|---|---|
| Install FPGA Toolchain | installed (132 s); second attempt `already-installed` | installed (140 s); `already-installed` |
| Aliases | none created (ASCII paths) | 2 junctions: toolchain → `links\6471f6175ebebaaf`, state → `links\83d3c1b595fd13de` |
| Tools / versions | all compatible, real store paths | all compatible, every path via `C:\ProgramData\NexysVHDL\links\…` |
| Project detection, Project Files, hierarchy (auto + manual), Set Top | pass | pass |
| Check / Problems | pass; error at 32:26 shown and cleared | pass; error at 32:26 shown and cleared |
| Simulate / Waveform | 33 checks @ 660 ns; viewer, cursor, zoom, reload | same |
| Design / RTL Schematic | pass; AND → `led0` linked to `src/top.vhd:32:19` | same (relative GHDL comments resolved) |
| Build (Synthesis → Implementation → Bitstream) | pass; 409.67 MHz, 3,825,910 B | pass; 409.67 MHz, 3,825,910 B |
| Results | **LUTs 57 / 63,400**, FF 27 / 126,800, I/O 4 / 210, BRAM 0 / 135, DSP 0 / 240 | same |
| Hardware | detection through the official djtgcfg; no board | same |
| Verify Toolchain after the workflow | 21,465 files unchanged | 21,465 files unchanged |
| Modules | 104 from the installed extension, 0 elsewhere, no `.ts` | same |
| Process trace | only bundle executables + official `djtgcfg.exe`; no Python314 | same, through the alias. **No tool path or command line contained the hostile names**; GHDL got `..\..\src\…` |
| UI-only update 0.5.0 → 0.5.1 | toolchain reused: same folder, marker unchanged | not repeated |

**External state** (fresh snapshot before both runs, compared after): `~/.apio` (21,424 files), the Digilent folders, the Adept DLLs and the developer GHDL are **unchanged in content and timestamps**. The driver store is unchanged, and the real `%LOCALAPPDATA%\NexysVHDL` was never created.

The hostile-run junctions remain in `C:\ProgramData\NexysVHDL\links\` (two links into `%TEMP%\nxv hostile`) for review. Remove them with a non-recursive `rmdir` of each junction, which does not touch the targets.

## 17. macOS (darwin-arm64) implementation and validation (2026-10-02)

Branch `phase4/classroom-bundle-macos` from `main` at `b1ecb1d`. Host: macOS 27.0 (26A428), Apple M4, arm64; Node 24.21.0; VS Code 1.140.0 (`07f806f9`). The Windows/shared architecture (ADR-007) is reused unchanged: the same recipe format, assembler, packer, store, loader, classroom mode, setup model and packaging script. No Homebrew is installed on this Mac.

### 17.1 Shared changes (platform-neutral, Windows behaviour unchanged)

| Change | Why (genuine macOS requirement) | Windows impact |
|---|---|---|
| `tests/hostile-paths.test.ts`: the RTL source-link test builds its paths with the host's `resolve`/`join` instead of `win32.join` | The test hard-coded a Windows path and passed it through the host `resolve()`. On macOS that yields one folder name `C:\José…`, so the test failed (405/406 baseline). `ghdlSourceMap` itself was correct (verified with native POSIX paths). | none (test-only) |
| `core/toolchain/tar.ts` + `scripts/toolchain/lib.mjs`/`compare.mjs`: relative **symbolic links** are archived, extracted and hashed | The official macOS archives contain 189 links: PyInstaller's `_internal/Python → Python.framework/Versions/3.14/Python` in Apio, and Qt framework `Versions/Current` links plus dylib/Python aliases in oss-cad-suite. Copying them as files would make dyld load two copies of the same library. Links are accepted only when `safeLinkTarget()` proves they stay inside the tree (relative, `../` only as a prefix and never above the root, then plain names); nothing is ever written through a link; links are created after all files; hard links and special files are still refused. Tree-hash line for a link: `path\0->\0target\n`. | none: a tree without links hashes exactly as before (test pins the legacy formula); the released Windows content hash `43b3fb80…` is unchanged (test) |
| `scripts/toolchain/assemble.mjs`: `toolchains/bundle/licenses-<target>/` is merged into the toolchain's `licenses/` | macOS needs license texts Windows does not ship (LLVM, Python 3.14). Adding them to the shared folder would change the released Windows toolchain content on reassembly. A name collision with a shared text is refused. `validateRecipe` checks every `licenses/…` reference exists. | none (no `licenses-win32-x64/`) |
| `scripts/toolchain/notices.mjs`: a "Board programmer" section for a bundled programmer | macOS bundles openFPGALoader | none (Windows programmer is `system`) |
| `extension/services/environment-summary.ts`: a **bundled** programmer whose toolchain is not installed yet shows *Not Installed — installed with the FPGA toolchain* (setup-required) instead of *Problem*, and adds no separate programmer problem | Installed-package run: before installation the Mac setup row said "Board programmer (openFPGALoader) — Problem" | none (Windows programmer is not bundled) |
| `tests/integration/run-installed.ts`: macOS branch (app bundle Electron/CLI, POSIX OS-only PATH, Mac hostile settings, `NEXYS_PATH_PREPEND`, `NEXYS_HOSTILE_GHDL`); inherited `VSCODE_*`/`ELECTRON_*` variables removed for both platforms. `installed-suite.ts`: module origin compared by real path (`/tmp` is `/private/tmp`); process step records the hostile settings | macOS validation | harness only |
| `platform/macos/path-alias.ts` + registry entry in `platform/index.ts` (`pathAlias` for darwin-arm64, the same hook as Windows) | A home folder whose path has a space or non-ASCII character makes `~/Library/NexysVHDL` an Apio-refused path (§17.14) | none (Windows registration unchanged) |
| `LICENSE`, `NOTICE`, `package.json` `license`, `.vscodeignore`, `scripts/package.mjs` (license gate: no `--skip-license`, LICENSE/NOTICE required, shipped `LICENSE.txt` must equal `LICENSE`; LICENSE/NOTICE in the distribution folder) | NexysVHDL's own license decision (§17.15) | the Windows VSIX/zip will also contain LICENSE and NOTICE; the Windows toolchain is unaffected |
| `scripts/validation/watch-processes-macos.c` | macOS counterpart of `watch-processes.ps1`: libproc poller (2 ms), every (pid, executable) pair incl. bash→exec transitions and full argv, optional `all` mode for process-tree attribution | none |

### 17.2 Toolchain 1.0 for macOS: exact components (verified)

All archives downloaded from the official GitHub releases and checked against GitHub's published SHA-256 digests; each matches the recipe.

| Component | Version | Official archive | SHA-256 | Evidence |
|---|---|---|---|---|
| GHDL | **6.0.0** (`6.0.0.r0.ge589c698c`), **LLVM JIT** backend, macOS 15 aarch64 | `ghdl/ghdl` v6.0.0 `ghdl-llvm-jit-6.0.0-macos15-aarch64.tar.gz` (37,155,806 B) | `c21312d5…31c7769` | §17.3 |
| Apio | **1.7.0** (`pyinst-darwin-arm64-2026-09-27`, commit `ccede3ec`), Python 3.14.7 inside | `fpgawars/apio` 2026-09-27 `apio-cli-darwin-arm64-20260927-bundle.tgz` (18,884,126 B) | `96352962…fc77e15f` | 124/124 entries identical to the validated `/Applications/Apio` (installed from the same release's `.pkg`); the bundle adds `README.txt` |
| Apio definitions | 2026.09.17 | `apio-definitions-20260917.tgz` | `34a2047d…be150` | 991/991 identical to `~/.apio/packages` |
| oss-cad-suite (Yosys **0.63+173**, openFPGALoader **1.1.1**) | 2026.09.15 | `apio-oss-cad-suite-darwin-arm64-20260915.tgz` (506,883,485 B) | `5c8729c2…a31b9d2` | 24,987/24,987 identical |
| verible | 2026.09.20 | `apio-verible-darwin-arm64-20260920.tgz` | `dba75c55…f111e4b` | 12/12 identical |
| openXC7 (nextpnr-xilinx **e860c9c8**, prjxray-db `a90f27c1`, **parts-index schema 7**, Python 3.12.5) | **2026.09.25** | `apio-openxc7-darwin-arm64-20260925.tgz` (77,149,656 B) | `24469f14…e0ecf3e2` | 5,447 identical; the validated install additionally had 17 runtime `__pycache__` files (`cpython-312`, i.e. written by openXC7's own Python) |
| chipdb xc7a100t | 2026-09-25 | `apio-xilinx-chipdb-xc7a100t-20260925.bin.tgz` (3,799,612 B) | `86b8ea41…3c0a12` | asset and `chipdb-xc7a100t.bin` (`b4098ce6…`) SHA-256 equal to `XILINX-PARTS-INDEX.json` |

- **Apio packages on macOS:** Apio 1.7.0's own `packages.jsonc` restricts `drivers` and `graphviz` to `windows-amd64`, and the validated `~/.apio` has only definitions, oss-cad-suite, verible and openxc7. The Windows-derived draft listed six; the Mac recipe has these four, and the generated pinned remote config lists exactly them. Apio 1.7.0 accepts it (`apio packages list`: all OK, no download).
- **openXC7 pin:** 2026-09-25 / schema 7 only; a test asserts that the 2026-09-27 (schema 8) package is never referenced. Because every package is pinned in a `file://` config inside the bundle and the loader refuses any mismatch, the Phase 3 incident (an unpinned Apio replacing openXC7) cannot recur.
- **Draft corrections:** openXC7 version string `2026-09-25` (the draft's `2026.09.25` would never equal the release tag read from `BUILD-INFO.json`, so openXC7 would have shown as *incompatible*); chipdb asset name `…xc7a100t-20260925` (not `…xc7a100tcsg324…`); drivers/graphviz removed; `installedAt` from the validated install.
- **Reproducibility:** two independent assemblies gave the same content hash `f04022180f9bb746dc5dc467bc7d1d379512f302159763f8c4a8c0ed50b2aac7` (31,699 entries: 31,510 files + 189 links, 2,758,218,326 B).

### 17.3 Finding: GHDL-LLVM needs Xcode Command Line Tools — Toolchain 1.0 uses the official LLVM-JIT build of the same release

The ahead-of-time **LLVM** build (`ghdl-llvm-6.0.0-macos15-aarch64`, validated in Phases 1–4A on this developer Mac) links every elaborated design into a native executable with `/usr/bin/cc` (the process trace showed `cc -o top_tb e~top_tb.o … libgrt.a` running Command Line Tools `clang`/`ld`). A student Mac has no Command Line Tools (`/usr/bin/cc` is only Apple's install-prompt stub), and Apple's linker/SDK cannot be redistributed.

| Step (same project) | LLVM build without Command Line Tools (`DEVELOPER_DIR` invalid) | LLVM-JIT build without Command Line Tools |
|---|---|---|
| analyze `-a` | OK | OK |
| elaborate `-e` (Check, Simulate) | **fails** (`xcrun: error`, `ghdl:error: compilation error`) | OK |
| run `-r` (Simulate) | — | OK |
| synthesize `--synth` (RTL, Build) | OK | OK |

Equivalence (JIT without CLT vs the validated LLVM build): simulation output identical (`ALL TESTS PASSED (33 checks)`, stop at 660 ns); GHW identical; VCD identical apart from its `$date` line; synthesized Verilog **identical** (`0cea0f62…`), hence the same netlist for Yosys/nextpnr. The JIT `bin/ghdl` links only `libSystem`, `libz` and `libc++` (LLVM 22.1.0 and the GNAT runtime are static), so it is fully relocatable. **Decision (approved by the owner, 2026-10-02):** Toolchain 1.0 for macOS uses `ghdl-llvm-jit-6.0.0-macos15-aarch64` — the **same official GHDL 6.0.0 release** (`ghdl/ghdl` v6.0.0, `6.0.0.r0.ge589c698c`), its LLVM-JIT backend variant, not an upgrade — because it is preferable to requiring students to install Xcode Command Line Tools. The equivalence checks above and the full installed-package workflow (§17.7, §17.14) passed with it. The installed-package trace confirms no `cc`, `clang`, `ld`, `xcrun` or `ghdl1-llvm` process runs anymore.

### 17.4 Python (the Windows `C:\Python314` question, on macOS)

- Apio is a PyInstaller executable with its own Python 3.14.7 (`_internal/Python.framework`); it ran with PATH `/usr/sbin:/sbin` only (no `python3` reachable).
- openXC7's `bin/fasm2frames`, `bin/bit2fasm` and `bin/.fasm-wrapped` are bash wrappers that `exec "$top/libexec/python3.12"` with `PYTHONHOME=$top`: no PATH Python is involved (different from Windows). `bin/xc7pll` (`#!/usr/bin/env python3`) and `bin/fasm` (Nix store paths) are never run by Apio's Xilinx flow.
- **No Python shim is needed** (`shims: []`, `pathPrepend: []`).
- **Proof:** in the installed run the only Python process was `…/1.0/apio/packages/openxc7/libexec/python3.12` (argv `… libexec/fasm2frames --part xc7a100tcsg324-1 --db-root …/prjxray-db/artix7 …`); no `/usr/bin/python3`, no Command Line Tools Python, no decoy `python`/`python3` (decoys first on PATH logged nothing). With `DYLD_PRINT_LIBRARIES`, the fasm2frames imports load images only from the toolchain and `/usr/lib`/`/System`; `sys.prefix` is the bundled openxc7 package. `hardware.frames` re-generated from the same `hardware.fasm` is byte-identical (`f7af759e…`). Verify Toolchain after the workflow: no `__pycache__` written (`PYTHONDONTWRITEBYTECODE=1`).

### 17.5 Store, state and environment on macOS

| | Path |
|---|---|
| Data root | `~/Library/NexysVHDL` (not "Application Support": Apio refuses a space; macOS short user names contain no spaces) |
| Toolchain 1.0 (immutable) | `~/Library/NexysVHDL/toolchains/darwin-arm64/1.0/` + `.nexysvhdl-installed.json` |
| Writable state | `~/Library/NexysVHDL/state/darwin-arm64-1.0/apio-home/` — after all runs only `cached-remote-config.json` (1,323 B) |
| Tool environment | `PATH=/usr/bin:/bin:/usr/sbin:/sbin`; `APIO_HOME`, `APIO_PACKAGES`, `APIO_REMOTE_CONFIG_URL=file://…/apio/remote-config/apio-{major}.{minor}.x.jsonc`; `PYTHONDONTWRITEBYTECODE=1`; inherited `PATH`, `APIO_*`, `PYTHON*` removed |

No administrator rights are needed. VS Code on macOS imports the login-shell environment, so the extension host sees the user's full PATH (here `/usr/local/bin`, `/Applications/Apio`, `~/.cargo/bin`, …) even when started with a reduced PATH; only the bundle environment above reaches the tools.

### 17.6 Artifacts

| Artifact | Size | SHA-256 |
|---|---|---|
| `nexysvhdl-0.5.0-darwin-arm64.vsix` | 241,351 B (235.7 KiB), 126 files; installed 936 KiB | `72169bf4…1eca24a` |
| `nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz` | 657,363,463 B (626.9 MiB) | `d8cdf6e2…a2359d` |
| Installed Toolchain 1.0 | 2,758,218,326 B (2.57 GiB; 2.65 GiB on disk), 31,699 entries | content `f0402218…` |
| `NexysVHDL-0.5.0-darwin-arm64.zip` | 623,538,720 B (594.7 MiB) | `10cba252…5232669` |

`npm run package:mac` passed every gate (requirement, archive + `.sha256`, assembled content = requirement, notices/licenses, typecheck + build, 23 resources, VSIX content audit, privacy audit, distribution folder + zip). Major sizes (installed): oss-cad-suite 1,760 MiB (libexec 867 — other FPGA families' nextpnr, solvers, GUIs; share 458; lib 433; Qt frameworks 59), openXC7 666 MiB (prjxray-db zynq7 259, artix7 187, spartan7 104), GHDL 106, chipdb 37, Apio 35, verible 24, definitions 2.5. Nothing pruned (§11 reasoning applies).

### 17.7 Installed-package validation (real VSIX, private profile, no `--extensionDevelopmentPath`)

Setup: private `--user-data-dir`/`--extensions-dir` under `/tmp/nxv` (the scratch path was too long for VS Code's 104-byte IPC socket limit), real `~/Library/NexysVHDL` store (absent before), the classroom ZIP "downloaded" with a `com.apple.quarantine` attribute (simulated: written with `xattr`, then extracted with `ditto`, which propagates it like Archive Utility), PATH = decoy folder + `/usr/bin:/bin:/usr/sbin:/sbin`, hostile `APIO_HOME=~/.apio`, `APIO_PACKAGES=~/.apio/packages`, `PYTHONHOME`, `PYTHONPATH`, `NEXYSVHDL_GHDL=<the working developer GHDL>`, `NEXYSVHDL_APIO=/Applications/Apio/apio`, `NEXYSVHDL_TOOLS_DIR=~/.apio/packages`, dead `HTTP(S)_PROXY`. Decoy `ghdl`/`apio`/`yosys`/`nextpnr-xilinx`/`openFPGALoader`/`python`/`python3`/`pip`/`fasm2frames`/`xc7frames2bit`/`iverilog` log any use.

| Item | Result |
|---|---|
| Before install | *Setup required*; toolchain *Not Installed*; programmer *Not Installed — installed with the FPGA toolchain* |
| Install FPGA Toolchain (quarantined archive) | `installed` in **29.2 s**; second attempt `already-installed`; no staging folder left |
| After install | *Ready — Ready for design, build and programming*; GHDL 6.0.0, Apio 1.7.0, openXC7 2026-09-25, Yosys 0.63+173, nextpnr-xilinx e860c9c8, openFPGALoader 1.1.1, all `compatible`, all under `~/Library/NexysVHDL/toolchains/darwin-arm64/1.0/`; programmer *Ready (bundled)* |
| Create Project / duplicate | `StudentDemo` created outside the repository / `ALREADY_EXISTS` |
| Project detection, Project Files, hierarchy (automatic + manual), Set Top | pass |
| Check / Problems | passed (top, top_tb); error at 32:26 shown and cleared |
| Simulate / GHW / VCD / Waveform | `ALL TESTS PASSED (33 checks)` @ 660 ns; viewer, cursor (95 ns: count `8`/`1000`), zoom, pan, fit, reload on re-simulation |
| Design / RTL Schematic | pass; AND(`u_blink`,`sw0`) → `led0` linked to `src/top.vhd:32:19` |
| Build (Synthesis → Implementation → Bitstream, live stages) | **57 LUTs, 27 FFs**, 7 CARRY4, 1 BUFG; timing **PASS 391.54 MHz** (target 100), slack **+7.446 ns** (= Phase 4A Mac); bitstream 3,825,910 B; constraints from the raw XDC file |
| Results capacities (board metadata) | LUTs 57 / 63,400; FF 27 / 126,800; BRAM 0 / 135; DSP 0 / 240; I/O 4 / 210 |
| Hardware view | detection ran the bundled openFPGALoader (`--scan-usb`): no board; setup rows Toolchain *Ready*, Programmer *Ready (bundled)*, Board *Not Connected* |
| VHDL highlighting | `.vhd` → `vhdl`, NexysVHDL grammar scopes (91/157, 101/173, 231/415) |
| Verify Toolchain after the workflow | ok, 31,699 entries unchanged |
| Modules | 102 from the installed extension, 0 elsewhere, no `.ts` |
| Hostile paths: profile, extensions folder and project in `/tmp/nxv hostile/José García 学生/` | all of the above pass (57/27, 391.54 MHz, 33 checks, RTL link, Verify ok); 39 GHDL/Apio invocations, none with the hostile names in its command line; bitstream payload identical to the standard run (3,825,788 B, `8ce1601e…`; only the header time differs) |
| UI-only update 0.5.0 → 0.5.1 (validation-only VSIX: version fields changed in a copy of the real VSIX; repository version unchanged) | 0.5.1 loaded from `emxplore.nexysvhdl-0.5.1`; toolchain *Ready* immediately at the same folder; marker byte-identical (`b37c6b1b…`), same mtime and inode; version folder inode/mtime unchanged; no file newer than the marker; no extraction in the trace |

### 17.8 Process trace, PATH and external state

- `watch-processes-macos.c` (`all` mode) recorded every process; analysis kept the descendants of the VS Code instance under test. **Toolchain 1.0 executables:** `ghdl/bin/ghdl`, `apio/bin/apio`, `oss-cad-suite/libexec/{yosys,yosys-abc,openFPGALoader,realpath}`, `openxc7/libexec/{nextpnr-xilinx,python3.12,xc7frames2bit}` (bash wrappers from the same packages). **Other:** `/bin/bash`, `/bin/sh`, `/usr/bin/env`, `/usr/bin/dirname`, `/usr/bin/locale` (macOS); VS Code's own helpers, its login-shell probe (`zsh -i -l -c`) and its Git extension (`git --version`, `git rev-parse` — NexysVHDL never runs git). **None** from `/opt/homebrew`, `/usr/local`, `~/.apio`, `/Applications/Apio`, the repository, the developer GHDL, Command Line Tools compilers/linkers or any Python other than openXC7's.
- **No PATH fallback:** the decoy log is empty for all five phases; `NEXYSVHDL_GHDL` (a working GHDL) and `NEXYSVHDL_APIO` were ignored; the dead proxy caused no failure (no network use).
- **External state** (`scripts/validation/snapshot.mjs`, before the clean run vs after all phases): `~/.apio` (31,271 files; its `cached-remote-config.json` still from 01:00, before this work) **unchanged in content and timestamps**; `/Applications/Apio` (120 files) unchanged; developer GHDL (249 files) unchanged; only `~/Library/NexysVHDL` was created. The rehearsal runs before the final build also left them unchanged.

### 17.9 Relocation, permissions, signatures, Gatekeeper

- **Relocation:** `otool -L` over all 631 Mach-O files of the installed store: dependencies are `@rpath`/`@executable_path`/`@loader_path` (inside the packages), `/usr/lib` or `/System/Library`; **none** in `/opt/homebrew`, `/usr/local`, `/Users`. Some upstream binaries still carry LC_RPATH entries of their CI machines (`/Users/runner/work/…`), which do not exist on a student Mac and are never needed. At runtime (`DYLD_PRINT_LIBRARIES`, started from the installed store) ghdl, apio, yosys, yosys-abc, openFPGALoader, nextpnr-xilinx, xc7frames2bit and openXC7's python3.12 load images only from the toolchain and the system.
- **Permissions:** after pack → extract → install all 989 executable files keep their executable bit and all 189 links are identical (target and type); archive headers are uid/gid 0 without names; executables are 0755.
- **Signatures (unchanged upstream):** all 631 Mach-O files are ad-hoc signed (402 `adhoc`, 229 `adhoc,linker-signed`), no Team ID, not notarized. `codesign --verify --strict` passes except PyInstaller's `Python.framework/Versions/3.14/Python` ("code has no resources but signature indicates they must be present"), identical in the validated `/Applications/Apio`; it loads and runs normally. Nothing was re-signed or stripped; no personal identity was used.
- **Quarantine/Gatekeeper:**
  - *Observed:* installing from a quarantined archive through the extension leaves **no** `com.apple.quarantine` on any of the 34,549 installed entries (VS Code does not set `LSFileQuarantineEnabled`; Node writes fresh files and copies no attributes); only `com.apple.provenance` is present, and every tool ran.
  - *Observed (representative test on a copy):* the same `ghdl` binary with a quarantine attribute added is **killed by Gatekeeper** (SIGKILL, exit 137; `spctl --assess`: rejected), without the attribute it runs.
  - *Consequence:* the supported flow (Install FPGA Toolchain… from the archive) works with a normally downloaded classroom ZIP; extracting the `.tar.gz` by hand (Archive Utility propagates quarantine) would produce blocked binaries, so the student guide says not to. *Assumption, not tested:* managed Macs with stricter policies (e.g. MDM rules that deny unnotarized code) may block ad-hoc signed tools; the clean long-term fix would be an institutional Developer ID signature + notarization of the toolchain, which re-signs upstream binaries and is a redistribution decision.

### 17.10 License inventory (macOS) and redistribution blockers

| Component | License | Corresponding-source obligation |
|---|---|---|
| GHDL 6.0.0 (LLVM-JIT build) | GPL-2.0-or-later; libgnat GPL-3.0 + GCC Runtime Library Exception; libgcc_s (exception); LLVM 22.1.0 statically linked: Apache-2.0 WITH LLVM-exception | GPL source (GHDL v6.0.0); LLVM: license + notice text (shipped) |
| Apio 1.7.0 bundle | GPL-2.0; Python 3.14.7 PSF-2.0; OpenSSL 3.5.7 Apache-2.0; libusb-1.0 LGPL-2.1; zstd 1.5.7 BSD; Python packages per `*.dist-info` | GPL source (Apio `ccede3ec`), LGPL source for libusb |
| oss-cad-suite 2026.09.15 | Yosys ISC; openFPGALoader Apache-2.0; libusb LGPL-2.1, libftdi LGPL-2.1/GPL-2.0; 59 `license/LICENSE.*` (16 contain GPL text, 8 contain LGPL text, e.g. iverilog, gtkwave, verilator, ghdl), each naming its source revision; Python 3.11 PSF; Graphviz EPL-1.0 (rev `da4c2ec6`); **Qt 5 frameworks (LGPL-3.0) without any license file in the package** | GPL/LGPL source per tool; Qt: LGPL notice + source |
| openXC7 2026.09.25 | nextpnr-xilinx ISC, prjxray ISC, prjxray-db CC0-1.0, Python 3.12.5 PSF (`lib/python3.12/LICENSE.txt`) | none beyond notices |
| chipdb, definitions, verible | CC0-derived / GPL-2.0 / Apache-2.0 | definitions: GPL source |

Texts shipped in the toolchain's `licenses/`: the shared set plus `licenses-darwin-arm64/` (`LLVM-LICENSE.txt` from `llvmorg-22.1.0`, `PSF-2.0-Python-3.14.txt` from CPython `v3.14.7`). **Redistribution remains NOT READY:** the shared GPL/LGPL corresponding-source mechanism plus, for macOS, the Qt LGPL-3.0 notice/source for frameworks shipped without a license file, the LGPL libusb/libftdi and OpenSSL notices in the Apio bundle, and the GPL/LGPL corresponding source for the macOS components (GHDL incl. GNAT runtime, Apio, oss-cad-suite tools, libusb/libftdi, Qt). Resolved since: NexysVHDL's own license (Apache-2.0, §17.15) and the GHDL backend (approved, §17.3). The Windows-only drivers/graphviz-package items do not apply (not in the Mac bundle).

### 17.11 Privacy

Every file of the Mac toolchain (binaries included), the NexysVHDL-generated files, the VSIX (gate: 132 text files) and the distribution folder were searched: no `nohafahmy`, `WSClaude`, repository name, scratch path, user e-mail, token or developer path. `/Users/<name>` strings exist only in upstream binaries/sources (`runner` = GitHub CI, upstream authors' examples); "private key" hits are CPython's deliberately invalid test certificates and a PEM parser string in QtNetwork; `AKIA` occurs only inside Unicode/ICU data tables.

### 17.12 Tests

`npm test`: **414/414** at the first macOS review (406 baseline after the portability fix + 8); **420/420** after §17.14/§17.15 (+4 macOS alias, +2 license); typecheck clean. New: tar link round trip (frameworks, `../` aliases, long pax `linkpath`), link-target safety + writer refusal, unchanged legacy tree hash, six new extraction refusals (no/absolute/escaping/inner-`..` targets, writing through a link, link replacing a folder, hard link); build-script hash parity with links; macOS store install with links + verify + re-pointed link detected; macOS hostile shell environment never reaching a tool; `~/Library/NexysVHDL` vs "Application Support" path rule; bundled programmer waiting for the toolchain; macOS recipe pinned exactly (versions, JIT GHDL, Apio bundle, four packages, no openXC7 2026-09-27, official URLs, bundled programmer, no shims); requirement with both targets (Windows hash unchanged); license texts per target.

### 17.13 Known limitations (macOS)

1. ~~GHDL backend change needs owner approval~~: **approved** (§17.3).
2. **Physical Program not run** in this phase (no board): DEFERRED.
3. ~~A home folder with a space or non-ASCII character disables Build/RTL~~: **fixed** with a private ASCII alias (§17.14). Remaining: if `$TMPDIR` is missing, non-ASCII or not private to the user, no alias is made and Build/RTL report `BUNDLE_PATH_ALIAS_FAILED` (Check and Simulate still work); macOS may purge an old alias from `$TMPDIR`, and it is recreated the next time the toolchain is loaded (window reload or Refresh).
4. Toolchain binaries are ad-hoc signed and not notarized (upstream): fine through the installer, blocked if extracted by hand; managed Macs with strict policies untested.
5. The installed-validation profile had to live under `/tmp` because of the 104-byte socket path limit; this is a harness constraint, not a product one (VS Code's normal profile path is short).

### 17.14 Home folders with spaces or non-English characters (follow-up, 2026-10-02)

**Problem.** The store is `$HOME/Library/NexysVHDL`. macOS short user names cannot contain spaces, but a home folder can be moved or mounted elsewhere (e.g. `/Volumes/Home Drive/José García`). Apio refuses such `APIO_HOME`/`APIO_PACKAGES` paths, so Build and the RTL Schematic were disabled.

**Feasibility (before implementing).** Toolchain 1.0 installed under `/tmp/nxv home/José García 学生/Library/NexysVHDL`, a project under `…/Mis Proyectos ñ/Demo`, Apio pointed at hand-made symbolic links in `$TMPDIR`: GHDL synthesis and `apio build` (Yosys, nextpnr-xilinx, fasm2frames, xc7frames2bit) → SUCCESS, 3,825,910 B. The oss-cad-suite wrappers `realpath` themselves back to the real (Unicode) path and Yosys works there; only Apio's own path check needs ASCII. No macOS reason prevents an alias.

**Solution** (`platform/macos/path-alias.ts`, registered as the darwin `pathAlias` — the same core hook as the Windows junction; the loader calls it only when the real toolchain or state path is not Apio-safe):
- The real, immutable Toolchain 1.0 and the writable state stay in `$HOME/Library/NexysVHDL` (Verify Toolchain hashes the real folder). Only the paths handed to the tools change.
- Alias = symbolic link `$TMPDIR/NexysVHDL-links/<sha256(real target)[:16]>` → the real folder. `$TMPDIR` is the per-user Darwin temporary folder launchd gives every app (`/var/folders/<..>/T/`, ASCII, owned by the user, mode 0700).
- Checks: `$TMPDIR` must be set, absolute, ASCII-safe, a directory owned by the user and not writable by group/others (a world-writable `/tmp` is refused); `NexysVHDL-links` is created 0700 and must be a real directory (not a link) owned by the user and not group/other-writable; an existing entry is reused only if it is the user's own symbolic link whose `readlink` and `realpath` equal the target; the user's own *dangling* link of that name is recreated; any other entry (another owner's, or a live link elsewhere) is never used and the next name is tried.
- No administrator rights, no change to HOME, no `~/.apio`, no PATH fallback (the bundle environment is unchanged). Ephemeral: if macOS purges it from `$TMPDIR`, it is recreated on the next toolchain load.

**Unit tests (`tests/hostile-paths.test.ts`, 4):** naming/0700 folder/reuse; a planted live link, another owner's link and own dangling link (only the last is replaced); refusal of a linked/foreign/group-writable alias folder and of a shared `$TMPDIR`, missing/unsafe `TMPDIR`, missing target; and a real-filesystem classroom test with HOME `…/Users/José García 学生/…` (spaces, accents, CJK): the real store stays the toolchain, every executable and `APIO_*` path is ASCII via the alias, the links point to the real toolchain/state folders, the folder is 0700, a second load reuses them.

**Installed-package validation with a hostile HOME** (rebuilt VSIX 0.5.0, private profile/extensions *inside* the hostile home, `HOME=/tmp/nxv home/José García 学生` given to VS Code, the real `$TMPDIR`, quarantined download, hostile environment and decoys as in §17.7):

| Item | Result |
|---|---|
| Data root / install | `<HOME>/Library/NexysVHDL`; Install FPGA Toolchain → `installed` (29.4 s) into the real hostile path |
| Aliases | `$TMPDIR/NexysVHDL-links` (drwx------, user) with two user-owned links: `f9acc684…` → `…/José García 学生/Library/NexysVHDL/toolchains/darwin-arm64/1.0`, `01be80d7…` → `…/state/darwin-arm64-1.0` |
| Environment | every tool path, `APIO_HOME`, `APIO_PACKAGES`, `APIO_REMOTE_CONFIG_URL` under `/var/folders/…/NexysVHDL-links/…`; PATH = OS folders only |
| Show Environment | *Ready*; all six tools `compatible`; programmer *Ready (bundled)* |
| Check → Problems → RTL Schematic → Simulate → Build | passed (top/top_tb) → error at 32:26 shown/cleared → AND → `led0` linked to `src/top.vhd:32:19` → 33 checks @ 660 ns → **57 LUT / 27 FF, PASS 391.54 MHz**, 3.6 MB bitstream |
| Verify Toolchain after the workflow | ok, 31,699 entries (`f0402218…`) |
| Process trace | every FPGA executable launched via the alias and resolving into the hostile-home Toolchain 1.0; no Homebrew, `/usr/local`, `~/.apio`, `/Applications/Apio`, compiler/linker or other Python; decoys unused |
| External state | `~/.apio`, `/Applications/Apio`, developer GHDL **and the real `~/Library/NexysVHDL`** unchanged (content and timestamps); writable state only `cached-remote-config.json` |

**Regression with the normal HOME** (same rebuilt VSIX, fresh profile): no alias is made (ASCII store); setup Ready (`already-installed`), Check/Simulate/RTL/Build pass (57/27, 391.54 MHz), Verify after the workflow ok (31,699). *Note:* a first regression run reported `TOOLCHAIN_MODIFIED`: 17 `prjxray/__pycache__/*.cpython-312.pyc` files had been written into the real store at 20:04 by a manual `fasm2frames` re-check run during the relocation audit (§17.4) **without** `PYTHONDONTWRITEBYTECODE` — not by NexysVHDL. Verify Toolchain detected it as designed; the 17 files were removed (no original file had changed) and the rerun verified clean.

### 17.15 NexysVHDL's own license: Apache-2.0

- `LICENSE`: the canonical Apache License 2.0 text (unmodified copy of `https://www.apache.org/licenses/LICENSE-2.0.txt`, SHA-256 `cfc7749b…bc523d30`, pinned by a test).
- `NOTICE`: NexysVHDL, `Copyright 2026 Walid Dyab`, EMXplore as the project/publisher, the license, and an explicit statement that the separately distributed toolchain's components are **not** licensed under Apache-2.0 and keep their own licenses (GPL/LGPL included).
- `package.json` `license: Apache-2.0` (was `UNLICENSED`); README "License" section; CHANGELOG; VSIX readme; `THIRD_PARTY_NOTICES.md` states that Apache-2.0 covers NexysVHDL's own code (and NexysVHDL-authored toolchain files such as the manifest, pinned Apio config and notices) and that third-party software is not relicensed.
- Packaging: `vsce` now checks the license (no `--skip-license`); `.vscodeignore` ships `LICENSE` (vsce stores it as `extension/LICENSE.txt`) and `NOTICE`; `package:mac`/`package:win` require both, verify the shipped license text equals `LICENSE`, and copy both into the classroom folder/zip.
- The toolchain archives are unchanged (no rebuild; Windows `43b3fb80…` and macOS `f0402218…` content hashes unchanged).
- This resolves only NexysVHDL's own-license item. **Redistribution/license stays NOT READY** (§17.10).

Rebuilt Mac artifacts after §17.14/§17.15: VSIX 243.0 KiB (248,794 B, 129 files, incl. `LICENSE.txt`, `NOTICE`; SHA-256 `5c1ae73a…`; runtime byte-identical to the VSIX validated in §17.14, only CHANGELOG and the student guide text differ); toolchain archive unchanged (`d8cdf6e2…`); classroom ZIP 594.7 MiB (adds LICENSE, NOTICE). Tests: **420/420**.
