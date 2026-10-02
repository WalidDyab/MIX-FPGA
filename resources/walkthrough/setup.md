# Verify your setup

NexysVHDL has two parts:

| Part | What it is | When you install it |
|---|---|---|
| **NexysVHDL extension** | the VS Code views, commands and editors | from the `.vsix` file, and again for each NexysVHDL update |
| **NexysVHDL FPGA toolchain** | the VHDL simulator and FPGA build tools, private to NexysVHDL | **once** (about 3 GB on disk); updates of the extension reuse it |

Run **Show Environment**. You should see:

- `Bundled FPGA Toolchain — Ready`
- on Windows only: `Digilent USB/JTAG Support — Ready` (needed only to **program** the board)
- `Board — Not Connected` is fine: you only need the board to program it.

If the toolchain is *Not Installed*, click **Install FPGA Toolchain…** and choose the `nexysvhdl-toolchain-…` file from the classroom download.

You never need to install GHDL, Apio, Yosys, nextpnr, Python or Vivado for NexysVHDL.
