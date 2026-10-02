# Installing NexysVHDL on Windows

NexysVHDL — **Classroom Preview** — for the Digilent Nexys A7-100T.
Supported: **Windows 10/11, x64** (not Windows on ARM).

You need three things. Everything else (the VHDL simulator, the FPGA synthesis, place-and-route and bitstream tools, and the Python they use) comes with NexysVHDL. **Do not install GHDL, Apio, Yosys, nextpnr, openXC7 or Python for NexysVHDL**; if you already have them, NexysVHDL ignores them and never changes them.

| # | What | Why |
|---|---|---|
| 1 | Visual Studio Code **1.120 or newer** | the editor NexysVHDL runs in |
| 2 | **NexysVHDL** (extension + FPGA toolchain) | design, check, simulate, build |
| 3 | **Digilent USB/JTAG support** — only if NexysVHDL says it is missing | programming the board over USB |

## 1. Visual Studio Code

Install VS Code from <https://code.visualstudio.com/>. If you already have it, check **Help → About**: the version must be 1.120 or newer.

## 2. NexysVHDL

Your course provides the NexysVHDL classroom download `NexysVHDL-<version>-win32-x64.zip`. Unzip it. It contains:

| File | What it is |
|---|---|
| `nexysvhdl-<version>-win32-x64.vsix` | the NexysVHDL extension (small) |
| `nexysvhdl-toolchain-<toolchain version>-win32-x64.tar.gz` | the NexysVHDL FPGA toolchain (about 725 MB; about 3 GB once installed) |
| `SHA256SUMS.txt`, `THIRD_PARTY_NOTICES.md` | checksums and licenses |

**a. Install the extension.** In VS Code open the Extensions view (Ctrl+Shift+X), click **…** (top right) → **Install from VSIX…**, and choose the `.vsix` file.

**b. Install the FPGA toolchain.** Click the **NexysVHDL** icon in the Activity Bar. NexysVHDL tells you that it needs its FPGA toolchain: click **Install FPGA Toolchain…** and choose the `nexysvhdl-toolchain-…tar.gz` file. Installation takes about a minute. The toolchain is installed for your Windows user account in `%LOCALAPPDATA%\NexysVHDL` and is reused by later NexysVHDL updates, so you install it only once per toolchain version. NexysVHDL checks every file against the validated toolchain before using it.

**c. Check.** Run **NexysVHDL: Show Environment** (Ctrl+Shift+P). You should see:

```
Extension                   Ready
Bundled FPGA Toolchain      Ready — 1.0 (Windows x64)
Digilent USB/JTAG Support   Ready   or   Setup Required
Board                       Not Connected   (fine until you program)
Status: Ready for design and build
```

You can now create projects, check, simulate and build without anything else.

## 3. Digilent USB/JTAG support (for programming only)

Programming the board uses Digilent's own USB/JTAG software. Digilent does not allow NexysVHDL to include it, so NexysVHDL uses the copy installed on your computer.

- If Show Environment says **Digilent USB/JTAG Support — Ready**, do nothing.
- A Vivado installation already installs Digilent's USB **driver**, but not the **Adept Utilities** that NexysVHDL uses, so a Vivado computer may still say *Setup Required*. NexysVHDL never changes a working Vivado or driver setup.
- If it says **Setup Required**, install the official **Digilent Adept Runtime** and **Digilent Adept Utilities** from Digilent: <https://digilent.com/reference/software/adept/start>. NexysVHDL was validated with Adept Runtime 2.30.4 and Adept Utilities 2.7.1; the Runtime must be 2.30 or newer.
- Then run **NexysVHDL: Show Environment** again.

"Setup Required" for Digilent support only blocks **Program FPGA**; everything else works.

## If something is wrong

| Message | What to do |
|---|---|
| *FPGA toolchain not installed* | Install it from the `nexysvhdl-toolchain-…` file (step 2b). |
| *The archive content does not match the validated toolchain* | The file is damaged or the wrong one; download the classroom package again. |
| *Could not create a plain-ASCII path …* | Your Windows user name contains a space or a non-English letter and the computer does not allow NexysVHDL to create its small link folder in `C:\ProgramData\NexysVHDL`. Ask your instructor/IT. Check and Simulate still work. |
| *GHDL cannot use the file name …* | Rename that VHDL file using only English letters, digits, `_` and `-` (folder names may contain any characters). |
| *No Nexys A7 detected* | USB cable in the **PROG/UART** port, board switched **ON**, Digilent support Ready. |
| *connected by USB but the FPGA/JTAG chain is unavailable* | The board power switch is off. |

**NexysVHDL: Verify FPGA Toolchain** re-checks every installed file. **NexysVHDL: Third-Party Notices** shows the licenses of the included tools.

## User names and folders with spaces or non-English letters

They are fully supported: user names like "José García" or "王小明", and project folders like "Documents\Mis Proyectos" work. Some of the FPGA build tools only accept plain English paths, so for such accounts NexysVHDL creates a small link (a directory junction, no administrator rights needed) in `C:\ProgramData\NexysVHDL\links` that points to its own folder in your profile. The tools use that plain path; your files stay in your profile. VHDL *file* names should still use English letters (VHDL itself only allows English letters in names).

## Uninstalling

Uninstall the extension in the Extensions view. The FPGA toolchain stays in `%LOCALAPPDATA%\NexysVHDL` (so a reinstall or update does not need it again); delete that folder (and, if present, `C:\ProgramData\NexysVHDL\links`) to remove it.
