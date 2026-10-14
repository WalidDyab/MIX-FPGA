# Phase 3 — Windows DE10-Lite integration (MIX-FPGA)

Branch `phase3/windows-de10-integration`, based on `main` = `539912b428ab7344eab0c7ba6ef85965eb8bec31`
("Phase 2: integrate Nexys A7 and DE10-Lite backends"). Nothing committed or pushed in this phase.

**Status: complete, awaiting review.** Windows DE10-Lite Build and Program validated; Nexys A7 physical programming regression still open (no Nexys board was available).

## A. Baseline (2026-10-14)

* `main` = `539912b`, tree clean, branch `phase3/windows-de10-integration` at the same commit.
* `npm ci` was needed first (`node_modules` absent). `npm test` on Windows: **864 tests, 861 pass, 1 fail, 2 skipped**
  (log `.artifacts/logs/P3-baseline-test.log`). The one failure, `MIX-FPGA DE10 backend independence › defaults every tool path…`,
  asserted macOS `/` path strings and fails on any Windows host; it fails identically on `main`. The yardstick on macOS was 864/863/0/1.
* Nexys A7 on Windows through the real VS Code Extension Development Host (`tests/integration/multiboard-suite.ts`, `MIXFPGA_STAGE=nexys`
  `MIXFPGA_NEXYS_BUILD=1`, report `.artifacts/logs/P3-A-nexys-windows-edh.json`): Environment Ready (Bundled FPGA Toolchain, Digilent USB/JTAG),
  Check passed, Simulate passed (stopped at 280 ns), RTL schematic ready, **Build PASS 25.7 s** (56 LUTs, 27 FFs, 409.67 MHz, +7.6 ns, `hardware.bit` 3.6 MB),
  hardware: none connected. The suite needed a Windows branch (it assumed `$HOME`/`limactl`); that is a test-only change.
* Installed Windows FPGA tools: NexysVHDL 0.6.0 + Toolchain 1.0 (`%LOCALAPPDATA%\NexysVHDL\toolchains\win32-x64\1.0`, untouched), Digilent Adept 1.9.18 / djtgcfg 2.7.1,
  Vivado ML 2024.1, **Quartus Prime Lite 23.1std Build 991** (`C:\intelFPGA_lite\23.1std`, no MAX 10 package), Altera USB-Blaster drivers (see F).

## B. MIX-FPGA-owned Windows toolchain

`toolchains/mixfpga/windows-x64.json` + `scripts/mixfpga/assemble-windows.mjs` (copies from Toolchain 1.0 as a provenance source only, byte-for-byte; the PE import
tables decide which DLLs travel) + `scripts/mixfpga/toolchain.mjs record|verify windows-x64` (file hash + whole-folder tree hash).
Runtime location (development): `toolchains/experimental` (git-ignored) or `$MIXFPGA_TOOLCHAIN_ROOT`. All binaries are x86-64 and start with only the Windows system folders on PATH.

| Component | Version | Files | exe sha256 | Upstream |
|---|---|---|---|---|
| GHDL (mcode, UCRT64, GNAT 15.2.0) | 6.0.0 | 119 | `5bb01f50…` | github.com/ghdl/ghdl v6.0.0, `ghdl-mcode-6.0.0-ucrt64.zip` sha256 `76e160ce…` |
| Yosys | 0.63+173 (66306a8ca) | 362 | `1d5532cd…` | YosysHQ OSS CAD Suite via FPGAwars tools-oss-cad-suite 2026-09-15, archive sha256 `7e221239…` |
| openFPGALoader | 1.1.1 (rev 451beadf) | 119 | `5500a7ee…` | same OSS CAD Suite archive |

Licenses: GHDL GPL-2.0-or-later (+ GCC runtime exception for libgnat/libgcc); Yosys ISC (+ readline GPL-3.0, Tcl, libffi, libstdc++ exception); openFPGALoader Apache-2.0 (libusb/libftdi LGPL-2.1, hidapi).
Source offer for GHDL, and the readline/hidapi/libusb notices, remain release-time work. Total 192 MB. Full hashes are in the manifest.

## D. Architecture (shared Quartus engine, host executors)

```
BoardProfile            core/backend/types.ts, boards/<id>/board.json   (hosts: macos-arm64, windows-x64)
ConstraintProvider      core/backend/qsf-sdc.ts
ImplementationProvider  core/implementation/quartus/provider.ts   QuartusImplementationProvider  (id "quartus", ALL platform-neutral logic)
   └ QuartusExecutor    install / run / collect / killTools       (the only host seam)
        ├ macOS:   platform/macos/de10/quartus-lima-provider.ts   LimaQuartusExecutor   -> LimaEngine (VM, Rosetta)
        └ Windows: platform/windows/de10/quartus-native-executor.ts NativeQuartusExecutor -> NativeQuartusEngine (native Quartus)
ProgrammingProvider     platform/shared/native-jtag.ts  NativeJtagProgrammer (openFPGALoader, SVF) — shared; Windows decision pending (F)
FamilyRuntime           core/backend/flow.ts  (macOS De10Runtime, WindowsDe10Runtime) — the only host switch is runtime/multiboard.ts
```

* The macOS Lima code was cut into the shared provider; its guest commands are byte-identical, and the macOS fake-VM suite (all of `tests/mixfpga`, `tests/multiboard`) passes unchanged.
* Implementation provider id is now the neutral `quartus` (was `quartus-lima`) in `boards/de10-lite/board.json` and `profiles.ts`; `ProviderRegistry.supportsHost` treats an unknown host as unsupported for a board that lists hosts.
* Windows "engine" = the native Quartus install: nothing to start; `ensureReady` proves version `25.1std.0 Build 1129` and the MAX 10 device folder. The UI row stays "FPGA Engine".
* Quartus tools run by full path with `QUARTUS_ROOTDIR` and the install's `bin64` first on PATH, in a per-build job folder `%LOCALAPPDATA%\MIX-FPGA\staging\jobs\<project>-<hash>-<rand>`.
* Tests: `tests/windows-de10/` (28 new), `tests/backend/board-profiles.test.ts` and `tests/multiboard/router.test.ts` adapted (provider id, unsupported-host = Linux), the macOS-path assertion in `tests/mixfpga/independence.test.ts` made separator-neutral.

## C. Quartus Prime Lite 25.1 on Windows (installed 2026-10-14)

* Installer `QuartusLiteSetup-25.1std.0.1129-windows.exe` (1,752,505,168 B) + `max10-25.1std.0.1129.qdz` (302,078,437 B, sha256 `8057844b…19ce9`, same as macOS). The Altera license was accepted by the user.
* Command (`D:\Software\Intel-Altera\25.1\install25.cmd`, run elevated with a UAC click; the installer refuses to run unelevated): `--mode unattended --unattendedmodeui none --accept_eula 1 --installdir C:/intelFPGA_lite/25.1std --create_desktop_shortcuts 0 --disable-components quartus_help,arria_lite,cyclone,cyclone10lp,cyclonev,max,quartus_update,riscfree,questa_fse,questa_fe`. Return code 0. Quartus 23.1 untouched. The GUI was never launched.
* Footprint 8.82 GB (83,246 files); `quartus` 3.86 GB, `devinfo` 0.93 GB. All of `quartus_sh/map/fit/sta/asm/cpf/pgm` report `Version 25.1std.0 Build 1129 10/21/2025 SC Lite Edition`. `get_part_list -family {MAX 10}` lists 271 parts including `10M50DAF484C7G`.
* Installer side effects: a Windows Firewall rule for `jtagserver.exe`, the user variable `QSYS_ROOTDIR`, a `vcredist2022` run that exited 1638 (a newer runtime was already present). Drivers unchanged.
* MAX 10 readiness is asked of Quartus (`quartus_sh -t part-check.tcl`: `load_package device`, `get_part_list -family {MAX 10}`, exact part); MAX 10 data lives under `devinfo\55nm`, so folder layout is never consulted. `--tcl_eval` cannot carry a multi-statement script (found only by the real run).

## E. Real Windows build (DE10-Lite starter project, VS Code Extension Development Host)

Check, Simulate (1320 ns), Design/RTL schematic, Build all pass; Quartus 25.1 Build 1129, `Device: 10M50DAF484C7G`, `clk=P11`, `led0=A8`, QSF/SDC generated as on macOS, student sources byte-identical, only Quartus tools started (no Lima), not elevated.
28 Logic Elements, 26 Registers, 0 Memory Bits, 0 DSP, 4/360 pins, Fmax 311.53 MHz (target 50), setup +16.8 ns, hold +0.17 ns — identical to macOS. Build times (host-dependent): 64.3/56.8 s, 68.8/50.3 s, 41.7/38.8 s cold/warm over three sessions (macOS 34/27 s).

## F. Windows programming

* The DE10-Lite USB-Blaster is `USB\VID_09FB&PID_6001`, bound to Altera's own kernel driver (`AlteraUSBBlaster`, `oem11.inf` = usbblstr.inf 2.12.28.0), not WinUSB. openFPGALoader cannot open it (libusb -12, ftdi -4) and would need a driver swap, which classroom use rules out.
* `quartus_pgm -l` and `jtagconfig` see `USB-Blaster [USB-0]` and IDCODE `031050DD`. `quartus_pgm -c "USB-Blaster [USB-0]" -m jtag -o "p;top.sof@1"` exits 0 ("Configuration succeeded -- 1 device(s) configured"), ~4 s, unelevated. Physical behaviour confirmed by the user (SW0, LEDR0, KEY0) for the manual run and for the integrated VS Code Program command: **PASSED**.
* Windows: `QuartusPgmProgrammer` (`platform/windows/de10/quartus-programmer.ts`) + `.sof`; macOS: openFPGALoader + `.svf`; both are role id `native-jtag` and declare `artifactFormat`. A Quartus build always yields typed `.sof` and `.svf` (`build-info.json` schema 2 has every hash); Program uses the manifest hash, so an overwritten file is refused. openFPGALoader is removed from the Windows toolchain.

## G. Integrated validation (Nexys A7 → DE10-Lite → Nexys A7, one user-data folder, three real VS Code launches)

| | Nexys A7-100T | DE10-Lite | Nexys A7-100T |
|---|---|---|---|
| Board / constraints | `.xdc`; Add File: Source, Simulation Testbench, Constraint | `.qsf`+`.sdc`; Add File adds Constraint: Pins (QSF) / Clock (SDC) | same as first |
| Environment | Bundled FPGA Toolchain, Digilent USB/JTAG | Board, VHDL Tools, FPGA Engine, Programmer (Quartus) | same as first |
| Check / Simulate / RTL | pass / 280 ns / ready | pass / 1320 ns / ready | same as first |
| Build | 24.6 s, 56 LUTs, 27 FFs, 409.67 MHz, +7.6 ns, `hardware.bit` | 41.7 s cold, 38.8 s warm, 28 LE, 26 Reg, 311.53 MHz, `top.sof` | 23.5 s, identical to first |
| Hardware | none (no Nexys board attached) | one DE10-Lite | none |

No `.mix-fpga` folder in the Nexys project, Toolchain 1.0 has no file modified after its install, no Lima/openFPGALoader process. Nexys A7 physical programming regression: **not run — no Nexys board available.**

## Cross-platform architecture review

* **Board-independent:** `BoardProfile`/`ProviderRegistry`/`BoardFlows`/`FamilyRuntime`, normalized build/program results, the whole UI and router (`extension/services/multiboard-backend.ts`), GHDL/Yosys check-simulate-RTL flow, project/`.nvproj` model.
* **Vendor-independent:** the contracts in `core/backend/types.ts`, `ConstraintProvider` selection, `ProgrammingFormat` typing, results labels from board data.
* **Quartus-specific, platform-independent:** `core/implementation/quartus/{provider,parsers}.ts` (staging, QSF/SDC, hashing, chain, parsing, stale/artifact manifest, cancellation), `core/backend/qsf-sdc.ts`.
* **macOS-specific:** `platform/macos/de10` (Lima engine + executor, Rosetta handling, provisioning), openFPGALoader programming (`platform/shared/native-jtag.ts`, used only there).
* **Windows-specific:** `platform/windows/de10` (Quartus discovery, native engine/executor, `QuartusPgmProgrammer`), the owned GHDL/Yosys toolchain assembly.
* **Only OS switch:** `runtime/multiboard.ts` picks the runtime by host key; the UI contains no OS checks.

## Remaining before an installable student product

Installer/packaging and per-user toolchain root (replace repo-relative `toolchains/experimental`); first-run guidance for the Quartus 25.1 + MAX 10 install (~9 GB, student accepts the Altera license; needs administrator once); redistribution notices for the owned tools; ASCII-safe job folder when the Windows user name has non-ASCII characters; investigate the slower native Quartus build times; Nexys A7 physical regression; extension-id/project-file naming migration.
