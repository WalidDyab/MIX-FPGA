# Phase 5B: macOS per-component licence inventory (DRAFT)

Engineering/compliance assessment generated from the committed inventories and the exact distributed archives; **not legal advice**. Every row comes from `toolchains/mixfpga/compliance/macos-arm64.inventory.json` (DE10-Lite support archive) or `toolchains/compliance/toolchain-1.0.json` (Nexys A7 support archive). "Modified by MIX-FPGA": **no** for every third-party row unless stated (verified: the DE10 archive's GHDL, Yosys, readline, libusb, libftdi and openFPGALoader files are byte-identical to the Nexys archive's; its Lima files are identical to the official lima-2.2.1-Darwin-arm64.tar.gz; the Nexys archive is the unmodified official Apio/oss-cad-suite/openXC7 packages).

Status words are those of the inventory: verified, inherited (byte-identical to a component reviewed in the NexysVHDL review), unclear, pending.

## 1. DE10-Lite support archive (`mixfpga-de10-lite-support-1.0-macos-arm64.tar.gz`, 36 components)

| Component | Version | Licence (SPDX) | Class | Source obligation | Linking | Status | Flags |
|---|---|---|---|---|---|---|---|
| GHDL (ghdl, ghwdump) | 6.0.0 (6.0.0.r0.ge589c698c) | GPL-2.0-or-later | strong-copyleft | corresponding-source | Executable. Statically contains the LLVM code generator and the GNAT Ada runtime (see ghdl | inherited | L6 |
| LLVM (statically linked into ghdl) | 22.1.0 (Homebrew build) | Apache-2.0 WITH LLVM-exception | permissive | none |  | verified |  |
| GNAT / GCC runtime libraries | libgnat-14, libgcc_s 1.1 | GPL-3.0-or-later WITH GCC-exception-3.1 | runtime-exception | none-required-by-exception | Dynamic libraries beside the program (replaceable files). | unclear | L6 |
| libghdl, libghdlvpi, libghdl.a | 6.0.0 | GPL-2.0-or-later | strong-copyleft | corresponding-source | Dynamic / static library files. | inherited | L6 |
| libghw (GHDL waveform library) and its header | 6.0.0 | LGPL-2.1-or-later | weak-copyleft | library-source-and-replaceability |  | verified | L9 |
| GHDL synthesis headers | 6.0.0 | GPL-2.0-or-later | strong-copyleft | corresponding-source |  | unclear | L8 |
| vhpi_user.h (IEEE P1076 WG) | 2019 | Apache-2.0 | permissive | none |  | verified |  |
| vpi_user.h (IEEE Std 1800-2017 PLI header) | - | UNCLEAR | unclear | none |  | unclear | L8 |
| VHDL STD library (standard, textio, env) and its compiled form | 6.0.0 | GPL-2.0-or-later | strong-copyleft | corresponding-source |  | unclear | L7 |
| IEEE 1076-2008 packages and the Apache-licensed math packages (IEEE P1 | 2019 files | Apache-2.0 | permissive | none |  | verified |  |
| IEEE 1076.3-1995 synthesis packages (numeric_bit, numeric_std; VHDL-87 | 1995 | LicenseRef-IEEE-1076.3-1995 (custom terms: distribute unchanged, not for profit) | unclear | none |  | unclear | L1 |
| VITAL packages (IEEE 1076.4: vital95, vital2000) | - | UNCLEAR | unclear | none |  | unclear | L2 |
| UPF package (IEEE 1801 power-aware simulation support) | - | UNCLEAR | unclear | none |  | unclear | L2 |
| Synopsys std_logic_arith / unsigned / signed / misc packages | 1990-1992 | LicenseRef-Synopsys-permissive | permissive | none |  | verified |  |
| Compiled IEEE library (GHDL .cf files) | 6.0.0 | derived from ieee-2008-library and ieee-1076-3-1995 (same terms apply) | unclear | none |  | unclear | L1 |
| GHDL vendor-library compile scripts and ansi_color.sh | 6.0.0 | GPL-2.0-or-later | strong-copyleft | corresponding-source |  | verified |  |
| Yosys | 0.63+173 (git 66306a8ca-dirty) | ISC | permissive | corresponding-source | Executable, dynamically linked to readline, libffi, zlib and Tcl shipped beside it; static | unclear | L3, L4 |
| Libraries compiled into the yosys executable (ezsat/minisat, json11, f | per Yosys source tree | per library (typically MIT, ISC or public-domain style) | permissive | none |  | pending | L4 |
| GNU Readline | 8.2.001 | GPL-3.0-or-later | strong-copyleft | corresponding-source | Dynamic library beside the program (@executable_path/../lib). | inherited | L3, L9 |
| ncurses | 6.4 | X11 | permissive | none |  | inherited |  |
| libffi | 3.4.4 | MIT | permissive | none |  | inherited |  |
| Tcl (library and script library) | 8.6.13 | TCL (Tcl/Tk licence) | permissive | none |  | inherited |  |
| zlib (bundled copy) | 1.3 | Zlib | permissive | none |  | inherited |  |
| openFPGALoader | 1.1.1 | Apache-2.0 | permissive | none | Executable, dynamically linked to libusb, libftdi1, hidapi and zlib shipped beside it. | inherited |  |
| libusb | 1.0.26 | LGPL-2.1-or-later | weak-copyleft | library-source-and-replaceability | Dynamic library beside the program. | inherited | L5, L9 |
| libftdi1 | 1.5 | LGPL-2.0-only | weak-copyleft | library-source-and-replaceability |  | inherited | L9 |
| HIDAPI | 0.12.0 | BSD-3-Clause | permissive | none |  | inherited |  |
| zlib (bundled copy) | 1.3 | Zlib | permissive | none |  | inherited |  |
| Zstandard | 1.5.5 | BSD-3-Clause | permissive | none |  | inherited |  |
| openFPGALoader bridge bitstreams (spiOverJtag_*, bpiOverJtag_*) | 1.1.1 | Apache-2.0 (as part of the openFPGALoader release) | unclear | none |  | unclear | L10 |
| Lima (limactl, lima and wrappers, documentation, man pages) | 2.2.1 | Apache-2.0 | permissive | none | Go executable (statically linked Go modules); dynamically links macOS system frameworks on | verified | L11 |
| Lima helper programs (limactl-mcp, lima-driver-krunkit) | 2.2.1 | Apache-2.0 | permissive | none |  | verified | L11 |
| Lima guest agents (Darwin-aarch64, Linux-aarch64) | 2.2.1 | Apache-2.0 | permissive | none |  | verified | L11 |
| Lima VM templates | 2.2.1 | Apache-2.0 | permissive | none |  | verified |  |
| Go standard library and 100 Go modules compiled into Lima's programs | go1.27.1; module versions in go-licenses | BSD-3-Clause (Go), MIT (45 modules), Apache-2.0 (26), BSD-3-Clause (25), BSD-2-Clause (3), | permissive | none-except-mpl-module |  | verified | L11 |
| MIX-FPGA engine VM template and provisioning scripts | phase4 | Apache-2.0 | permissive | none |  | verified |  |

### Lima Go dependencies (inside lima-go-dependencies)

Go standard library go1.27.1 (BSD-3-Clause) plus 100 modules; licence texts collected from the exact embedded versions, each module hash checked against the hash embedded in the Lima binaries: MIT 45, Apache-2.0 26, BSD-3-Clause 25, BSD-2-Clause 3, **MPL-2.0 1** (`github.com/hashicorp/hcl/v2` v2.24.0, used by guestagent-darwin, guestagent-linux, lima-driver-krunkit, limactl; module archive `https://proxy.golang.org/github.com/hashicorp/hcl/v2/@v/v2.24.0.zip`, sha256 `53fd4e96ac9c190e192759daf49b63397865214d337ab5f6dbf6e68c1b0f4810`).

## 2. Nexys A7 support archive (`nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz`, tree `f04022180f9bb746dc5dc467bc7d1d379512f302159763f8c4a8c0ed50b2aac7`, 31699 files)

### 2.1 Top-level components

| Component | Version | Licence (SPDX, reviewed) |
|---|---|---|
| GHDL | 6.0.0 | GPL-2.0-or-later AND GPL-3.0-or-later WITH GCC-exception-3.1 AND Apache-2.0 WITH LLVM-exception AND Apache-2.0 |
| Apio | 1.7.0 | GPL-3.0-or-later AND PSF-2.0 AND Apache-2.0 AND LGPL-2.1-or-later AND MIT AND BSD-3-Clause AND BSD-2-Clause AND MPL-2.0 AND (Artistic-1.0-Perl OR GPL-1.0-or-later) AND Apache-2.0 WITH LLVM-exception |
| Apio definitions package | 2026.09.17 | GPL-3.0-only |
| Apio oss-cad-suite package (Yosys, openFPGALoader) | 2026.09.15 | LicenseRef-NexysVHDL-aggregate |
| Apio verible package | 2026.09.20 | Apache-2.0 |
| Apio openXC7 package (nextpnr-xilinx, Project X-Ray tools) | 2026.09.25 | ISC AND CC0-1.0 AND Apache-2.0 AND MIT AND PSF-2.0 AND Apache-2.0 WITH LLVM-exception AND BSL-1.0 AND BSD-3-Clause AND BSD-2-Clause AND 0BSD AND Zlib AND bzip2-1.0.6 AND MPL-2.0 |
| openXC7 chip database for xc7a100t (Nexys A7-100T, xc7a100tcsg324) | 2026-09-25 | CC0-1.0 |

### 2.2 oss-cad-suite tools (58); tools whose licence requires source are marked

| Tool | Licence(s) | Source required | Pinned source |
|---|---|---|---|
| abc | LicenseRef-Berkeley-permissive | no | not pinned (permissive) @ b4a657e75b16 |
| aiger | MIT, BSD-3-Clause | no | not pinned (permissive) @ 039ec1a2cc37 |
| amaranth | BSD-2-Clause | no | not pinned (permissive) @ a30350dcab95 |
| amaranth-boards | BSD-2-Clause | no | not pinned (permissive) @ 96dfc332b5c9 |
| apicula | MIT | no | not pinned (permissive) @ 3da6c408c44c |
| avy | LicenseRef-Berkeley-permissive | no | not pinned (permissive) @ f2e304405f3a |
| bitwuzla | MIT | no | oss-bitwuzla @ 6e46391816b4 |
| black-iceprog | GPL-3.0 | **yes** | oss-black-iceprog @ 8b6667d1cdc3 |
| boolector | MIT | no | oss-boolector @ 43dae91c1070 |
| btor2tools | MIT | no | oss-btor2tools @ d381aefa4560 |
| cadical | MIT | no | oss-cadical @ e7369b4b04fa |
| cocotb | BSD-3-Clause | no | not pinned (permissive) @ 41564633538c |
| cvc4 | BSD-3-Clause | no | oss-cvc4 @ 3dda54ba7e69 |
| cvc5 | BSD-3-Clause | no | oss-cvc5 @ 77d0bec48a74 |
| dfu-util | GPL-2.0 | **yes** | oss-dfu-util @ f9a537c93935 |
| ecpdap | MIT | no | not pinned (permissive) @ 3335a3ad8892 |
| ecpprog | ISC | no | not pinned (permissive) @ 1931c3e121f6 |
| eqy | ISC | no | not pinned (permissive) @ 3b20c1c7a112 |
| fujprog | BSD-2-Clause | no | not pinned (permissive) @ cc3ea93f2b8d |
| ghdl | GPL-2.0 | **yes** | ghdl-6.0.0 @ e589c698c351 |
| ghdl-yosys-plugin | GPL-3.0 | **yes** | oss-ghdl-yosys-plugin @ 07a30ed39fb6 |
| graphviz | EPL-1.0 | **yes** | oss-graphviz @ da4c2ec6f24c |
| gtkwave | GPL-2.0 | **yes** | oss-gtkwave @ 10cfae614ed8 |
| icefunprog | GPL-3.0 | **yes** | oss-icefunprog @ 99e6abc7c0da |
| iceprogduino | Apache-2.0 | no | not pinned (permissive) @ 91f3b5aff502 |
| icestorm | ISC | no | not pinned (permissive) @ f31c39cc2ead |
| imctk | Apache-2.0, MIT | no | not pinned (permissive) @ 1a73a50fd770 |
| iverilog | GPL-2.0 | **yes** | oss-iverilog @ 6767a079560f |
| libftdi | LGPL-2.0, GPL-2.0 | **yes** | oss-libftdi @ 5c2c58e03ea9 |
| libpoly | LGPL-3.0 | **yes** | oss-libpoly @ 1383809f2aa5 |
| libusb | LGPL-2.1 | **yes** | oss-libusb @ c6a35c56016e |
| lingeling | MIT | no | oss-lingeling @ 89a167d0d2ef |
| mau | ISC | no | not pinned (permissive) @ 5ab774c33570 |
| mcy | ISC | no | not pinned (permissive) @ 8b23eba5f22d |
| migen | BSD-2-Clause | no | not pinned (permissive) @ e19524c963a8 |
| nextpnr | ISC | no | not pinned (permissive) @ 5281b8d8afe3 |
| openfpgaloader | Apache-2.0 | no | not pinned (permissive) @ 451beadfae95 |
| openocd | GPL-2.0 | **yes** | oss-openocd @ b6ee13720688 |
| picosat | MIT | no | not pinned (permissive) @ 2c4d88d95db4 |
| pono | BSD-3-Clause | no | oss-pono @ b243cef7ea0c |
| prjoxide | ISC | no | not pinned (permissive) @ 9ab3b4ee3b9c |
| prjpeppercorn | ISC | no | not pinned (permissive) @ e8eab9a45b7f |
| prjtrellis | ISC, MIT | no | not pinned (permissive) @ 73bd41173180 |
| python3 | PSF-2.0, ISC | no | not pinned (permissive) @ 8b6ee5ba3bd0 |
| sby | ISC | no | not pinned (permissive) @ 268502844eab |
| sby-gui | ISC | no | not pinned (permissive) @ 6c977084c17c |
| scy | ISC | no | not pinned (permissive) @ dc92d1319aa6 |
| smt-switch | BSD-3-Clause | no | oss-smt-switch @ f2d7d3d6dfcc |
| surfer | EUPL-1.2 | **yes** | oss-surfer-darwin @ 0ab7f4722be9 |
| symfpu | BSD-2-Clause | no | oss-symfpu @ 8fbe139bf007 |
| tinyfpgab | GPL-3.0 | **yes** | oss-tinyfpgab @ e8f915033f7a |
| tinyprog | GPL-3.0 | **yes** | oss-tinyprog @ 97f6353540bf |
| verilator | LGPL-3.0, GPL-3.0 | **yes** | oss-verilator @ 3b328d2bb661 |
| xdot | LGPL-3.0 | **yes** | oss-xdot @ 6248c81c21a0 |
| yices | GPL-3.0 | **yes** | oss-yices @ 016a6243de76 |
| yosys | ISC | no | oss-yosys @ 66306a8ca34c |
| yosys-slang-plugin | ISC | no | not pinned (permissive) @ 8c82a4b7c4df |
| z3 | MIT | no | not pinned (permissive) @ 76182c7e663d |

### 2.3 Bundled native libraries (70 entries; usage class A = loaded by tools MIX-FPGA runs, B = referenced by other bundled programs, C = not referenced)

| Library group | Version | Licence(s) | Class | Linking | Source ids |
|---|---|---|---|---|---|
| macports-atk | 2.38.0 | LGPL-2.0-or-later | B | dynamic | macports-distfile-atk-2.38.0.tar.xz, macports-port-atk-dbdd9e59fb7d |
| macports-boost176 | 1.76.0 | BSL-1.0 | B | dynamic |  |
| macports-brotli | 1.1.0 | MIT | B | dynamic |  |
| macports-bzip2 | 1.0.8 | bzip2-1.0.6 | B | dynamic |  |
| macports-cairo | 1.17.6 | LGPL-2.1-only, MPL-1.1 | B | dynamic | macports-distfile-cairo-1.17.6.tar.xz, macports-port-cairo-bb144e56ff42 |
| macports-expat | 2.5.0 | MIT | B | dynamic |  |
| macports-fontconfig | 2.15.0 | LicenseRef-fontconfig | B | dynamic |  |
| macports-freetype | 2.13.2 | FTL, GPL-2.0-or-later | B | dynamic |  |
| macports-fribidi | 1.0.13 | LGPL-2.1-or-later | B | dynamic | macports-distfile-fribidi-1.0.13.tar.xz, macports-port-fribidi-515d438c57b9 |
| macports-gdbm | 1.23 | GPL-3.0-or-later | B | dynamic | macports-distfile-gdbm-1.23.tar.gz, macports-port-gdbm-c6951fd11cdb |
| macports-gdk-pixbuf2 | 2.42.10 | LGPL-2.1-or-later | B | dynamic | macports-distfile-gdk-pixbuf-2.42.10.tar.xz, macports-port-gdk-pixbuf2-d487547d1205 |
| macports-gettext-runtime | 0.21.1 | LGPL-2.1-or-later | B | dynamic | macports-distfile-gettext-0.21.1.tar.gz, macports-port-gettext-30239928d683 |
| macports-glib2 | 2.78.3 | LGPL-2.1-or-later | B | dynamic | macports-distfile-glib-2.78.3.tar.xz, macports-port-glib2-69c4cab16d1b |
| macports-gmp | 6.3.0 | LGPL-3.0-or-later, GPL-2.0-or-later | B | dynamic | macports-distfile-gmp-6.3.0.tar.bz2, macports-port-gmp-833eca2a8455 |
| macports-gobject-introspection | 1.78.1 | LGPL-2.0-or-later | B | dynamic | macports-distfile-gobject-introspection-1.78.1.tar.xz, macports-port-gobject-introspection |
| macports-graphite2 | 1.3.14 | LGPL-2.1-or-later | B | dynamic | macports-distfile-graphite2-1.3.14.tgz, macports-port-graphite2-967d1f217e27 |
| macports-gtk-osx-application-gtk3 | 3.0.1 | LGPL-2.1-only | B | dynamic | macports-distfile-gtk-mac-integration-3.0.1.tar.xz, macports-port-gtk-osx-application-4483 |
| macports-gtk3 | 3.24.38 | LGPL-2.0-or-later | B | dynamic | macports-distfile-gtk+-3.24.38.tar.xz, macports-port-gtk3-0c8486132d77 |
| macports-harfbuzz | 8.3.0 | MIT | B | dynamic |  |
| macports-hidapi | 0.12.0 | GPL-3.0-only, BSD-3-Clause, LicenseRef-HIDAPI | A | dynamic |  |
| macports-icu | 74.1 | Unicode-3.0 | B | dynamic |  |
| macports-lerc | 4.0.0 | Apache-2.0 | B | dynamic | macports-distfile-lerc-4.0.0.tar.gz, macports-port-lerc-943f85650255 |
| macports-libdeflate | 1.19 | MIT | B | dynamic |  |
| macports-libepoxy | 1.5.10 | MIT | B | dynamic |  |
| macports-libffi | 3.4.4 | MIT | A | dynamic |  |
| macports-libftdi1 | 1.5 | LGPL-2.0-only | A | dynamic | macports-distfile-libftdi1-1.5.tar.bz2, macports-port-libftdi-3bdf7f45e366 |
| macports-libiconv | 1.17 | LGPL-2.1-or-later | B | dynamic | macports-distfile-libiconv-1.17.tar.gz, macports-port-libiconv-4aac31a17a1d |
| macports-libjpeg-turbo | 2.1.5.1 | IJG, BSD-3-Clause, Zlib | B | dynamic |  |
| macports-libpixman | 0.42.2 | MIT | B | dynamic |  |
| macports-libpng | 1.6.40 | Libpng | B | dynamic |  |
| macports-libusb | 1.0.26 | LGPL-2.1-or-later | A | dynamic | macports-distfile-libusb-1.0.26.tar.gz, macports-port-libusb-6b3c05d3a37d |
| macports-ncurses | 6.4 | X11 | A | dynamic |  |
| macports-openssl3 | 3.2.0 | Apache-2.0 | B | dynamic |  |
| macports-ossp-uuid | 1.6.2 | LicenseRef-OSSP-uuid-MIT-style | B | dynamic |  |
| macports-pango | 1.50.14 | LGPL-2.0-or-later | B | dynamic | macports-distfile-pango-1.50.14.tar.xz, macports-port-pango-2dc9caa772eb |
| macports-pcre2 | 10.42 | BSD-3-Clause WITH PCRE2-exception | B | dynamic |  |
| macports-readline | 8.2.001 | GPL-3.0-or-later | A | dynamic | macports-distfile-readline82-001, macports-distfile-readline-8.2.tar.gz, macports-port-rea |
| macports-realpath | 1.0.2 | BSD-2-Clause | A | dynamic |  |
| macports-sqlite3 | 3.44.2 | blessing | B | dynamic |  |
| macports-tcl | 8.6.13 | TCL | A | dynamic |  |
| macports-tiff | 4.6.0 | libtiff | B | dynamic |  |
| macports-tk | 8.6.13 | TCL | B | dynamic |  |
| macports-xz | 5.4.5 | LicenseRef-public-domain | B | dynamic |  |
| macports-zlib | 1.3 | Zlib | A | dynamic |  |
| macports-zstd | 1.5.5 | BSD-3-Clause, GPL-2.0-only | B | dynamic |  |
| qt-5.15.3 | 5.15.3 | LGPL-3.0-only, GPL-2.0-only, GPL-3.0-only | B | dynamic | qt-5.15.3-qtactiveqt, qt-5.15.3-qtandroidextras, qt-5.15.3-qtbase, qt-5.15.3-qtcharts, qt- |
| qt-5.15.3-gpl3-only-modules | 5.15.3 | GPL-3.0-only | B | dynamic | qt-5.15.3-qtactiveqt, qt-5.15.3-qtandroidextras, qt-5.15.3-qtbase, qt-5.15.3-qtcharts, qt- |
| yosyshq-pygobject | 3.46.0 | LGPL-2.1-or-later | C | dynamic | pypi-pygobject-3.46.0, yosyshq-oss-cad-suite-build-2026-03-24 |
| yosyshq-pycairo | 1.25.1 | LGPL-2.1-only, MPL-1.1 | C | dynamic | pypi-pycairo-1.25.1 |
| yosyshq-cpython-3.11 | 3.11.6 | PSF-2.0 | B | dynamic |  |
| yosyshq-gnat-runtime | GCC/GNAT 14 | GPL-3.0-or-later WITH GCC-exception-3.1 | B | dynamic |  |
| yosyshq-tools | per tool | LicenseRef-per-tool | A | per tool |  |
| libusb | 1.0.30 | LGPL-2.1-or-later | B | dynamic | libusb-1.0.30, homebrew-core-libusb-formula-c1f707f5 |
| python-runtime | Python 3.14.7, OpenSSL 3 | PSF-2.0, Apache-2.0, BSD-3-Clause | A | dynamic |  |
| ox-libcxx | LLVM 16.0.6 | Apache-2.0 WITH LLVM-exception | A | dynamic |  |
| ox-boost | 1.81.0 | BSL-1.0 | A | dynamic |  |
| ox-antlr4-runtime | 4.9.3 | BSD-3-Clause | A | dynamic |  |
| ox-apple-libiconv | 99 (Apple libiconv; repo | BSD-2-Clause, BSD-3-Clause | A | dynamic | nixpkgs-574d1eac-recipes |
| ox-python-3.12 | 3.12.5 | PSF-2.0 | A | dynamic |  |
| ox-bzip2 | 1.0.8 | bzip2-1.0.6 | A | dynamic |  |
| ox-libffi | 3.4.6 | MIT | A | dynamic |  |
| ox-xz | 5.6.2 | 0BSD | A | dynamic |  |
| ox-zlib | 1.3.1 | Zlib | A | dynamic |  |
| ox-zstd | 1.5.6 | BSD-3-Clause, GPL-2.0-only | A | dynamic |  |
| ox-fasm | 0.0.2.r98.g9a73d70 (open | Apache-2.0 | A | dynamic |  |
| ox-pyyaml | 6.0.1 | MIT | A | dynamic |  |
| ox-simplejson | 3.19.2 | MIT, AFL-2.1 | A | dynamic |  |
| ox-eigen-compiled-in | 3.4.0 (+ upstream commit | MPL-2.0 | A | compiled in: header-only C++ templates i | eigen-3.4.0, eigen-commit-d0e3791b, nixpkgs-574d1eac-recipes |
| ox-not-shipped | readline 8.2p10, gdbm 1. | GPL-3.0-or-later, MIT, Apache-2.0, blessing, LGPL-2.1-or-later | C | referenced by shipped CPython extension  |  |
| eigen-build-environment | 3.4.0 | MPL-2.0 | B | header-only; may be compiled into the os | eigen-3.4.0, macports-port-eigen3-53dd381abb03 |

### 2.4 Python packages frozen into Apio (Python 3.14.7)

apio  (GPL-3.0-or-later); SCons 4.8.1 (MIT); attrs 26.1.0 (MIT); certifi 2026.07.22 (MPL-2.0); charset_normalizer 3.5.1 (MIT); click 8.2.1 (BSD-3-Clause); colorama 0.4.6 (BSD-3-Clause); configobj 5.0.9 (BSD-3-Clause); debugpy 1.8.19 (MIT); google.protobuf (protobuf) 6.33.5 (BSD-3-Clause); idna not recorded in the bundle (BSD-3-Clause); json5 0.15.0 (Apache-2.0); jsonschema 4.26.0 (MIT); jsonschema_specifications not recorded in the bundle (MIT); markdown_it (markdown-it-py) 4.2.0 (MIT); mdurl 0.1.2 (MIT); packaging 25.0 (Apache-2.0 OR BSD-2-Clause); pygments 2.21.0 (BSD-2-Clause); referencing not recorded in the bundle (MIT); requests 2.33.1 (Apache-2.0); rich 14.0.0 (MIT); rpds (rpds-py) not recorded in the bundle (MIT); serial (pyserial) 3.5 (BSD-3-Clause); setuptools not recorded in the bundle (MIT); urllib3 not recorded in the bundle (MIT); usb (pyusb) not recorded in the bundle (BSD-3-Clause); vcdvcd 2.6.0 ((Artistic-1.0-Perl OR GPL-1.0-or-later) AND MIT); wheel 0.46.2 (MIT).
