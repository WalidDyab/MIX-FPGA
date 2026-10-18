# Third-party notices: MIX-FPGA 0.7.0 for macOS (Apple silicon)

**STATUS: DRAFT, NOT FOR REDISTRIBUTION.** Prepared in Phase 5B as an engineering/compliance assessment, not legal advice. Items in `[OWNER DECISION]` brackets need the project owner; items marked *needs legal review* need counsel. The DRAFT marking must stay until every item in section 9 is closed or accepted in writing by the project owner. The machine-readable companions are [`macos-component-license-inventory.md`](macos-component-license-inventory.md) and [`macos-source-provenance-manifest.json`](macos-source-provenance-manifest.json).

## 1. What this covers

MIX-FPGA is distributed as separate parts. Each part is listed here with what it contains.

| Part | File | SHA-256 | Third-party content |
|---|---|---|---|
| MIX-FPGA extension | `nexysvhdl-0.7.0-darwin-arm64.vsix` | `5f0447f909a2ad46566fb93032c085f2c07b9a9bed718d16ffd9f0dbc21c152a` (Phase 5A build; a rebuilt VSIX has a new hash) | none (section 2) |
| Nexys A7 support archive | `nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz` | `d8cdf6e2a6c082d05189396b10892b1a6605a267b2f2b884c9911c9140a2359d` | the unmodified official Apio 1.7.0, YosysHQ OSS CAD Suite 2026.09.15 and openXC7 packages, GHDL 6.0.0 (section 4) |
| DE10-Lite support archive | `mixfpga-de10-lite-support-1.0-macos-arm64.tar.gz` | `f8cbe33f56b54018204ba4f3f9c0a6cf4a4ad8e66145e36787c3b8e47f70eebb` | GHDL 6.0.0, Yosys 0.63+173, openFPGALoader 1.1.1, Lima 2.2.1 (section 5) |
| Corresponding source | `MIX-FPGA-0.7.0-macos-sources/` (not yet assembled; section 7) | to be recorded | the sources named below |

## 2. MIX-FPGA's own code

Apache License 2.0, Copyright 2026 Walid Dyab (an EMXplore project). This covers the extension (compiled TypeScript, VHDL grammar, board data, templates, icons, documentation) and the MIX-FPGA-authored files inside the support archives (the toolchain manifests, the engine VM template and provisioning scripts). The extension bundles no third-party code and no npm runtime dependencies. The Apache license does **not** apply to the third-party components below.

## 3. Principles

- **Aggregation.** The support archives are aggregations of separate programs, each under its own license. Nothing is relicensed.
- **Unmodified.** MIX-FPGA does not patch or rebuild any third-party program. The archives carry the upstream binaries as released. Evidence for this release: the DE10 archive's GHDL, Yosys, readline, libusb, libftdi and openFPGALoader files are byte-identical to the Nexys archive's; its Lima files are identical to the official `lima-2.2.1-Darwin-arm64.tar.gz` (sha256 `9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e`); the Nexys archive is the official upstream packages. No MIX-FPGA modification notices are therefore required.
- **Separate libraries stay replaceable.** All LGPL/GPL libraries are separate dynamic libraries (`@executable_path/../lib/...`), see section 8.

## 4. Nexys A7 support archive: components

Full detail (every tool, 70 library groups, Python packages, source ids) is in the inventory file. Summary by license class:

| Class | Components | Source or text provided |
|---|---|---|
| Strong copyleft | GHDL 6.0.0 (GPL-2.0-or-later, with std.textio and the GRT runtime under GPLv2); Apio 1.7.0 (GPL-3.0-or-later; the in-archive notice file says GPL-2.0, which is wrong, see 9); Apio definitions 2026.09.17 (GPL-3.0); GPL tools of the oss-cad-suite (dfu-util, GTKWave, Icarus Verilog, OpenOCD, Yices, black-iceprog, icefunprog, tinyfpgab, tinyprog, ghdl-yosys-plugin); GNU readline 8.2.001 (GPL-3.0-or-later) | corresponding source in the source package |
| Weak copyleft | libusb 1.0.26 and 1.0.30, libftdi1 1.5, libghw, libpoly, xdot and Verilator (LGPL-3.0), GTK/GLib/Pango/ATK/Cairo/gdk-pixbuf/fribidi/graphite2/gettext/libiconv/GMP/gtk-mac-integration/PyGObject/pycairo, Qt 5.15.3 (58 frameworks and 67 plugins; Charts, Data Visualization, Quick 3D, Virtual Keyboard, Lottie, Network Authorization and the WebGL plugin are GPL-3.0-only), Graphviz (EPL-1.0), Surfer (EUPL-1.2), certifi (MPL-2.0), Eigen (MPL-2.0, compiled into nextpnr-xilinx), vcdvcd (Artistic-1.0-Perl or GPL-1.0-or-later) | source of each library in the source package |
| Runtime exception | libgnat-14 and libgcc_s (GPL-3.0-or-later with GCC Runtime Library Exception 3.1); LLVM 22.1.0 (Apache-2.0 with LLVM exception) statically in GHDL | license and exception texts |
| Permissive | Yosys (ISC), openFPGALoader (Apache-2.0), nextpnr-xilinx and Project X-Ray (ISC), Python (PSF-2.0), OpenSSL 3.2.0/3.5.7 (Apache-2.0), verible (Apache-2.0), zlib, zstd, hidapi, Tcl, ncurses, libffi, Boost, ICU, and the rest of the MacPorts and Nix libraries | license texts |
| Data | openXC7 chip database and prjxray-db (CC0-1.0) | none |

Of these, the tools MIX-FPGA actually runs are: GHDL, Yosys (with readline, libffi, libtcl, zlib), openFPGALoader (with libusb, libftdi1, hidapi, zlib), nextpnr-xilinx, xc7frames2bit and Python 3.12 (fasm2frames), and Apio. Qt, GTK and most of the suite are redistributed but never loaded by MIX-FPGA (they are candidates for removal in a later toolchain version).

## 5. DE10-Lite support archive: components

| Component | Version | License | Source |
|---|---|---|---|
| GHDL (`ghdl`, `ghwdump`, libraries, scripts) | 6.0.0 (`e589c698c`) | GPL-2.0-or-later; GRT runtime and `std.textio` GPLv2; IEEE-2008 packages Apache-2.0 | `ghdl-6.0.0.tar.gz` |
| LLVM, statically linked into `ghdl` | 22.1.0 | Apache-2.0 WITH LLVM-exception | none required |
| GNAT/GCC runtime (`libgnat-14`, `libgcc_s`) | 14.2.0 | GPL-3.0-or-later WITH GCC-exception-3.1 | none required by the exception |
| libghw | 6.0.0 | LGPL-2.1-or-later | in `ghdl-6.0.0.tar.gz` |
| IEEE 1076.3-1995 `numeric_bit`/`numeric_std` (VHDL-87/93 sets, sources and compiled) | 1995 | IEEE terms: distributable unchanged, not sold or distributed for profit | see L1 |
| VITAL and UPF packages | - | no license statement | see L2 |
| Synopsys std_logic_arith/unsigned/signed/misc | 1990-1992 | use and distribute without restriction if copyright statements are kept | texts in the archive |
| Yosys | 0.63+173 (`66306a8ca-dirty`) | ISC; distributed together with and linked to GPL-3.0-or-later readline, treated as a GPLv3 combination (L3) | `oss-yosys.tar.gz` + `oss-yosys--abc.tar.gz` + `oss-yosys--libs-cxxopts.tar.gz` + the build recipe `yosyshq-oss-cad-suite-build-2026-03-24.tar.gz` |
| GNU readline | 8.2 patch 001 | GPL-3.0-or-later | `readline-8.2.tar.gz`, `readline82-001`, MacPorts port `556ec864a7d9` |
| libffi 3.4.4, ncurses 6.4, Tcl 8.6.13, zlib 1.3 | | MIT, X11, TCL, Zlib | none required |
| openFPGALoader | 1.1.1 | Apache-2.0 (upstream has no NOTICE file at v1.1.1) | none required |
| libusb | 1.0.26 | LGPL-2.1-or-later | `libusb-1.0.26.tar.gz`, MacPorts port `6b3c05d3a37d` |
| libftdi1 | 1.5 | LGPL-2.0-only | `libftdi1-1.5.tar.bz2`, MacPorts port `3bdf7f45e366` |
| hidapi 0.12.0, zstd 1.5.5 | | BSD-3-Clause options | none required |
| openFPGALoader bridge bitstreams (111) | 1.1.1 | Apache-2.0 as part of the release; per-file provenance unknown (L10) | none |
| Lima (`limactl`, `lima`, helpers, guest agents, templates) | 2.2.1 | Apache-2.0 | none required. **Lima's own NOTICE file must accompany it** (section 6) |
| Go 1.27.1 standard library and 100 Go modules compiled into Lima | | BSD-3-Clause, MIT (45), Apache-2.0 (26), BSD-3-Clause (25), BSD-2-Clause (3), **MPL-2.0 (1: `github.com/hashicorp/hcl/v2` v2.24.0)** | see section 6 |
| MIX-FPGA engine VM template and provisioning scripts | phase4 | Apache-2.0 (MIX-FPGA) | in the archive |

## 6. Specific notices that must accompany the binaries

**Lima NOTICE (Apache-2.0 section 4(d)).** Reproduce `upstream-notices/Lima-2.2.1-NOTICE.txt` (sha256 `a7e0caed1395c49dfa6ce7dc8aa6362e4daa8369917f56fbe80084c1ae8c765c`, tag v2.2.1) with the Lima files. The official Lima tarball does not contain it.

**MPL-2.0 module.** Lima is linked with `github.com/hashicorp/hcl/v2` v2.24.0 (MPL-2.0), used by `limactl`, `lima-driver-krunkit` and both guest agents. MIX-FPGA has not modified it. Its Source Code Form is the Go module archive `https://proxy.golang.org/github.com/hashicorp/hcl/v2/@v/v2.24.0.zip` (sha256 `53fd4e96ac9c190e192759daf49b63397865214d337ab5f6dbf6e68c1b0f4810`, go.sum `h1:2QJdZ454DSsYGoaE6QheQZjtKZSUs9Nh2izTWiwQxvE=`). The license text is in `LICENSES/lima-go/github.com/hashicorp/hcl/v2@v2.24.0/LICENSE`. `[OWNER DECISION]` point to the upstream location (permitted for unmodified code) or include the archive in the source package (recommended).

**Yosys with readline.** The `yosys` executable loads `libreadline.8.2.dylib` from `../lib/`, which is GPL-3.0-or-later. MIX-FPGA treats the distributed `yosys` plus readline as a work governed by GPLv3 and provides the complete corresponding source of both (Yosys with its `abc` and `cxxopts` submodules, readline 8.2 with patch 001, and the build scripts). Yosys' own license (ISC) is compatible. *Needs legal review to confirm the combined-work position.*

**Libraries compiled into the `yosys` executable** (from the Yosys source tree at `66306a8ca34cb1dcdafe12a5838fa8f0c1a7f4c2`; each license text is in that tree):

| Library | License | Where the text is |
|---|---|---|
| ezSAT (Claire Xenia Wolf) | ISC | file header (`libs/ezsat/`) |
| MiniSat (Een, Sorensson) | MIT | `libs/minisat/LICENSE` |
| json11 (Dropbox) | MIT | header of `libs/json11/json11.cpp` |
| fstapi (Tony Bybell) | MIT | header of `libs/fst/fstapi.cc` |
| sha1 | public domain | header of `libs/sha1/sha1.cpp` |
| BigInteger (Matt McCutchen) | public domain | `libs/bigint/README` |
| subcircuit (Claire Xenia Wolf) | ISC | header of `libs/subcircuit/subcircuit.cc` |
| cxxopts | MIT (Jarryd Beck; submodule `libs/cxxopts`, `4bf61f08`) | `libs/cxxopts/LICENSE` in the submodule archive |
| ABC (Berkeley) | Berkeley permissive | `abc/copyright.txt` in the `abc` submodule archive (`b4a657e7`); the Nexys archive also carries `license/LICENSE.abc` |

`[TO DO]` copy the MIT/ISC texts and copyright lines above into the shipped notices.

**GHDL.** GHDL's own documentation (v6.0.0, `doc/licenses.rst`) says: the front-end package `std.textio` and the runtime library GRT are GPLv2, "as a consequence ... you are not allowed to distribute an executable produced by GHDL without allowing access to the VHDL sources." (The majority of GRT source files carry a GCC-style linking exception; the documentation does not state it.) MIX-FPGA runs simulations in memory (LLVM JIT) and does not distribute students' executables. Students who distribute an executable built with GHDL should include their VHDL sources.

**IEEE 1076.3-1995 packages (L1).** The VHDL-87 and VHDL-93 `numeric_bit` and `numeric_std` files in the GHDL library carry this notice (paraphrased): the files may be distributed without change and may not be sold or distributed for profit. MIX-FPGA always runs GHDL with `--std=08`, which uses the Apache-2.0 IEEE packages; the 1995 sets are redistributed unmodified and unused by any MIX-FPGA flow. `[OWNER DECISION]` see section 9.

**Digilent, Quartus and others.** See section 8.

## 7. Source and written offer

The corresponding source of every GPL/LGPL/MPL/EPL/EUPL component of the two archives is provided in `MIX-FPGA-0.7.0-macos-sources/` (design in `docs/phase5b-redistribution-report.md`), which accompanies the archives at the same place and time. Every source archive has its SHA-256 in `manifest.json` (existing archives: `NexysVHDL-Toolchain-1.0-Sources.zip`, sha256 `69f496eb2b852f922ce0f1a7b8322ee467be2e23b1da665e35e6f170d1d095b6`).

`[OWNER DECISION]` written offer text: "For three years from the date you received this software, and for as long as MIX-FPGA 0.7.0 is distributed, you may obtain the complete corresponding source of the components listed here, free of charge except for the cost of physical distribution, by writing to <contact>." The contact address and duration are the owner's.

## 8. Your right to modify and replace covered components

The GPL and LGPL components are separate files inside the installed folder (`~/Library/MIX-FPGA/toolchains/1.0/macos-arm64/...` and `~/Library/MIX-FPGA/support/nexys-a7/...`), loaded at run time; you may replace them with your own builds from the corresponding source, for your own use, and reverse-engineer them for debugging. The installed folder is read-only by default; make a file writable, replace it, and on Apple silicon re-sign it (`codesign -f -s - <file>`). MIX-FPGA keeps working with replaced files. **Verify** and the Setup page will report the file as "changed" and **Repair** will restore the original only when you choose Repair. MIX-FPGA's integrity check is a support aid, not a technical restriction. (Tested in Phase 5B on a copy: a modified libftdi loaded and ran, Setup reported "1 changed", nothing was restored automatically.) A configuration with replaced files is not supported.

**Not included, not redistributed:** Altera Quartus Prime Lite and the MAX 10 device package (you download them from Altera and accept Altera's license yourself); Apple Rosetta and macOS frameworks; Canonical's Ubuntu 24.04 cloud image and the Ubuntu packages installed inside the engine (downloaded on your computer from Canonical and Ubuntu servers during setup); Digilent Adept software or drivers (not needed on macOS); Vivado; Xcode.

## 9. Open items (the DRAFT warning stays until each is closed)

| Id | Item | Status |
|---|---|---|
| L1 | IEEE 1076.3-1995 "not for profit" packages in both archives | `[OWNER DECISION]` + *needs legal review* |
| L2 | VITAL and UPF packages without license statement | open, *needs legal review*; unused by MIX-FPGA |
| L3 | Yosys with GPLv3 readline | position documented here; *needs legal review* |
| L4 | `-dirty` Yosys build | explained by the build recipe, not independently reproduced (report section C) |
| L9 | Integrity check versus replacement rights | behavior tested; documentation text in section 8; *needs legal review* |
| L10 | 111 openFPGALoader bridge bitstreams | provenance unknown; unused |
| N1 | In-archive notices of the Nexys archive label Apio and Apio definitions "GPL-2.0" (correct: GPL-3.0-or-later and GPL-3.0), ship a Graphviz EPL-2.0 text where the binary is EPL-1.0, and a libwdi text not needed on macOS | supersede with this file or fix in the next toolchain version |
| N2 | The DE10 archive's own `THIRD_PARTY_NOTICES.txt` reads "DRAFT - NOT FOR REDISTRIBUTION" | replace with the final notices when the gate closes |
| N3 | Lima NOTICE missing from the DE10 archive | add (section 6) |
| N4 | MPL-2.0 `hcl` source pointer | decide and add (section 6) |
| N5 | Copyright lines/texts of libraries compiled into Yosys | copy into the notices (section 6) |
| N6 | Written offer contact and duration | `[OWNER DECISION]` |
