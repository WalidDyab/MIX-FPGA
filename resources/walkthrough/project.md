# Create or open a project

**Create NexysVHDL Project** asks for a parent folder and a name, then creates:

```
MyProject/
├── nexysvhdl.json        project settings (board, top entity, testbench)
├── src/top.vhd           your design (VHDL-2008)
├── sim/top_tb.vhd        a self-checking testbench
└── constraints/nexys-a7-100t.xdc   pins and clock (standard Xilinx XDC)
```

**Open NexysVHDL Project** opens any folder that contains `nexysvhdl.json`, for example a project from your course.

NexysVHDL writes generated files only into the hidden `.nexysvhdl/` folder. Your `src/`, `sim/` and `constraints/` stay yours.
