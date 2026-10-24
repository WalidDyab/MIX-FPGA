# Installing MIX-FPGA on Windows

MIX-FPGA — **Classroom Preview** (an EMXplore project) — for the Digilent **Nexys A7-100T** and the Terasic **DE10-Lite**.
Supported: **Windows 10/11, 64-bit Intel/AMD (x64)**, not Windows on ARM. Visual Studio Code **1.120 or newer**.

Two ways to install; both give the same result:

* **The installer** (`MIX-FPGA-<version>-Windows-x64-Setup.exe`): detects Visual Studio Code and any NexysVHDL you already have, installs the extension, and installs the board support you choose.
* **By hand** (the *Fresh* or *Upgrade* ZIP): the same files and a step-by-step guide inside the ZIP (`INSTALL-FRESH-Windows.md` or `INSTALL-UPGRADE-from-NexysVHDL.md`).

You choose **Nexys A7**, **DE10-Lite** or **both**; only what the boards you chose need is installed.

## What you need

| What | For | Where from |
|---|---|---|
| Visual Studio Code 1.120+ | the editor MIX-FPGA runs in | <https://code.visualstudio.com> (the *User Installer* is fine) |
| The MIX-FPGA files from your course | the extension and the board support | your instructor |
| Nexys A7 only, to program the board: **Digilent Adept Runtime 2.30+ and Adept Utilities** | programming over USB (nothing else needs them) | Digilent's free download: <https://digilent.com/reference/software/adept/start> |
| DE10-Lite only: **Altera Quartus Prime Lite 25.1std (Build 1129)** and the **MAX 10 device package** | building and programming the DE10-Lite | Altera's free download; MIX-FPGA asks for the two files and installs them (see below) |

Free disk space: about **3 GB** for the Nexys A7 support, **0.2 GB** plus about **13 GB** (while installing; about 9 GB afterwards) for the DE10-Lite. **Do not install GHDL, Apio, Yosys, nextpnr, openXC7 or Python for MIX-FPGA**: it brings its own and ignores any you have.

## 1. Visual Studio Code

Install it from the link above. If you already have it, check **Help → About**: the version must be 1.120 or newer.

## 2. MIX-FPGA with the installer (recommended)

1. Keep the whole MIX-FPGA folder together: `Setup.exe` finds its files (the extension and the support archives) **next to itself** and refuses anything that is not exactly the file of this release.
2. Double-click `MIX-FPGA-<version>-Windows-x64-Setup.exe`. Windows may show a blue **"Windows protected your PC"** window because this classroom release is **not signed**: choose **More info**, check that the name is `MIX-FPGA-…-Setup.exe` and that the file came from your instructor, then choose **Run anyway**. Do not turn Windows security off; nothing in MIX-FPGA asks you to.
3. The installer tells you what it found: **Fresh install**, **Upgrade from NexysVHDL** or **Repair/Reinstall**. Choose **Nexys A7-100T**, **DE10-Lite** or **Both boards** and press **Install**. It checks every file first (nothing is changed if one is damaged), installs the extension **over** any NexysVHDL (no uninstall first), then installs the board support. Keep the window open until it says the work is done.
4. Press **Open MIX-FPGA Setup**, or open Visual Studio Code, click the **MIX-FPGA** icon and choose **Show Environment**.

If you already use **NexysVHDL 0.6.0**: your projects, `.nvproj` and `nexysvhdl.json` files and settings are not touched, nothing is uninstalled, and the old **Toolchain 1.0** stays where it is (`%LOCALAPPDATA%\NexysVHDL`). MIX-FPGA needs the new **Toolchain 1.1**, which is installed separately (`%LOCALAPPDATA%\MIX-FPGA`). You can delete the old folder yourself later to free about 3 GB.

## 3. By hand (the ZIP)

Unzip the *Fresh* or *Upgrade* ZIP and follow its `INSTALL-…-Windows.md`. In short: install the `.vsix` (Extensions view → **…** → **Install from VSIX…**), then in MIX-FPGA run **Show Environment → Install FPGA Toolchain**, tick your board(s) and choose the matching support file from the folder when asked. MIX-FPGA checks the file against the one this release expects.

## 4. Check

Run **MIX-FPGA: Show Environment**. For a Nexys A7 you should see *Installed* for the board and *VHDL Tools — Ready*. Then **New Project**, **Check**, **Simulate**, **RTL Schematic** and **Build** work.

## 5. Programming the Nexys A7: Digilent software

The Nexys A7 is programmed with Digilent's own USB/JTAG software. Digilent does not allow MIX-FPGA to include it, so you install it once from Digilent's page (link above): **Adept Runtime** (2.30 or newer) **and Adept Utilities**. Until then everything except **Program** works, and the Setup page shows *Programmer — Not installed* with the link. MIX-FPGA never installs or changes a USB driver, and a Vivado driver is not enough on its own (the *Utilities* are the part MIX-FPGA uses). Run **Show Environment** again afterwards.

## 6. The DE10-Lite: Altera's software (one-time)

MIX-FPGA installs its own small tools for the DE10-Lite, and builds and programs through Altera's **Quartus Prime Lite** (the free edition). If Quartus 25.1 with MAX 10 support is already on this computer, MIX-FPGA only checks it. Otherwise, in **Show Environment → Install DE10-Lite Support**:

1. Download Altera's two files: `QuartusLiteSetup-25.1std.0.1129-windows.exe` and `max10-25.1std.0.1129.qdz` (Altera's website; free). Choose them when asked. MIX-FPGA checks both before anything runs.
2. **Windows asks for your permission once** (a blue/yellow box naming *Windows PowerShell*). This is the only time administrator rights are used; MIX-FPGA never sees a password, and everything you do afterwards (Check, Simulate, Build, Program) runs as a normal user. If you say *No*, nothing is installed.
3. MIX-FPGA shows **Altera's own licence agreement** exactly as Altera's installer provides it. Nothing is installed unless you tick *"I have reviewed and accept the Altera Quartus Prime Software License Agreement."*
4. Altera's installer runs (several minutes), then MIX-FPGA proves Quartus works by building a tiny test design.

The DE10-Lite's USB-Blaster uses Altera's standard driver, which Quartus' own installer provides. MIX-FPGA does not install, change or replace USB drivers.

## Long folder names

Windows limits path lengths. MIX-FPGA checks before it installs and says so if the folder it would use is too deeply nested; a normal account has room to spare. Do not move the `MIX-FPGA` folder into a deeply nested place.

## If something is wrong

| Message | What to do |
|---|---|
| *Visual Studio Code was not found* (installer) | Install it (section 1), then **Check again**. |
| *… is damaged or is not the file of this release* | The download is incomplete or is another version. Download the MIX-FPGA folder again. Nothing was changed. |
| *Needs repair* in Setup | **Repair** in the Setup page restores MIX-FPGA's own files. It asks first. |
| *Installed (modified)* | You changed a file of the installed tools. Everything keeps working; **Repair** restores the supported copy if you want. Nothing is restored on its own. |
| *Programmer — Not installed* (Nexys A7) | Install Digilent Adept Runtime and Utilities (section 5). |
| *No board found* when programming | Connect the board by USB, switch it on, press **Detect**. The Nexys A7 uses its PROG/UART port; the DE10-Lite its USB-Blaster. |
| Windows says the file is from the internet / unrecognised | See step 2 of section 2. Only run files from your instructor; compare the SHA-256 in `SHA256SUMS` with `Get-FileHash <file>` in PowerShell if you want to be sure. |

The installer writes a log to `%TEMP%\MIX-FPGA-Setup.log`; send it to your instructor if the installer stops.
