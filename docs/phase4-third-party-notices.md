# Phase 4 · Checkpoint E — third-party notices for MIX-FPGA Toolchain 1.0 (macOS)

Status: **DRAFT**. Nothing here is legal advice; items marked *unclear* are reported, not decided.

## What was inventoried
The four tool folders of the validated payload (`ghdl`, `yosys`, `openfpgaloader`, `lima`: 670 files, 1 symlink) plus the engine scripts. Every file belongs to exactly one inventory component (`tests/install/notices.test.ts` fails otherwise). Data: `toolchains/mixfpga/compliance/macos-arm64.inventory.json`. Generated: `toolchains/mixfpga/notices/macos-arm64/` (`THIRD_PARTY_NOTICES.txt`, `LICENSES/`, 25 licence texts copied unchanged, hashes listed). Rebuild: `node scripts/mixfpga/build-notices.mjs && node scripts/mixfpga/record-toolchain.mjs`.

## Evidence
* All 470 files of ghdl, yosys and openfpgaloader are byte-identical (sha256) to files in the installed NexysVHDL Toolchain 1.0, so that toolchain's existing compliance review (`toolchains/compliance`) applies to them. That is recorded as *inherited*.
* Load commands of every Mach-O file were read (`otool -L`): all non-system dependencies are inside the payload; the rest are macOS system libraries and frameworks (not shipped).
* New checks this checkpoint: file headers of the GHDL VHDL libraries, embedded strings of `ghdl` (Homebrew LLVM 22.1.0 statically linked) and `yosys` (compiled-in libs, `-dirty` build), Go build information of all five Lima binaries (100 modules, go1.27.1).

## Obligations by class
| Class | Components | What MIX-FPGA must do |
|---|---|---|
| Strong copyleft | GHDL (GPL-2.0+), libghdl*, GHDL std library and scripts, **readline (GPL-3.0+)**, Yosys as distributed with it | licence text, notices, complete corresponding source or a written offer |
| Weak copyleft | libusb 1.0.26 (LGPL-2.1+), libftdi1 1.5 (LGPL-2.0), libghw (LGPL-2.1+) | licence text, library source, replaceable library |
| Runtime exception | libgnat-14, libgcc_s (GPL-3.0+ with GCC exception) | texts; no source required by the exception |
| Permissive | openFPGALoader, Lima, Yosys, LLVM, zlib, ncurses, libffi, Tcl, hidapi (BSD option), zstd (BSD option), IEEE 2008 packages, Synopsys packages | licence text and copyright notices |

## Not redistributed
Altera Quartus Prime Lite and the MAX 10 package, Rosetta, macOS frameworks, Ubuntu image and packages, krunkit, and the NexysVHDL toolchain itself.

## Source availability for a release
GHDL e589c698; Yosys 66306a8c (with abc, cxxopts); readline 8.2 + patch 001; libusb 1.0.26; libftdi1 1.5; their MacPorts Portfile commits. Archives and sha256 are pinned in the inventory (taken from the NexysVHDL source lock). The written offer text and contact details are the owner's decision.

## Open questions (see the inventory for details)
| | Severity | Question |
|---|---|---|
| L11 | minor (was blocking) | Collected: licence texts of the Go standard library (go1.27.1) and all 100 Go modules compiled into Lima, each module archive verified against the hash embedded in the Lima binaries (`go-licenses.json`). One module, `github.com/hashicorp/hcl/v2`, is MPL-2.0: the release notices must say how to obtain its source (pinned in the inventory). |
| L1 | needs decision (legal review before release) | IEEE 1076.3-1995 `numeric_bit` / `numeric_std` (VHDL-87/93 sets and compiled form): "may not be sold or distributed for profit". New finding. |
| L2 | needs decision | VITAL and UPF packages carry no licence statement. |
| L3 | needs decision (legal review before release) | Yosys is distributed linked with GPLv3 readline: confirm the combined-work position. |
| L4 | needs decision | Yosys binary is `-dirty`; notices of libs compiled into it (minisat/ezsat, json11, fstapi…) not collected. |
| L9 | needs decision (legal review before release) | Our integrity check restores replaced LGPL/GPL libraries; the source offer must explain how recipients can run modified ones. |
| L10 | needs decision | 111 openFPGALoader bridge bitstreams: provenance. Unused by our flows. |
| L5–L8 | minor | libusb text revision, GHDL build recipe/GNAT origin, GPL reach on GHDL output, two headers without a licence statement. |
