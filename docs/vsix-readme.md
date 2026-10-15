# MIX-FPGA — Classroom Preview

One VS Code environment for VHDL-2008 FPGA design on two boards, the **Digilent Nexys A7-100T** and the **Terasic DE10-Lite**: create a project, check and simulate your VHDL, view waveforms and schematics, build and program the board. MIX-FPGA is the update of NexysVHDL: NexysVHDL projects and their Nexys A7 tools keep working.

MIX-FPGA is an EMXplore project. Copyright 2026 Walid Dyab.

## Setup

1. Install this extension (Extensions → … → Install from VSIX…).
2. Click the **MIX-FPGA** icon → **Show Environment** → **Install FPGA Toolchain**, and choose the boards you will use. Only their support is installed; you can add the other board later.
   - Nexys A7-100T: the course's Nexys A7 support file (or, after an update from NexysVHDL, nothing: the existing tools are reused).
   - DE10-Lite (macOS Apple silicon): MIX-FPGA installs its tools and a hidden FPGA engine, and asks for Altera's free Quartus Prime Lite download and your acceptance of Altera's licence.
3. Windows only, for programming the Nexys A7: if **Show Environment** says *Digilent USB/JTAG Support — Setup Required*, install the official Digilent Adept Runtime and Adept Utilities (see the installation guide).

You do not need to install GHDL, Apio, Yosys, nextpnr, Python, Vivado or any Linux tool.

## Use

**MIX-FPGA: Getting Started** walks you through: Create/Open Project → edit VHDL → constraints → Check → Simulate → Waveform → RTL Schematic → Build → Program.

Nexys A7 pins are standard Xilinx **XDC** files; DE10-Lite pins and clocks are Quartus **QSF** and **SDC** files.

## Documentation

- `docs/student-install-macos.md`, `docs/student-install-windows.md`
- `docs/student-quick-start.md`
- `LICENSE` (Apache-2.0, MIX-FPGA itself), `NOTICE`, `THIRD_PARTY_NOTICES.md` (the FPGA tools keep their own licenses), `CHANGELOG.md`

Supported: macOS Apple silicon (both boards), Windows x64, VS Code 1.120+.
