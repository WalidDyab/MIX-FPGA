# Verify your setup

MIX-FPGA is one VS Code environment for two FPGA boards:

| Board | What MIX-FPGA installs for it |
|---|---|
| **Nexys A7-100T** | the VHDL tools, the FPGA build tools and the programmer (about 3 GB) |
| **DE10-Lite** | the VHDL tools, the programmer and a hidden FPGA engine; Altera's free Quartus Prime Lite, which you download from Altera, is installed into it (about 12 GB in total) |

You only install support for the boards you use, and you can add the other board later.

Run **Show Environment**. Under **Board Support** each board shows **Installed** or **Not installed**:

- **Install FPGA Toolchain** (first time): choose your boards; MIX-FPGA installs only what they need.
- **Install … Support** next to a board adds it later.
- **Verify Environment** checks everything that is installed.
- `Hardware — Not connected` is fine: you only need the board to program it.

If you used NexysVHDL before, your Nexys A7 projects and tools keep working: MIX-FPGA is its update.

You never need to install GHDL, Yosys, nextpnr, Python, Vivado or Linux tools yourself.
