# NexysVHDL quick start

From an empty folder to a blinking LED on the Nexys A7-100T. First install NexysVHDL and its FPGA toolchain ([Windows](student-install-windows.md), [macOS](student-install-macos.md)). **NexysVHDL: Getting Started** in VS Code walks through the same steps.

## 1. Create a project

**NexysVHDL: Create NexysVHDL Project** → choose a parent folder → name it (letters, digits, `_`, `-`; e.g. `BlinkDemo`) → board **Nexys A7-100T** → open it.

```
BlinkDemo/
├── nexysvhdl.json                 board, top entity, testbench, constraints file
├── src/top.vhd                    the design: LED0 blinks while SW0 is on; BTNC restarts
├── sim/top_tb.vhd                 self-checking testbench
└── constraints/nexys-a7-100t.xdc  pins and the 100 MHz clock (Xilinx XDC)
```

To work on a course project instead, use **Open NexysVHDL Project** on its folder (it must contain `nexysvhdl.json`).

**Adding files.** Click **+ Add File** at the top of the **Design** view. Choose *Source* (a `.vhd` design file → `src/`), *Simulation Testbench* (a `.vhd` file → `sim/`) or *Constraint* (an `.xdc` file → `constraints/`), then *Create New* (a VHDL-2008 skeleton) or *Copy From Computer* (a copy is placed inside the project, so the project folder stays complete and portable). If the name already exists you choose *Replace* or *Rename*. Only `.vhd` and `.xdc` files are accepted here; rename a `.vhdl` file to `.vhd` first.

## 2. The NexysVHDL sidebar

| View | Shows |
|---|---|
| Project | board, VHDL standard, top entity, constraints, testbench, environment |
| Design | **Files** (your files by role: `TOP`, `TESTBENCH`, `IN USE`, with **+ Add File**) and **Hierarchy** (which entity instantiates which); switch modes with the buttons in the view's title bar |
| Workflow | Check, Simulate, Build (Synthesis → Implementation → Bitstream), Program |
| Hardware | the connected board |
| Results | timing, resources, bitstream, logs |

## 3. Check → Simulate → Waveform

- **Check** analyzes all VHDL. Mistakes appear in **Problems**; it also runs when you save.
- **Simulate** runs `sim/top_tb.vhd`; it should end with `ALL TESTS PASSED`.
- **Open Waveform** shows the signals; click to read values at a time.
- **Display As**: next to every bus in the waveform, choose *Binary*, *Hex*, *Unsigned Decimal* or *Signed Decimal*. A `std_logic_vector` is only read as signed if you choose *Signed Decimal*. Signals with undefined bits (`U`, `X`, `Z`, `W`, `L`, `H`, `-`) show that letter instead of a number. The choices are remembered for the project.
- A testbench with a free-running clock must end itself with `std.env.stop;` (testbenches made by *+ Add File* do). If it does not, click **Simulation length** in the Project view and choose a fixed stop time such as `1us`.

## 4. Look at the hardware

- **Open Design Schematic**: the blocks (entity instances) and how their ports are wired.
- **Open RTL Schematic**: the logic your VHDL infers — the counter register, the adder, the reset multiplexer and the AND gate driving `led0`.

## 5. Pins: standard XDC, as in Vivado

NexysVHDL uses ordinary **Xilinx XDC** files. You edit them as text, exactly as in Vivado; there is no graphical pin editor.

```tcl
## Clock: 100 MHz on pin E3
set_property -dict { PACKAGE_PIN E3  IOSTANDARD LVCMOS33 } [get_ports { clk }]
create_clock -period 10.00 [get_ports { clk }]

## LED0 on pin H17
set_property -dict { PACKAGE_PIN H17 IOSTANDARD LVCMOS33 } [get_ports { led0 }]
```

Rules:

1. Every **port of the top-level entity** needs a `PACKAGE_PIN` line whose `get_ports` name is spelled exactly like the VHDL port (`led0` in VHDL ↔ `led0` in XDC).
2. Reuse what you have: lines from your course XDC, or from Digilent's *Nexys A7-100T master XDC* — uncomment the pins you use and rename the ports to match your entity.
3. Vector ports use one line per bit: `[get_ports { led[0] }]`, `[get_ports { led[1] }]`, …
4. Keep `create_clock` for the clock input; Build reports timing against it.
5. Several `.xdc` files may live in `constraints/`; the one marked **IN USE** is used (right-click → *Use This Constraints File*).

If a port has no pin, **Build** stops before implementation and Problems shows which port.

## 6. Build

**Build** runs Synthesis → Implementation → Bitstream (about 15–30 s for small designs). **Results** shows *Timing PASS/FAIL* at your clock, LUTs, flip-flops, BRAM, DSP and I/O use, and the bitstream.

## 7. Program the board

1. USB cable in the Nexys A7 **PROG/UART** port; power switch **ON**.
2. **Hardware → Detect Boards** shows `Nexys A7-100T` and its serial number.
3. **Program FPGA**. With the starter design: switch **SW0** on → **LED0** blinks; hold **BTNC** → the LED stops; release → it blinks again.

The FPGA forgets the design when the board is switched off (SRAM programming).

## Optional appearance

NexysVHDL offers an optional navy-and-orange color theme the first time you open a project. It applies to that project folder only and never changes your VS Code theme elsewhere. Switch any time with **NexysVHDL: Use NexysVHDL Classroom Appearance** and **NexysVHDL: Use My VS Code Appearance**.

## What NexysVHDL does not do (Classroom Preview)

One board (Nexys A7-100T), VHDL (VHDL-2008) only, no Verilog/SystemVerilog, no graphical pin assignment, no flash programming.
