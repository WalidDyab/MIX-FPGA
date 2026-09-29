# Phase 3B — macOS platform adapter (Apple silicon)

Date: 2026-09-29
Branch: `phase3/macos` from baseline `80d073d`
Result: **PASS**, on the M4 Mac and the Nexys A7-100T. The adapter is implemented and unit-tested. The real shared-core build and real SRAM programming worked, and the user confirmed the physical test. The adapter is **not activated** in `platform/index.ts` yet (see §1).

No Vivado, Windows, VM, Parallels or Rosetta was used, and no USB driver or shell profile was changed.

---

## 1. Phase 3C integration requirement

**The shared contract cannot yet carry the macOS Apio pin into the CLI. Wiring the real adapter in before that is fixed will break the validated toolchain.** This was observed during Phase 3B.

### What is missing

- `PlatformServices` (`platform/types.ts`) offers `programmer`, `toolLocator` and `status`. It has **no way to decorate or configure the shared `ToolRunner`**, and no way to supply per-tool environment.
- `cli/context.ts` builds `ApioImplementationProvider` and the shared `ToolDetector` with its own `NodeToolRunner`. So it **cannot apply the macOS Apio pin** (`APIO_REMOTE_CONFIG_URL`) to any Apio call.
- `platform/index.ts` has mapped `darwin` to `createMacosPlatform` since Phase 3A. Filling that factory in therefore **activates the real adapter in the CLI immediately**. This contradicts the plan's "Phase 3C registers the adapters".
- `tests/cli.test.ts` assumes the platform factories are placeholders. It runs the real CLI (`doctor`, `check`, `simulate`, `build`, and the compiled CLI as a real process) against **the host's real adapter**. The last test in that file ("platform adapters (Phase 3A placeholders)") asserts that both adapters provide nothing.

### What happened

When the real adapter was first returned from `createMacosPlatform`, `npm test` ran the shared CLI tests on this Mac. The tests found the real GHDL and Apio and ran `apio raw` **without** the pin. Apio fetched the upstream remote config and **replaced the validated openXC7 `2026-09-25` package with `2026-09-27`**. That package has `XILINX-PARTS-INDEX` schema 8, the release that makes Apio 1.7.0 fail with "Unexpected schema version 8, expected 7". Four shared CLI tests also failed.

The user authorized the recovery below and it was verified:
1. Ran `apio packages install` with the pinned `APIO_REMOTE_CONFIG_URL`. openXC7 is back to `2026.09.25`, parts-index schema 7. Yosys `0.63+173` and nextpnr `e860c9c8` were confirmed through pinned Apio. definitions, oss-cad-suite and verible were untouched (same versions and install times).
2. `createMacosPlatform`, the factory registered in `platform/index.ts`, was made **inert** again. The real adapter is exported separately as `createMacosAdapter()`.
3. The regression test `tests/platform/macos/macos-apio-pin-regression.test.ts` was added. It proves that every Apio invocation made through the real adapter carries the pin, that Apio is refused if the pin cannot be expressed, and that the registered factory reaches no tools.
4. `npm test`: 142/142. `~/.apio` was byte-identical before and after the run.

### Recommended for Phase 3C (not implemented on this branch)

1. **Add a platform-level runner/environment hook.** For example, add `wrapRunner?(runner: ToolRunner): ToolRunner` to `PlatformServices`, and have `cli/context.ts` build `ctx.runner = platform.wrapRunner?.(base) ?? base` before creating any provider or detector. An equivalent clean mechanism would also work, such as per-tool environment on `LocatedTool`. The macOS adapter already provides this as `MacosAdapter.runner`, which is a `PinnedApioRunner`.
2. **Make the CLI tests inject a stub/fake platform** (`ContextOverrides.platform`) instead of creating the host's real adapter, and replace the Phase 3A placeholder assertion. Unit tests must never find or run host-local FPGA tools. The Windows agent will hit the same failures once its adapter is real.
3. **Activate both real adapters in `platform/index.ts` only after (1) and (2).** For macOS that is a one-line change: register `createMacosAdapter` instead of the inert `createMacosPlatform`.
4. Afterwards, the platform adapter's detector (`MacosToolchainDetector`) should also feed `doctor`, because the shared `ToolDetector` cannot detect openXC7 or openFPGALoader.

---

## 2. Adapter structure (`platform/macos/`)

| File | Contents |
|---|---|
| `index.ts` | `createMacosPlatform` (registered, inert). `createMacosAdapter(host, options)` (real): returns `MacosAdapter`, which is `PlatformServices` plus `runner` (pinned), `apioEnvironment`, `pinnedConfigDir`, `providers()` and `toolchainDetector()`. |
| `system.ts` | `MacosSystem`: file, environment and architecture access. It is injected, so all logic is unit-testable on any OS. |
| `executable.ts` | Mach-O header parser (thin and universal) and wrapper-script resolution. |
| `tool-locator.ts` | `MacosToolLocator` (a `ToolLocator`) with `discover()`, which returns structured candidates, rejections and diagnostics. |
| `apio-pin.ts` | Pin URL, pin-file check, JSONC tag reader, and `PinnedApioRunner`. |
| `openxc7.ts` | openXC7 version normalization, package metadata, and compatibility checks. |
| `openfpgaloader.ts` | Pure parsers for openFPGALoader output (version, `--scan-usb`, `--detect`, configuration status, failure classes). |
| `programmer.ts` | `OpenFpgaLoaderProgrammer`, a `ProgrammerProvider`. |
| `toolchain.ts` | `MacosToolchainDetector`, which detects all six `ToolId`s. |

No shared file was changed. Everything uses the Phase 3A contracts as they are:
- the shared `GhdlVhdlProvider`, `ApioImplementationProvider` and `ToolDetector`;
- `ProgrammerProvider`, `ProgrammingService`, `ToolLocator` and `ToolRunner`.

## 3. Native ARM handling

- **Host:** `host.arch` must be `arm64`. On Apple silicon, `x64` means Node itself runs under Rosetta. The adapter then offers no locator or programmer, sets its status to `unsupported architecture x64 …`, and the detector reports `MACOS_UNSUPPORTED_ARCH`.
- **Tools:** every located executable's Mach-O header is read without running it.
  - Apio's `bin/<tool>` bash wrappers are followed to `libexec/<tool>`.
  - Universal binaries count as native if they contain arm64.
  - x86_64-only binaries are rejected with `MACOS_TOOL_UNSUPPORTED_ARCH`, and discovery moves on to the next candidate. Rosetta is never invoked or installed.
- **Real result:** GHDL, Apio and openFPGALoader (`…/oss-cad-suite/libexec/openFPGALoader`) are all `native arm64`.

## 4. GHDL discovery

Priority order:
1. `NEXYSVHDL_GHDL`, an explicit override. If it is unusable, discovery stops with `MACOS_TOOL_OVERRIDE_INVALID` instead of silently falling back.
2. The NexysVHDL-managed folder: `$NEXYSVHDL_TOOLS_DIR/ghdl/bin/ghdl`, default `~/Library/Application Support/NexysVHDL/tools/ghdl/bin/ghdl`.
3. `PATH`.
4. A development fallback, `~/WSClaude/NexysVHDL/tools/ghdl/bin/ghdl`: the Phase 1/2 install (official 6.0.0 aarch64 release). This one location is passed in by `createMacosAdapter` as data; it is not built into the locator.

The shared CLI chain puts project settings and `NEXYSVHDL_*` first anyway. On this Mac GHDL was found through (4): `6.0.0`, native arm64.

## 5. Apio discovery

Priority order: `NEXYSVHDL_APIO`, then `<managed>/apio/apio`, then `/Applications/Apio/apio` (installer location), then `~/Applications/Apio/apio`, then `PATH`. Found: `/Applications/Apio/apio`, `1.7.0` (`pyinst-darwin-arm64-2026-09-27`), native arm64. Apio is never installed, updated or modified by the adapter.

## 6. Pinned Apio/openXC7 environment

- The pin is `toolchains/apio-remote-config/apio-1.7.x.jsonc`. It is located relative to the NexysVHDL installation (`packageRoot()`), so users never export anything and no shell profile changes.
- `APIO_REMOTE_CONFIG_URL = file://<abs>/toolchains/apio-remote-config/apio-{major}.{minor}.x.jsonc`.
- **The URL is not percent-encoded.** Apio 1.7.0 reads the text after `file://` as a literal path. Verified on this Mac: a folder with a space works raw, but the `%20` form fails with `Failed to read a local config file`. Folders containing `{` or `}` are rejected, because Apio uses those characters for its template.
- `PinnedApioRunner` adds the variable to **every** Apio invocation and overrides any inherited value. Other tools are unaffected.
- **Apio is identified by what the executable resolves to, not by its spelling** (`ResolvedApioIdentity`, fixed in Phase 3C). An invocation counts as Apio if:
  - its file name is exactly `apio` (any case); or
  - its `realpath` or file identity (dev:ino) equals the Apio the macOS locator resolved, which honours `NEXYSVHDL_APIO`; or
  - the resolved file is named `apio`, or sits next to Apio's `BUILD-INFO.json` with `"package-name": "apio-cli"`.

  So `/Applications/Apio/Apio` (case-insensitive APFS), versioned aliases such as `apio-1.7.0`, symlink chains, and a project-setting path to another Apio installation are all pinned. A name merely *containing* "apio" is not enough. Before the fix, a supported override whose file name was not literally `apio` ran Apio **unpinned**, the same failure mode as the Phase 3B openXC7 incident.
- If the pin cannot be expressed, the runner **refuses** to start Apio and returns `spawn-failed: refused to run Apio without APIO_REMOTE_CONFIG_URL`.
- `createMacosAdapter` always builds its runner this way. The shared providers returned by `providers()`, the detector and the programmer all use it.
- `checkApioPin()` checks that the file for the detected Apio version exists (`MACOS_APIO_PIN_MISSING`, `MACOS_APIO_PIN_INVALID`) and reads its package tags.
- Apio caches the remote config by URL. Each run of the adapter prints `Active env options [APIO_REMOTE_CONFIG_URL]`.

## 7. openXC7 version normalization

The same release appears as `2026-09-25` (the `BUILD-INFO.json` `release-tag` and the pin tag), as `2026.09.25` (`apio packages list` and `installed_packages.json`), and as `20260925` (file names).

- `normalizeOpenXc7Version()` maps all three to the canonical Apio package version, `2026.09.25`.
- `reportedOpenXc7Version()` reports the manifest's own spelling of the same release. So the **unchanged** shared `evaluateCompatibility()` (exact string match) gives `compatible` whether a manifest uses dots (macOS) or dashes (Windows). Different releases still come out `incompatible`.
- The adapter also checks the package directly:
  - `MACOS_OPENXC7_NOT_PINNED_RELEASE`: installed release ≠ pin tag;
  - `MACOS_OPENXC7_SCHEMA_INCOMPATIBLE`: parts-index schema ≠ the schema Apio accepts (Apio 1.7 → 7);
  - `MACOS_OPENXC7_METADATA_MISMATCH`: `BUILD-INFO.json` and `installed_packages.json` disagree;
  - `MACOS_OPENXC7_WRONG_PLATFORM`: target ≠ `darwin-arm64`.

The broken `2026-09-27` package would raise the first two.

Real result: raw `2026-09-25` is reported as `2026.09.25`, **compatible**, schema 7, `darwin-arm64`, nextpnr revision `e860c9c8…`.

## 8. Yosys / nextpnr detection

These use the shared `ToolDetector` probes (`apio raw -- yosys -V`, `apio raw -- nextpnr-xilinx --version`), run through the pinned runner. So they execute inside Apio's own tool environment with the pin set. They are skipped entirely when the pin file is missing.

Real result: Yosys `0.63+173` and nextpnr-xilinx `e860c9c8`, both compatible.

## 9. openFPGALoader discovery

- **Location:** the executable `apio upload` ran in Phases 1–2, `<APIO_HOME or ~/.apio>/packages/oss-cad-suite/bin/openFPGALoader`. Apio puts that `bin/` on `PATH`, and the Phase 1/2 logs show `openFPGALoader --force-terminal-mode --verify --board nexys_a7_100 …`.
- **Wrapper:** it is a bash wrapper that sets `OPENFPGALOADER_SOJ_DIR` and execs `libexec/openFPGALoader`, a native arm64 binary. The adapter invokes the wrapper, exactly as Apio does.
- **Fallbacks:** `NEXYSVHDL_PROGRAMMER`, then `PATH`. Homebrew is not needed; it is not installed on this Mac.
- **Version:** `openFPGALoader v1.1.1`, parsed as `1.1.1` and **compatible** with the manifest.

## 10. Board detection

`detectBoards(board)`:
1. `openFPGALoader --scan-usb`. Probes are kept only if they match `board.identification.usb` (`0403:6010`).
2. For each matching probe: `openFPGALoader --board nexys_a7_100 --ftdi-serial <SN> --detect` (or `--busdev-num <bus>:<dev>` when there is no serial). A board is reported only if the JTAG chain answers with the expected IDCODE `0x3631093` (xc7a100; revision bits ignored).
3. **A generic FTDI device is never treated as ready.** If it is visible on USB but JTAG fails, or a different FPGA answers, the result is `MACOS_USB_VISIBLE_JTAG_UNAVAILABLE` with an explanation, and no board.
4. If nothing is connected, the result is an empty list with an info diagnostic, `MACOS_NO_BOARD`. `ProgrammingService` then reports `PROGRAM_NO_BOARD`.

The board-id mapping (`nexys-a7-100t` → `nexys_a7_100`, IDCODE `0x3631093`) lives in the adapter (`OPENFPGALOADER_BOARDS`), because `boards/*.json` has no openFPGALoader backend id. Phase 3C could move it into `backendIds`.

Real result, with the board connected:
```
selector      ftdi-serial=210292BCFFE4
serialNumber  210292BCFFE4
productName   Digilent USB Device
boardId       nexys-a7-100t
transport     USB JTAG FTDI2232 0403:6010, FPGA xc7a100 idcode 0x3631093
```

## 11. Programming

- **`prepareArtifact()`** returns `{ path: canonical.path, source: canonical, transformation: 'none' }`. The canonical `hardware.bit` is neither copied nor opened for writing; openFPGALoader accepts openXC7's file as-is.
- **`program()`** checks, before running anything:
  - the destination is volatile;
  - the bitstream exists and is not empty;
  - the `.bit` header part matches the board. It reads the header only; a mismatch gives `MACOS_BITSTREAM_PART_MISMATCH`.

  It then runs:
  ```
  openFPGALoader --board nexys_a7_100 --ftdi-serial <SN> --write-sram --force-terminal-mode <hardware.bit>
  ```
  - This is the validated Phase 1/2 command with two changes:
    - explicit probe selection (`--ftdi-serial` or `--busdev-num`), so a second board is never programmed by accident;
    - `--write-sram` made explicit. It is openFPGALoader's default.
  - `--verify` is dropped: openFPGALoader documents it as "SPI Flash only", and it did no readback for SRAM loads in Phase 2.
  - Flash flags (`-f`, `--write-flash` and others) are refused when the command is built.
- **Success criteria:** exit code 0 **and** configuration status `done 1`. If DONE is missing or 0, the result is `MACOS_PROGRAM_DONE_NOT_REACHED`, never success. On success there is an info diagnostic, `MACOS_PROGRAMMED_SRAM` (volatile: lost when the board is powered off).
- **Failures** are mapped to short explanations (`MACOS_PROGRAM_FAILED`) with the last tool error line. The failure classes are `no-probe`, `usb-unavailable`, `jtag-init-failed`, `no-fpga`, `bitstream-error` and `unknown`. The raw output is kept in `<workspace>/program/openfpgaloader-program.log`.

Real result: `succeeded` in 5.3 s, with `ir: 1 isc_done 1 isc_ena 0 init 1 done 1`. The canonical SHA-256 was identical before and after programming (`295dcbec…9ac4`).

## 12. Structured diagnostics

| Code | Meaning |
|---|---|
| `MACOS_NO_BOARD` (info), `PROGRAM_NO_BOARD` (service) | No board connected |
| `MACOS_USB_VISIBLE_JTAG_UNAVAILABLE` | USB device visible, but programming not possible |
| `MACOS_PROGRAMMER_NOT_FOUND`, availability `false` | openFPGALoader missing |
| `MACOS_UNSUPPORTED_ARCH`, `MACOS_TOOL_UNSUPPORTED_ARCH` | Unsupported architecture |
| `MACOS_APIO_PIN_MISSING`, `MACOS_APIO_PIN_INVALID`, `MACOS_APIO_PIN_PATH_INVALID` | Apio pin configuration missing or unusable |
| `MACOS_OPENXC7_NOT_PINNED_RELEASE`, `MACOS_OPENXC7_SCHEMA_INCOMPATIBLE` | Incompatible openXC7 package |
| `MACOS_PROGRAM_FAILED`, `MACOS_PROGRAM_TIMED_OUT`, `MACOS_PROGRAM_CANCELLED`, `MACOS_PROGRAMMER_NOT_STARTED` | Programming failure |
| `MACOS_PROGRAM_DONE_NOT_REACHED` | Configuration DONE not reached |
| `MACOS_BITSTREAM_PART_MISMATCH`, `MACOS_BITSTREAM_MISSING` | Wrong or missing bitstream |

## 13. Tests

`tests/platform/macos/`: **51 tests**, all using a fake `MacosSystem` and a scripted `ToolRunner`. They need no GHDL, Apio, openFPGALoader, board or macOS, so they run on Windows too.

| File | Covers |
|---|---|
| `macos-discovery.test.ts` | Mach-O thin, universal, script and other files; wrapper → libexec; x86_64 rejection; GHDL priority (override, invalid override, managed, `NEXYSVHDL_TOOLS_DIR`, PATH, development); Apio discovery; openFPGALoader from `APIO_HOME`/oss-cad-suite |
| `macos-toolchain.test.ts` | Pin URL (spaces raw, no `%20`; relative/brace rejection); pin file per Apio version; tracked pin tags; `PinnedApioRunner`; dash/dot/compact normalization; compatible (real BUILD-INFO against the macOS manifest); incompatible `2026-09-27` + schema 8; missing package; full detection = compatible with every Apio call pinned; no `apio raw` without the pin file; Rosetta x64 |
| `macos-programmer.test.ts` | Version, scan-usb (real, with and without a board), detect, configuration status (through `\r` progress bars), failure classes, `.bit` header part, SRAM-only arguments; availability; missing programmer; detection by USB + IDCODE; no-board → `PROGRAM_NO_BOARD`; FTDI visible but JTAG unavailable; wrong FPGA; prepareArtifact unchanged; full `ProgrammingService` success with an unchanged canonical hash; failure; DONE not reached; part mismatch; adapter factory |
| `macos-apio-pin-regression.test.ts` | Resolved-identity pinning: `apio`, `/Applications/Apio/Apio`, a versioned alias, a symlink chain and another Apio copy are pinned, both directly and as `NEXYSVHDL_APIO` through detection and `apio build`; unrelated executables whose names contain "apio" are not; the resolved Apio is refused without a pin; file-identity matching without `BUILD-INFO.json`. **Every** Apio invocation through `createMacosAdapter` carries the pin: detection (`--version`, `raw -- yosys -V`, `raw -- nextpnr-xilinx --version`), the shared `ApioImplementationProvider` (`build --verbose`) and direct runner use, even when an upstream URL is passed in. Apio is refused without a pin. The registered factory and `createPlatformServices(darwin)` expose no locator, programmer or runner. |

Fixtures in `tests/platform/macos/fixtures/` are real outputs from this Mac:
- openFPGALoader version;
- scan-usb with and without the board;
- detect with no probe;
- a program attempt with no probe;
- openXC7 `BUILD-INFO.json` and `installed_packages.json`.

The detect and program-success fixtures come from the Phase 1/2 Mac logs.

`tests/platform/macos/real-validation.ts` is the **manual** engineering script (`toolchain | build | detect | program`). It uses only `createMacosAdapter()` and is not part of `npm test`.

Suite result: `npm run typecheck` passes, and `npm test` gives **142/142** (91 baseline + 51 macOS) with no real tool activity. `~/.apio` was byte-identical before and after.

## 14. Real build (shared core, `examples/nexys-a7-counter`)

Driven through `WorkflowController` with the adapter's `providers()` (pinned runner):

| Step | Result |
|---|---|
| check | succeeded; elaborated `top`, `counter_tb` |
| simulate | passed, "ALL TESTS PASSED (28 checks)", stopped at 280 ns, waveform `.nexysvhdl/sim/counter_tb.ghw` |
| synthesize | succeeded (GHDL `--synth`, `generated.v`) |
| constraints | succeeded (Phase 3A generated XDC) |
| implement | succeeded in 13.5 s (Apio 1.7.0 / openXC7 2026-09-25 / nextpnr e860c9c8); `Active env options [APIO_REMOTE_CONFIG_URL]` |

Generated constraints, staged in isolation as `impl/generated.xdc` + `impl/apio.ini` (`constraint-file = generated.xdc`):
```
set_property -dict { PACKAGE_PIN E3 IOSTANDARD LVCMOS33 } [get_ports {clk100mhz}]
create_clock -name clk100mhz -period 10.00 [get_ports {clk100mhz}]
```
- nextpnr ran with `-o xdc=generated.xdc`, which confirms the explicit Apio constraint-file setting.
- nextpnr printed `Derived frequency constraint of 100.0 MHz for net $iopadmap$clk100mhz`. The only warning was `ignoring unsupported XDC option '-name'`; in Phase 2 it was three warnings (`-add`/`-name`/`-waveform`).
- Pads were constrained for `led0`, `clk100mhz` and `btnc`.
- **The simplified Phase 3A XDC works with Apio 1.7.0 / openXC7 2026-09-25 / nextpnr e860c9c8.**

| | Phase 3B macOS | Phase 2 macOS |
|---|---|---|
| FF (FDRE) | 27 | 27 |
| Packed LUTs (SLICE_LUTX) | 56 | 56 |
| CARRY4 | 7 | 7 |
| IO / BUFG | 3 / 1 | 3 / 1 |
| Target | 100 MHz | 100 MHz |
| Fmax after routing | **372.58 MHz — PASS** | 372.58 MHz |
| Worst slack | 7.316 ns | ≈ 7.3 ns |
| hardware.bit | 3,825,910 bytes, part `xc7a100tcsg324-1` | 3,825,910 bytes |

The canonical bitstream's SHA-256 is `295dcbec9ebf394bc22fe455e3209c06cc513cd625ac73db087f70cb42659ac4`. It differs from Phase 2's because the header timestamp differs (phase2-macos §15).

On its first build after the openXC7 reinstall, Apio fetched `apio-xilinx-chipdb-xc7a100t-20260925.bin.tgz`, the chip database for the **same pinned release**, into the openXC7 package. Package versions did not change.

## 15. Physical result

The board was programmed through `OpenFpgaLoaderProgrammer` via `ProgrammingService`. User confirmation, verbatim:

> "LED0 blinks, BTNC holds it off, release restarts blinking"

**PASS.**

## 16. Known limitations

- The adapter is not registered (§1). It is used through `createMacosAdapter()` directly until Phase 3C.
- **Shared-core finding — GHDL writes into the student's project on macOS.** `GhdlVhdlProvider` runs `ghdl -e` with `cwd` = project root and no `-o`. With GHDL's LLVM backend (macOS), elaboration writes native executables (`top`, `counter_tb`) and `e~*.o` objects **into the project root**, which breaks ADR-001. The mcode backend on Windows writes none. The files from this validation run were deleted. Suggested core fix: pass `-o <workspace>/sim/<unit>` to `-e`, and run `-r` from the workspace, or use `--elab-run`. Not changed here (`core/` is frozen).
- Only the Nexys A7-100T has an openFPGALoader profile (`OPENFPGALOADER_BOARDS`).
- The pin covers Apio 1.7.x only. A newer Apio needs a new validated `apio-X.Y.x.jsonc`, and a new entry in `PARTS_INDEX_SCHEMA_FOR_APIO`.
- `APIO_HOME` is honoured if set. Otherwise `~/.apio` is used, which is the location Apio reported (`apio info system`).
- GHDL is currently found through the development fallback. A NexysVHDL-managed GHDL location is defined, but nothing installs into it yet.
- Intel Macs are not supported (not validated).

## 17. Phase 3C recommendations

1. Implement §1 first: add the runner/environment hook, make the CLI tests use a stub platform, and only then register both real adapters.
2. Use `MacosToolchainDetector` for `doctor` on macOS, so openXC7 and openFPGALoader show as compatible rather than "not checked".
3. Fix the GHDL LLVM elaboration output location in `GhdlVhdlProvider` (§16).
4. Consider adding `backendIds.openfpgaloader` (and the IDCODE) to `boards/*.json`.
5. Repeat the full regression through the CLI on macOS once it is wired: `doctor` (all compatible), then `check`, `simulate`, `build` and `program`.
