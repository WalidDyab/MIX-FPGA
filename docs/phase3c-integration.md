# Phase 3C — cross-platform integration

Date: 2026-09-29/30
Branch: `phase3/integration`. It is not merged into `main`.
Integration host: Windows 11 Home 10.0.26200 x64, Node 24.13.0.

**Windows result: PASS.**
- The ordinary CLI (no overrides) ran `doctor` (all compatible), `check`, `simulate`, `build` (timing PASS) and `program`.
- The physical LED0/BTNC check was confirmed by the user.
- The student tree was unchanged.

**macOS: real validation still required** (§12).

## 1. Starting point

| | Commit |
|---|---|
| Frozen baseline (`main`) | `80d073d3bbffa3737d55e495ffb5396d1d0c084f` |
| Windows Phase 3B (`phase3/windows`) | `4539f9c3ae30663363b71f141792f95189cc07a4` |
| macOS Phase 3B (`phase3/macos`) | `01ada8b80fff278a1b571fbfbcf9941ba789a7af` |

## 2. Merge results

- `origin/phase3/windows`, then `origin/phase3/macos`, were merged into `phase3/integration` with `--no-ff`. Both Phase 3B commits are preserved unchanged.
- **Conflicts: none.** Ownership was disjoint: `platform/windows/**`, `platform/macos/**`, the tests under `tests/platform/<os>/` and the per-platform docs.
- Pre-integration check: `npm run typecheck` was clean, and `npm test` gave **194/194** (91 baseline + 52 Windows + 51 macOS).

## 3. Shared issues found in Phase 3B and fixed here

| # | Issue | Fix |
|---|---|---|
| 1 | The CLI gave providers a plain `NodeToolRunner`, so the macOS Apio pin could not reach them | Platform-configured runner (ADR-005) |
| 2 | CLI tests used the host registry and could run real tools (on macOS this replaced an FPGA package) | Injected fake host, platform and runner; process trap; regression test |
| 3 | Both real adapters existed but only as inert entries | Registry keyed by platform/arch; real adapters registered |
| 4 | GHDL used the project root as cwd, so LLVM output landed in the student's tree (ADR-001 violation) | GHDL cwd = workspace folder, absolute sources |
| 5 | A `prepareArtifact()` exception escaped `ProgrammingService` | Every provider exception becomes a failed `ProgrammingResult` |
| 6 | `doctor` could not show openXC7 or the programmer | `PlatformServices.inspectToolchain()` |

### 3.1 Runner and environment (Issue 1)

```
createContext():
  baseRunner = overrides.runner ?? new NodeToolRunner()
  platform   = overrides.platform ?? createPlatformServices(host, { runner: baseRunner, env })
  ctx.runner = platform.runner ?? baseRunner      ← used for detection, GHDL, Apio, doctor
  (the adapter built its programmer/inspector on the same runner)
```

- **Windows** returns no `runner`, so the base runner is used unchanged. The macOS Apio pin is never applied on Windows.
- **macOS** returns its `PinnedApioRunner`. Every invocation whose executable is named `apio` gets `APIO_REMOTE_CONFIG_URL=file://<repo>/toolchains/apio-remote-config/apio-{major}.{minor}.x.jsonc`. If that URL cannot be formed, the invocation is refused with `spawn-failed` and never runs unpinned.
- The factory receives the base runner instead of the root calling a later `configureRunner()`. That way the adapter's programmer and inspector are guaranteed to share the configured runner.

### 3.2 CLI test isolation (Issue 2)

`tests/helpers.ts` provides:

| Helper | What it does |
|---|---|
| `TEST_HOST` | A fixed fake host (`win32/x64`), so output is identical on every OS |
| `fakePlatform()` | A platform with no tools |
| `ForbiddenRunner` | Refuses every run and records attempts |
| `isolatedCli()` | Builds the overrides above |
| `trapProcesses(t)` | Mocks every `child_process` entry point to fail the test. One trap per test; the only exception is starting Node itself, for the compiled-CLI `--help`/`--version` check |

- `tests/cli.test.ts` now runs entirely on these helpers. The compiled-CLI test only uses `--help`/`--version`, which never build a context.
- `tests/test-isolation.test.ts` makes the guarantee explicit. It checks three things:
  - Every CLI command runs with zero processes and zero runner calls.
  - An injected platform fully replaces the registry.
  - No test file runs `runCli`/`createContext` without `isolatedCli`/`trapProcesses`.
- `npm test` never runs GHDL, Apio, djtgcfg, openFPGALoader or Vivado, never touches USB/JTAG or the network, and never modifies FPGA packages.

### 3.3 Adapter registration (Issue 3)

`platform/index.ts` holds a registry of `{ platform, arch, factory }`:

| Host | Result |
|---|---|
| `win32/x64` | `createWindowsPlatform`: real Windows adapter |
| `darwin/arm64` | `createMacosPlatform`: `createMacosAdapter(host, { runner, system: nodeSystem(env) })` |
| `darwin/x64` | `unsupported`: "requires native arm64 (Apple silicon), not Intel or Rosetta" |
| `win32/arm64`, `linux/*`, other | `unsupported`, with a reason |

The temporary inert factories are gone. No adapter logic was duplicated.

### 3.4 GHDL workspace isolation (Issue 4)

`GhdlVhdlProvider` changes:
- **Working directory.** Every GHDL run uses its step's workspace folder as working directory: `.nexysvhdl/check/` (new), `.nexysvhdl/sim/` or `.nexysvhdl/synth/`.
- **Sources.** Source files are passed as absolute paths.
- **Simulation.** `simulate` elaborates (`-e`) before running (`-r`) in `sim/`, which the LLVM backend needs once `check` output no longer sits in the project root.
- **Diagnostics.** They are mapped back to project-relative paths, so the output is unchanged for students.

Files are prevented from being created in the source tree; nothing is cleaned up afterwards. `tests/ghdl-workspace.test.ts` uses a fake runner that behaves like the LLVM backend: it writes `<unit>` and `e~<unit>.o` into its cwd. It verifies the cwd of check, simulate and synthesize, absolute sources, output under `.nexysvhdl/`, an unchanged student tree, and project-relative diagnostics.

### 3.5 Programming error handling (Issue 5)

`ProgrammingService.program()`/`detectBoards()` catch exceptions from `availability`, `detectBoards`, `prepareArtifact` and `program`. Each becomes a failed `ProgrammingResult` with a diagnostic:

| Stage | Code |
|---|---|
| availability | `PROGRAMMER_UNAVAILABLE` |
| detectBoards | `PROGRAM_DETECT_FAILED` |
| prepareArtifact | `PROGRAM_PREPARE_FAILED` |
| program | `PROGRAM_FAILED` |
| canonical file unreadable | `PROGRAM_CANONICAL_UNREADABLE` |

A new neutral `ProgrammingError(diagnostics)` keeps a provider's own diagnostics. The Windows `DigilentArtifactError` now extends it, so a malformed bitstream reports `DIGILENT_BIT_MALFORMED`. The canonical-hash check still runs after a failed preparation. The CLI prints `Program: FAILED` plus diagnostics, exits 1, and shows no stack trace.

### 3.6 Doctor and toolchain inspection (Issue 6)

`PlatformServices.inspectToolchain({ tools, manifest?, locator })` returns `{ tools: Map<ToolId, DetectedTool>, diagnostics }`. `doctor` prints those detections and diagnostics, and falls back to the core `ToolDetector` when no adapter provides inspection. `doctor` names no vendor tool or environment variable.

- **Windows** runs `WindowsToolchainInspector` on the composition root's locator, so project settings and `NEXYSVHDL_*` come first.
- **macOS** runs `MacosToolchainDetector` (arm64 checks, pin/schema checks, openFPGALoader) on the pinned runner.

## 4. Tests

| Suite | Covers |
|---|---|
| `tests/platform-registry.test.ts` | win32/x64 → Windows; darwin/arm64 → macOS with `PinnedApioRunner`; darwin/x64, linux, win32/arm64 → unsupported; Windows runner undecorated; macOS runner pinned or refused, never unpinned |
| `tests/test-isolation.test.ts` | All CLI commands run with zero processes; the registry is replaced; a static rule on test sources |
| `tests/ghdl-workspace.test.ts` | GHDL check/simulate/synth run in the workspace; the source tree is unchanged; diagnostics are project-relative |
| `tests/programming-errors.test.ts` | A `prepareArtifact` exception becomes a result; `ProgrammingError` diagnostics are kept; every stage and non-`Error` values are handled; unreadable canonical file; Windows malformed bitstream gives `DIGILENT_BIT_MALFORMED` |
| `tests/cli.test.ts` (rewritten) | Isolated CLI; doctor uses platform inspection; the platform runner is used for doctor/check/simulate/build; `program` handles provider failure with exit 1 and no stack trace |
| Updated | The Windows factory test (real adapter, undecorated) and the macOS pin regression (the registered factory pins or refuses) |

Mutation checks:
- Putting the GHDL cwd back to the project root fails 3 tests.
- Using the base runner instead of `platform.runner` fails 2 tests.

**Result: `npm run typecheck` is clean; `npm test` gives 214/214** (194 merged + 20 integration).

## 5. Real Windows validation (ordinary CLI)

These runs used `node dist/cli/main.js <command>` from `examples/nexys-a7-counter/`, with no `ContextOverrides`, no direct adapter construction and no custom runner. `.nexysvhdl/` was deleted first, so the run started fresh.

| Command | Result |
|---|---|
| `doctor` | Adapter "Windows". GHDL 6.0.0, Apio 1.6.0, openXC7 2026-09-24, Yosys 0.63+173, nextpnr-xilinx 0eae9fb and the programmer (Adept Utilities 2.7.1 / djtgcfg 2.6.1, Adept Runtime 2.30.4) are all **compatible**; overall **compatible**. The programmer is available. |
| `boards` | nexys-a7-100t with CLK100MHZ/BTNC/SW0/LED0 |
| `project info` | Validation OK; XDC preview |
| `check` | OK (elaborated `top`, `counter_tb`) |
| `simulate` | PASSED: `ALL TESTS PASSED (28 checks)` @280 ns |
| `build` | SUCCEEDED in 15.3 s: **56 LUT, 27 FF**, 3 IO, 1 BUFG, 7 CARRY4. clk100mhz target 100 MHz, achieved **409.67 MHz, PASS**, slack **+7.559 ns**. `hardware.bit` 3,825,910 B |
| `program` (no board connected) | `FAILED — No Digilent Nexys A7-100T was detected…` `[PROGRAM_NO_BOARD]`, exit 1 |
| `program --serial 210292BCFFE4` | OK. `djtgcfg init` found XC7A100T (IDCODE 13631093); `prog -d SN:210292BCFFE4 -index 0 -file …\program\hardware-digilent.bit` gave "Programming succeeded." in 3.99 s. SRAM only |

- **Canonical integrity:** `hardware.bit` SHA-256 `77689b2b…3c99` was identical before and after programming. The prepared `hardware-digilent.bit` (`a9f7e4fb…2917`) differs only in field b (`xc7a100tcsg324-1` → `7a100tcsg324`). The payload (3,825,788 B) is **identical**, SHA-256 `225048fb…b003`, the same as in Phase 3B.
- **Physical:** user-confirmed PASS. LED0 blinks, holding BTNC keeps LED0 off, and releasing it resumes blinking.
- **Source-tree cleanliness:** outside `.nexysvhdl/`, the example is byte-identical before and after `check`/`simulate`/`build`/`program`: `nexysvhdl.json`, `src/*.vhd`, `sim/*.vhd`. There is no `top`, `counter_tb`, `e~*.o`, `work-obj*.cf`, `generated.v` or `*.bit` outside the workspace. All GHDL state is in `.nexysvhdl/{check,sim,synth}`.
- **Drivers, Vivado and Apio:** no driver change, no Zadig/WinUSB, and Vivado is not used. The Windows Apio installation was not modified, and no pin was applied.

## 6. macOS composition review (static; not run from Windows)

On darwin/arm64 the ordinary CLI resolves `createMacosPlatform`, and `ctx.runner` is the adapter's `PinnedApioRunner`:

| Path | Runner |
|---|---|
| `doctor` | `inspectToolchain` → `MacosToolchainDetector` built on the pinned runner |
| `check` / `simulate` / `build` | `GhdlVhdlProvider` and `ApioImplementationProvider` receive `ctx.runner` (pinned) |
| `program` | `OpenFpgaLoaderProgrammer`, built on the pinned runner |

The base `NodeToolRunner` is never handed to a provider on macOS. No Mac package was run or altered from Windows.

## 7. Mac validation still required

Run on the Apple-silicon Mac through the ordinary CLI from `examples/nexys-a7-counter/`:
1. **`doctor`:** all tools compatible, including openXC7 `2026-09-25` (schema 7) and openFPGALoader 1.1.1, with no pin diagnostics. Record `~/.apio` before and after; it must be byte-identical.
2. **`check`, `simulate`, `build`:** in particular the new GHDL flow with the LLVM backend (`-e` in `check/` and `sim/`, then `-r` in `sim/`). The student tree must stay clean: no `top`, `counter_tb` or `e~*.o` outside `.nexysvhdl/`.
3. **`program --serial <sn>`**, then the physical LED0/BTNC check.
4. **`npm test`** must pass with `~/.apio` unchanged.

## 8. Known limitations and concerns

- **The macOS pin matches by file name.** The Apio pin recognises Apio when the executable's name is exactly `apio`. An explicit `NEXYSVHDL_APIO` or project `toolchain.tools.apio` path to a differently named executable would not be pinned. The ordinary discovered path is `…/apio`. This is left as validated in Phase 3B for the macOS owner to decide.
- **macOS doctor ignores project tool paths.** The macOS `inspectToolchain` uses its own locator (architecture checks), so project-level `toolchain.tools` paths are not reflected in the macOS `doctor` table. Windows uses the composition root's locator.
- **Windows arm64 is unsupported** until it is validated.
- `simulate` now runs an extra `ghdl -e`, which costs about 0.1 s with mcode.
- The Adept Utilities version is still derived from djtgcfg 2.6.1 (Phase 3B limitation).
