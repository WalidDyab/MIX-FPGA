# Third-party notices — NexysVHDL

NexysVHDL is distributed as two separately versioned parts. This file covers both.

**NexysVHDL's own code** (the extension: its compiled code, VHDL grammar, board data, templates, icons and documentation, and the NexysVHDL-authored files of the toolchain such as its manifest, pinned Apio configuration and notices) is licensed under the **Apache License, Version 2.0** (`LICENSE`, `NOTICE`). **Third-party software is not relicensed:** every component of the FPGA toolchain stays under its own license, as listed below (including the GNU GPL and LGPL). The Apache License does not apply to them.

## 1. The NexysVHDL extension (`.vsix`)

The extension contains only NexysVHDL's own compiled code and data (TypeScript compiled to JavaScript, the VHDL grammar, board data, icons, documentation). It bundles **no third-party code or npm runtime dependencies**. It runs inside Visual Studio Code, which is installed and licensed separately by Microsoft.

The NexysVHDL TextMate grammar for VHDL (`resources/vhdl/vhdl.tmLanguage.json`) was written for NexysVHDL and is not derived from a third-party grammar.

## 2. The NexysVHDL FPGA toolchain (`nexysvhdl-toolchain-<version>-<platform>.tar.gz`)

The toolchain redistributes, unmodified, the official release archives of open-source FPGA tools. Its complete notice — every component with version, license, license texts, project and source links, and the SHA-256 of the archive it was taken from — is `THIRD_PARTY_NOTICES.md` inside the installed toolchain folder (Windows: `%LOCALAPPDATA%\NexysVHDL\toolchains\win32-x64\<version>\`; macOS: `~/Library/NexysVHDL/toolchains/darwin-arm64/<version>/`). **NexysVHDL: Third-Party Notices** opens it.

Windows toolchain 1.0 (win32-x64), summary:

| Component | Version | License (as declared upstream) |
|---|---|---|
| GHDL (mcode, UCRT64 build) | 6.0.0 | GPL-2.0-or-later; GNAT/GCC runtime under GPL-3.0 with the GCC Runtime Library Exception; zlib |
| Apio (Windows bundle, with Python 3.14 and Python packages) | 1.6.0 | GPL-2.0; Python PSF-2.0; package licenses in the bundle |
| Apio definitions | 2026.09.17 | GPL-2.0 |
| Apio oss-cad-suite (Yosys 0.63+173 and the rest of the YosysHQ OSS CAD Suite, Python 3.11) | 2026.09.15 | Yosys ISC; per-tool licenses in `license/` (47 files, including GPL-licensed tools) |
| Apio openXC7 (nextpnr-xilinx 0eae9fb, Project X-Ray tools and database) | 2026.09.24 | nextpnr-xilinx ISC; Project X-Ray ISC; prjxray-db CC0-1.0; Python PSF-2.0 |
| openXC7 chip database xc7a100tcsg324 | 2026-09-24 | derived from prjxray-db (CC0-1.0) |
| Apio drivers (Zadig, libusb/libftdi tools; never run by NexysVHDL) | 2026.09.15 | Zadig GPL-3.0; libwdi LGPL-3.0; libusb/libftdi LGPL-2.1 / GPL-2.0 |
| Apio graphviz (not used by NexysVHDL) | 2026.09.15 | EPL (version to be confirmed) |
| Apio verible (not used by NexysVHDL) | 2026.09.20 | Apache-2.0 |

macOS toolchain 1.0 (darwin-arm64), summary:

| Component | Version | License (as declared upstream) |
|---|---|---|
| GHDL (LLVM JIT, macOS 15 aarch64 build) | 6.0.0 | GPL-2.0-or-later; GNAT/GCC runtime under GPL-3.0 with the GCC Runtime Library Exception; LLVM Apache-2.0 with LLVM exceptions |
| Apio (macOS bundle, with Python 3.14, OpenSSL, libusb, zstd and Python packages) | 1.7.0 | GPL-2.0; Python PSF-2.0; OpenSSL Apache-2.0; libusb LGPL-2.1; package licenses in the bundle |
| Apio definitions | 2026.09.17 | GPL-2.0 |
| Apio oss-cad-suite (Yosys 0.63+173, openFPGALoader 1.1.1 with libusb/libftdi/hidapi, Python 3.11, Qt 5 frameworks and the rest of the YosysHQ OSS CAD Suite) | 2026.09.15 | Yosys ISC; openFPGALoader Apache-2.0; per-tool licenses in `license/` (59 files, including GPL/LGPL-licensed tools and libraries); Qt LGPL-3.0 |
| Apio openXC7 (nextpnr-xilinx e860c9c8, Project X-Ray tools and database, Python 3.12) | 2026.09.25 | nextpnr-xilinx ISC; Project X-Ray ISC; prjxray-db CC0-1.0; Python PSF-2.0 |
| openXC7 chip database xc7a100t | 2026-09-25 | derived from prjxray-db (CC0-1.0) |
| Apio verible (not used by NexysVHDL) | 2026.09.20 | Apache-2.0 |

Source code for the GPL/LGPL components is available from the upstream projects at the exact versions listed in the toolchain's notice file.

## 3. Not included

**Digilent Adept Runtime, Adept Utilities (`djtgcfg`) and Digilent USB drivers** are proprietary Digilent software and are **not** included. On Windows, NexysVHDL uses the copy installed from Digilent's official installers; see `docs/student-install-windows.md`.

On macOS the board programmer (openFPGALoader) is included in the toolchain and no Digilent software or USB driver is needed.

Vivado and any other Xilinx/AMD software are not included and not used. Apple's Xcode and Command Line Tools are not included and not needed.
