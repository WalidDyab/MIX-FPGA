# Changelog

## 0.5.0 — Classroom Preview (requires NexysVHDL toolchain 1.0)

First installable NexysVHDL package. Not published on the Visual Studio Marketplace; distributed to classes as a download.

**Board and language**
- Digilent Nexys A7-100T (XC7A100T-1CSG324C) only.
- VHDL, VHDL-2008. NexysVHDL's own VHDL syntax highlighting, comments, brackets and indentation.

**Projects**
- Create / Open NexysVHDL Project; starter project (blinking LED, self-checking testbench, XDC).
- Project Files, Design Hierarchy (refreshes on save), Set Top Entity, Set Testbench.
- Pins and clocks in standard Xilinx **XDC** files, edited as text exactly as in Vivado; ports without a pin are reported before implementation.

**Workflow**
- Check (VHDL analysis/elaboration) with errors in Problems; optional check on save.
- Simulate (self-checking testbenches) and the VCD **Waveform Viewer**.
- **Design Schematic** (structure) and **RTL Schematic** (inferred registers, multiplexers, arithmetic, logic).
- Build: **Synthesis → Implementation → Bitstream**, with timing (PASS/FAIL per clock, achieved MHz, worst slack) and resource use (LUT, FF, BRAM, DSP, I/O) in Results.
- Hardware view (board detection) and Program FPGA (SRAM). Programming backends: Digilent Adept `djtgcfg` on Windows (requires the official Digilent support), openFPGALoader on macOS. Programming through this packaged extension is pending validation on a physical board.

**Classroom setup**
- The FPGA toolchain is a **separate, versioned artifact** (toolchain 1.0): installed once per user with *Install FPGA Toolchain…*, verified file by file against the validated content, and reused by later NexysVHDL updates. Toolchain versions install side by side and are never modified.
- NexysVHDL uses **only** its own toolchain: it never uses or changes GHDL, Apio, Yosys, nextpnr, openXC7 or Python installed elsewhere, never uses `~/.apio`, and never updates tools by itself.
- Show Environment (setup overview), Getting Started walkthrough, welcome actions when no project is open, Verify FPGA Toolchain, Third-Party Notices.
- Windows and macOS project folders, Windows user names and macOS home folders with spaces or non-English letters (e.g. "José García", "王小明") work for the complete workflow.
- Results show device capacities from the data sheet (Nexys A7-100T: 63,400 LUTs, 126,800 flip-flops, 135 block RAMs, 240 DSPs, 210 user I/O).

**License**
- NexysVHDL is licensed under the Apache License 2.0 (`LICENSE`, `NOTICE`). The FPGA toolchain's third-party components keep their own licenses (`THIRD_PARTY_NOTICES.md`).

**Supported systems**
- Windows 10/11 x64 (validated).
- macOS on Apple silicon (validated; no Homebrew, Xcode Command Line Tools or USB driver needed).
- VS Code 1.120 or newer.
