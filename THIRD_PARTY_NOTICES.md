# Third-party notices — NexysVHDL

NexysVHDL is distributed as two separately versioned parts. This file covers both.

**NexysVHDL's own code** (the extension: its compiled code, VHDL grammar, board data, templates, icons and documentation, and the NexysVHDL-authored files of the toolchain such as its manifest, pinned Apio configuration, shims, placeholder notes and notices) is licensed under the **Apache License, Version 2.0** (`LICENSE`, `NOTICE`). Copyright 2026 Walid Dyab. NexysVHDL is an EMXplore project.

**Third-party software is not relicensed.** The NexysVHDL FPGA toolchain is an *aggregation* of separate third-party programs and data; every component stays under its own license, as listed below (including the GNU GPL and LGPL). The Apache License does not apply to them, and the toolchain as a whole is not "Apache-2.0".

## 1. The NexysVHDL extension (`.vsix`)

The extension contains only NexysVHDL's own compiled code and data (TypeScript compiled to JavaScript, the VHDL grammar, board data, icons, documentation). It bundles **no third-party code or npm runtime dependencies**. It runs inside Visual Studio Code, which is installed and licensed separately by Microsoft.

The NexysVHDL TextMate grammar for VHDL (`resources/vhdl/vhdl.tmLanguage.json`) was written for NexysVHDL and is not derived from a third-party grammar.

## 2. The NexysVHDL FPGA toolchain (`nexysvhdl-toolchain-<version>-<platform>.tar.gz`)

The toolchain redistributes, unmodified, the official release archives of open-source FPGA tools. NexysVHDL does not patch or rebuild them. Its complete notice — every component with version, license, license texts, project and source links, and the SHA-256 of the archive it was taken from — is `THIRD_PARTY_NOTICES.md` inside the installed toolchain folder (Windows: `%LOCALAPPDATA%\NexysVHDL\toolchains\win32-x64\<version>\`; macOS: the Nexys A7 support in `~/Library/MIX-FPGA/support/nexys-a7/toolchains/darwin-arm64/<version>/THIRD_PARTY_NOTICES.md` and the DE10-Lite support in `~/Library/MIX-FPGA/toolchains/<version>/macos-arm64/THIRD_PARTY_NOTICES.txt`). **NexysVHDL: Third-Party Notices** opens it.

The machine-readable inventory of Toolchain 1.0 (every component, the tools inside the oss-cad-suite package, the Python packages frozen into Apio, licenses as SPDX expressions, binary archives, pinned sources and open review items) is [`toolchains/compliance/toolchain-1.0.json`](toolchains/compliance/toolchain-1.0.json); the review is documented in [`docs/toolchain-1.0-redistribution.md`](docs/toolchain-1.0-redistribution.md).

Windows Toolchain 1.0 (win32-x64), summary:

| Component | Version | License (SPDX, as reviewed) | Source |
|---|---|---|---|
| GHDL (mcode, UCRT64 build) with its GNAT/GCC runtime | 6.0.0 | GPL-2.0-or-later; runtime GPL-3.0-or-later WITH GCC-exception-3.1; IEEE 2008 packages Apache-2.0; winpthreads MIT/BSD-3-Clause; zlib Zlib | ghdl/ghdl v6.0.0 (`e589c698…`), in the source package |
| Apio (Windows PyInstaller bundle: python.org Python 3.14.7 with OpenSSL 3.5.7, Python packages, Microsoft Visual C++ runtime 14.51 and Universal CRT 10.0.26100.1742) | 1.6.0 | Apio GPL-3.0-or-later; Python PSF-2.0; OpenSSL Apache-2.0; package licenses (MIT, BSD, Apache-2.0, MPL-2.0 certifi, Artistic-1.0-Perl OR GPL-1.0-or-later vcdvcd); Microsoft runtime: Microsoft Distributable Code (see below) | FPGAwars/apio `9fbb279c…`, certifi and vcdvcd sdists, in the source package |
| Apio definitions | 2026.09.17 | GPL-3.0 (license text without "or later") | FPGAwars/apio-definitions `2fd2c665…`, in the source package |
| Apio oss-cad-suite (Yosys 0.63+173 and the rest of the YosysHQ OSS CAD Suite, Python 3.11) | 2026.09.15 | Yosys ISC; per-tool licenses in `license/` (47 files; GPL/LGPL/EUPL tools: dfu-util, GTKWave, Icarus Verilog, libftdi, libpoly, libusb, OpenOCD, Surfer, Verilator, Yices); bundled Fedora 39 MinGW libraries and static GMP: see "Windows bundled libraries" | every GPL/LGPL/EUPL tool at its recorded revision, in the source package |
| Apio openXC7 (nextpnr-xilinx 0eae9fb, Project X-Ray tools and database, Python 3.11.9, MinGW runtime built by Nix, nixpkgs `574d1eac`) | 2026.09.24 | nextpnr-xilinx ISC; Project X-Ray ISC; prjxray-db CC0-1.0; Python PSF-2.0; libmcfgthread 1.6.1 LGPL-3.0-or-later; GCC 13.3.0 runtime GPL-3.0-or-later WITH GCC-exception-3.1; Eigen 3.4.0 MPL-2.0 (compiled in); other runtime libraries permissive | FPGAwars/tools-openxc7 `8a01b11b…`, mcfgthread v1.6-ga.1 and its nixpkgs recipe, Eigen 3.4.0, in the source package |
| openXC7 chip database xc7a100tcsg324 | 2026-09-24 | CC0-1.0 (derived from prjxray-db) | — |
| Apio verible (not used by NexysVHDL) | 2026.09.20 | Apache-2.0 | — |
| Apio drivers, Apio graphviz | — | **not included**: empty placeholder folders (Apio requires the folders; NexysVHDL never uses them) | — |

Windows bundled libraries (inside the oss-cad-suite, openXC7 and Apio packages; each one identified as an exact build). Per-library detail — files, origin, version, license, whether NexysVHDL loads it, source — is `nativeLibraryInventory["win32-x64"]` in the compliance manifest; license texts the payload does not carry are in `toolchains/compliance/licenses/win32-x64/` and in the source package.

| Libraries | Origin | License (SPDX) | Loaded by NexysVHDL's tools | Source |
|---|---|---|---|---|
| GNU readline 8.2, termcap 1.3.1 | Fedora 39 MinGW packages (YosysHQ build image) | GPL-3.0-or-later; GPL-2.0-or-later | yes (Yosys) | Fedora SRPMs, plus the Yosys and Icarus Verilog sources (programs linked with them) |
| gettext 0.22 (libintl; libgettext*, libtextstyle), win-iconv, Tcl 8.6.12, libffi, zlib, bzip2, xz, winpthreads, GCC 13.2.1 runtime | Fedora 39 MinGW | LGPL-2.1-or-later (libintl) / GPL-3.0-or-later; public domain; TCL; MIT; Zlib; bzip2; MIT AND BSD-3-Clause; GPL-3.0-or-later WITH GCC-exception-3.1 | yes (Yosys, Python) | Fedora SRPM for gettext; the others permissive or under the GCC exception (SRPMs pinned) |
| Qt 5.15.11 (qtbase), GTK 3, GLib, Pango, ATK, Cairo, gdk-pixbuf, fribidi, libusb 1.0.24, libftdi 1.4, libidn2, dbus, FreeType, hidapi | Fedora 39 MinGW | LGPL-3.0/GPL-2.0/GPL-3.0; LGPL-2.0/2.1-or-later; Cairo LGPL-2.1 or MPL-1.1; libftdi LGPL-2.0 + GPL-2.0 with exception; dual-licensed ones under either option | no | Fedora SRPMs (upstream sources, Fedora patches, spec) |
| Boost 1.78, ICU 73, OpenSSL 3.0.9, PostgreSQL client, SQLite, Tk, libpng, libjpeg-turbo, libtiff, curl, libssh2, expat, fontconfig, HarfBuzz, pixman, PCRE2, libepoxy, ANGLE | Fedora 39 MinGW | permissive | no | not required (SRPMs pinned by URL and SHA-256) |
| GMP 6.1.2 (static, inside bitwuzla, cvc4, cvc5, pono, Yices) | built in the YosysHQ image from Fedora's mingw-gmp SRPM | LGPL-3.0-or-later OR GPL-2.0-or-later | no | GMP SRPM, the build recipe and the source of every program it is linked into (relinking) |
| Python 3.11.6 (oss-cad-suite), libyices | YosysHQ builds | PSF-2.0; GPL-3.0-or-later | yes (Python for fasm2frames); no | build recipe; Yices source |
| mcfgthread 1.6.1, GCC 13.3.0 runtime, winpthreads 11.0.1, Python 3.11.9, OpenSSL 3.0.14, libffi, expat, xz, bzip2, SQLite, mpdecimal, zlib (openXC7) | Nix, nixpkgs `574d1eac` (pkgsCross.mingwW64) | LGPL-3.0-or-later; GPL-3.0-or-later WITH GCC-exception-3.1; permissive | yes (mcfgthread, GCC runtime, winpthreads, Python) | mcfgthread source and nixpkgs recipe; the rest not required |
| Microsoft Visual C++ runtime 14.51.36247.0, Universal CRT 10.0.26100.1742 (Apio) | python.org CPython 3.14.7; Windows SDK 10.0.26100 redistributables | Microsoft Distributable Code | yes (VC++ runtime); the UCRT copies are not loaded on Windows 10/11 | none (proprietary object code; no source obligation) |

**Microsoft runtime files.** `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`, `ucrtbase.dll` and the `api-ms-win-*.dll` files in `apio\bin\_internal` are Microsoft "Distributable Code", redistributed unmodified as part of the Apio program under Microsoft's Visual Studio and Windows SDK license terms (Third Party Distribution), as passed on by python.org's `LICENSE.txt` ("Additional Conditions for this Windows binary build"). They are © Microsoft Corporation; Microsoft's terms continue to protect them: they may not be modified, separated from the program they ship with to be distributed on their own, used on a non-Microsoft platform, or used with Microsoft's trademarks to name or endorse other software. The license texts are in `toolchains/compliance/licenses/win32-x64/apio-win-*` and in the source package.

macOS Toolchain 1.1 (darwin-arm64) is the Toolchain 1.0 content with the compliance changes listed in the notices of each archive (VHDL-87/93, VITAL and UPF libraries, openFPGALoader bridge bitstreams and three GHDL plug-in headers removed; GHDL library indexes regenerated; licence labels and texts corrected). It is delivered as two support archives, each with its own corresponding-source package (see "Source code"). Summary of the Nexys A7 support:

| Component | Version | License (SPDX, as reviewed) | Source |
|---|---|---|---|
| GHDL (LLVM JIT, macOS 15 aarch64 build) | 6.0.0 | GPL-2.0-or-later; GNAT/GCC runtime GPL-3.0-or-later WITH GCC-exception-3.1; LLVM Apache-2.0 WITH LLVM-exception | ghdl/ghdl v6.0.0, in the source package |
| Apio (macOS bundle, with Python 3.14.7, OpenSSL 3.5.7, zstd 1.5.7, libusb 1.0.30 and Python packages) | 1.7.0 | Apio GPL-3.0-or-later; Python PSF-2.0; OpenSSL Apache-2.0; zstd BSD-3-Clause; libusb LGPL-2.1-or-later; package licenses as on Windows | FPGAwars/apio `ccede3ec…`; libusb 1.0.30 release tarball and its Homebrew build formula; in the source package |
| Apio definitions | 2026.09.17 | GPL-3.0 (license text without "or later") | in the source package |
| Apio oss-cad-suite (Yosys 0.63+173, openFPGALoader 1.1.1, Python 3.11, the rest of the YosysHQ OSS CAD Suite, and the libraries below) | 2026.09.15 | Yosys ISC; openFPGALoader Apache-2.0; per-tool licenses in `license/` (59 files); Icarus Verilog GPL-2.0-or-later; Python 3.11.6 PSF-2.0; Graphviz EPL-1.0; bundled libraries: see below | each GPL/LGPL/EUPL/EPL tool at its recorded revision, YosysHQ's build recipe, and the sources of the bundled libraries below; in the source package |
| Apio openXC7 (nextpnr-xilinx e860c9c8, Project X-Ray tools and database, Python 3.12, Nix-built libraries) | 2026.09.25 | nextpnr-xilinx ISC; Project X-Ray ISC; prjxray-db CC0-1.0; Python PSF-2.0; bundled libraries permissive (see below); Eigen MPL-2.0 compiled into nextpnr-xilinx | FPGAwars/tools-openxc7 `22b6a11d…`, Eigen 3.4.0 and the nixpkgs recipes; in the source package |
| openXC7 chip database xc7a100t | 2026-09-25 | CC0-1.0 (derived from prjxray-db) | — |
| Apio verible (not used by NexysVHDL) | 2026.09.20 | Apache-2.0 | — |

macOS bundled libraries (inside the Apio, oss-cad-suite and openXC7 packages; each one identified by comparing its code with the exact build input). Per-library detail — files, origin, version, license, whether NexysVHDL loads it, source archives — is `nativeLibraryInventory` in the compliance manifest; license texts the toolchain folder does not carry are in `toolchains/compliance/licenses/darwin-arm64/` and in the source package:

| Libraries | Origin | License (SPDX) | Loaded by NexysVHDL's tools | Source |
|---|---|---|---|---|
| GNU readline 8.2 (patch 001) | MacPorts build in YosysHQ's macOS build environment | GPL-3.0-or-later; every program that loads it (`yosys`, `yosys-abc`, `yosys-filterlib`, Icarus Verilog `vvp`, `vhdlpp` and the `.vpi` modules, the Python 3.11 `readline` module) is distributed with it under GPL version 3 | yes (Yosys, and `yosys-abc` started by it; the others are present, not run) | readline-8.2 + patch 001, the MacPorts recipe, Yosys, Icarus Verilog (GPL-2.0-or-later, revision 6767a079) and CPython 3.11.6 (revision 8b6ee5ba) sources, in the source package |
| libusb 1.0.26, libftdi1 1.5, hidapi 0.12.0 | MacPorts | LGPL-2.1-or-later; LGPL-2.0 (library); hidapi under its BSD option | yes (openFPGALoader) | upstream archives and MacPorts recipes (hidapi: permissive option) |
| libffi, ncurses, Tcl 8.6.13, zlib 1.3, realpath | MacPorts | MIT, X11, TCL, Zlib, BSD-2-Clause | yes (Yosys, wrappers) | not required (permissive) |
| Qt 5.15.3 (58 frameworks, plugins) | Qt 5.15.3 open-source build in mmicko/macos-resources v3 | LGPL-3.0 / GPL-2.0 / GPL-3.0; Charts, Data Visualization, Quick 3D, Virtual Keyboard, Lottie, Network Authorization, WebGL plugin: GPL-3.0 only | no (GUI tools only) | official Qt 5.15.3 module sources and the documented build configuration |
| GTK 3, GLib, Pango, ATK, Cairo, gdk-pixbuf, GObject-Introspection, fribidi, graphite2, gettext libintl, GNU libiconv 1.17, GMP 6.3.0, gdbm 1.23, gtk-mac-integration, PyGObject 3.46.0, pycairo 1.25.1 | MacPorts / YosysHQ build | LGPL-2.0/2.1/3.0 (Cairo/pycairo LGPL-2.1 or MPL-1.1; GMP LGPL-3.0 or GPL-2.0); gdbm GPL-3.0-or-later | no | upstream archives and MacPorts recipes / PyPI sdists |
| Boost 1.76, ICU 74.1, OpenSSL 3.2.0, FreeType, HarfBuzz, fontconfig, libpng, libjpeg-turbo, libtiff, pixman, expat, brotli, bzip2, xz, zstd, pcre2, sqlite, Tk, lerc, libdeflate, libepoxy, OSSP uuid | MacPorts | permissive (BSL-1.0, Unicode-3.0, Apache-2.0, FTL, MIT, …) | no | not required (lerc included: MacPorts metadata says GPL-2+, upstream says Apache-2.0) |
| libusb 1.0.30 (Apio) | Homebrew bottle collected by PyInstaller | LGPL-2.1-or-later | no (Apio USB commands only) | libusb-1.0.30 release tarball and Homebrew formula |
| Python 3.14.7, OpenSSL 3.5.7, zstd 1.5.7 (Apio) | python.org macOS framework | PSF-2.0, Apache-2.0, BSD-3-Clause | yes | not required |
| libc++ 16.0.6, Boost 1.81.0, antlr4 4.9.3, Apple libiconv 99, Python 3.12.5, libffi, bzip2, xz, zlib, zstd, fasm, PyYAML, simplejson (openXC7) | Nix, nixpkgs `574d1eac` | Apache-2.0 WITH LLVM-exception, BSL-1.0, BSD, PSF-2.0, MIT, 0BSD, Zlib, Apache-2.0 (Apple libiconv is BSD, not LGPL) | yes | not required; Eigen 3.4.0 (MPL-2.0, compiled into nextpnr-xilinx) source included |

DE10-Lite support (macOS Toolchain 1.1): GHDL 6.0.0 (GPL-2.0-or-later with the GCC runtime exception, LLVM Apache-2.0 with exception), Yosys 0.63+173 (ISC) with GNU Readline 8.2 (GPL-3.0-or-later, distributed with Yosys under GPL version 3), openFPGALoader 1.1.1 (Apache-2.0) with libusb 1.0.26 (LGPL-2.1-or-later), libftdi1 1.5 (LGPL-2.0), HIDAPI, zlib and Zstandard, and Lima 2.2.1 (Apache-2.0, with its NOTICE file) with the Go modules compiled into it, among them github.com/hashicorp/hcl/v2 v2.24.0 (MPL-2.0, unmodified, source archive in the source package). The complete list, with licence texts, is the `THIRD_PARTY_NOTICES.txt` of that archive.

The Apio and Apio definitions labels that Toolchain 1.0 showed as GPL-2.0 are corrected in the Toolchain 1.1 notices (GPL-3.0-or-later and GPL-3.0-only).

### Source code

The source code of the macOS Toolchain 1.1 components whose licenses require it is delivered as **one corresponding-source package per support archive**: **`MIX-FPGA-Nexys-A7-Support-1.1-Sources.zip`** for `nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz` and **`MIX-FPGA-DE10-Lite-Support-1.1-Sources.zip`** for `mixfpga-de10-lite-support-1.1-macos-arm64.tar.gz`. Each is provided in the same place and at the same time as its binary archive (there is no written offer), pins every source by SHA-256 (`manifest.json`) and maps every shipped binary to its sources (`binary-to-source.json`). Redistribute each package with its archive, unchanged. The source code of the Windows Toolchain 1.0 components is published as **`NexysVHDL-Toolchain-1.0-Sources.zip`**, built reproducibly by `npm run compliance:assemble` from the pinned revisions in `toolchains/compliance/toolchain-1.0.json` (archive hashes in `toolchains/compliance/sources-1.0.lock.json`). It is published next to each NexysVHDL release that includes the toolchain. Anyone who redistributes the toolchain should redistribute that package with it.

**Status:** the technical review of macOS Toolchain 1.1 is complete (`docs/phase5e-compliance-conclusions.md`); the license review of Windows Toolchain 1.0 has no open blocking item (see `docs/toolchain-1.0-redistribution.md`): every redistributed program and library is identified as an exact build, every license is identified from its text, and the source of every component whose license requires it is in the source package, which `npm run compliance:assemble` builds reproducibly. This is an engineering record, not a legal opinion.

## 3. Not included

**Digilent Adept Runtime, Adept Utilities (`djtgcfg`) and Digilent USB drivers** are proprietary Digilent software and are **not** included, mirrored or downloaded by NexysVHDL. On Windows, NexysVHDL uses the copy installed from Digilent's official installers; see `docs/student-install-windows.md`.

The Windows toolchain does not include the Apio *drivers* package (Zadig, libusb/libftdi tools and PJRC's `serial_install.exe`) or the Apio *graphviz* package: NexysVHDL never runs them, and they are replaced by empty placeholder folders.

On macOS the board programmer (openFPGALoader) is included in the toolchain and no Digilent software or USB driver is needed.

Vivado and any other Xilinx/AMD software are not included and not used. Apple's Xcode and Command Line Tools are not included and not needed.
