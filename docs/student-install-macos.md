# Installing MIX-FPGA on macOS

MIX-FPGA — **Classroom Preview** — one VS Code environment for the **Digilent Nexys A7-100T** and the **Terasic DE10-Lite**.
Supported: **macOS on Apple silicon (M1 or newer)**. Intel Macs are not supported.
MIX-FPGA is an EMXplore project. Copyright 2026 Walid Dyab.

You install the support only for the boards you use; you can add the other board at any time. Everything the boards need (VHDL simulator, FPGA build tools, board programmer, and for the DE10-Lite a hidden FPGA engine) is installed and managed by MIX-FPGA. **Do not install Homebrew, Python, Xcode Command Line Tools, GHDL, Apio, Yosys, nextpnr, openXC7, openFPGALoader, Vivado, Linux tools or Digilent software for MIX-FPGA**; if you already have any of them, MIX-FPGA ignores them and never changes them.

## 1. Visual Studio Code

Install VS Code from <https://code.visualstudio.com/> (the *Apple silicon* or *Universal* download) and move it to **Applications**. The version must be 1.120 or newer (**Code → About Visual Studio Code**).

## 2. MIX-FPGA

In VS Code open the Extensions view (⇧⌘X), click **…** → **Install from VSIX…**, and choose the `nexysvhdl-<version>-darwin-arm64.vsix` file from your course (the file name keeps its earlier name so that NexysVHDL installations update to MIX-FPGA).

**Already using NexysVHDL?** Installing MIX-FPGA updates it. Your projects open as before, nothing in them is rewritten, and your Nexys A7 tools keep working without a new download. **Show Environment** shows *Nexys A7-100T — Installed*; you can add the DE10-Lite whenever you like.

## 3. Board support

Click the **MIX-FPGA** icon and run **Show Environment**, then **Install FPGA Toolchain**, and tick the boards you will use:

| Board | What happens | Disk space |
|---|---|---|
| **Nexys A7-100T** | choose the Nexys A7 support file from your course (`nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz`); every file is checked | about 2.8 GB |
| **DE10-Lite** | MIX-FPGA installs its tools and prepares its FPGA engine (internet needed once). If Apple's **Rosetta** is missing, Apple's own installer opens and asks you to agree to Apple's licence. Then MIX-FPGA asks for two free files from Altera — `QuartusLiteSetup-25.1std.0.1129-linux.run` and `max10-25.1std.0.1129.qdz` (Quartus Prime Lite 25.1, Linux) — shows Altera's licence from the installer itself, and installs Quartus only after you tick *I have reviewed and accept the Altera Quartus Prime Software License Agreement.* | about 12 GB once finished (the engine's disk can grow to at most 60 GB; it is not reserved) |

Later, **Install … Support** next to a board adds it; **Verify Environment** checks everything; **Repair** continues an interrupted setup or puts back anything that changed.

When you create a project for a board whose support is not installed, MIX-FPGA offers to install it first.

## 4. Programming the board

macOS needs **no driver**: the board programmer included in MIX-FPGA talks to both boards over USB. Connect the board (Nexys A7: the **PROG/UART** port; DE10-Lite: the **USB-Blaster** port), switch it **ON**, click **Refresh** in the Hardware view, then **Program FPGA**. Programming is temporary (it lasts until the board is switched off).

## If something is wrong

| Message | What to do |
|---|---|
| *… support is not installed* | **Show Environment** → **Install … Support**. |
| *The file you chose is not the one Setup needs* | Download that file again (from your course, or from Altera for the two Quartus files). |
| *Setup needs an internet connection* | Connect, then **Repair**: it continues where it stopped. |
| *There is not enough free space* | Free some space (see the table above), then **Repair**. |
| *The licence could not be shown, so nothing was installed* | Download the Quartus installer again from Altera. |
| *GHDL cannot use the file name …* | Rename that VHDL file using only English letters, digits, `_` and `-`. |
| *No board detected* | Check the USB port and cable (some cables only charge) and that the board is switched **ON**. |

If macOS asks whether Visual Studio Code may access your Documents, Desktop or Downloads folder, click **Allow**: MIX-FPGA needs to read your project and the files you choose.
