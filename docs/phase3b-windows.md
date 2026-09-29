# Phase 3B — Windows platform adapter

Date: 2026-09-29
Branch: `phase3/windows`, from the frozen baseline `80d073d3bbffa3737d55e495ffb5396d1d0c084f`. That baseline passed 91/91 tests on Windows and macOS.
Host: Windows 11 Home 10.0.26200 x64, Node 24.13.0.

**Result: PASS.** Unit tests pass (143/143). The real build through the shared core passes timing. Programming through the new `ProgrammerProvider` succeeded, and the physical LED/BTNC check was confirmed by the user. No shared file was changed.

## 1. Implementation structure

Everything is under `platform/windows/`:

| File | Role |
|---|---|
| `windows-platform.ts` | `createWindowsPlatformServices(host, options?)` assembles the real adapter: `toolLocator`, `programmer` and `inspector` |
| `index.ts` | Public exports. **`createWindowsPlatform` (the entry registered in `platform/index.ts`) is still the Phase 3A placeholder** (see §12) |
| `host-environment.ts` | Injectable environment variables and filesystem (`WindowsHostEnvironment`), case-insensitive env lookup, UTF-16 installer-log decoding |
| `tool-locator.ts` | `WindowsToolLocator implements ToolLocator` |
| `toolchain-inspector.ts` | `WindowsToolchainInspector`: version detection for all six `ToolId`s |
| `digilent/bit-header.ts` | Structural `.bit` parser and the Digilent header normalizer (pure) |
| `digilent/djtgcfg-output.ts` | Pure parsers for `enum`, `init`, `prog` and `-version`, the install-log parser, and error classification |
| `digilent/adept-environment.ts` | djtgcfg and Adept Runtime/Utilities detection (read-only) |
| `digilent/digilent-programmer.ts` | `DigilentProgrammer implements ProgrammerProvider`, plus `prepareDigilentBitstream()` |

Every process is started through the shared `ToolRunner`, with argument arrays and `shell: false`. The adapter never starts a shell, an installer, Vivado, Zadig or any driver tool.

## 2. Tool discovery (`WindowsToolLocator`)

Only files are checked and nothing is executed. The first hit wins:

1. **`NEXYSVHDL_<TOOL>`** environment override. This is the same variable as the core's `ConfiguredToolLocator`, so the programmer honours `NEXYSVHDL_PROGRAMMER` too. In the CLI, project-level `toolchain.tools` paths come in front of this through `toolLocatorFor()`.
2. **NexysVHDL-managed folders** (GHDL):
   - `<package>\tools\ghdl*\bin\ghdl.exe`, newest `ghdl-X.Y.Z` first;
   - then `%LOCALAPPDATA%\NexysVHDL\tools\ghdl*\bin\ghdl.exe`.
3. **Standard install locations**:
   - Apio: `%APIO_HOME%\bin\apio.exe`, or `%USERPROFILE%\.apio\bin\apio.exe`.
   - GHDL: MSYS2 `C:\msys64\{ucrt64,mingw64,clang64}\bin\ghdl.exe`.
   - djtgcfg: `%ProgramFiles(x86)%\Digilent\AdeptUtilities\djtgcfg.exe`, then `%ProgramFiles%\…`.
4. **PATH**: `.exe` only. A `.cmd` or `.bat` would need `cmd.exe`, so those are never picked.

Nothing is tied to `C:\Users\user`: paths come from `USERPROFILE`, `LOCALAPPDATA`, `APIO_HOME`, `ProgramFiles*`, `SystemDrive` and `PATH`. Yosys, nextpnr-xilinx and openXC7 are not located as executables because they are reached through Apio.

Real result on this machine:

| Tool | Path | Method |
|---|---|---|
| ghdl | `D:\WSClaude\NexysVHDL\tools\ghdl-6.0.0\bin\ghdl.exe` | NexysVHDL tools folder |
| apio | `C:\Users\user\.apio\bin\apio.exe` | Apio default install |
| programmer | `C:\Program Files (x86)\Digilent\AdeptUtilities\djtgcfg.exe` | Digilent Adept Utilities default install |

## 3. Version detection (`WindowsToolchainInspector`)

- **GHDL, Apio, Yosys, nextpnr-xilinx**: delegated to the core `ToolDetector`, which uses the same probes as Phase 3A. Yosys and nextpnr are probed with `apio raw -- …`.
- **openXC7**: the `release-tag` field of `<apio home>\packages\openxc7\BUILD-INFO.json`, read with the core `parseOpenXc7ReleaseTag`.
- **Programmer**:
  - The `djtgcfg -version` banner gives djtgcfg's own version (`2.6.1`).
  - The Adept Utilities package version is derived from it with `ADEPT_UTILITIES_BY_DJTGCFG = { '2.6.1': '2.7.1' }`, the pairing observed in Phase 1B. The package version is not recorded anywhere on disk: registry `DisplayVersion` is the installer-framework version 1.9.18. An unknown djtgcfg build therefore reports no package version (status `unknown`) instead of a guess.
  - The Adept Runtime version is parsed from `%ProgramFiles%\Digilent\install.log` (UTF-16LE), from the header `<<<<< Digilent Adept Runtime 2.30.4 >>>>>`.

Real result, evaluated against `toolchains/reference-phase2-windows-x64.json`:

| Tool | Detected | Status |
|---|---|---|
| GHDL | 6.0.0 | compatible |
| Apio | 1.6.0 | compatible |
| openXC7 | 2026-09-24 | compatible |
| Yosys | 0.63+173 | compatible |
| nextpnr-xilinx | 0eae9fb | compatible |
| Programmer | 2.7.1 (djtgcfg 2.6.1, Adept Runtime 2.30.4) | compatible |
| **overall** | | **compatible** |

The macOS `APIO_REMOTE_CONFIG_URL` pin is **not** applied on Windows. The adapter sets no Apio environment, and the Windows Apio install was neither updated nor changed.

## 4. Adept availability

`availability()` locates djtgcfg and runs `djtgcfg -version`, which is read-only:

- djtgcfg missing: unavailable, with install guidance. No installer is ever launched.
- Exit code `0xC0000139` (entry point not found): unavailable, "Adept Runtime too old, install 2.30 or newer". This is the Phase 1B failure mode of djtgcfg 2.7.1 on Vivado's bundled 2018 runtime.
- Runtime older than 2.30: usable, with a caveat.

Real result: `available — djtgcfg 2.6.1 (Adept Utilities 2.7.1), Adept Runtime 2.30.4, at C:\Program Files (x86)\Digilent\AdeptUtilities\djtgcfg.exe`.

## 5. Board enumeration

`detectBoards(board)` works in three steps:

1. **Enumerate.** It runs `djtgcfg enum` and parses each `Device:` block into a `DetectedBoard`:
   - `selector`: `SN:<serial>` (a bare serial is not accepted by djtgcfg);
   - `serialNumber`, `productName` and `transport`;
   - `boardId`: set when the product name matches `board.identification.productNames` (`"Nexys A7 -100T"`), comparing case- and whitespace-insensitively.
2. **Filter other products.** Other Digilent products, such as a Basys 3 or a Nexys A7-50T, are left out. Each one gets an `info` diagnostic, so it can never be picked by accident. All matching boards are returned. With several boards, the shared `selectTarget` requires `--serial`, and the provider never guesses.
3. **Probe JTAG.** For each matching board it runs `djtgcfg init -d SN:<serial>`. This can be turned off with `probeJtagOnDetect: false`. If the scan chain fails, the board stays in the list and gets a `warning`.

**Board-not-powered diagnostic (`DIGILENT_JTAG_UNAVAILABLE`).** djtgcfg exits 1 for every error and has no machine-readable code, so there is no better signal than its text. The adapter combines two structural facts with the text, which reduces reliance on the exact wording:

- the device *was* enumerated over USB;
- `init` failed with a scan-chain error (`failed to initiali[sz]e scan chain`), not with `unable to open device`, which is classified separately (unplugged, or held by another program).

The message: "Digilent Nexys A7-100T (serial …) is connected by USB but the FPGA/JTAG chain is unavailable. Check that the board power switch is ON."

Real results:
- Board off: 1 board `SN:210292BCFFE4`, plus the warning `DIGILENT_JTAG_UNAVAILABLE`. A programming attempt failed at `init` with the same code, and `prog` was not run.
- Board on: 1 board `SN:210292BCFFE4`, with no diagnostics.
- Earlier, with nothing connected: `No devices found`, giving no boards and no diagnostics.

## 6. Header normalization (`digilent/bit-header.ts`)

This is a TypeScript port of `experiments/phase1b-windows-programmer/normalize_bit_header.py`. No Python is involved.

- **Structural parse.** The parser checks, in order:
  - the 13-byte preamble;
  - fields `a`, `b`, `c` and `d` in that order, each with a u16 length and NUL-terminated (`b` must also be printable ASCII);
  - field `e` with a u32 payload length, which must end exactly at end-of-file and must not be empty.

  Anything else is rejected with a reason: bad preamble, truncation, trailing bytes, wrong field order, missing NUL, or a bogus length. The parser never throws.
- **Validation.** Field `b` must equal the board's implementation part (`board.fpga.part` = `xc7a100tcsg324-1`). The target value is derived from it (`7a100tcsg324`) instead of being hard-coded. Any other part is rejected (`DIGILENT_BIT_PART_MISMATCH`), because such a bitstream was not built for this board.
- **Rewrite.** Only field `b` is rewritten, and the file is re-serialised from the parsed fields. There is no find/replace over the file. A test puts the part-name bytes inside the payload and proves they survive.
- **Verification.** The output is re-parsed. Fields `a`, `c` and `d` must be byte-identical, `b` must be the target, and the payload length and bytes must be identical. Otherwise the result is `DIGILENT_BIT_VERIFY_FAILED`. Mutation check: replacing the serializer with a blind replace makes 11 tests fail.
- **Already compatible** (`b` is already `7a100tcsg324`, for example a Vivado bitstream): the output is byte-identical, `transformation: 'none'`.

### Artifact preparation and immutability

```
canonical .nexysvhdl\impl\_build\default\hardware.bit   (never written)
        |
        v  prepareArtifact()  ->  prepareDigilentBitstream()
.nexysvhdl\program\hardware-digilent.bit                 (temp file + rename, re-read and compared)
        |
        v
djtgcfg prog -d SN:<serial> -index 0 -file <prepared>
```

- The prepared path is always `<outputDir>\hardware-digilent.bit`. A path equal to the canonical one is refused.
- In the already-compatible case the file is still copied verbatim into `program\`, so djtgcfg and its log always use the `program\` folder.
- The shared `ProgrammingService` also hashes the canonical file before and after preparation.

Real result:

| | canonical `hardware.bit` | prepared `hardware-digilent.bit` |
|---|---|---|
| size | 3,825,910 B | 3,825,906 B |
| SHA-256 | `e46bc00a70ea939525b2dbec21d9e264d6366c6fec4e213914b3fa4110185dc9` (same before and after) | `04996d6715d459fae4da49d86b6e12b29a988ad56368f659b7125512fcbb3eaf` |
| field b | `xc7a100tcsg324-1` | `7a100tcsg324` |
| fields a, c, d | | identical |
| payload (3,825,788 B) SHA-256 | `225048fbe3665b30bc25a36571ac9984e94f125f1257d50b14d231232566b003` | **identical** |

## 7. Programming command

`program()` runs these steps:

1. **Safety net.** It re-parses the artifact and refuses (`DIGILENT_ARTIFACT_NOT_PREPARED`) unless field `b` is in Digilent form. djtgcfg is never handed a file it would reject with its cryptic "unrecognized error code".
2. **Init.** It runs `djtgcfg init -d SN:<serial>`. Device 0 on the chain must be `XC7A100T`, derived from `board.fpga.device`; otherwise the result is `DIGILENT_DEVICE_MISMATCH`.
3. **Program.** It runs `djtgcfg prog -d SN:<serial> -index 0 -file <prepared>`, FPGA SRAM only, with a 180 s timeout and the caller's `AbortSignal`.
4. **Result.** Success requires exit code 0. If the "Programming succeeded." line is missing, a `DIGILENT_SUCCESS_UNCONFIRMED` warning is added.
   - Failures are classified as `DIGILENT_JTAG_UNAVAILABLE`, `DIGILENT_DEVICE_OPEN_FAILED`, `DIGILENT_FILE_REJECTED`, `DIGILENT_FILE_UNREADABLE`, `DIGILENT_TIMEOUT`, `DIGILENT_CANCELLED` or `DIGILENT_PROGRAM_FAILED`.
   - The argument array, exit code, outcome, duration, stdout and stderr of every run go to `program\djtgcfg-program.log`, returned as `LogRef` `djtgcfg-program`.

`erase`, flash, Vivado and openFPGALoader are never used.

Real result:

- `init` returned 0 with `Found Device ID: 13631093`, `Device 0: XC7A100T`, in 237 ms.
- `prog` returned 0 with "Programming succeeded." in 3,970 ms. The total `ProgrammingResult` was `succeeded`, `destination: volatile`, 4.2 s.
- The shared CLI `program --serial 210292BCFFE4`, with the adapter injected through `ContextOverrides.platform`, also gave `Program: OK` (exit 0).

## 8. Real shared-core build (`examples/nexys-a7-counter`)

The adapter was injected with `runCli(args, out, { platform: createWindowsPlatformServices(host) })`; `platform/index.ts` was not used.

| Step | Result |
|---|---|
| check | OK (elaborated `top`, `counter_tb`) |
| simulate | PASSED: `ALL TESTS PASSED (28 checks)` @280 ns |
| build | SUCCEEDED in 15.8 s: validate, workspace, check, synthesize, constraints, implement (isolated staging) |
| resources | 56 LUT, 27 FF, 3 IO, 1 BUFG, 7 CARRY4 |
| timing | clk100mhz target 100 MHz, achieved **409.67 MHz, PASS**, critical path 2.4 ns, worst slack 7.559 ns |
| bitstream | `hardware.bit`, 3,825,910 bytes |

## 9. Physical result

**User-confirmed PASS** on the Nexys A7-100T with serial 210292BCFFE4:
- LED0 blinks;
- holding BTNC keeps LED0 off (reset);
- releasing BTNC restarts the blinking.

## 10. Driver and Vivado impact

- No driver changes, no Zadig, no WinUSB, no installer runs.
- After programming, every `VID_0403&PID_6010` interface still matches the Phase 1B `state\drivers-final.txt`. Interface 0 is still `oem32.inf`, FTDI 2.12.36.20, service FTDIBUS.
- Optional Vivado 2024.1 check, detection only (`notes/phase2-windows-vivado/detect.tcl`, batch mode): target `localhost:3121/xilinx_tcf/Digilent/210292BCFFE4A`, device `xc7a100t_0`, **DONE = 1**. hw_server was not left running, and `djtgcfg enum` still worked afterwards.

## 11. Tests

There are 52 new tests in `tests/platform/windows/windows-*.test.ts`. The fixtures are in `tests/fixtures/windows/djtgcfg/`: real djtgcfg captures, plus `*.synthetic.txt` files for cases that need more than one board. The tests use a mock `ToolRunner`, an in-memory Windows filesystem, and synthetic `.bit` files built by an independent builder. They never execute djtgcfg, GHDL, Apio or Vivado and never need Windows, so they run as-is on macOS.

| File | Covers |
|---|---|
| `windows-bit-header.test.ts` | Parsing; 10 malformed variants; part-name mapping; only field b differs; payload identity; payload-embedded part name survives; already-compatible behaviour; part mismatch; canonical file unchanged; prepared path differs; no temp files left; overwrite refusal |
| `windows-djtgcfg-output.test.ts` | enum with one/zero/multiple boards and malformed output (LF and CRLF); init chain; error classes; success line; djtgcfg and Adept Runtime versions |
| `windows-digilent-programmer.test.ts` | Availability (present, missing, old runtime); detection (one, none, multiple with the service refusing to guess, other products, not powered, probe off, enum failure/unrecognised/djtgcfg missing); preparation; programming end to end through `ProgrammingService` with serial selection and exact argument array; success and log; not powered; wrong FPGA; five failure classes; exit code 0 without the success line; unprepared file refused; cancellation passed through |
| `windows-tool-discovery.test.ts` | Validated layout; env override; no hard-coded profile; `APIO_HOME`; GHDL priority (managed newest, then per-user, then MSYS2, then PATH, quoted PATH entries); `.exe`-only PATH; empty machine; case-insensitive env; full version detection evaluated as `compatible` against the Windows manifest; missing tools; unknown djtgcfg build; factory; placeholder still registered |

Results: `npm run typecheck` is clean, and `npm test` gives **143 / 143** (91 baseline + 52 Windows).

## 12. Known limitations

- **Not registered.** `createWindowsPlatform`, which `platform/index.ts` maps to `win32`, is intentionally still the placeholder. Replacing it would activate the adapter through the existing registry and break the shared `tests/cli.test.ts` expectations (placeholder on win32, "not configured" CLI output). The real adapter is `createWindowsPlatformServices`.
- **No structured failure from `prepareArtifact()`.** The shared `ProgrammerProvider.prepareArtifact()` returns only a `ProgrammingArtifact`. The Windows provider therefore throws `DigilentArtifactError` (with `.diagnostics`) for a malformed or wrong-part bitstream. `ProgrammingService.program()` does not catch it, so today the CLI would surface an exception instead of diagnostics. The same checks are also available without throwing through `prepareDigilentBitstream()`.
- **Doctor does not show openXC7 or the programmer.** `doctor` shows both as "not checked": it uses only the core `ToolDetector`, and `PlatformServices` has no slot for platform version detection. `WindowsToolchainInspector` produces all six.
- **Package version by mapping.** The Adept Utilities version comes from the djtgcfg-to-package mapping, and only `2.6.1 → 2.7.1` is known.
- **English-text classification.** djtgcfg error classification relies on its English `ERROR:` text, which is the only signal djtgcfg provides.
- **Single board only.** Only one physical board was available, so multi-board behaviour is covered by synthetic fixtures only.
- **SRAM only.** Only volatile (SRAM) programming exists. The upstream fix for the header (Vivado-style part name) still belongs in openXC7 `xc7frames2bit`.

## 13. Recommendations for Phase 3C

1. **Register the adapter.** In `platform/index.ts`, map `win32` to `createWindowsPlatformServices`, or make `createWindowsPlatform` return it. Then update the `tests/cli.test.ts` placeholder test and the Windows CLI expectations. Those tests currently call the real registry with `env: {}`. Once they get the real adapter, they should inject a platform, or the "no tools" CLI tests will discover and run real tools on a configured Windows machine.
2. **Catch preparation failures in the core.** Either make `ProgrammingService.program()` catch errors from `prepareArtifact()` and turn them into diagnostics (for example `PROGRAM_PREPARE_FAILED`, carrying `err.diagnostics` when present), or give `prepareArtifact` a result type with diagnostics. Both are small shared changes, not made here.
3. **Add platform version detection to `PlatformServices`.** Add an optional slot, for example `detectTool?(tool): Promise<DetectedTool | undefined>` or a `ToolDetector`-like object, so `doctor` reports openXC7 and the programmer. The Windows inspector already implements this.
4. **Record djtgcfg's own version in the manifest.** Add `djtgcfg 2.6.1` and `Adept Runtime 2.30.4` to the notes of the Windows manifest's `programmer` entry, or change the tested value to the djtgcfg version, to reduce reliance on the package mapping.
5. **Hardware regression.** Use the injected adapter as done here: `doctor` → `check` → `simulate` → `build` → `program --serial`.

## Files

```
platform/windows/
    index.ts                      exports; placeholder entry kept for Phase 3C
    windows-platform.ts           createWindowsPlatformServices()
    host-environment.ts           env/filesystem boundary
    tool-locator.ts               WindowsToolLocator
    toolchain-inspector.ts        WindowsToolchainInspector
    digilent/bit-header.ts        .bit parser + normalizer
    digilent/djtgcfg-output.ts    djtgcfg output parsers
    digilent/adept-environment.ts Adept detection
    digilent/digilent-programmer.ts DigilentProgrammer (ProgrammerProvider)
tests/platform/windows/           52 tests + synthetic .bit builder
tests/fixtures/windows/           djtgcfg output fixtures
docs/phase3b-windows.md           this record
```
