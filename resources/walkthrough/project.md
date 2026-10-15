# Create or open a project

**New Project** asks for a parent folder, a name and the board (Nexys A7-100T or DE10-Lite), then creates, for example for the Nexys A7:

```
MyProject/
├── nexysvhdl.json        project settings (board, top entity, testbench)
├── src/top.vhd           your design (VHDL-2008)
├── sim/top_tb.vhd        a self-checking testbench
└── constraints/nexys-a7-100t.xdc   pins and clock (standard Xilinx XDC)
```

**Open Project** opens any folder that contains `nexysvhdl.json`, or its `.nvproj` project file, for example a project from your course. A DE10-Lite project has `constraints/de10-lite.qsf` and `.sdc` instead of the `.xdc`.

If you choose a board whose support is not installed yet, MIX-FPGA offers to install it first.

MIX-FPGA writes generated files only into hidden folders (`.nexysvhdl/`, and `.mix-fpga/` for the DE10-Lite). Your `src/`, `sim/` and `constraints/` stay yours.
