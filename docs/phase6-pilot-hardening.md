# Phase 6 — Pilot hardening (working notes, not released)

Scope: the VS Code extension, its orchestration and its tests. **Toolchain 1.0 is release-frozen and was not touched**: no file under `toolchain/`, `toolchains/bundle/`, the installed `%LOCALAPPDATA%\NexysVHDL\toolchains\…\1.0` store, `requirement.json` or the recipes changed; the package tests that pin the Toolchain 1.0 content hashes still pass. The extension version is unchanged (0.5.0); the public number is decided after pilot validation.

## Bugs fixed

| Pilot finding | Cause | Fix |
|---|---|---|
| A top entity `DigitDisplay` failed with `GHDL_SYNTH_NO_TOP` although GHDL succeeded | VHDL identifiers are case-insensitive, Verilog module names are not; the code looked for the lower-cased name | `resolveTopModule()` matches the configured top case-insensitively and `SynthesisResult.topModule` keeps the module **as GHDL spelled it**. Build passes it to the port/XDC check and to Apio (`top-module`, primitive count); the RTL path passes it to Yosys `hierarchy -top`; the RTL model picks its top case-insensitively. Students are never asked to lower-case entity names. |
| Four simultaneous Builds collided on `.nexysvhdl/check` and `synth` (Windows `EBUSY`) | Nothing prevented concurrent pipeline runs; the service's busy test ran before its first `await` completed | Two layers. Core: `withProjectLock()` (`core/workflow/project-lock.ts`), a per-project single-flight claim taken synchronously, used by `WorkflowController.check/simulate/build/rtl` and `CoreBackend.program`; a refused request returns `PIPELINE_BUSY` ("Build is already running.") and starts nothing; released in `finally`. Service: `NexysVhdlService.exclusive()` takes the same kind of claim before any `await`; commands call `ensureFree()` before opening progress UI. |
| A testbench with a free-running clock and `wait;` ran until the 120 s time-out | GHDL only stops at `std.env.stop` or a stop time | Optional `simulation.stopTime` (GHDL `--stop-time`), set from **Project → Simulation length** or *NexysVHDL: Set Simulation Stop Time…*; absent by default, so existing projects behave exactly as before. A time-out now reports `SIM_NO_END` with the two remedies. |

## Features

- **Design view** replaces *Project Files* and *Design Hierarchy*: modes *Files* (default; `+ Add File` first) and *Hierarchy*, remembered per workspace. The two old tree classes are reused unchanged inside it.
- **+ Add File**: Source (`src/*.vhd`), Simulation Testbench (`sim/*.vhd`), Constraint (`constraints/*.xdc`); Create New or Copy From Computer (physical copy, never an external path); only `.vhd`/`.xdc`; Replace / Rename / Cancel on collisions (case-insensitive); VHDL-2008 skeletons (testbench ends with `std.env.stop`); an existing active XDC is never switched silently; the new file opens in the editor. Rules live in `extension/project/add-file.ts` (no VS Code API).
- **NexysVHDL Classroom appearance**: optional color theme; first-use question (`Use NexysVHDL Classroom Appearance` / `Keep My VS Code Appearance`), workspace scope only, two commands to switch, setting `nexysvhdl.promptForClassroomAppearance`. Logic in `extension/appearance/appearance-manager.ts`; its settings port can only write the workspace value.
- **Waveform Display As**: Binary / Hex / Unsigned Decimal / Signed Decimal per signal (BigInt, exact at any width), integers numeric by default, metavalues never turned into numbers (`U`, `X`, `Z`, `W`, `L`, `H`, `-` shown), choices remembered in workspace state. The VCD parser keeps the metavalues in a side table (`VcdModel.raw`) so existing trace data is unchanged. No change to GHDL or its output.

## Verification

- `npm test`: see the final report. New suites: `tests/phase6-core.test.ts`, `tests/extension/phase6-service.test.ts`, `tests/extension/phase6-ui.test.ts`; real GHDL fixture `tests/fixtures/ghdl/numeric-types.vcd`.
- Real Extension Development Host run (not part of `npm test`): `tests/integration/run-phase6.ts` + `phase6-suite.ts`, against a multi-file mixed-case `DigitDisplay` project, with the installed Toolchain 1.0 (check, simulate with `--stop-time`, RTL, full Build to a bitstream, 4 simultaneous Builds).
- Not verified: programming a physical board (unchanged code path; `CoreBackend.program` only gained the lock), macOS (nothing in Phase 6 is platform-specific; see the report).
