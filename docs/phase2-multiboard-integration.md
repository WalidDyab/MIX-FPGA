# Phase 2 — multi-board VS Code integration (MIX-FPGA)

Branch `phase2/macos-multiboard-integration`, based on the Phase 1 commit `7d4d26b7d59c08f155e2e838065581b87bea407e`
("Phase 1: prove macOS DE10-Lite backend"). Nothing committed or pushed in this phase.

**Status: Phase 2 complete.** DE10-Lite physical path PASSED (user-confirmed, below). Nexys A7 physical program regression is the only open hardware item.

Goal: the existing NexysVHDL interface (PROJECT / DESIGN / WORKFLOW / HARDWARE / RESULTS, waveform, both schematics, console)
becomes the first multi-board MIX-FPGA interface. No second UI was designed. The board decides everything underneath.

## 1. Architecture

```
 VS Code UI (unchanged views, commands)
        │  NexysBackend interface (unchanged; +optional supportsBoard / verifyEnvironment / restartEngine, +onStatus)
 extension/services/multiboard-backend.ts   MixFpgaBackend   ← the ONLY place that dispatches by board
        │  BoardFlows (core/backend/flow.ts)  ProviderRegistry (core/backend/registry.ts)
 runtime/multiboard.ts  createBoardFlows()   ← composition root; builds providers, never starts a process or the VM
   ├─ original flow (reference, untouched):  runtime/context controllerFor / programmingFor
   │     OpenXC7ImplementationProvider  XdcConstraintProvider  LegacyProgrammingProvider   (core/backend/nexys.ts — adapters)
   └─ Quartus family (macOS arm64):       De10Runtime (platform/macos/de10/runtime.ts)
         MIX-FPGA GHDL + Yosys (check, simulate, RTL), QuartusLimaImplementationProvider, NativeJtagProgrammer, LimaEngine
```

* **Board data is the source of truth.** `boards/<id>/board.json` gained an optional `displayName` and `backend` block
  (`constraints` xdc|qsf-sdc, `implementation`, `programming`, `programmingFormat` bit|svf, `programmerBoardKey`, `jtagIdcode`,
  `metricLabels`, `hosts`). A board without `backend` is the original flow, so the Nexys A7 board file only gained `displayName`.
  `boards/de10-lite/board.json` is new (pins from Terasic's manual).
* **Reference implementation preserved.** The Nexys providers are adapters over the existing `WorkflowController` and
  `ProgrammingService`; they add no logic and return the original result objects as `native`, so Nexys Check/Simulate/Build/Program
  produce what they produced before (progress stream and result forwarded verbatim; only Results wording is unified, see §6).
* **Provider contracts** (Phase 1 proposal, now used by the UI path): `BoardProfile`, `ConstraintProvider`, `ImplementationProvider`
  (`build`, `artifactFor`, `currentInputs`, `selfContained`), `ProgrammingProvider` (`detect`, `program`), `EngineProvider`,
  `NormalizedBuildResult`. `ProviderRegistry` maps a profile to providers and refuses a board on an unsupported host
  (`BOARD_HOST_UNSUPPORTED`: "DE10-Lite is not supported on this computer yet.").
* **No `if board === …` in UI code.** Commands and views read `snapshot.constraintFormat` / `boardName` (derived from board data) and call the backend.
  The router asks the registry; the only per-family knowledge is in `runtime/multiboard.ts` (which VHDL tools a family uses).

## 2. Project schema and migration

The project file already had `board`. What changed is how a missing/malformed value is treated (`core/project/board-resolution.ts`):

| `nexysvhdl.json` | Result |
|---|---|
| `"board": "de10-lite"` / `"nexys-a7-100t"` | used as is (an unknown id is reported by validation) |
| `"board"` not a non-empty string | **error** `PROJECT_BOARD_INVALID` — never guessed |
| `board` absent, has a `pins` mapping or an `.xdc` `constraints` path, and no `.qsf`/`.sdc` in `constraints/` | **Nexys A7-100T**, in memory only (`project.legacyBoardDefault = true`) |
| `board` absent, anything else | **error** `PROJECT_BOARD_MISSING` ("add a board setting …") |

Migration is deterministic, minimal and non-destructive: **no file is rewritten on open** (a test proves the project file is
byte-identical and no backup/temp file appears), so there is nothing to reverse. `.nvproj` is unchanged (still only a launch descriptor).
`createProject` (scripted, no board given) keeps the original Nexys behaviour; the interactive New Project always asks.

## 3. UI behaviour

* **New Project** lists boards from the registry (display names, FPGA device), hides boards the computer cannot support, then scaffolds via
  `extension/project/board-scaffold.ts` (XDC scaffold = the original files; QSF+SDC scaffold = `constraints/de10-lite.qsf` with `DEVICE 10M50DAF484C7G`,
  `.sdc` with the 50 MHz clock, starter `top.vhd`/`top_tb.vhd`). No backend names are shown.
* **Project view** is unchanged: project name, board display name (`DE10-Lite` / `Nexys A7-100T`), Environment.
* **Files / Add File** are board-aware: Nexys offers `.xdc`; DE10-Lite offers *Constraint: Pins (QSF)* and *Constraint: Clock (SDC)*; every `.qsf`/`.sdc`
  in `constraints/` is in use (no "make it active?" question); "Remove from Project" is honoured by validation and by the build.
* **Check / Simulate / Design + RTL Schematic** use the same controller and views for both boards; DE10 projects use **MIX-FPGA's own GHDL 6.0.0 and Yosys 0.63**
  (`toolchains/experimental`, recorded in `toolchains/mixfpga/macos-arm64.json`), not the Nexys toolchain.
* **Build** → `MixFpgaBackend.build()` → the board's `ImplementationProvider`. For DE10: Check (own GHDL), then Quartus in the hidden engine under one project claim;
  student-facing status lines `Preparing FPGA engine… / Preparing the project… / Synthesis… / Fitting… / Timing… / Generating programming file… / Collecting results…`
  (no Lima/Linux words), the Build row shows Synthesis → Implementation → Bitstream; cancellation kills Quartus inside the engine.
* **Results** use the board's words: DE10-Lite `Logic Elements / Registers / Memory Bits / DSP Blocks / I/O pins`; Nexys `LUTs / Flip-Flops / BRAM (36 Kb) / DSP / I/O pins`
  (a Logic Element is never labelled LUT). Timing rows are common: `Timing PASS, Target 50 MHz, Fmax 311.53 MHz, Setup slack +16.8 ns, Hold slack +0.17 ns`.
  Raw vendor reports stay in the build folder and the console/log.
* **Hardware** → the board's `ProgrammingProvider`. DE10: native openFPGALoader, USB never passed to the VM, SRAM (SVF) only, no flash. Program refuses: no artifact
  (`PROGRAM_NO_BITSTREAM`), artifact of another board (`PROGRAM_ARTIFACT_WRONG_BOARD`), design/constraints changed since the build (`PROGRAM_ARTIFACT_STALE`, by SHA-256 of
  every input recorded in `build-info.json`), tampered artifact (`ARTIFACT_CHANGED`), board absent (`BOARD_ABSENT`), wrong chip on the JTAG chain (`UNEXPECTED_DEVICE`).
* **Environment** for DE10-Lite: `Board DE10-Lite / VHDL Tools Ready / FPGA Engine Ready / Programmer Ready / Hardware Connected|Not Connected`; **Details**: GHDL 6.0.0,
  Yosys 0.63, Quartus Prime Lite 25.1std.0 Build 1129, MAX 10 25.1, Lima 2.2.1, Rosetta 2, openFPGALoader 1.1.1. Actions: **Verify Environment** (integrity of owned tools by SHA-256
  against the manifest, then a real Quartus run) and **Restart FPGA Engine**. No other VM control. A DE10 project never shows the Nexys "toolchain not installed" prompt.
* **Console / naming**: `MIX-FPGA Console`, `MIX-FPGA Log`, view container, command categories/titles, welcome text, Problems source, status bar, student-facing messages,
  README/NOTICE/quick-start say MIX-FPGA ("MIX-FPGA is an EMXplore project", Copyright 2026 Walid Dyab, NexysVHDL history acknowledged).
  Internal identifiers (extension id `emxplore.nexysvhdl`, command ids `nexysvhdl.*`, `nexysvhdl.json`, `.nvproj`, `.nexysvhdl/`, class names, theme "NexysVHDL Classroom") are deliberately unchanged.

## 4. Engine lifecycle (lazy)

Nothing starts the VM except Build, Verify Environment and Restart FPGA Engine. Opening a project, the Environment page (it only runs `limactl list` and, if the VM is running,
the Quartus probe), Check, Simulate, Waveform, Design/RTL schematic and Detect do not. Proven twice: unit tests assert no `limactl` call, and in the real VS Code run the VM was
**Stopped before Check/Simulate/Schematics and still Stopped after them**; Build then started it. No auto-start at login, no idle shutdown (proposal for Phase 3).
`ensureReady()` keeps Phase 1's repair of the Rosetta/`rosettad` failure and Quartus smoke test.

## 5. Toolchain ownership (`toolchains/mixfpga/macos-arm64.json`, `scripts/mixfpga/toolchain.mjs record|verify`)

Owned/redistributable (hash-recorded, license + source recorded): GHDL 6.0.0 (GPL-2+ with runtime exception), Yosys 0.63 (ISC), Lima 2.2.1 (Apache-2.0), openFPGALoader 1.1.1
(Apache-2.0; libusb/libftdi LGPL), MIX-FPGA adapters/scripts (Apache-2.0). External, never redistributed by MIX-FPGA: Rosetta 2 (Apple), Quartus Prime Lite 25.1 and the MAX 10
package (Altera). Copies of GHDL/Yosys/openFPGALoader are byte-identical to the validated NexysVHDL Toolchain 1.0 files (sources only read; Toolchain 1.0 verified unmodified).
Nothing packaged or released.

## 6. Tests

| Suite | Tests | Pass | Fail | Skip |
|---|---|---|---|---|
| Original NexysVHDL 0.6.0 (Phase 1 baseline) | 709 | 708 | 0 | 1 |
| Phase 1 additions (`tests/mixfpga`) | 74 | 74 | 0 | 0 |
| Phase 1 baseline total | **783** | 782 | 0 | 1 |
| Phase 2 additions (`tests/backend` 18, `tests/multiboard` 62, +1 in `tests/mixfpga`) | 81 | 81 | 0 | 0 |
| **Phase 2 complete suite** | **864** | **863** | **0** | **1** (same `launcher (Windows)` skip) |

Existing Nexys tests changed (deliberately, product-name/behaviour spec): board list now has two boards; `Digilent Nexys A7-100T` → `Nexys A7-100T` display name; console header,
a command title, the Problems source label and the manifest identity say MIX-FPGA; the NOTICE wording; `ADD_FILE_KINDS` test uses the per-board list. No Nexys behavioural
assertion was weakened. Bugs found by the new tests and fixed: QSF `DEVICE` matched inside `#` comments; removed (excluded) QSF/SDC files were still validated and built;
build chain order now matches the Build row (synthesis → fit → timing → assemble → package, so the stage indicator never steps backwards).

## 7. Real-tool and real-VS-Code validation (2026-10-14, macOS 27, VS Code 1.141.0, Apple M4)

Extension Development Host, three launches sharing one user-data folder: **Nexys → DE10-Lite → Nexys** (`tests/integration/multiboard-suite.ts`, reports in `.artifacts/logs/P2-vscode-*.json`).

| Check | Nexys A7-100T | DE10-Lite |
|---|---|---|
| Project view / board | `Nexys A7-100T` | `DE10-Lite` |
| Constraint files / Add File kinds | `.xdc`; Source, Simulation Testbench, Constraint | `.qsf` + `.sdc`; Source, Simulation Testbench, Constraint: Pins (QSF), Constraint: Clock (SDC) |
| Environment | Bundled FPGA Toolchain Ready, programmer Ready (original) | Board / VHDL Tools / FPGA Engine / Programmer Ready + Details |
| Check, Simulate | passed (660 ns) | passed (1320 ns), engine Stopped before and after |
| Design + RTL schematic | RTL ready | RTL ready, engine still Stopped |
| Build | **PASS 5.8 s** (57 LUTs, 27 Flip-Flops, 372.58 MHz, +7.3 ns, hardware.bit 3.6 MB) | **PASS cold 34.3 s / warm 27.0 s** (28 Logic Elements, 26 Registers, 0 Memory Bits, 0 DSP Blocks, Fmax 311.53 MHz, +16.8 ns, hold +0.17 ns, top.svf 1.7 MB) |
| Hardware | none connected (no Nexys board attached) | DE10-Lite 91d28408 detected |
| Verify Environment / Restart FPGA Engine | "nothing to verify" (no engine) | all steps OK; engine restarted and running |
| Program (SRAM) | **not run: no Nexys board available — physical regression pending** | "FPGA programmed"; **physical PASS confirmed by the user**: SW0 up → LEDR0 blinks at the expected rate, SW0 down → off, KEY0 resets correctly |

Cross-board checks: no `.mix-fpga` folder in the Nexys project; DE10 results/artifacts never offered to the Nexys project; Toolchain 1.0 hashes identical and no file newer after
the Nexys build (the build wrote only to the per-user tool state folder `~/Library/NexysVHDL/state`, its designed location).

## 8. Remaining NexysVHDL names visible to a student

Extension id / publisher.name (`emxplore.nexysvhdl`), command ids and settings keys (`nexysvhdl.*`), `nexysvhdl.json`, `.nvproj`, the hidden `.nexysvhdl/` folder, the theme
"NexysVHDL Classroom" (+ its command), the Nexys toolchain archive/installer file names (`nexysvhdl-toolchain-…`), most of `docs/` (install guides, release notes, phase reports),
the Windows launcher/installer. These need a migration discussion (extension id, project file) before they change.

## 9. Legal / toolchain work remaining

hidapi/zlib/zstd license files and LGPL notices for the openFPGALoader bundle; GHDL source offer for a redistributed copy; Lima/Ubuntu cloud-image notices; Quartus/MAX 10 installation flow
with the student accepting Altera's license themselves (never ours); Rosetta install prompt; decide where the owned toolchain lives for students (per-user data folder instead of
`toolchains/experimental`); sign/notarize anything shipped on macOS.

## 10. Recommended scope for Phase 3

1. Packaging decisions: extension id/project-file naming migration; per-user MIX-FPGA toolchain root (replace the repo-relative dev path) with install/verify UX for the owned tools.
2. First-run engine provisioning for DE10: guided Rosetta + Quartus/MAX 10 install from files the student supplies, with progress and clean-up policy (installer copies, image cache).
3. Idle auto-shutdown policy for the engine (opt-in proposal), and a visible "FPGA engine" status in the Hardware/Environment views.
4. More DE10 examples (switches → LEDs, seven-segment) with a pin-table test against Terasic's manual; QSF/SDC editing helpers.
5. Windows backend for the Nexys flow is unchanged; DE10 on Windows is out of scope until a Quartus-native or VM strategy is chosen.
6. Physical regression on a real Nexys A7 (the one hardware check not done in Phase 2) and a classroom pilot of the DE10 path.

## 11. Closeout checks (2026-10-14)

* Full suite re-run: **864 tests, 863 pass, 0 fail, 1 skipped** (`launcher (Windows)`, platform skip also in the baseline); 200 suites.
* Change set (`git add -n -A`): 80 text files, none over 300 KB; nothing staged (`git diff --cached` empty). `.artifacts/`, `toolchains/experimental/` (GHDL, Yosys, Lima, openFPGALoader),
  `dist/`, `node_modules/` and every `.mix-fpga/` build folder are git-ignored; no FPGA outputs (`.sof/.svf/.pof`), VM files, vendor installers, screenshots or toolchain binaries are in the change set.
* NexysVHDL Toolchain 1.0 untouched: manifest `71241b94…`, `ghdl` `38a99c1c…`, openFPGALoader `99dcde0e…` unchanged, no file newer than the start of the day; `NexysVHDL-repo` clean.
  `scripts/mixfpga/toolchain.mjs verify` confirms MIX-FPGA's own GHDL, Yosys, Lima and openFPGALoader against the manifest.
