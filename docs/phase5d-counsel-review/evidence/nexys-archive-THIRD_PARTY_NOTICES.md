# Third-party software in the MIX-FPGA Nexys A7 support (macOS Apple silicon)

**Status: CANDIDATE: counsel review pending (L3 Yosys with GPLv3 readline, L9 replacement rights, the L4 residual that the Yosys rebuild is functionally but not byte-identical, and confirmation that shipping the source package with the binaries satisfies the licences).**

MIX-FPGA toolchain 1.1 for darwin-arm64. MIX-FPGA runs these programs privately from this folder; it does not install them on the computer, add them to PATH or change any other installation.

## Licensing of this toolchain

This toolchain is an aggregation of separate programs and data, each distributed under its own license, listed below. It is **not** licensed under the MIX-FPGA license. MIX-FPGA itself is licensed under the Apache License 2.0 (Copyright 2026 Walid Dyab; MIX-FPGA (formerly NexysVHDL) is an EMXplore project); that license covers only MIX-FPGA's own code and the files MIX-FPGA generates in this folder (`toolchain-manifest.json`, this file, the pinned Apio configuration).

## What was changed

Every component is the official release archive listed below, verified by SHA-256 when the toolchain was assembled. MIX-FPGA patches and rebuilds no third-party program. The only changes are the omissions and regenerations below, made for licensing reasons:

- **ghdl** (`ghdl`), ghdl-prune: Phase 5B decisions L1/L2: remove the VHDL-87/93 IEEE libraries (IEEE 1076.3-1995 numeric_bit/numeric_std, not for profit), VITAL-95, VITAL-2000 and UPF; regenerate the 2008/2019 IEEE library indexes with GHDL itself. 30 files removed; regenerated: `lib/ghdl/ieee/v08/ieee-obj08.cf`, `lib/ghdl/ieee/v19/ieee-obj19.cf`. The complete list is in `toolchain-manifest.json`.
- **ghdl** (`ghdl`), remove: Phase 5C decision L8: the GHDL plugin-development headers vpi_user.h and synth_gates.h carry no licence statement; no program, library, script or MIX-FPGA flow uses them (they are only needed to compile a GHDL plugin), and synth.h, which includes synth_gates.h, goes with them so the header set is not left broken. 3 files removed. The complete list is in `toolchain-manifest.json`.
- **apio-oss-cad-suite** (`apio/packages/oss-cad-suite`), ghdl-prune: Phase 5B decisions L1/L2 for the GHDL library copy inside the oss-cad-suite package (unused by MIX-FPGA): same removals; indexes taken from the pruned GHDL tree, object files of the removed units deleted. 88 files removed; regenerated: `lib/ghdl/ieee/v08/ieee-obj08.cf`, `lib/ghdl/ieee/v19/ieee-obj19.cf`. The complete list is in `toolchain-manifest.json`.
- **apio-oss-cad-suite** (`apio/packages/oss-cad-suite`), remove: Phase 5B decision L10: the 111 openFPGALoader bridge bitstreams have no provenance; MIX-FPGA programs SRAM only and never uses them. 111 files removed. The complete list is in `toolchain-manifest.json`.

MIX-FPGA always runs GHDL with `--std=08`. The omitted packages are not needed for that: a design that uses `ieee.vital_timing`, `ieee.vital_primitives`, `ieee.vital_memory`, `upf` or the VHDL-87/93 `ieee` library gets a normal "unit not found" error.

## Source code

The source code of every component whose license requires it (GNU GPL, GNU LGPL, MPL, EPL, EUPL), at the exact revisions these binaries were built from, is the **MIX-FPGA-Nexys-A7-Support-1.1-Sources.zip** that is distributed together with this toolchain, at the same place and time. Its `manifest.json` lists each source archive with its SHA-256 and the upstream repository and revision, and maps every shipped binary to its source. If you redistribute this toolchain (for example to a classroom), redistribute that package with it, unchanged.

The inventory of every bundled program, library and Python package, with its license and source, is the compliance manifest `toolchains/compliance/toolchain-1.1.json`; the source package includes a copy. Items it lists under "unresolved" are still under review.

## Your right to modify and replace components

The GPL and LGPL components are separate files, loaded at run time, which you may replace with your own builds made from the corresponding source, for your own use, and reverse-engineer for debugging. The installed folder is read-only by default; make a file writable, replace it, and on Apple silicon re-sign it (`codesign -f -s - <file>`). The tools keep working with replaced files. The Setup page and Verify report a changed file as "changed", and Repair puts the original back only when you choose Repair. The integrity check is a support aid, not a technical restriction. A configuration with replaced files is not supported.

## Components

### GHDL — 6.0.0

VHDL analyzer, simulator and synthesizer (LLVM 22.1.0 JIT backend, macOS 15 aarch64 build: elaboration and simulation run in memory, no system linker or Xcode Command Line Tools needed).

- Folder: `ghdl` (83 files, 103.7 MiB)
- License: GPL-2.0-or-later; the GRT runtime and std.textio are GPLv2; libgnat GPL-3.0-or-later with GCC Runtime Library Exception 3.1; libgcc_s GCC Runtime Library Exception; LLVM 22.1.0 (statically linked into bin/ghdl) Apache-2.0 WITH LLVM-exception; IEEE-2008 packages Apache-2.0 (the 1995, VITAL and UPF packages of the upstream release are omitted)
- License evidence: Upstream COPYING.md and doc/licenses.rst of GHDL v6.0.0; the IEEE-2008 packages carry the Apache-2.0 header and LICENSE of the IEEE P1076 WG; bin/ghdl statically links LLVM 22.1.0 (Homebrew LLVM build) and the GNAT 14.2.0 runtime (alire-project GNAT-FSF-builds 14.2.0-1, see the upstream Build-MacOS workflow); lib/ also ships libgnat-14.dylib and libgcc_s.1.1.dylib (GCC 14.2.0 runtime).
- License texts: `licenses/GHDL-COPYING.md`, `licenses/GPL-2.0.txt`, `licenses/GPL-3.0.txt`, `licenses/GCC-RUNTIME-EXCEPTION-3.1.txt`, `licenses/LLVM-LICENSE.txt`, `ghdl/lib/ghdl/src/ieee2008/LICENSE`
- Project: https://github.com/ghdl/ghdl
- Upstream source: https://github.com/ghdl/ghdl/archive/refs/tags/v6.0.0.tar.gz (GHDL 6.0.0.r0.ge589c698c); LLVM https://github.com/llvm/llvm-project/tree/llvmorg-22.1.0; GCC 14.2.0 runtime https://ftp.gnu.org/gnu/gcc/gcc-14.2.0/
- Redistributed archive: https://github.com/ghdl/ghdl/releases/download/v6.0.0/ghdl-llvm-jit-6.0.0-macos15-aarch64.tar.gz (SHA-256 `c21312d5a0cc5833e6d8690d8c4343e67f4fc32f070c07343816cd11a31c7769`)

### Apio — 1.7.0

FPGA build manager (PyInstaller bundle pyinst-darwin-arm64-2026-09-27 with a private Python 3.14.7 runtime and SCons; identical to the validated /Applications/Apio install).

- Folder: `apio/bin` (125 files, 34.5 MiB)
- License: GPL-3.0-or-later; Python 3.14.7 PSF-2.0; bundled OpenSSL 3.5.7 Apache-2.0, libusb 1.0.30 LGPL-2.1-or-later, zstd 1.5.7 BSD-3-Clause; Python packages per *.dist-info
- License evidence: apio/bin/LICENSE in the bundle is the GNU GPL version 3 text and Apio 1.7.0 declares GPL-3.0-or-later (this corrects the GPL-2.0 label of Toolchain 1.0). The bundle carries no license text for Python, OpenSSL, libusb or zstd (texts in licenses/ and licenses/compliance/); Python package licenses under apio/bin/_internal/*.dist-info.
- License texts: `apio/bin/LICENSE`, `licenses/PSF-2.0-Python-3.14.txt`, `licenses/LGPL-2.1.txt`, `licenses/LLVM-LICENSE.txt`
- Project: https://github.com/FPGAwars/apio
- Upstream source: https://github.com/FPGAwars/apio/tree/ccede3ecb88f809d1c5a6063a274ba1852bdc519
- Redistributed archive: https://github.com/fpgawars/apio/releases/download/2026-09-27/apio-cli-darwin-arm64-20260927-bundle.tgz (SHA-256 `963529620145c7dac6e3356f79fc7bd0f7e2302420e1e7c712345435fc77e15f`)

### Apio definitions package — 2026.09.17

Apio board/FPGA/programmer definitions.

- Folder: `apio/packages/definitions` (991 files, 2.5 MiB)
- License: GPL-3.0-only
- License evidence: LICENSE in the package is the GNU GPL version 3 text without an "or later" grant (this corrects the GPL-2.0 label of Toolchain 1.0).
- License texts: `apio/packages/definitions/LICENSE`
- Project: https://github.com/FPGAwars/apio-definitions
- Upstream source: https://github.com/FPGAwars/apio-definitions/tree/2fd2c66575c775810aacfa1e174b377ec711f6a4
- Redistributed archive: https://github.com/fpgawars/apio-definitions/releases/download/2026-09-17/apio-definitions-20260917.tgz (SHA-256 `34a2047db39c3c91f9dfb2e84b5ea67095302b7cc8bbf7dd5d3f1f06d57be150`)

### Apio oss-cad-suite package (Yosys, openFPGALoader) — 2026.09.15

YosysHQ OSS CAD Suite build for Apio (darwin-arm64): Yosys 0.63+173 (yosys-release-tag 2026-03-24), openFPGALoader 1.1.1 with libusb/libftdi/hidapi, Python 3.11, and the rest of the suite (incl. Qt 5 frameworks used only by other nextpnr variants and GUIs).

- Folder: `apio/packages/oss-cad-suite` (24788 files, 1747.8 MiB)
- License: Mixed; Yosys ISC; openFPGALoader Apache-2.0; GNU readline 8.2 GPL-3.0-or-later; libusb 1.0.26 and libftdi1 1.5 LGPL; Qt 5.15.3 LGPL-3.0/GPL-2.0/GPL-3.0 (six modules GPL-3.0 only); GTK/GLib/Pango/Cairo and other MacPorts libraries LGPL or permissive; per-tool licenses in license/LICENSE.* (59 files), including GPL-licensed tools (e.g. Icarus Verilog, GTKWave); Python 3.11 PSF-2.0. The per-library inventory is in the compliance manifest and licenses/compliance/
- License evidence: license/LICENSE.* in the package (the Graphviz text there is EPL-1.0, the version of the binary); Python packages under lib/python3.11/site-packages/*.dist-info; the licence texts of the bundled native libraries (Qt, MacPorts libraries) are in licenses/compliance/. The libusb text in license/LICENSE.libusb records revision 1.0.24; the shipped library is 1.0.26 (text in licenses/compliance/ocs-macports-libusb).
- License texts: `apio/packages/oss-cad-suite/license`, `licenses/yosys-COPYING.txt`, `licenses/LGPL-3.0.txt`, `licenses/GPL-3.0.txt`, `licenses/compliance`
- Project: https://github.com/FPGAwars/tools-oss-cad-suite
- Upstream source: https://github.com/FPGAwars/tools-oss-cad-suite/tree/b246ed025634562f953daccef0c9d2f7995d30c3 (build recipe); upstream https://github.com/YosysHQ/oss-cad-suite-build
- Redistributed archive: https://github.com/fpgawars/tools-oss-cad-suite/releases/download/2026-09-15/apio-oss-cad-suite-darwin-arm64-20260915.tgz (SHA-256 `5c8729c24567dcf83f5a28dcaf02a276d0456a263b43ae5714f9bcf13a31b9d2`)

### Apio verible package — 2026.09.20

Verible SystemVerilog tools (used by 'apio format/lint'; required by Apio's package check; not used by NexysVHDL).

- Folder: `apio/packages/verible` (12 files, 24.0 MiB)
- License: Apache-2.0 (Verible upstream)
- License evidence: No license file in the package; https://github.com/chipsalliance/verible/blob/master/LICENSE
- License texts: `licenses/verible-LICENSE.txt`
- Project: https://github.com/FPGAwars/tools-verible
- Upstream source: https://github.com/chipsalliance/verible/tree/v0.0-4294-gc1d8f5e8
- Redistributed archive: https://github.com/fpgawars/tools-verible/releases/download/2026-09-20/apio-verible-darwin-arm64-20260920.tgz (SHA-256 `dba75c553500903d8c813295bc30c1c2cc2079462bf648d20ff73b815f111e4b`)

### Apio openXC7 package (nextpnr-xilinx, Project X-Ray tools) — 2026.09.25

openXC7 (darwin-arm64): nextpnr-xilinx e860c9c8360d8501a1b55df94e58f3dfe7bde958, prjxray fasm2frames/xc7frames2bit, Project X-Ray database a90f27c1caefee5276f47440f4c730b50519a86f, parts index schema 7, Python 3.12.5.

- Folder: `apio/packages/openxc7` (5445 files, 666.2 MiB)
- License: Mixed; nextpnr-xilinx ISC, Project X-Ray tools ISC, prjxray-db CC0-1.0, Python 3.12 (PSF-2.0) and packages under lib/
- License evidence: No top-level license file in the package; upstream https://github.com/openXC7/nextpnr-xilinx/blob/xilinx-upstream/COPYING , https://github.com/f4pga/prjxray/blob/master/LICENSE , https://github.com/f4pga/prjxray-db/blob/master/LICENSE ; Python license lib/python3.12/LICENSE.txt and package licenses under lib/python3.12/site-packages/*.dist-info.
- License texts: `licenses/nextpnr-xilinx-COPYING.txt`, `licenses/prjxray-LICENSE.txt`, `licenses/prjxray-db-LICENSE.txt`, `apio/packages/openxc7/lib/python3.12/LICENSE.txt`
- Project: https://github.com/FPGAwars/tools-openxc7
- Upstream source: https://github.com/FPGAwars/tools-openxc7/tree/22b6a11dc3198c2c28ad6b9c482f23e7a08e2331 (build recipe); https://github.com/openXC7/nextpnr-xilinx/tree/e860c9c8360d8501a1b55df94e58f3dfe7bde958 ; https://github.com/f4pga/prjxray-db/tree/a90f27c1caefee5276f47440f4c730b50519a86f
- Redistributed archive: https://github.com/fpgawars/tools-openxc7/releases/download/2026-09-25/apio-openxc7-darwin-arm64-20260925.tgz (SHA-256 `24469f147f56ff02b1e18384096a1f56c8a5b56cc7c488edd32554c3e0ecf3e2`)

### openXC7 chip database for xc7a100t (Nexys A7-100T, xc7a100tcsg324) — 2026-09-25

nextpnr-xilinx chipdb that Apio would otherwise download on demand into openxc7/chipdb; generated from Project X-Ray data for the same openXC7 release (chipdb-id d8eda92262f6d0c1).

- Folder: `apio/packages/openxc7/chipdb` (2 files, 37.4 MiB)
- License: Derived from prjxray-db (CC0-1.0) by nextpnr-xilinx (ISC) tooling
- License evidence: Release asset of FPGAwars/tools-openxc7 2026-09-25; sha256 values from the package's XILINX-PARTS-INDEX.json (asset-sha256, chipdb-sha256) for parts xc7a100tcsg324-*.
- License texts: `licenses/prjxray-db-LICENSE.txt`, `licenses/nextpnr-xilinx-COPYING.txt`
- Project: https://github.com/FPGAwars/tools-openxc7
- Upstream source: https://github.com/FPGAwars/tools-openxc7/tree/22b6a11dc3198c2c28ad6b9c482f23e7a08e2331
- Redistributed archive: https://github.com/fpgawars/tools-openxc7/releases/download/2026-09-25/apio-xilinx-chipdb-xc7a100t-20260925.bin.tgz (SHA-256 `86b8ea41db04a2307f1f077c7c49e3f6615d7110b37f1e49a6aabfbf533c0a12`)

## Not included

Digilent Adept Runtime, Adept Utilities and drivers (not needed on macOS: the board programmer in this toolchain talks to the board over USB), Vivado and other Xilinx/AMD software, Apple Xcode and Command Line Tools.

## Board programmer

openFPGALoader 1.1.1 is included in this bundle. openFPGALoader 1.1.1 (Apache-2.0) ships in the official Apio oss-cad-suite package together with the libusb, libftdi and hidapi libraries it loads from the package itself; macOS needs no FPGA USB driver for the Nexys A7's FTDI JTAG interface.

