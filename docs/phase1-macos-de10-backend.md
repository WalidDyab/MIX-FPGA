# Phase 1 — macOS / DE10-Lite backend (MIX-FPGA)

MIX-FPGA is an EMXplore project. Copyright 2026 Walid Dyab. Apache-2.0.
Status: **Phase 1 COMPLETE — all acceptance criteria met on real hardware.** Nothing committed or pushed; awaiting user review.

| Path | Result |
|---|---|
| Manual chain (`mixfpga-ofl` + SVF), Checkpoint F | **PASSED** — LEDR0 blink confirmed by the user (2026-10-14) |
| New TypeScript `ProgrammingProvider` path, final acceptance | **PASSED** — LEDR0 blink confirmed by the user after `De10LiteBackend.program()` (2026-10-14) |
| Headless build through `QuartusLimaImplementationProvider` | PASSED (cold ≈34 s, warm ≈26 s) |
| Automated tests | 783 total, 782 pass, 0 fail, 1 skipped (pre-existing "launcher (Windows)" skip); Nexys baseline 708 pass unchanged |
| Closeout checks | nothing staged; no `.artifacts`/Quartus/VM/installer/vendor files in the change set; NexysVHDL Toolchain 1.0 and `NexysVHDL-repo` unmodified (hashes below) |

Sections appear in chronological order; statements such as "pending" or "not installed" in earlier checkpoints describe the state *at that time* and are resolved in later sections.

## Base
- NexysVHDL repo `NexysVHDL-repo`: `main`, clean, HEAD `a6c459a` (macOS 0.6.0). Untouched.
- MIX-FPGA: branch `phase1/macos-de10-backend`, created at `a6c459aa50979eae46c900f1eede7288baf4c886` (full history preserved). Nothing committed or pushed.
- Note: this checkout already had `origin = github.com/WalidDyab/MIX-FPGA`; nothing was pushed.

## Host (recorded 2026-10-13, before any change; Rosetta was installed by the user afterwards)
| Item | Value |
|---|---|
| macOS | 27.0.1 (26A434) |
| Model | Mac16,12, Apple M4, arm64 |
| RAM | 16 GiB |
| Free disk | 122 GiB of 228 GiB |
| Rosetta 2 | **Not installed** (`arch -x86_64` → "Bad CPU type"; only the Linux-VM stub `/Library/Apple/usr/libexec/oah/RosettaLinux`) |
| Xcode CLT | `/Library/Developer/CommandLineTools` present |
| Lima | none before this work (`~/.lima` absent) |
| Quartus / Altera files | none found (searched volume, Downloads) |
| System GHDL / openFPGALoader / VS Code CLI / brew | not on PATH |
| NexysVHDL Toolchain 1.0 (reference only) | `~/Library/NexysVHDL/toolchains/darwin-arm64/1.0`; manifest sha256 `71241b94…fc09a`; GHDL 6.0.0 (sha256 `38a99c1c…3c3d`); openFPGALoader 1.1.1 (sha256 `06457ddf…21d`) |

## Lima
- Version: **2.2.1** (latest stable release; 2.3.0 is beta only). Source: github.com/lima-vm/lima release v2.2.1.
- Tarball `lima-2.2.1-Darwin-arm64.tar.gz`, sha256 `9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e` — matches the official `SHA256SUMS`.
- Installed under ignored `toolchains/experimental/lima-2.2.1/` (Apache-2.0 LICENSE kept in `share/doc/lima/`). Own `LIMA_HOME=~/Library/MIX-FPGA/lima` (repo-local path exceeds the 104-char UNIX socket limit).
- VM config: `platform/macos/lima/mix-fpga-de10.yaml` (vz, aarch64, 4 CPU, 8 GiB, 60 GiB disk, Rosetta+binfmt, pinned Ubuntu 24.04 `release-20260926` arm64 image with digest, only `~/Library/MIX-FPGA/staging` mounted writable).

## Blockers at Checkpoint A (both resolved in Checkpoints B and C)
1. Rosetta 2 must be installed (`softwareupdate --install-rosetta --agree-to-license`) — privileged + license acceptance; awaiting user.
2. Quartus Prime Lite 25.1 Linux installer + MAX 10 device package — not on this Mac; user must download from the official Altera site.

## Checkpoint B — VM, Rosetta (2026-10-13)
- Rosetta 2 installed by the user; `arch -x86_64 /usr/bin/true` OK.
- Instance `mix-fpga-de10`, `LIMA_HOME=~/Library/MIX-FPGA/lima`. Guest: Ubuntu 24.04.5 LTS, kernel 6.8.0-142 aarch64, vz, 4 CPU, 7.9 GiB visible RAM, 60 GiB disk (58 G fs, 1.8 G used before Quartus).
- Native ARM64: `/bin/ls` is `ELF aarch64`, `uname -m` = `aarch64`.
- Rosetta: binfmt `rosetta` enabled (`interpreter /mnt/lima-rosetta/rosetta`, flags OCF). Test binary: busybox-static 1.37.0-7ubuntu1 **amd64** (deb sha256 `fd605342…8141a4`, Ubuntu archive): ELF x86-64, `busybox uname -m` → `x86_64`, while guest `uname -m` → `aarch64`. PASS.
- Timings: image download+create 24 s (cached image afterwards); cold start 11 s; warm start 7 s.
- Idle (60 s after start): guest RAM used 332 MiB; host `limactl` 0.0 % CPU, VM XPC 0.0 % CPU, 1.1 GB RSS.
- Disk before Quartus: VM dir 2.0 GB, Lima image cache 2.5 GB.
- Workaround: repo-local LIMA_HOME exceeded the 104-char UNIX socket limit; moved to `~/Library/MIX-FPGA/lima`.

## Vendor files supplied by user (not committed, not redistributed)
| File | Size | SHA-256 |
|---|---|---|
| `QuartusLiteSetup-25.1std.0.1129-linux.run` | 1,982,715,698 | `518433ec7dcd61725560af653353f7a5c320cce9e528b22747b8a8df3674c4eb` |
| `max10-25.1std.0.1129.qdz` | 302,078,437 | `8057844b0b91c2ba7ef2b37b1986d198ec4f1831cc9be0a52d18e5feb4c19ce9` |

## Checkpoint C — Quartus Prime Lite 25.1 + MAX 10 (2026-10-13)
License: user explicitly accepted the Altera Quartus Prime Lite terms in chat; `--accept_eula 1` used on that basis. Installers were copied (not moved) to `~/Library/MIX-FPGA/staging/vendor/` (2.1 GB, outside git); originals remain in `~/Downloads`.

**Installed**: Quartus Prime Lite Edition **25.1std.0 Build 1129 (10/21/2025)**, MAX 10 device package **max10-25.1std.0.1129.qdz**, at `/opt/mixfpga/quartus/25.1std` (guest). Device check: family list `{MAX 10}`; `10M50DAF484C7G` present in `get_part_list`.

**Final unattended command** (run in guest, from the staging mount):
```
./QuartusLiteSetup-25.1std.0.1129-linux.run --mode unattended --unattendedmodeui minimal --accept_eula 1 \
  --installdir /opt/mixfpga/quartus/25.1std \
  --disable-components quartus_help,arria_lite,cyclone,cyclone10lp,cyclonev,max,quartus_update,riscfree,questa_fse,questa_fe \
  --create_desktop_shortcuts 0
```
Enabled components: `quartus`, `devinfo`, `max10`. Install time ~63 s. Logs: `.artifacts/logs/install-*.{log,txt}`, `quartus-guest-install.log`.

**Disk (guest `/`, used)**
| Stage | Used |
|---|---|
| Before Quartus (after amd64 libs, 2.3 GB base+libs) | 2.40 GB |
| After Quartus (no MAX 10) | 11.53 GB (install dir 8.6 GB) |
| After MAX 10 (clean single install) | 11.92 GB (install dir 8.9 GB; MAX 10 ≈ +0.4 GB) |
| After cleanup (apt cache/lists, installer temp logs) | 11.33 GB (11 G of 58 G; 47 G free) |

Install dir breakdown: quartus 3.5 G, **nios2eds 3.6 G**, ip 1.9 G, niosv 23 M. `nios2eds` ships inside the mandatory `quartus` component and is unused (possible future trim; not removed, to stay audit-clean). Host: VM dir 11 GB, vendor copies 2.1 GB, Lima image cache 2.5 GB. Guest RAM after install work: 740 MiB used (rest page cache).

**Installer behaviour worth knowing**: re-running the main installer on an existing install-dir, with `max10` enabled, does nothing (exits 0 in ~10 s, no unpack); `dev_install.run` likewise no-op'd. A clean single install with `quartus,devinfo,max10` is what works. No installer warnings besides "Unable to use minimal UI during unattended installation" (harmless).

**Rosetta workarounds (no vendor file was modified)**
1. x86-64 ELF loader and libs missing → `platform/macos/lima/provision-guest.sh`: enable dpkg `amd64` (archive.ubuntu.com, arm64 sources pinned with `Architectures: arm64`), install `libc6:amd64 libstdc++6 zlib1g libx11 libxext libxft libxtst libxi libxrender libsm libice libfreetype libfontconfig libpng16 libxcb libglib2.0 libudev1 libncurses6 libtinfo6 libcrypt1` (amd64). `libcrypt.so.1` was the only lib found missing at run time (quartus_map).
2. Quartus `adm/qenv.sh` picks 32-bit from `uname -m` (aarch64) and greps `/proc/cpuinfo` for `sse` → "Can not run the 64-bit Quartus II software on a 32-bit machine". Workaround in `platform/macos/lima/provision-quartus-env.sh`, installing `/usr/local/bin/mixfpga-q`: runs each tool in a private mount namespace (`sudo unshare -m`) with a bind-mounted x86-like `/proc/cpuinfo`, a `uname -m`→`x86_64` shim first in PATH, then drops privileges via `setpriv`. Student-writable files are never touched as root. Needs passwordless sudo in the guest (Lima default).

**Environment set by `mixfpga-q`**: `QUARTUS_ROOTDIR_OVERRIDE=/opt/mixfpga/quartus/25.1std/quartus`, `LC_ALL=C.UTF-8`, `HOME` preserved, `PATH=/usr/local/lib/mixfpga/shim:$QUARTUS_ROOTDIR/bin:/usr/local/bin:/usr/bin:/bin`. Quartus GUI never launched.

**CLI verification** (each via `mixfpga-q <tool> --version`, exit 0, all "Version 25.1std.0 Build 1129 10/21/2025 SC Lite Edition"): quartus_sh, quartus_map, quartus_fit, quartus_sta, quartus_asm, quartus_cpf (also quartus_pgm, quartus_cdb). `quartus_syn` is Pro-only (expected; Lite uses quartus_map).

## Checkpoint D — DE10-Lite blink builds headlessly (2026-10-13)

### Authoritative pin source (archived in `.artifacts/sources/terasic/`, git-ignored)
- Terasic DE10-Lite product page (resources tab): https://www.terasic.com.tw/cgi-bin/page/archive.pl?Language=English&CategoryNo=218&No=1021&PartNo=4 — lists *DE10-Lite User Manual v1.7 (2025-04-01)* and *DE10-Lite CD-ROM v2.2.0*.
- Downloaded: `DE10-Lite_User_Manual.pdf` (6,234,852 B, 74 pp, SHA-256 `ab2c47e5a7e4ac26874013bfe05df31e2d498bc9a7f9f6b33bd931c64db848ac`); text extracted to `DE10-Lite_User_Manual.txt`. Page footers date the body October 17, 2022; revision table ends V1.7 (2022.10).
- **Table 3-2**: `MAX10_CLK1_50` = **PIN_P11**, 50 MHz, Bank 3B, 3.3-V LVTTL. **Table 3-5**: `LEDR0` = **PIN_A8**, 3.3-V LVTTL, active-high ("driving its pin high turns it on").
- Device 10M50DAF484C7G: Terasic product page + manual. Both pins match the secondary cross-check (P11 / A8).
- The System CD (v2.2.0, would contain the default QSF) was **not** fetched: its download needs a form-token POST and ~GB-scale transfer; the manual tables are Terasic's own authoritative pin list. Can be added if wanted.
- Non-manual QSF settings in `de10-lite.qsf` (`RESERVE_ALL_UNUSED_PINS_WEAK_PULLUP`) are standard Quartus options, not from Terasic.

### Project: `experiments/phase1-de10-blink/`
`src/blink.vhd` (entity `blink`, 26-bit counter, `ledr0 <= count(25)`, ≈0.75 Hz → LED toggles every ~0.67 s), `constraints/de10-lite.qsf` (family/device/pins/IO standard), `constraints/de10-lite.sdc` (`create_clock -period 20.000 clk_50`, `derive_clock_uncertainty`).
- **GHDL Check (independent, `--std=08`, Toolchain 1.0's ghdl 6.0.0 used read-only, workdir in `.artifacts/ghdl`)**: PASS. Log `.artifacts/logs/ghdl-check.txt`.
- **Student sources unchanged**: SHA-256 of all 4 project files identical before/after both builds (`.artifacts/logs/source-hashes-before.txt`).

### Staging and build driver (Checkpoint D shell prototype `mixfpga-build.sh` — since replaced by the TypeScript backend of Checkpoint G, which implements the same design)
Copies `src/*.vhd`, `constraints/*.{qsf,sdc}` to `~/Library/MIX-FPGA/staging/jobs/<name>-<hash>/`, generates `blink.qpf/.qsf` there (top entity, `PROJECT_OUTPUT_DIRECTORY`, VHDL/SDC file lists + the board QSF appended; refuses if constraints don't name `10M50DAF484C7G`), copies the job into a **guest-local** dir (`~/.mixfpga-work/<id>`), runs `mixfpga-q quartus_map → quartus_fit → quartus_asm → quartus_sta`, copies `output_files` back and into `<project>/.mix-fpga/build/de10-lite/` (ignored). Per-step logs and `timing.txt` in `…/logs/`.

### Result (all four steps exit 0; raw reports in `.artifacts/de10-blink/`, logs in `.artifacts/logs/`)
| Item | Value |
|---|---|
| Analysis & Synthesis | Successful, 0 errors, 1 warning; top `blink`; family MAX 10 |
| Fitter | Successful, 0 errors, 4 warnings; **Device 10M50DAF484C7G**; pins `clk_50`=P11 (3.3-V LVTTL, bank 3), `ledr0`=A8 (3.3-V LVTTL, bank 7) per `blink.pin` |
| Timing analyzer | Successful; all 9 corner/slack lines positive |
| Assembler | Successful → `blink.sof` |
| Logic elements | 27 / 49,760 (<1 %) — 27 combinational, 26 registers |
| Memory / DSP | 0 / 1,677,312 bits; 0 / 288 9-bit multipliers; 0 PLLs; 0 UFM/ADC |
| Pins | 2 / 360 |
| Target clock | 50 MHz (20.000 ns) |
| Slack (setup, worst) | +16.605 ns @ Slow 1200mV 85C; 16.964 @ 0C; 18.644 @ Fast 0C |
| Slack (hold, worst) | +0.156 ns (Fast 1200mV 0C) |
| Fmax | 294.55 MHz (85C) / 329.38 MHz (0C) unrestricted; 250.0 MHz restricted by max I/O toggle rate |
| Warnings | 18236 ×4 (NUM_PARALLEL_PROCESSORS unset); 292013 LogicLock needs subscription (benign); 169177 "1 pin must meet 3.3-V interface requirements (AN 447)" — expected for 3.3-V LVTTL on MAX 10 (board-level, same on Terasic reference designs); 15714 some pins have incomplete I/O assignments (unused pins, weak pull-up) |
| `blink.sof` | 3,216,546 B, SHA-256 `dea4f9fd9b7c31b655e9cffd1013be2e3101f1f3a2461b86117094f7b85cb8c4` |
| `blink.pof` | 1,450,252 B, `9e7485a5…97326d` (flash image; **not** for Phase 1) |
| `blink.svf` | 1,801,020 B, SHA-256 `9991a0c2…11284e`, via `quartus_cpf -c -q 10MHz -g 3.3 -n p blink.sof blink.svf` (fallback for openFPGALoader) |

### Build times (VM Rosetta/JIT; steps in `timing.txt`)
- **Cold** (VM stopped → started by the driver, fresh job dir): **33.0 s** total = VM start 7.8 s + Quartus 25.1 s (map 10.1, fit 8.3, asm 2.8, sta 3.7).
- **Warm** (VM running, fresh job dir): **24.6 s** (map 10.1, fit 8.3, asm 2.8, sta 3.7). Quartus has no cross-run cache here; the warm/cold difference is VM startup only.

### Programming-format investigation (preliminary at Checkpoint D; hardware result: `.sof` is NOT loadable, `.svf` works — see Checkpoint F)
openFPGALoader v1.1.1 (frozen Toolchain 1.0 binary, read-only) lists board `de10lite` (cable `usb-blaster`) and cable `usb-blaster` 0x09fb:6001; `--file-type` can force a type. Primary artifact: `.sof` (SRAM, temporary). If openFPGALoader rejects `.sof`, use `blink.svf` (generated above). Internal flash (`.pof`) deliberately out of scope.

### New problems found and workarounds (all scripted in `platform/macos/lima/`)
1. **Quartus tools died with SIGBUS after the first VM reboot** (even `--version`). Cause (strace): Rosetta mmaps its AOT cache file `~/.cache/rosetta/*.flu` at offset 0x2000, but the file is 33 bytes. It occurs only while Lima's **`rosettad` AOT caching daemon** serves `/run/rosettad/rosetta.sock`; stopping the daemon fixes it; clearing `~/.cache/rosetta` and `/var/cache/rosettad` does not. `systemctl disable/mask` do not stick because Lima 2.2.1's `boot.Linux/05-rosetta-volume.sh` rewrites `rosettad.service` and runs `systemctl enable --now` on every boot. Workaround: a systemd drop-in `rosettad.service.d/mixfpga-no-aot.conf` replacing `ExecStart` with `sleep infinity` (no socket → Rosetta runs without AOT). Verified across a stop/start. This is a real **classroom risk**: it depends on Lima/Rosetta/macOS versions; pin them and keep an automated Quartus smoke test in "Detect/Ensure Ready".
2. Builds run on the guest-local disk and use the virtiofs mount only for transfer (a first attempt to build on the mount was abandoned while debugging; the SIGBUS was *not* virtiofs-related).
3. Quartus writes its outputs in the project dir unless `PROJECT_OUTPUT_DIRECTORY` is set; the driver sets it.

### Host disk footprint after the successful build (`.artifacts/logs/host-footprint.txt`)
| Item | Size |
|---|---|
| Lima runtime (`toolchains/experimental/lima-2.2.1`, includes guest agents) | 78 MB |
| VM directory `~/Library/MIX-FPGA/lima/mix-fpga-de10` (sparse, actual blocks; 60 GiB virtual) | 10.8 GB |
| Lima image cache `~/Library/Caches/lima` (Ubuntu cloud image, raw+qcow2) | 2.46 GB |
| Build staging `~/Library/MIX-FPGA/staging/jobs` | 6.5 MB |
| Quartus installer copies `~/Library/MIX-FPGA/staging/vendor` | 2.13 GB (*still present*) |
| **Total `~/Library/MIX-FPGA`** | **12.96 GB** |
| Originals in `~/Downloads` (user's) | 2.28 GB |
| Project `.mix-fpga` (sof+svf+pof+reports+logs) | 9.6 MB |
| Repo `.artifacts` (raw evidence, ignored) | 53 MB |
| Guest: `/` used / free | 11 GB / 47 GB; guest build dir 12 MB; RAM idle 455 MiB used |
Cleanup-policy notes: the vendor copies (2.1 GB) and image cache (2.5 GB, regenerable) are removable after install; guest `nios2eds` (3.6 GB) is an unused part of the `quartus` component.

## Checkpoint E — native programmer and detection (2026-10-13)

### Pinned native openFPGALoader (separate from NexysVHDL runtime)
Location: `toolchains/experimental/openfpgaloader-1.1.1/` (git-ignored); wrapper `platform/macos/de10/mixfpga-ofl` (sets `OPENFPGALOADER_SOJ_DIR`). MIX-FPGA has **no runtime dependency** on NexysVHDL Toolchain 1.0.
- Version: **openFPGALoader v1.1.1**; arch: Mach-O arm64 (native Apple silicon); upstream: https://github.com/trabucayre/openFPGALoader, built by YosysHQ OSS CAD Suite 2026-09-15 at source revision `451beadfae953df07ae14e1dc29238b8d9ae60bc` (per bundled `LICENSE.openfpgaloader`).
- Copied (read-only source, originals untouched) from `~/Library/NexysVHDL/toolchains/darwin-arm64/1.0/apio/packages/oss-cad-suite/{libexec,lib,share,license}`. **Every copied file is byte-identical** to the validated NexysVHDL copy (`cmp`):
| File | SHA-256 |
|---|---|
| `libexec/openFPGALoader` | `99dcde0efb78de808ce596fc82c8361127f7c793618aa46d6b386dd79586fdc3` |
| `lib/libusb-1.0.0.dylib` | `5c17d619e03c6db07ec356fa1a601d80abee353f21567045c82029de8360a50f` |
| `lib/libftdi1.2.5.0.dylib` | `fd8cc846cb2b020cb0a04204ace7111c5fba3d3a6953b3913b013a7a8f0c13f3` |
| `lib/libhidapi.0.dylib` | `ce63ca7a3fb58d6ca6fb53ea296904a958a2686d359ff12ed5b6c0e7ee5cbc49` |
| `lib/libz.1.3.dylib` | `d98b15f0ee5f7f6596be580c56a6b44f22df1b42a27ff7141eb8bda7c3f19644` |
| `lib/libzstd.1.5.5.dylib` | `388b05433363fa24f11d528d474cbce3000b4d3e7b048fe1f963d5a99733a63b` |
(The NexysVHDL `bin/openFPGALoader` shell wrapper, sha256 `06457ddf…`, was not copied; it is replaced by `mixfpga-ofl`.)
- Licenses (kept in `license/`): openFPGALoader **Apache-2.0**; libusb **LGPL-2.1+**; libftdi **LGPL-2 (library)**; hidapi (see upstream; BSD/GPL/HIDAPI terms), zlib, zstd (BSD/zlib-style — **their license files are not in the bundle; to be added before any redistribution**). Redistribution is permitted in principle, but LGPL dynamic-library obligations (notices, replaceability of the dylibs — satisfied by shipping them as separate .dylib files) and the missing hidapi/zlib/zstd notices must be verified before shipping. `bin` runs: `openFPGALoader v1.1.1`.
- Board support in v1.1.1: `-b de10lite` (cable `usb-blaster`, 0x09fb:6001); `--file-type` selectable.

### Detection — board present (2026-10-14), detection only, nothing programmed
Raw output: `.artifacts/logs/E-detect-board-present.txt` (absent-board run kept in `E-detect-board-absent.txt`).
- **macOS USB enumeration (`ioreg`)**: "USB-Blaster", vendor "Altera", idVendor 2555 = **0x09FB**, idProduct 24577 = **0x6001**, serial `91d28408`, behind an HP USB-C Travel Hub G2 (works through the hub). `system_profiler SPUSBDataType` prints nothing in this environment, so `ioreg` is the reliable source.
- **`openFPGALoader --scan-usb`**: `001 004 0x09fb:0x6001 usb-blaster Altera 91d28408 USB-Blaster`.
- **`openFPGALoader --detect -b de10lite`** (exit 0), JTAG chain, one device:
  `index 0: idcode 0x31050dd, manufacturer altera, family MAX 10, model 10M50D, irlength 10`.
- **Conclusion**: the MAX 10 is identified correctly — IDCODE 0x031050DD is the 10M50DA (10M50DAF484C7G) JTAG ID; the chain has the single expected device. openFPGALoader v1.1.1 needed no change; no driver install or privileges were needed on macOS.

## Checkpoint F — first programming attempt (2026-10-14): FAILED in software, board untouched
Command: `mixfpga-ofl -b de10lite --file-type sof …/blink.sof` (artifact sha256 `dea4f9fd…c8c4`). Log: `.artifacts/logs/F-program-sof.txt`.
Result: `Model not supported. Please update max10_memory_map.` / `Failed to program FPGA`, exit 1. Re-detect afterwards still shows IDCODE `0x31050dd` 10M50D. **Nothing was written to the device** (error raised before any JTAG programming).

### Root cause (read from upstream source, v1.1.1 `src/altera.cpp` vs current master)
- openFPGALoader has **no `.sof` parser**. In `Altera::Altera()` the mode is chosen from the file extension: `svf` → `MEM_MODE` (SRAM, plays the SVF over JTAG); `rbf/rpd` → MEM/SPI; `pof` → `FLASH_MODE`; and **any other extension on a MAX 10 → `FLASH_MODE`** (this is what `.sof` hit; `--file-type sof` just names it).
- `FLASH_MODE` on MAX 10 goes through `max10_program()`, which writes the internal flash/UFM and needs the chip in `max10_memory_map`. In **v1.1.1** the map only has 10M08SAU, 10M16SA, 10M25SA → **10M50D (0x031050dd) is absent** → the error above.
- Upstream history: 2026-03-24 added 10M16D; **2026-08-14** (`628317d`, `b31fa6c`) added 10M50D with `.pof` *internal-flash* programming. Latest tag is still v1.1.1 (2026-03-11); master HEAD `bf2b529` (2026-10-05). So 10M50D flash support exists only on unreleased master.
- Neither version can load a `.sof` into SRAM. **The upstream-supported SRAM path for MAX 10 is the `.svf` (MEM_MODE)**, which is exactly the fallback already generated by `quartus_cpf -c -q 10MHz -g 3.3 -n p` (`blink.svf`, sha256 `9991a0c2…11284e`). Flash programming (`.pof`) is out of Phase 1 scope, so the newer master's 10M50D flash support is not needed.
- Conclusion: failure is "wrong artifact type for this tool," not a USB/JTAG problem and not fixed by a version bump for SRAM use.

### Second attempt — SVF into SRAM (2026-10-14 00:36)
`mixfpga-ofl -b de10lite …/blink.svf` (sha256 `9991a0c2…11284e`), ~4.0 s. Output: `USB-BlasterI has a 24MHz fixed frequency` / `end of SVF file`; no error lines. JTAG re-detect afterwards still reports 10M50D (0x31050dd). Log: `.artifacts/logs/F-program-svf.txt` (the `rc=` line there is empty — a shell-pipeline slip in my logging; the tool printed no error). SRAM only; internal flash untouched.
**Status at that moment: software flow passed; physical confirmation pending — resolved: user confirmed LEDR0 blinks (see Checkpoint F result below).**


### Checkpoint F result — PASSED (physical confirmation, 2026-10-14)
After the SVF load the user confirmed **LEDR0 blinks correctly at the expected rate**. End-to-end chain proven on real hardware:
`VHDL → GHDL Check → Quartus Prime Lite 25.1 CLI in Lima/Rosetta → MAX 10 implementation → SVF → native macOS openFPGALoader → DE10-Lite`.
Phase 1 acceptance criterion (physical LED behaviour confirmed by the user) is met.

---

## Checkpoint G — reusable backend, provider seam, tests (2026-10-14)

### What was added (all additive; the only existing file touched is `.gitignore`)
| Path | Purpose |
|---|---|
| `core/backend/types.ts` | Vendor-neutral contracts: `BoardProfile`, `ConstraintProvider`/`ConstraintSet`, `ImplementationProvider`, `NormalizedBuildResult`, `ProgrammingProvider`, `EngineProvider` |
| `core/backend/profiles.ts` | `DE10_LITE_PROFILE` (exact part `10M50DAF484C7G`, IDCODE `0x031050dd`, QSF+SDC, SVF) |
| `core/backend/qsf-sdc.ts` | `QsfSdcConstraintProvider` (read-only; checks DEVICE, QSF+SDC presence) |
| `core/backend/environment.ts` | `describeEnvironment()` — the student-facing Board / FPGA / VHDL / Simulation / Implementation Engine / Programmer table + Details |
| `core/implementation/quartus/parsers.ts` | Pure Quartus report/log parsers (resources, slack, Fmax, SDC clocks, success-line, warnings) |
| `platform/macos/de10/config.ts` | Paths + pinned versions (MIX-FPGA-owned locations only) |
| `platform/macos/de10/engine.ts` | `LimaEngine` — status / ensureReady / restart / shutdown / repair |
| `platform/macos/de10/quartus-lima-provider.ts` | `QuartusLimaImplementationProvider` — staging, Quartus chain, cancel, result normalisation |
| `platform/macos/de10/ofl-programmer.ts` | `NativeJtagProgrammer` — detect + program (SVF) |
| `platform/macos/de10/backend.ts` | `De10LiteBackend` facade: `status() ensureReady() build() cancelBuild() detectHardware() program() restartImplementationEngine() shutdownImplementationEngine() environment()` |
| `platform/macos/de10/cli.ts`, `mixfpga-de10` | Validation driver (`status\|ensure-ready\|build\|detect\|program\|restart\|shutdown\|env`, `--json`) — not a student UI |
| `platform/macos/lima/` | `mix-fpga-de10.yaml`, `provision-guest.sh`, `provision-quartus-env.sh` |
| `tests/mixfpga/*`, `tests/fixtures/quartus-de10/` | 74 focused tests; fixtures are real Phase 1 Quartus reports |

### Proposed interfaces (summary; code in `core/backend/types.ts`)
```ts
BoardProfile            { id, name, vendor, fpga{family, device, jtagIdcode?}, constraintFormat:'xdc'|'qsf-sdc',
                          implementationProviderId, programmingProviderId, programmingFormat:'bit'|'svf',
                          programmerBoardKey?, metricLabels{logic,registers,memory,dsp}, identification? }
ConstraintProvider      { format; collect(projectDir): ConstraintSet; validate(set, board): Diagnostic[] }   // read-only
ImplementationProvider  { id; supports(board); build({projectDir, board, top?, signal?, onProgress?, onOutput?}): NormalizedBuildResult }
ProgrammingProvider     { id; availability(); detect(board): HardwareDetection; program({artifact, board, signal?}): ProgramOutcome }
EngineProvider          { id; status(); ensureReady(signal?); restart(signal?); shutdown() }    // the "toolchain provider"
NormalizedBuildResult   { boardId, device, implementationStatus, failedStage?, timingStatus, clocks[], resources{logic,registers,memoryBits,...: VendorMetric},
                          warnings[], diagnostics[], programmingArtifact?, rawReports[], logs[], stageDurationsMs, durationMs }
VendorMetric            { used, available?, label:'Logic Elements'|'LUTs'|..., vendorName:'Total logic elements' }   // never converted between vendors
```
Mapping to concepts requested: `BoardProfile` (above); constraint abstraction = `ConstraintProvider` with `XdcConstraintProvider` (Nexys, wraps the existing `generateXdc` / project XDC — Phase 2) and `QsfSdcConstraintProvider` (done); `ImplementationProvider` = `OpenXC7ImplementationProvider` (Phase 2 adapter over today's `WorkflowController`+Apio provider) and `QuartusLimaImplementationProvider` (done); `ProgrammingProvider` = adapter over today's `ProgrammingService`/`ProgrammerProvider` for Nexys, `NativeJtagProgrammer` for DE10; build-result parsing = `core/implementation/quartus/parsers.ts` beside the existing Apio parsers; environment = `EngineProvider` + `describeEnvironment()`.

**Naming note.** `core/implementation` already has an `ImplementationProvider` that takes *generated Verilog + XDC* (an openXC7 shape). The proposed contract takes *a project + a board profile* and returns a `NormalizedBuildResult`, because Quartus consumes VHDL directly. They live in separate modules (`core/backend` vs `core/implementation`); Phase 2 should wrap the old one in an adapter rather than change it.

### Normalised build result
`implementationStatus` (passed/failed/cancelled/not-run), `timingStatus` (met/not-met/unconstrained/not-run), per-clock target / Fmax / restricted Fmax / worst setup & hold slack, and vendor-native resource metrics with labels from the board profile (`Logic Elements`, `Registers`, `Memory bits`, `Multipliers (9-bit)` for DE10-Lite; `LUTs` etc. for Nexys). Passing requires Quartus's own "was successful. 0 errors" line for every stage, the fitter reporting the exact device and top entity, and a non-empty `.sof` and `.svf`; exit code 0 alone is not trusted.

### Cancellation and restart
`cancelBuild()` aborts the in-flight `limactl shell` (the `ToolRunner` kills the host process tree) and then runs a best-effort `pkill` of Quartus processes inside the VM, so nothing keeps running; a cancel request wins even if the tool finished in the same instant, so the status is `cancelled`, never a half-trusted `passed`. A cancelled programming run reports that the board configuration is undefined until programmed again. `restartImplementationEngine()` = `limactl stop` then `ensureReady()`. `shutdownImplementationEngine()` = `limactl stop`. No idle auto-shutdown yet (builds leave the VM running).

### How `ensureReady()` detects and handles the Rosetta / `rosettad` failure
1. Lima state via `limactl list`; stopped → `limactl start` (failure → `ENGINE_START_FAILED`); missing → `ENGINE_NOT_INSTALLED`.
2. **Pre-emptive check**: `test -S /run/rosettad/rosetta.sock` inside the VM. The socket exists only while Lima's AOT daemon is serving, which is the exact precondition of the SIGBUS. If active → run the idempotent provisioning script from the shared staging dir (installs the systemd drop-in that stops the socket, plus `mixfpga-q`), report `ROSETTAD_REPAIRED`.
3. **Functional probe**: `mixfpga-q quartus_sh --version` must exit 0 and print `25.1std.0 Build 1129`. Exit 135 / "Bus error" is classified as `sigbus` → repair once → probe again; still failing → `QUARTUS_SIGBUS` (state `unhealthy`, no loop). Exit 127 → `QUARTUS_MISSING` (repair once). A different version → `QUARTUS_PROBE_FAILED`.
4. Because Lima rewrites `rosettad.service` and re-enables it at **every** boot, the drop-in (not `disable`/`mask`) is what persists; step 2 additionally covers a future Lima that changes this behaviour. `status()` reports an active socket as `ROSETTAD_AOT_ACTIVE` without changing anything.
All branches are unit-tested with a scripted VM (`tests/mixfpga/engine.test.ts`).

### Independence from NexysVHDL Toolchain 1.0
- Own locations only: `toolchains/experimental/{lima-2.2.1,openfpgaloader-1.1.1}` (git-ignored), `~/Library/MIX-FPGA/{lima,staging}`, guest `/opt/mixfpga`. The programmer binaries are byte-identical *copies* (provenance recorded above); the Toolchain 1.0 directory was only read, never written. Not a single backend source file mentions the NexysVHDL toolchain, and `tests/mixfpga/independence.test.ts` enforces: default paths contain no "nexys", no source reference to `NexysVHDL`/`.apio`, no imports of the Nexys implementation/programming/workflow code, and no host-side shell use. (The Checkpoint D GHDL check used Toolchain 1.0's `ghdl` read-only as an external tool; a MIX-FPGA-owned GHDL copy is a Phase 2 item.)

### Real-hardware verification of the new backend (2026-10-14)
- `mixfpga-de10 build experiments/phase1-de10-blink`: **cold (VM stopped) 34.1 s; warm 26.0–26.3 s (8 consecutive runs, all passed)**; timing met; 27 Logic Elements / 26 registers; Fmax 294.55 MHz; setup slack 16.605 ns; hold slack 0.156 ns; `blink.svf` 1,801,020 B.
- `mixfpga-de10 env` prints the student table (Ready ×4) and the Details (Quartus Prime Lite 25.1std.0 Build 1129, Lima VM, openFPGALoader v1.1.1).
- `mixfpga-de10 detect` later returned `board-absent` because the USB-Blaster had been unplugged after Checkpoint F — a genuine hardware check of that error path. **`program` through the new TypeScript backend was exercised on hardware afterwards — see "Final hardware acceptance" below (PASSED)** (Checkpoint F used the same `mixfpga-ofl` command line the backend issues, but the board was not connected afterwards); it is covered by unit tests only. Re-running it requires the board and the user's go-ahead.

### Bug found and fixed during Checkpoint G
Intermittent build failure (~1 in 3 runs) `Error (20004): Your design targets the device family "Cyclone V"` — Quartus had not read the generated QSF. It appeared when the same job directory name was deleted and recreated on the virtiofs share. Fix: a fresh job directory per build (old ones removed) **plus** an in-VM `sha256sum -c` manifest check with up to 5 copy retries (`STAGE_COPY_RETRIED` warning if a retry was ever needed). After the fix: 8 consecutive builds passed, and the retry path never fired. Root cause (stale/partial virtiofs view) is the best-supported explanation but was **not proven** — keep the manifest check, and watch for `STAGE_COPY_RETRIED` in classroom logs.

### Test results
| Suite | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| Nexys A7 baseline before any change (`npm test`) | 709 | 708 | 0 | 1 |
| New `tests/mixfpga/` (profiles, constraints, environment, parsers, engine, build, cancel, programmer, independence) | 74 | 74 | 0 | 0 |
| **Full suite after Phase 1 changes** | **783** | **782** | **0** | **1** (same pre-existing skip) |
Covered as requested: board identification and exact MAX 10 part; staging isolation; path handling with spaces; Lima stopped / running / missing; failed Lima startup; failed Quartus; nonzero exit propagation; no-success-line; result parsing; missing artifact; programmer missing; board absent; wrong device on chain; cancellation; no modification of student sources; no dependence on / modification of NexysVHDL. The physical acceptance criterion is not mocked (it was confirmed by the user). Raw logs: `.artifacts/logs/G-baseline-tests.txt`, `G-full-tests.txt`.

### Nexys A7 regression status
**No regression.** No Nexys source, board data, test or toolchain file was modified (`git diff --stat` shows only `.gitignore`); the 708 previously passing Nexys tests still pass, including `.nvproj`, Add File, hierarchy, Check, Simulate, waveform, schematic, build/program, project switching and persistence suites, and the architecture rules (`core/` stays platform-neutral). The shared `core/index.ts` was deliberately not modified; new modules are imported by path.

### Measurements summary
| Item | Value |
|---|---|
| Lima | 2.2.1 (sha256 `9e9eacce…c66e`), Apache-2.0 |
| VM | Ubuntu 24.04.5 aarch64, vz, 4 CPU, 8 GiB, 60 GiB; Rosetta + binfmt |
| VM create / cold start / warm start | 24 s / 11 s / 7 s |
| Idle | guest ≈350 MiB used; VM process 0.4 % CPU, ≈3.2 GB RSS (mostly page cache after builds) |
| Quartus | Prime Lite 25.1std.0 Build 1129 + MAX 10 `max10-25.1std.0.1129.qdz`; install dir 8.9 GB; guest `/` 11 GB used |
| Host footprint `~/Library/MIX-FPGA` | 13.0 GB (VM 10.8 GB, vendor installer copies 2.1 GB still present, jobs <10 MB) + image cache 2.5 GB + toolchains 89 MB |
| Build | cold 33–34 s, warm ≈26 s; 27 LE, 26 regs, Fmax 294.55 MHz, slack +16.6 / +0.156 ns |
| Programming | SVF into SRAM ≈4 s; `.sof` not loadable by openFPGALoader 1.1.1 or master |

### Risks for classroom deployment
1. **Rosetta + Lima + macOS version coupling** (the `rosettad` SIGBUS, the `.flu` 33-byte cache file, Lima rewriting units at boot). Pin all versions; run the Quartus smoke test in `ensureReady()`; keep the repair path tested.
2. **Intermittent staging failure** (above) — unproven root cause; guarded, monitor.
3. **Disk and time**: ≈13 GB per student Mac (≈10 GB after deleting installer copies and the image cache); the 3.6 GB unused `nios2eds` could be trimmed; first-time install is a multi-GB download and a licence acceptance per student/institution.
4. **Legal**: Quartus is not redistributable by us (vendor installer, EULA accepted by the user for this machine only). Lima (Apache-2.0) and Ubuntu cloud image need notice handling; openFPGALoader bundle needs hidapi/zlib/zstd licence files and LGPL notices for libusb/libftdi before shipping.
5. **Programmer limits**: `.sof` unsupported; SVF-only SRAM load; internal flash (`.pof`) for 10M50D exists only on unreleased openFPGALoader master — avoid until released.
6. **Rosetta 2 itself** needs a one-time privileged install + Apple licence prompt on student machines.
7. **Resource**: 8 GiB RAM reserved to the VM on 16 GB Macs; consider 6 GiB / idle auto-shutdown (not implemented).
8. USB-Blaster permissions on macOS needed no driver in this setup; other hubs/adapters untested.

### Recommendation for Phase 2
Proceed, scoped as: (1) **adapter layer** — wrap today's Nexys path as `OpenXC7ImplementationProvider` + `XdcConstraintProvider` + `ProgrammingProvider` behind the new contracts, then make `WorkflowController`/VS Code commands call generic Check / Build / Detect / Program selected by `BoardProfile`; (2) **board selection + DE10 project template** (`.nvproj`-equivalent with `board: de10-lite`, QSF/SDC Add File, “Logic Elements” labels in Results); (3) **engine lifecycle in the UI** (first-run provisioning, progress for the 34 s cold start, Details panel, restart); (4) **MIX-FPGA-owned GHDL + toolchain manifest** so nothing is borrowed from Toolchain 1.0; (5) hardware re-test of `program()` through the TypeScript backend with the board connected, plus a few more DE10 examples (switches, 7-segment) to validate pin tables; (6) decisions on legal/distribution (Quartus install flow, Lima/Ubuntu notices, LGPL notices) before any installer work. Do not build the DMG/installer until (1)–(4) are stable.

### Final hardware acceptance through the TypeScript backend (2026-10-14)
Driver: `.artifacts/accept.js` (calls `De10LiteBackend.detectHardware()` / `program()`); output `.artifacts/logs/G-final-acceptance.txt`.
- Board profile `de10-lite`, device `10M50DAF484C7G`, programmer board key `de10lite`.
- Artifact: the validated Checkpoint D SVF preserved at `.artifacts/de10-blink/blink.svf`, sha256 `9991a0c2…11284e` — checked against the recorded hash both by the driver and by `program()`'s own integrity check (design not rebuilt).
- `detect()`: `detected` — USB-Blaster `09fb:6001` serial `91d28408`, JTAG idcode `0x31050dd`, MAX 10 `10M50D`.
- `program()`: `programmed`, `softwareVerified: true`, 3,884 ms; tool printed `end of SVF file`, no error lines; SRAM only (internal flash untouched); openFPGALoader v1.1.1 unchanged.
- Post-program `detect()`: `detected`, same idcode `0x31050dd` MAX 10 10M50D.
**Physical confirmation (user, 2026-10-14): LEDR0 blinks correctly after programming through the TypeScript backend. The `ProgrammingProvider` hardware path is PASSED.**

### Phase 1 closeout checks (2026-10-14)
- Full suite re-run: 783 tests, 782 pass, 0 fail, 1 skipped (`launcher (Windows)` — platform skip that also existed in the baseline). Log `.artifacts/logs/G-closeout-tests.txt`.
- Change set (`git add -n -A`): `.gitignore` + 36 new source/test/fixture/doc files only (text, each < 200 KB). `git diff --cached` is empty (nothing staged). Git-ignored and absent from the change set: `.artifacts/`, `toolchains/experimental/` (Lima, openFPGALoader), `dist/`, `node_modules/`, `experiments/*/.mix-fpga/`. The vendor installers live in `~/Library/MIX-FPGA/staging/vendor` and `~/Downloads`, outside the repo.
- NexysVHDL Toolchain 1.0 untouched: manifest sha256 `71241b94…`, `ghdl` `38a99c1c…`, `openFPGALoader` wrapper `06457ddf…` and binary `99dcde0e…` all equal the values recorded at Checkpoint A; no file under `~/Library/NexysVHDL` is newer than the start of the work; `NexysVHDL-repo` is clean at `a6c459a`.
