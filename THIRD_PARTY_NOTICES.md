# Third-party notices — NexysVHDL

NexysVHDL is distributed as two separately versioned parts. This file covers both.

**NexysVHDL's own code** (the extension: its compiled code, VHDL grammar, board data, templates, icons and documentation, and the NexysVHDL-authored files of the toolchain such as its manifest, pinned Apio configuration, shims, placeholder notes and notices) is licensed under the **Apache License, Version 2.0** (`LICENSE`, `NOTICE`). Copyright 2026 Walid Dyab. NexysVHDL is an EMXplore project.

**Third-party software is not relicensed.** The NexysVHDL FPGA toolchain is an *aggregation* of separate third-party programs and data; every component stays under its own license, as listed below (including the GNU GPL and LGPL). The Apache License does not apply to them, and the toolchain as a whole is not "Apache-2.0".

## 1. The NexysVHDL extension (`.vsix`)

The extension contains only NexysVHDL's own compiled code and data (TypeScript compiled to JavaScript, the VHDL grammar, board data, icons, documentation). It bundles **no third-party code or npm runtime dependencies**. It runs inside Visual Studio Code, which is installed and licensed separately by Microsoft.

The NexysVHDL TextMate grammar for VHDL (`resources/vhdl/vhdl.tmLanguage.json`) was written for NexysVHDL and is not derived from a third-party grammar.

## 2. The NexysVHDL FPGA toolchain (`nexysvhdl-toolchain-<version>-<platform>.tar.gz`)

The toolchain redistributes, unmodified, the official release archives of open-source FPGA tools. NexysVHDL does not patch or rebuild them. Its complete notice — every component with version, license, license texts, project and source links, and the SHA-256 of the archive it was taken from — is `THIRD_PARTY_NOTICES.md` inside the installed toolchain folder (Windows: `%LOCALAPPDATA%\NexysVHDL\toolchains\win32-x64\<version>\`; macOS: `~/Library/NexysVHDL/toolchains/darwin-arm64/<version>/`). **NexysVHDL: Third-Party Notices** opens it.

The machine-readable inventory of Toolchain 1.0 (every component, the tools inside the oss-cad-suite package, the Python packages frozen into Apio, licenses as SPDX expressions, binary archives, pinned sources and open review items) is [`toolchains/compliance/toolchain-1.0.json`](toolchains/compliance/toolchain-1.0.json); the review is documented in [`docs/toolchain-1.0-redistribution.md`](docs/toolchain-1.0-redistribution.md).

Windows Toolchain 1.0 (win32-x64), summary:

| Component | Version | License (SPDX, as reviewed) | Source |
|---|---|---|---|
| GHDL (mcode, UCRT64 build) with its GNAT/GCC runtime | 6.0.0 | GPL-2.0-or-later; runtime GPL-3.0-or-later WITH GCC-exception-3.1; IEEE 2008 packages Apache-2.0; winpthreads MIT/BSD-3-Clause; zlib Zlib | ghdl/ghdl v6.0.0 (`e589c698…`), in the source package |
| Apio (Windows PyInstaller bundle: Python 3.14, OpenSSL 3, Python packages, Microsoft VC++/UCRT runtime) | 1.6.0 | Apio GPL-3.0-or-later; Python PSF-2.0; package licenses (MIT, BSD, Apache-2.0, MPL-2.0 certifi, Artistic-1.0-Perl OR GPL-1.0-or-later vcdvcd) | FPGAwars/apio `9fbb279c…`, certifi and vcdvcd sdists, in the source package |
| Apio definitions | 2026.09.17 | GPL-3.0 (license text without "or later") | FPGAwars/apio-definitions `2fd2c665…`, in the source package |
| Apio oss-cad-suite (Yosys 0.63+173 and the rest of the YosysHQ OSS CAD Suite, Python 3.11) | 2026.09.15 | Yosys ISC; per-tool licenses in `license/` (47 files; GPL/LGPL/EUPL tools: dfu-util, GTKWave, Icarus Verilog, libftdi, libpoly, libusb, OpenOCD, Surfer, Verilator, Yices); bundled third-party DLLs under review | every GPL/LGPL/EUPL tool at its recorded revision, in the source package |
| Apio openXC7 (nextpnr-xilinx 0eae9fb, Project X-Ray tools and database, Python 3.11, MSYS2 runtime) | 2026.09.24 | nextpnr-xilinx ISC; Project X-Ray ISC; prjxray-db CC0-1.0; Python PSF-2.0; libmcfgthread LGPL-3.0-or-later; GCC runtime with exception | FPGAwars/tools-openxc7 `8a01b11b…`, mcfgthread v1.6-ga.1, in the source package |
| openXC7 chip database xc7a100tcsg324 | 2026-09-24 | CC0-1.0 (derived from prjxray-db) | — |
| Apio verible (not used by NexysVHDL) | 2026.09.20 | Apache-2.0 | — |
| Apio drivers, Apio graphviz | — | **not included**: empty placeholder folders (Apio requires the folders; NexysVHDL never uses them) | — |

macOS Toolchain 1.0 (darwin-arm64), summary:

| Component | Version | License (SPDX, as reviewed) | Source |
|---|---|---|---|
| GHDL (LLVM JIT, macOS 15 aarch64 build) | 6.0.0 | GPL-2.0-or-later; GNAT/GCC runtime GPL-3.0-or-later WITH GCC-exception-3.1; LLVM Apache-2.0 WITH LLVM-exception | ghdl/ghdl v6.0.0, in the source package |
| Apio (macOS bundle, with Python 3.14.7, OpenSSL 3.5.7, libusb, zstd and Python packages) | 1.7.0 | Apio GPL-3.0-or-later; Python PSF-2.0; OpenSSL Apache-2.0; libusb LGPL-2.1-or-later; package licenses as on Windows | FPGAwars/apio `ccede3ec…`, in the source package |
| Apio definitions | 2026.09.17 | GPL-3.0 (license text without "or later") | in the source package |
| Apio oss-cad-suite (Yosys 0.63+173, openFPGALoader 1.1.1 with libusb/libftdi/hidapi, Python 3.11, Qt 5 frameworks and the rest of the YosysHQ OSS CAD Suite) | 2026.09.15 | Yosys ISC; openFPGALoader Apache-2.0; per-tool licenses in `license/` (58 files, including GPL/LGPL/EPL/EUPL tools); Qt 5 LGPL-3.0; bundled third-party libraries under review | every GPL/LGPL/EPL/EUPL tool at its recorded revision, in the source package |
| Apio openXC7 (nextpnr-xilinx e860c9c8, Project X-Ray tools and database, Python 3.12) | 2026.09.25 | nextpnr-xilinx ISC; Project X-Ray ISC; prjxray-db CC0-1.0; Python PSF-2.0; bundled libraries (libiconv LGPL) under review | FPGAwars/tools-openxc7 `22b6a11d…`, in the source package |
| openXC7 chip database xc7a100t | 2026-09-25 | CC0-1.0 (derived from prjxray-db) | — |
| Apio verible (not used by NexysVHDL) | 2026.09.20 | Apache-2.0 | — |

The macOS toolchain's own notice file still shows the earlier "GPL-2.0" label for Apio and the Apio definitions; the corrected identification is the one above (the validated macOS payload is not rebuilt for a label; see `docs/toolchain-1.0-redistribution.md`, "macOS follow-ups").

### Source code

The source code of the toolchain components whose licenses require it is published as **`NexysVHDL-Toolchain-1.0-Sources.zip`**, built reproducibly by `npm run compliance:assemble` from the pinned revisions in `toolchains/compliance/toolchain-1.0.json` (archive hashes in `toolchains/compliance/sources-1.0.lock.json`). It is published next to each NexysVHDL release that includes the toolchain. Anyone who redistributes the toolchain should redistribute that package with it.

**Status:** the license review of Toolchain 1.0 still has open items (third-party libraries bundled inside upstream packages whose exact source builds are not recorded upstream); until they are closed, the source package is a draft and Toolchain 1.0 is not cleared for redistribution by third parties. See `docs/toolchain-1.0-redistribution.md`.

## 3. Not included

**Digilent Adept Runtime, Adept Utilities (`djtgcfg`) and Digilent USB drivers** are proprietary Digilent software and are **not** included, mirrored or downloaded by NexysVHDL. On Windows, NexysVHDL uses the copy installed from Digilent's official installers; see `docs/student-install-windows.md`.

The Windows toolchain does not include the Apio *drivers* package (Zadig, libusb/libftdi tools and PJRC's `serial_install.exe`) or the Apio *graphviz* package: NexysVHDL never runs them, and they are replaced by empty placeholder folders.

On macOS the board programmer (openFPGALoader) is included in the toolchain and no Digilent software or USB driver is needed.

Vivado and any other Xilinx/AMD software are not included and not used. Apple's Xcode and Command Line Tools are not included and not needed.
