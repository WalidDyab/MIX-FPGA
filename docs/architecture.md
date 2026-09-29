# NexysVHDL architecture

Status: Phase 3C (platform adapters integrated). Applies to branch `phase3/integration` and later.

## 1. Objective

NexysVHDL gives students one VHDL-first workflow for the Digilent Nexys A7-100T that works the same on Windows x64 and Apple-silicon macOS. It covers editing, simulation, synthesis, implementation and programming, with the same project format, commands and results on both platforms.

Phases 1–2 proved the backend (GHDL → generated Verilog → Apio/Yosys/nextpnr-xilinx/Project X-Ray → real board) on both platforms. Phase 3 turns that into a product. The first step is a platform-neutral core that the CLI uses now and a VS Code extension will use later.

## 2. Layers

```
                ┌──────────────────────────┐   ┌───────────────────────────┐
  consumers     │  cli/  (nexysvhdl …)     │   │  VS Code extension (later) │
                └────────────┬─────────────┘   └─────────────┬─────────────┘
                             │  composition root: picks providers, injects them
                ┌────────────▼──────────────────────────────▼─────────────┐
  shared core   │ core/                                                    │
  (TypeScript,  │  project  board  toolchain  workspace  workflow  results │
  no platform   │  process (ToolRunner)   programming (contract + service) │
  code)         │  vhdl/ghdl (VhdlProvider)  implementation/apio            │
                └───────┬──────────────────────────────┬─────────────────┘
                        │ PlatformServices: runner, ToolLocator,
                        │ ProgrammerProvider, inspectToolchain
                ┌───────▼─────────────┐        ┌───────▼─────────────┐
  platform      │ platform/windows/   │        │ platform/macos/     │
  adapters      │ win32/x64: djtgcfg  │        │ darwin/arm64:       │
                │ base runner as-is   │        │ openFPGALoader,     │
                │                     │        │ Apio-pinned runner  │
                └───────┬─────────────┘        └───────┬─────────────┘
                        │ spawn (argument arrays, no shell)
  external      GHDL · Apio → Yosys → nextpnr-xilinx → Project X-Ray · board programmer
  tools
  data          boards/<id>/board.json · toolchains/*.json · <project>/nexysvhdl.json
```

Dependencies point downwards only. `core/` never imports from `platform/` or `cli/`, and it contains no platform branches. `tests/architecture.test.ts` enforces both rules.

## 3. Shared core (`core/`)

| Module | Responsibility |
|---|---|
| `results/` | `Diagnostic`, `LogRef`, `OperationStatus`, `OperationResult`, `BuildArtifact` |
| `process/` | `ToolRunner` interface + `NodeToolRunner` (spawn, argument arrays, cwd, env overrides, timeout, AbortSignal) |
| `project/` | `ProjectFile` / `Project` model, `loadProject()`, `validateProject()` |
| `board/` | `BoardDefinition` model, `BoardRegistry` (loads JSON), `generateXdc()` |
| `toolchain/` | Tool ids, expectations vs detections, `evaluateCompatibility()`, version parsers, manifests, `ToolLocator`, `ToolDetector` |
| `workspace/` | `WorkspaceManager` / `BuildWorkspace`: isolated per-project build folder and staging |
| `vhdl/` | `VhdlProvider` contract; `ghdl/` = GHDL implementation + output parser |
| `implementation/` | `ImplementationProvider` contract, utilization/timing models; `apio/` = Apio implementation + report parsers |
| `programming/` | `ProgrammerProvider` contract, `ProgrammingService` (target selection, canonical-bitstream protection) |
| `workflow/` | `WorkflowController` (check / simulate / build), `BuildResult` |

Every dependency is passed in through a constructor. There is no DI framework and no global mutable state.

The GHDL and Apio providers live in the core, not in `platform/`. They only need an executable path, and they behave identically on both platforms. Only *finding* those executables differs per platform, and that is what `ToolLocator` covers.

## 4. Project model

A student project is a folder with a `nexysvhdl.json`:

```json
{
  "name": "nexys-a7-counter",
  "board": "nexys-a7-100t",
  "language": "vhdl",
  "standard": "2008",
  "top": "top",
  "sources": ["src/counter.vhd", "src/top.vhd"],
  "simulation": { "sources": ["sim/counter_tb.vhd"], "testbench": "counter_tb" },
  "pins": { "clk100mhz": "CLK100MHZ", "btnc": "BTNC", "led0": "LED0" },
  "toolchain": { "manifest": "…optional…", "tools": { "ghdl": "…optional explicit path…" } }
}
```

- Paths are project-relative with `/`. Absolute paths, `\`, and paths that escape the project are rejected.
- `pins` maps top-level port names to board resource ids. Students never write XDC or `apio.ini`; NexysVHDL generates both.
- `validateProject()` returns every problem as a structured `Diagnostic` with a stable code, e.g. `PROJECT_MISSING_TOP`, `PROJECT_BOARD_UNSUPPORTED`, `PROJECT_NO_SOURCES`, `PROJECT_SOURCE_NOT_FOUND` or `PIN_RESOURCE_UNKNOWN`.
- See `examples/nexys-a7-counter/`, which holds the Phase 2 design.

## 5. Board model

`boards/<id>/board.json` (schema version 1) describes the FPGA (`device`, open-toolchain `part`), backend ids (e.g. `apio`), identification hints and a list of **resources**. Each resource has an `id`, a `kind`, `pins` (one pin, or N for an N-bit bus), an `ioStandard`, and an optional `clock.frequencyHz`.

Only resources proven on hardware are populated today: `CLK100MHZ` (E3, 100 MHz), `BTNC` (N17), `SW0` (J15) and `LED0` (H17). More switches, LED buses, seven-segment, UART and Pmods are added as data. Bus resources are already supported by `generateXdc()` (`port[i]`), so no orchestration code changes.

`generateXdc()` emits `[get_ports {name}]` with no spaces inside the braces (the form Phase 2 showed nextpnr-xilinx requires). For clock resources it emits `create_clock -name <port> -period <ns>`.

## 6. External toolchain boundary

All external programs run through `ToolRunner.run({ executable, args[], cwd, env, timeoutMs, signal })`:
- `spawn` with `shell: false`, so paths with spaces stay single arguments and no cmd/PowerShell/bash syntax exists anywhere in the core.
- Failures are values, never exceptions: `outcome` is one of `exited | timed-out | cancelled | spawn-failed`.
- Tests substitute a fake runner.
- Windows `.bat`/`.cmd` launchers can't be run without a shell; adapters must locate real executables.
- **One configured runner per host.** The composition root creates a base `NodeToolRunner` and gives it to the platform factory. If the adapter returns `PlatformServices.runner`, that runner replaces the base runner for *every* tool: `ToolDetector`, GHDL, Apio, the programmer and doctor inspection.
  - macOS returns a `PinnedApioRunner`. It adds `APIO_REMOTE_CONFIG_URL` to each Apio call, and refuses Apio if the pin cannot be expressed.
  - Windows returns none and uses the base runner unchanged.
  - No `process.env` mutation and no shell profiles are involved.

## 7. Isolated implementation staging (ADR-001)

```
student project/                         <project>/.nexysvhdl/      (build workspace)
  nexysvhdl.json                           check/   GHDL library + elaboration output of `check`
  src/*.vhd  ── GHDL (cwd = workspace, ──▶ sim/     GHDL library, elaborated testbench, *.ghw
  sim/*.vhd     absolute source paths)     synth/   GHDL library, generated.v
                                           impl/    ◀── the ONLY folder Apio sees
  (stray *.v, *.xdc are harmless)                    generated.v  generated.xdc  apio.ini
                                                     _build/default/hardware.bit   (canonical)
                                           program/ prepared programming artifacts
                                           logs/    raw tool logs
```

Every GHDL run uses its step's workspace folder as working directory and gets absolute source paths. With GHDL's LLVM/GCC backends (macOS), `-e` writes native executables and `e~*.o` objects into the working directory, so they now stay in `check/` or `sim/`; they never land in the student's tree. `simulate` elaborates (`-e`) before running (`-r`) in `sim/`. Diagnostics are mapped back to project-relative paths.

`BuildWorkspace.stageImplementation()` deletes and recreates `impl/`, writes exactly the requested files, and then verifies the folder holds nothing else. Apio runs with `cwd = impl/`.

The workspace must not be the project root and must not contain any project source (`checkIsolation()`).

This was verified with a real build: a project in a path with spaces, containing a stray duplicate-module `.v` and an extra `.xdc`, built successfully. The same situation broke the build in Phase 2.

## 8. Structured results

Each operation returns an `OperationResult`: `status`, `diagnostics`, `logs`, `durationMs`.

| Result | Adds |
|---|---|
| `VhdlCheckResult` | `elaborated[]` |
| `SimulationResult` | `testbench`, `passed`, `stoppedAt`, `messages[]`, `waveform` |
| `SynthesisResult` | `top`, `modules[]`, `generatedVerilog` |
| `ImplementationResult` | `part`, `bitstream` (canonical), `utilization`, `timing`, `stagedFiles[]` |
| `BuildResult` | `success`, `steps[]` (per-step status + time), `board`, `bitstream`, `generatedVerilog`, `utilization`, `timing`, all diagnostics and log refs |
| `ProgrammingResult` | `destination`, `target`, `artifact` |

`ResourceUtilization` carries LUT/FF/BRAM/DSP/carry/IO/global-clock counts, plus primitive totals and every placer resource verbatim for advanced views. `TimingResult` carries per-clock target/achieved MHz, worst slack, critical path and overall pass/fail.

A build whose timing fails is **not** a successful build, even if a bitstream exists. A capability with no provider reports `not-configured` and is never a success.

## 9. Toolchain version control (ADR-004)

- `ToolExpectation` (what a manifest says was tested) and `DetectedTool` (what is installed) are separate types. Only `evaluateCompatibility()` relates them, and it gives `compatible | incompatible | unknown | missing`.
- `toolchains/*.json` holds tested combinations per host. There are currently two **reference** manifests recorded from Phase 2 (Windows x64, macOS arm64). A release matrix is not chosen yet.
- `ToolDetector` probes GHDL, Apio, Yosys and nextpnr-xilinx (the last two via `apio raw --`) through a `ToolLocator`.
- openXC7 package metadata and the programmer backend are detected by platform adapters.
- `doctor` shows the adapter's `PlatformServices.inspectToolchain()` result, which uses the shared `DetectedTool` model plus diagnostics. Without an adapter it falls back to `ToolDetector`. `doctor` itself never names a platform tool.

## 10. Programmer abstraction (ADR-002)

```ts
interface ProgrammerProvider {
  availability(): Promise<ProgrammerAvailability>;
  detectBoards(board): Promise<{ boards: DetectedBoard[]; diagnostics }>;
  prepareArtifact({ canonical, board, outputDir }): Promise<ProgrammingArtifact>;
  program({ artifact, target, board, destination: 'volatile' }): Promise<ProgrammingResult>;
}
```

- `DetectedBoard` carries an opaque provider `selector`, plus `serialNumber`, `productName` and the recognised `boardId`.
- `ProgrammingArtifact` is always a separate object from the canonical `BuildArtifact`. It has a `transformation`, which is `none` when the canonical file is used as-is.
- `ProgrammingService` checks availability and selects the target: by serial number, or the single matching board; it never guesses among several.
- It also hashes the canonical `hardware.bit` before and after `prepareArtifact()`. It refuses to program if the canonical file changed, or if a transformed artifact claims the canonical path.
- A provider exception at any stage becomes a failed `ProgrammingResult` with diagnostics; exceptions never escape. A provider may throw `ProgrammingError(diagnostics)` to keep its own structured diagnostics (e.g. a malformed bitstream).

## 11. Windows/macOS separation

`platform/index.ts` is the single place that maps a host to an adapter, by platform **and** architecture:

| Host | Adapter |
|---|---|
| `win32/x64` | Windows: Digilent Adept `djtgcfg` programmer, Windows tool discovery |
| `darwin/arm64` | macOS: openFPGALoader programmer, arm64 discovery, pinned Apio runner |
| anything else (incl. `darwin/x64`, i.e. Intel or Rosetta) | `unsupported`, with a reason |

A factory receives `PlatformContext { runner, env }` and returns `PlatformServices`:

| Field | Meaning |
|---|---|
| `id`, `displayName`, `status` | Adapter identity and one-line state |
| `runner?` | The configured runner |
| `toolLocator?` | Tool discovery |
| `programmer?` | The `ProgrammerProvider` |
| `inspectToolchain?` | Toolchain inspection for `doctor` |

A missing capability reports *not configured*.

Explicit tool paths already work on every platform, through `nexysvhdl.json` → `toolchain.tools` or `NEXYSVHDL_<TOOL>` environment variables.

## 12. CLI

`cli/` is a thin consumer. It builds the context (host → adapter → configured runner → locators → providers → `WorkflowController`), runs one command and prints structured results. Tests inject `ContextOverrides` (fake host, fake platform, a runner that refuses everything), so `npm test` never reaches host tools. `tests/test-isolation.test.ts` enforces this. The commands are `doctor`, `boards`, `project info`, `check`, `simulate`, `build [--simulate] [--json]` and `program [--serial]`.

Exit codes: 0 ok, 1 failed, 2 usage/project error, 3 provider not configured. `runCli()` is exported for tests.

## 13. Future VS Code UI

The extension will import `core/` directly and replace the CLI's composition root with its own. It will render `BuildResult`/`Diagnostic` objects (Problems panel, status bar, utilization/timing views) and open `LogRef` paths for debug views. Cancellation already flows through `AbortSignal`. No GUI work starts before the Phase 3B adapters are merged.
