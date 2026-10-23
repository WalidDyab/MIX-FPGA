# Phase 5C: Toolchain 1.1 compliance rebuild and revalidation (macOS candidates)

Date: 2026-10-19. Branch `phase5c/toolchain-1.1` from `bb29353` (Phase 5B). **Candidates only (see the addendum below for the final frozen hashes)**: nothing is signed, notarized, published or adopted; Toolchain 1.0, its records and the validated `~/Library/MIX-FPGA` installation are unchanged (section 7). Legal conclusions remain an engineering assessment; counsel items are listed in section 9.

## 0. Addendum 2026-10-23: technically frozen candidate (supersedes the hashes in section 1)

After the first report the owner asked for: physical Program validation, the L8 headers, an attempt to reproduce the Yosys build (L4), and a reproducible rebuild. Outcome:

**L8 closed by removal.** `vpi_user.h` and `synth_gates.h` (no licence statement) are GHDL plugin-development headers: no executable, library, script or MIX-FPGA flow references them (`strings`/`grep` over the toolchain and the product, none). `synth.h` includes `synth_gates.h`, so it was removed with them rather than left broken; `libghw.h` (LGPL, with its library) and `vhpi_user.h` (Apache-2.0) stay. Nexys recipe gained a `remove` step, the DE10 assembler does the same, the inventory resolves L8.

**L4 closed on evidence, with a residual** (full record: [phase5c-l4-yosys-rebuild.md](phase5c-l4-yosys-rebuild.md), also inside both source packages): the recipe's compiler-name `sed` on the tracked `Makefile` reproduces the `-dirty` suffix on the pinned commit; a native rebuild from commit `66306a8c` (abc `b4a657e7`, cxxopts `4bf61f08`, readline 8.2 + patch 001 from the pinned sources, bison 3.8.2 and flex 2.6.4 as build tools) prints the same `0.63+173` and has an **identical help text for all 11,515 lines** (normalized SHA-256 `7b1aff67…c66`, same logfile hash `f5dede9581`) as the shipped binary. Residual: not bit-identical (cross clang 18.1.8 versus native clang 21; the original cross-compile image is not available here).

**Final frozen candidate hashes**

| Candidate | Bytes | SHA-256 |
|---|---|---|
| Nexys A7 support 1.1 | 652,947,482 | `6fc1f3ad3f0343fc04b2e270f669824db30f84bf71b91bd38640482f20433f0f` |
| DE10-Lite support 1.1 | 88,871,550 | `25317169b9bab2a636cf5cf420238eab43ad2c955dd82acddcf566244b3f6aa2` |
| Nexys source package | 490,733,519 | `5ccdc8f3f9389945fc9500a0dd24e871aa9d36d568567b140e229db5d867c2e1` |
| DE10 source package | 24,365,760 | `8c76974eb5cf91c2ad79743bcf59739fdb7ede7933fd756412078494563824fa` |
| Candidate extension (overlay build, not reproducible) | 555,665 | `53e6eae3ba0ea5fea799b7ca2b2e76aa05d44b9d99216e8e1ccd0304eedab3b6` |

Nexys tree `8b0beda82258a199ab6b9628a1018a754ac9ea33d629773061901d60ceaea07d`, 31,541 files, 2,744,208,064 installed bytes (1.0: 31,699 files). DE10 manifest `toolchain-1.1-macos-arm64.json` sha256 `25846c5ba6b741967d040a9772e24f13e49feb3ba26cdcc74c96002927c8ae04`, 683 files, 221,558,197 bytes (ghdl 88 files `6a576138…`, yosys `d02397e9…` and lima `1e31ca89…` and engine `25a880d8…` unchanged from 1.0, openfpgaloader `ceb8cc45…`, licenses `158f1733…`, notices `26f00864…`). Recipe `toolchains/bundle/darwin-arm64-1.1.json` sha256 `877c37675c876d2d382a230aa3c0a560bdd690f790b3311b59df82d5930052f5`, inventory `macos-arm64-1.1.inventory.json` `ae0271e884a72d0fc29cf9d90247df0097a36de07f4b3de1f8f364252b60d0d3`, compliance manifest `toolchain-1.1.json` `5f539d1072c27e86d952da9a66ae9243caf387357594141d5634668f5f82bf32`.

Reproducibility of the final build: Nexys assembled and packed twice (identical tree and archive), DE10 payload twice, both source packages twice (identical hashes each time). The 1.0 build scripts still reproduce the 1.0 records.

**Physical validation (isolated root, candidate extension, real VS Code, real boards)**

| Check | Result |
|---|---|
| Nexys A7: Check, Simulate (660 ns), RTL schematic, Build (13.8 s, 57 LUTs, 27 FFs) | PASS on the final candidate |
| DE10-Lite: install with Quartus 25.1 (isolated root, Altera licence accepted there only, with your permission), Check, Simulate (1320 ns), RTL, Build cold 35.5 s / warm 26.8 s | PASS; engine stayed stopped for Check/Simulate/RTL |
| **DE10-Lite physical Program (SRAM)**: Detect (one DE10-Lite, USB-Blaster serial `91d28408`), Program ("FPGA programmed", volatile, 3.9 s, `.svf` hash identical to the build record), Detect again (one board) | **PASS; you confirmed LEDR0 blinks with SW0 up and KEY0 holds the counter at zero** |
| Bridge bitstreams are not needed for SRAM programming | The installed 1.1 `openfpgaloader` folder has **no `share` directory at all**; the DE10 Program above and a direct run of the exact command MIX-FPGA issues (`openFPGALoader --board de10lite --write-sram --force-terminal-mode top.svf`) both succeed (exit 0, "write to ram", "end of SVF file"). MIX-FPGA's programmer refuses every flash flag (`FLASH_FLAGS` in `platform/macos/programmer.ts`), and the bridge (`spiOverJtag`) belongs to the SPI-flash path only (`strings` of the binary: "Skip loading bridge for spiOverjtag"). |
| **Nexys A7 physical Program** | **NOT PERFORMED.** Only a DE10 USB-Blaster was on USB when the test ran and you chose to skip the Nexys test. The Nexys uses the same `--write-sram` command class, but the physical result remains open and must be part of the repeat of the Phase 5A acceptance. |

Full macOS suite on the frozen state: 1142 tests, 255 suites, **1131 pass, 0 fail, 11 skipped**. Reference `~/Library/MIX-FPGA` (32,566 files): no file modified since the earlier identical snapshot (none newer than 2026-10-19 08:00, same count), its VM not started in this round; the 1.0 archives, `requirement.json`, `toolchain-1.0-macos-arm64.json` and `payloads-1.0.json` hashes are unchanged. The product still requires Toolchain 1.0; the CANDIDATE notices are in place in both archives; nothing is published.

**Open for counsel (technically frozen otherwise):** L3 (Yosys with GPLv3 readline), L9 (replacement rights versus the integrity check), the L4 residual (functionally identical, not byte-identical rebuild), and confirmation that shipping each source package beside its archive satisfies the licences. Everything else in section 9 below that is not listed here has been closed.

---

## 1. What was built

| Candidate | File | Bytes | SHA-256 |
|---|---|---|---|
| Nexys A7 support 1.1 | `nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz` | 652,953,225 | `7c93dd2b4b2c9506eacf754b4c8589a54c3f846ea1a2fb91d5f92b6b16063670` |
| DE10-Lite support 1.1 | `mixfpga-de10-lite-support-1.1-macos-arm64.tar.gz` | 88,881,825 | `a0bd6e04543f1e926864b9e1b6b7223b2e255e2cd2b5e96aff12cac21a3118df` |
| Nexys source package | `MIX-FPGA-Nexys-A7-Support-1.1-Sources.zip` | 490,726,453 | `70ac1f372a2cf577a90f6e1f5f7b5636af9b4d2e4fe1375c1e67a28a3dc413e7` |
| DE10 source package | `MIX-FPGA-DE10-Lite-Support-1.1-Sources.zip` | 24,362,807 | `4b11fbc7fdc030e240c40a665d8a49d7ef56253cb748574341f7f016f2287dee` |
| Candidate extension (overlay build, section 5) | `nexysvhdl-0.7.0-darwin-arm64.vsix` | 555,824 | `03b73ab82f44e68684ac8033cd2a921fcabdf0de3a2a12053106b7d99e7bbeee` (not reproducible: zip timestamps) |

Content hashes:

| | files | installed bytes | tree / manifest hash |
|---|---|---|---|
| Nexys 1.1 (1.0: 31,699 files, 2,758,218,326 B, `f0402218…`) | 31,544 | 2,744,264,052 | tree `b88196e2e772ba0b4a51051eca1bd0e8a09a12fe82ecc38339e7d497fab53740` |
| DE10 1.1 (1.0: 818 files, 229,468,458 B) | 686 | 221,615,543 | manifest `toolchains/mixfpga/toolchain-1.1-macos-arm64.json` sha256 `d17edb8f08020a7ecf4423ad32616c6b4c52e8736d009f8e7162e6825507c69c` |

DE10 unit trees (1.1): ghdl `940aefe1…` (changed), yosys `d02397e9…` (**identical to 1.0**), openfpgaloader `ceb8cc45…` (changed), lima `1e31ca89…` (**identical**), engine `25a880d8…` (**identical**), licenses `158f1733…`, notices `05212ae8…` (changed). Pins: `toolchains/mixfpga/payloads-1.1.json`, `toolchains/bundle/requirement-1.1.json`. Recipe `toolchains/bundle/darwin-arm64-1.1.json` (sha256 `30c47d32e53cdc629396d08e5ae30c210938578de5221975c7b02380be95570e`), inventory `macos-arm64-1.1.inventory.json` (`b63db91a…`), compliance manifest `toolchains/compliance/toolchain-1.1.json`.

**Exactly what changed against 1.0** (verified byte by byte, every other file is identical):

- Nexys: 231 files removed (88 + 111 + 30 + 2), 76 added, 6 modified. Removed: GHDL `ieee/v87`, `ieee/v93`, `src/ieee` (16), `src/upf` (2), `src/vital95` (4), `src/vital2000` (6); the same in the oss-cad-suite copy of GHDL's library (88 files including object files of the removed units); the 111 openFPGALoader bridge bitstreams; the wrong Graphviz EPL-2.0 text and the libwdi text. Added: 76 licence texts of the bundled native libraries (`licenses/compliance/`, Qt, MacPorts, Python runtime, Nix libraries). Modified: `THIRD_PARTY_NOTICES.md`, `toolchain-manifest.json`, and the four regenerated library indexes (`ieee-obj08.cf`, `ieee-obj19.cf` in each GHDL copy).
- DE10: 142 files removed (the same GHDL files, the 111 bitstreams, the 1995 IEEE header text), 10 added (Lima NOTICE, nine Yosys-library texts), 4 modified (notices, manifest, the two indexes).

## 2. How the GHDL libraries were regenerated

`scripts/toolchain/ghdl-prune.mjs` removes the directories and re-analyses the 2008 and 2019 IEEE libraries with GHDL itself, using the rules of GHDL's own `libraries/Makefile.inc` (6.0.0) minus VITAL-2000 and UPF; analysis timestamps of the upstream release are kept so the result does not depend on the build time. `--check` regenerates in a scratch copy and verifies the shipped index equals what GHDL writes. The oss-cad-suite copy is an LLVM build whose `ghdl` does not launch on current macOS, so its index is taken from the pruned JIT tree (the two upstream indexes were identical apart from timestamps, checked) and the object files of the removed units are deleted; every other object file stays as upstream built it.

## 3. Compliance material corrected inside the payloads

Apio is labelled GPL-3.0-or-later (the bundled `LICENSE` is GPLv3), Apio definitions GPL-3.0-only, the Graphviz text is the package's own EPL-1.0 file, the libwdi text is gone, the library licence texts ship inside the toolchain. Nexys notices (`THIRD_PARTY_NOTICES.md`) are regenerated: they list every change, state that the source package accompanies the archive (no written offer), explain how to replace components, and carry `CANDIDATE: counsel review pending`. DE10 notices (`THIRD_PARTY_NOTICES.txt`) begin `CANDIDATE - COUNSEL REVIEW PENDING` (no longer "DRAFT - NOT FOR REDISTRIBUTION"), list the changes, resolved items (L1, L2, L5, L6, L7, L10, L11) with their resolutions and the four items still open (L3, L4, L8, L9). Included: Lima 2.2.1 NOTICE (sha256 `a7e0caed…`), the texts of the libraries compiled into Yosys (MiniSat, cxxopts, ABC, json11, fstapi, ezSAT, subcircuit headers, sha1/BigInteger notes), the Yosys/readline GPLv3 texts. The `hcl` MPL-2.0 module archive is in the DE10 source package.

## 4. Source packages (one per archive)

Both contain: `sources/` (exact upstream archives, each verified against `sources-1.0.lock.json` before use), `licenses/`, the archive's `THIRD_PARTY_NOTICES`, `mix-fpga-build/` (recipe or inventory, the GHDL prune tool, the toolchain manifest), `patches/README.md` ("MIX-FPGA modifies no third-party source"; the only changes are the omissions/regenerations), `binary-to-source.json` (binary to source mapping and the modification list), `manifest.json` (SHA-256 and size of every file), `mix-fpga/LICENSE`, `NOTICE`, `README.md`.

- Nexys: 237 files, 135 source archives (the macOS-relevant sources of the reviewed 1.0 package; Windows-only sources are not included).
- DE10: 177 files, 13 source archives: GHDL, Yosys + abc + cxxopts, the YosysHQ build recipe, readline 8.2 + patch 001 + MacPorts port, libusb 1.0.26 + port, libftdi1 1.5 + port, and `github.com/hashicorp/hcl/v2@v2.24.0.zip` (fetched once from `proxy.golang.org`, 595,948 bytes, sha256 `53fd4e96…f4810` = the hash recorded in `go-licenses.json`). Permissive components (openFPGALoader, Lima, LLVM, zlib, zstd, hidapi, libffi, Tcl, ncurses) need no source; their upstream revisions are recorded.
- Both zips pass `unzip -t`; every file hash in each `manifest.json` was re-verified after extraction (0 mismatches).

## 5. Reproducibility

| Build | runs | result |
|---|---|---|
| Nexys tree and archive | assemble + pack three times after normalising directory times | identical tree `b88196e2…` and archive `7c93dd2b…` (a first design that left directory mtimes in the tar gave a different archive each time; fixed by the recipe flag `normalizeDirectoryTimes`) |
| DE10 payload | twice | identical `a0bd6e04…` |
| Source packages | twice each | identical |
| `ghdl-prune.mjs --check` | on the assembled tree | passes |
| 1.0 scripts | the modified assembler, notice builder and recorder re-run for 1.0 | Nexys 1.0 tree `f0402218…` and every 1.0 notices/manifest file byte-identical (no `git` diff) |

The candidate extension is built from a scratch overlay of the sources (`scripts/mixfpga/build-1.1-candidate.mjs`) in which the few places naming Toolchain 1.0 are switched to 1.1 (`layout.ts`, `setup.ts`, `multiboard.ts`, `.vscodeignore`, `requirement.json` with `candidate: true`); the repository itself still requires Toolchain 1.0.

## 6. Isolated software validation (separate root `~/MF11`, deleted afterwards; real VS Code, candidate VSIX, Setup code of the candidate)

| Check | Result |
|---|---|
| Nexys install from the 1.1 archive (file picker) | complete; Verify OK |
| Nexys suite (`multiboard`, stage nexys) | **PASS**: environment Ready (GHDL 6.0.0, Apio 1.7.0, openXC7 2026-09-25, Yosys 0.63+173, nextpnr-xilinx e860c9c8, openFPGALoader 1.1.1); Check passed; Simulate passed (stopped at 660 ns); RTL schematic ready; Build BUILD COMPLETE in 15.6 s: 57 LUTs, 27 FFs, timing PASS 372.58 MHz, `hardware.bit` 3,825,910 B |
| Nexys equivalence with the 1.0 build of the same project | synthesized Verilog (`generated.v`) **byte-identical** to the 1.0 build; bitstream differs in 8 bytes (the date/time in its header) |
| DE10 install from the 1.1 archive + Quartus 25.1 Build 1129 | complete (Altera licence accepted in the test root only, with your permission); Verify OK, all 11 steps |
| DE10 suite (`multiboard`, stage de10) | **PASS**: environment Ready; engine stayed stopped through Check, Simulate and RTL schematics; Check passed; Simulate passed (1320 ns); RTL ready; Build through Lima/Quartus: cold 52.8 s, warm 45.8 s, BUILD COMPLETE (28 LEs, timing met); Verify and engine restart OK |
| Verify/Repair on the 1.1 payloads | one file damaged in each (DE10 `ieee-obj08.cf`, Nexys `ghdl/bin/ghwdump`): Verify reported FAIL for both ("1 changed"); Repair with the support file restored both hashes; Verify OK again. Quartus files not touched |
| openFPGALoader without `share/openFPGALoader` | `--Version` runs; `--detect` reaches the normal "device not found" message |
| `--std=08` flows on pruned GHDL (also in the test suite) | analyse, elaborate, run (ALL TESTS PASSED, 28 checks), synth to Verilog pass; `ieee.vital_timing` and `ieee.std_logic_arith` under 2019 give a normal "not found" error |

The DE10 `top.svf` and `.sof` differ from the 1.0 build only by Quartus' build-time content (svf hash differs; sof differs in 35 bytes); resources and timing agree.

## 7. Regression and untouched records

Full macOS suite on this branch: **1142 tests, 255 suites: 1131 pass, 0 fail, 11 skipped** (was 1131 / 1120 / 0 / 11 at Phase 5B; the 11 new tests pass; the 11 skips are the same Windows-only, no-built-package and Altera-file ones). Reference installation `~/Library/MIX-FPGA`: file-by-file snapshot (32,566 files: path, size, mtime, mode) before and after is **identical**; its VM was never started. Toolchain 1.0: the sha256 of the five 1.0 archives and of `requirement.json`, `toolchain-1.0-macos-arm64.json`, `payloads-1.0.json`, `darwin-arm64.json` and the mtimes of the 1.0 archives are unchanged. The test suite has a guard for these (`tests/install/toolchain-1-1.test.ts`).

## 8. Files added or changed on the branch

New: `scripts/toolchain/ghdl-prune.mjs`, `scripts/mixfpga/assemble-1.1.mjs`, `derive-inventory-1.1.mjs`, `build-1.1-candidate.mjs`, `scripts/compliance/assemble-1.1.mjs`, `derive-1.1.mjs`, the 1.1 recipe, licence folders, requirement, pins, inventory, manifest, notices, Lima NOTICE and Yosys library texts, `tests/install/toolchain-1-1.test.ts`. Changed (all default to the old 1.0 behaviour): `scripts/toolchain/{assemble,lib,notices,pack}.mjs`, `scripts/mixfpga/{build-notices,build-payloads,record-toolchain}.mjs`, `platform/macos/install/notice-inventory.ts` (types).

## 9. Remaining legal and release items (not guessed)

1. **L3** Yosys with GPLv3 readline: combined-work position, **COUNSEL**. **L4** the `-dirty` Yosys binary: explained by the recipe, not reproduced, **COUNSEL/OWNER**. **L9** replacement rights versus the integrity check: behaviour tested in Phase 5B, text in the notices, **COUNSEL**. **L8** two GHDL headers without a licence statement (`vpi_user.h`, `synth_gates.h`) are still shipped: **OPEN**, minor, COUNSEL (not part of your decisions).
2. Counsel to confirm that shipping each source package beside its archive, instead of a written offer, satisfies the licences (hosting duration for as long as the binaries are offered still applies).
3. The notices inside both archives are final text but carry the CANDIDATE banner; clearing it changes a hash, so it must be the last step (counsel review first, then one final rebuild and a hash check).
4. Not done in this phase: the extension's own `THIRD_PARTY_NOTICES.md` and INSTALL text still describe the NexysVHDL-era layout and omit the DE10 archive, Lima and the "not included" items; `payloads-1.1.json` and the candidate pins keep the internal-use note; adopting 1.1 in the product (the constants and `requirement.json`) and re-running the Phase 5A clean-machine acceptance, including **hardware Program on both boards** (not exercised here; the SRAM programming path does not read `share/openFPGALoader`, to be confirmed on hardware); signing and notarization; Windows Toolchain 1.1.
5. The candidate VSIX is built from an overlay and is not byte-reproducible; the adopted RC will be built from the repository.
