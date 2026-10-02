# NexysVHDL — Classroom Preview

VHDL-2008 design for the **Digilent Nexys A7-100T** in Visual Studio Code: create a project, check and simulate your VHDL, view waveforms and schematics, build a bitstream and program the board.

## Setup

1. Install this extension (Extensions → … → Install from VSIX…).
2. Click the **NexysVHDL** icon → **Install FPGA Toolchain…** → choose the `nexysvhdl-toolchain-…tar.gz` file from your classroom download. It is installed once for your user account and reused by NexysVHDL updates.
3. Windows only, for programming: if **Show Environment** says *Digilent USB/JTAG Support — Setup Required*, install the official Digilent Adept Runtime and Adept Utilities (see the installation guide).

You do not need to install GHDL, Apio, Yosys, nextpnr, Python or Vivado.

## Use

**NexysVHDL: Getting Started** walks you through: Create/Open Project → edit VHDL → edit the XDC → Check → Simulate → Waveform → RTL Schematic → Build → Program.

Pins are set in standard Xilinx **XDC** files, exactly as in Vivado.

## Documentation

- `docs/student-install-windows.md`, `docs/student-install-macos.md`
- `docs/student-quick-start.md`
- `THIRD_PARTY_NOTICES.md`, `CHANGELOG.md`

Supported: Windows x64, macOS Apple silicon (pending), VS Code 1.120+.
