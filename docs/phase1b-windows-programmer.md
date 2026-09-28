# Phase 1B — Windows programming without Vivado (Digilent Adept)

Date: 2026-09-28
Goal: program the openXC7 `hardware.bit` onto the Nexys A7-100T with Digilent's own tools, without Vivado and without changing drivers, and keep Vivado Hardware Manager working.
Experiment directory: `experiments\phase1b-windows-programmer\`

**Result: PASS, with one required fix.** openXC7's `.bit` header has to be normalized before `djtgcfg` will accept it (see §5).

## 1. Original state (before any change)

| Item | Value |
|---|---|
| OS | Windows 11 Home 10.0.26200, 64-bit |
| Board USB | FT2232H, `VID_0403&PID_6010`, serial `210292BCFFE4` |
| Interface 0 (MI_00, JTAG) | "USB Serial Converter A", `oem32.inf`, FTDI **2.12.36.20** (2024-10-28), service **FTDIBUS** |
| Interface 1 (MI_01, UART) | "USB Serial Converter B" → COM6, FTDIBUS / FTSER2K 2.12.36.20 |
| Vivado | 2024.1. Detects `localhost:3121/xilinx_tcf/Digilent/210292BCFFE4A` → `xc7a100t_0`, DONE = 1 |
| Adept Runtime | "Digilent Software 1.5.8" (2018-06-22). Installed by Vivado's `install_digilent.exe`. `dmgr` 2.8.5, `djtg` 2.13.1, `jtsc` 2.10.4 in System32 and SysWOW64 |
| Adept Utilities (`djtgcfg`) | not installed |
| WaveForms | not installed |

Vivado 2024.1 bundles no Digilent DLLs of its own. hw_server uses the system Adept Runtime.
Snapshot: `state\drivers-before.txt`.

## 2. Digilent options investigated

1. **Adept Utilities → `djtgcfg`**: a CLI with commands `enum`, `init`, `prog`, `erase` and `loop`. It programs over JTAG (FPGA SRAM only; the SPI flash is not on the JTAG chain). **Selected.**
2. **WaveForms**: not needed, so not installed or evaluated.
3. **Adept Runtime API** (`dmgr`/`djtg`): works with the existing driver. A read-only Python/ctypes probe (`adept-probe\enum_devices.py`) enumerated `NexysA7`. However, the public API is raw JTAG only (no "configure FPGA" call), so using it directly means writing our own 7-series configuration sequence. Fallback only.

digilent.com and files.digilent.com sit behind a Cloudflare bot check, so the user downloaded the installers manually.

## 3. Installed Digilent components

Both installers are in `downloads\`, have valid Authenticode signatures, and were run by the user (UAC). The app refused to launch an admin installer on the user's behalf.

| Package | File | SHA-256 | Result |
|---|---|---|---|
| Adept Utilities 2.7.1 | `digilent.adept.utilities_v2.7.1.exe` (858 KB, signer "Digilent Inc.") | `0651A88B…82A37E` | `C:\Program Files (x86)\Digilent\AdeptUtilities\{djtgcfg,dadutil,dsumecfg}.exe` + `doc\*.pdf`. No driver or DLL changes. |
| Adept Runtime 2.30.4 | `digilent.adept.runtime_v2.30.4.exe` (70 MB, signer "Digilent, Inc.") | `2DF8EECB…7059DD` | DLLs upgraded in System32 and SysWOW64: `dmgr` 2.11.12, `djtg` 2.13.21, `dpcutil` 2.9.25, `jtsc` 2.10.25 (all 2025-12-05). Staged `Runtime\UsbDriver2\digiftdibus.inf` (FTDI 2.12.36.4, 2021). **No driver prompts, and USB bindings unchanged.** |

Why the Runtime upgrade was needed: `djtgcfg.exe` 2.7.1 is 32-bit and imports `DmgrSetNetworkEnumTimeout` and `DmgrGetEdvc`, which the 2018 `dmgr.dll` lacks. Against Vivado's runtime it fails to start with `0xC0000139` (entry point not found).
The user approved the upgrade explicitly.

Side effect: each installer overwrites the shared `C:\Program Files (x86)\Digilent\uninstall.exe`.

## 4. Driver state after everything

`state\drivers-final.txt`: every `VID_0403&PID_6010` interface still has the same INF, provider, version (FTDI 2.12.36.20) and service (FTDIBUS / FTSER2K) as the baseline.
The Microsoft-signed FTDI/Digilent packages in the driver store are 2.12.36.4 (2021), older than the bound 2.12.36.20, so Windows keeps the current binding.
**No Zadig, no WinUSB, no FTDIBUS replacement, no registry edits by hand.**

## 5. Bitstream header issue

With the original file, `djtgcfg prog` fails in 0.2 s, before any JTAG traffic:

```
ERROR: failed to set programming file
Received error: unrecognized error code
```

The cause is the `.bit` header's part-name field (field `b`):

| | field a | field b (part) | payload (field e) |
|---|---|---|---|
| openXC7 `xc7frames2bit` | `build\default\hardware.frames;Generator=xc7frames2bit` | `xc7a100tcsg324-1` | 3,825,788 B |
| Vivado 2019.1 / 2024.1 (5 project bitstreams, read-only) | `<top>;UserID=0XFFFFFFFF;Version=…` | `7a100tcsg324` | 3,825,788 B |

The fix, approved by the user, is `normalize_bit_header.py`. It writes a **copy** with only field `b` rewritten to Vivado form, then verifies the payload.

- Original `hardware.bit`: untouched, SHA-256 `b805749b…898c39` (same as Phase 1).
- `bit\hardware_digilent.bit`: SHA-256 `20418a6b…789b84`.
- Payload (last 3,825,788 bytes) SHA-256 is **identical** in both: `8cf6155d…37301a`.

Vivado accepts either header. djtgcfg needs the Vivado form.

## 6. Programming (no Vivado)

```bat
set DJTGCFG="C:\Program Files (x86)\Digilent\AdeptUtilities\djtgcfg.exe"
%DJTGCFG% enum
%DJTGCFG% init -d NexysA7
python normalize_bit_header.py ..\phase1-windows-vhdl\_build\default\hardware.bit bit\hardware_digilent.bit
%DJTGCFG% prog -d NexysA7 -index 0 -file D:\WSClaude\NexysVHDL\experiments\phase1b-windows-programmer\bit\hardware_digilent.bit
```

Output:

```
Programming device. Do not touch your board. This may take a few minutes...
Programming succeeded.
```

The exit code was 0 and it took 4.0 s, from a **non-elevated** shell. Log: `logs\djtgcfg-prog-normalized.log`.

**Physical result (user-confirmed): SW0 OFF → LED0 OFF, SW0 ON → LED0 ON.**

## 7. Vivado coexistence

After the Digilent programming (djtgcfg had exited), there was no driver action and no replug:

- `vivado\detect.tcl`: target `…/Digilent/210292BCFFE4A`, device `xc7a100t_0`, DONE = 1.
- `vivado\program.tcl`: reprogrammed the **original** `hardware.bit`. `End of startup status: HIGH`, DONE = 1.
- With Vivado's `hw_server.exe` still running as a daemon, `djtgcfg prog` again succeeded (`logs\djtgcfg-prog-with-hwserver.log`). The two tools can alternate freely. hw_server only claims the cable while a target is open, so a simultaneous open Hardware Manager session is expected to conflict (not tested).

## 8. Automation interface (for a future ProgrammerProvider)

| Need | Command | Result |
|---|---|---|
| Executable | `C:\Program Files (x86)\Digilent\AdeptUtilities\djtgcfg.exe` (32-bit, v2.6.1 banner / package 2.7.1) | |
| Detect board | `djtgcfg enum` | rc 0. Lines `Device: <user name>`, `Product Name: Digilent Nexys A7 -100T`, `Serial Number: 210292BCFFE4` |
| Detect FPGA | `djtgcfg init -d <dev>` | rc 0. `Found Device ID: 13631093` (XC7A100T IDCODE), `Device 0: XC7A100T` |
| Program SRAM | `djtgcfg prog -d <dev> -index 0 -file <bit>` | rc 0 + `Programming succeeded.` |
| Select a specific board | `-d NexysA7` (user name/alias) or **`-d SN:210292BCFFE4`** | a bare serial fails |
| Errors | no board: `ERROR: failed to initialize scan chain`, rc 1. Missing file: `ERROR: could not open "…" for reading`, rc 1. Bad header: `ERROR: failed to set programming file`, rc 1 | |
| Verify | no readback/verify command. Success = rc 0 + "Programming succeeded." (the utility checks DONE). Optional stronger check: `init` IDCODE before programming | |
| Flash | not supported over this path (djtgcfg's `erase` clears the FPGA's SRAM configuration). Not tested | |
| Admin rights | installing needs admin; **using djtgcfg does not** | |

The help flags are `-?`/`-help`, not `-h`/`--help`.

## 9. Dependencies for students (Windows)

- **Adept Runtime ≥ 2.30.x**: Vivado 2024.1's bundled 2018 runtime is too old for djtgcfg 2.7.1.
- **Adept Utilities 2.7.1.**
- Both are free from Digilent, need admin to install and a manual browser download (Cloudflare). No Vivado required.
- Our tool must normalize the `.bit` header (a pure-Python step, ~60 lines) or get openXC7/Apio to emit Vivado-style part names.

## 10. Licensing / redistribution

No license or EULA files are installed with either package, and Digilent's website could not be read (bot check). Whether we may bundle the Adept Runtime/Utilities with our application is **unverified**, so for now assume students install them from Digilent. Ask Digilent before planning to redistribute.

## 11. Limitations

- Only SRAM (volatile) programming was tested. Flash is untouched.
- The Runtime upgrade changed Vivado's Digilent DLLs. Vivado 2024.1 worked afterward in this test, but other Vivado versions were not tested. Vivado's `install_digilent.exe` would reinstall its bundled (2018) runtime and break djtgcfg again.
- A simultaneously open Hardware Manager target was not tested.
- The header rewrite is a workaround; the upstream fix belongs in openXC7 `xc7frames2bit`.
- Only one board was connected, so the multi-board behavior of `SN:` selection is inferred, not tested.

## Files

```
phase1b-windows-programmer\
    normalize_bit_header.py     header-only .bit normalizer (payload verified)
    bit\hardware_digilent.bit   normalized copy of Phase-1 hardware.bit
    adept-probe\enum_devices.py read-only Adept API enumeration probe
    downloads\                  Digilent installers (user-downloaded)
    logs\                       djtgcfg output
    state\                      driver snapshots (before / after-utilities / after-runtime / final)
    vivado\                     detect.tcl, program.tcl, logs
```
