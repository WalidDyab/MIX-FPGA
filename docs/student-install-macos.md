# Installing NexysVHDL on macOS

NexysVHDL — **Classroom Preview** — for the Digilent Nexys A7-100T.
Supported: **macOS on Apple silicon (M1 or newer)**. Intel Macs are not supported.

You need two things. Everything else (the VHDL simulator, the FPGA synthesis, place-and-route and bitstream tools, the board programmer and the Python they use) comes with NexysVHDL. **Do not install Homebrew, Python, Xcode or its Command Line Tools, GHDL, Apio, Yosys, nextpnr, openXC7, openFPGALoader, Vivado or Digilent software for NexysVHDL**; if you already have any of them, NexysVHDL ignores them and never changes them.

| # | What | Why |
|---|---|---|
| 1 | Visual Studio Code **1.120 or newer** | the editor NexysVHDL runs in |
| 2 | **NexysVHDL** (extension + FPGA toolchain) | design, check, simulate, build and program |

## 1. Visual Studio Code

Install VS Code from <https://code.visualstudio.com/> (the *Apple silicon* or *Universal* download) and move it to **Applications**. If you already have it, check **Code → About Visual Studio Code**: the version must be 1.120 or newer.

## 2. NexysVHDL

Your course provides the NexysVHDL classroom download `NexysVHDL-<version>-darwin-arm64.zip`. Double-click it to unzip it (Safari may already have done that for you). The folder contains:

| File | What it is |
|---|---|
| `nexysvhdl-<version>-darwin-arm64.vsix` | the NexysVHDL extension (small) |
| `nexysvhdl-toolchain-<toolchain version>-darwin-arm64.tar.gz` | the NexysVHDL FPGA toolchain (about 630 MB; about 2.8 GB once installed) |
| `SHA256SUMS.txt`, `THIRD_PARTY_NOTICES.md` | checksums and licenses |

Do **not** double-click the `.tar.gz` file; NexysVHDL installs it for you.

**a. Install the extension.** In VS Code open the Extensions view (⇧⌘X), click **…** (top right) → **Install from VSIX…**, and choose the `.vsix` file.

**b. Install the FPGA toolchain.** Click the **NexysVHDL** icon in the Activity Bar. NexysVHDL tells you that it needs its FPGA toolchain: click **Install FPGA Toolchain…** and choose the `nexysvhdl-toolchain-…tar.gz` file. Installation takes less than a minute. The toolchain is installed for your macOS user account in `~/Library/NexysVHDL` (no administrator password is needed) and is reused by later NexysVHDL updates, so you install it only once per toolchain version. NexysVHDL checks every file against the validated toolchain before using it.

**c. Check.** Run **NexysVHDL: Show Environment** (⇧⌘P). You should see:

```
Extension                           Ready
Bundled FPGA Toolchain              Ready — 1.0 (macOS Apple silicon)
Board programmer (openFPGALoader)   Ready (bundled)
Board                               Not Connected   (fine until you program)
Status: Ready for design, build and programming
```

You can now create projects, check, simulate, build and program without anything else.

If macOS asks whether Visual Studio Code may access files in your Documents, Desktop or Downloads folder, click **Allow**: NexysVHDL needs to read your project and the toolchain file.

## 3. Programming the board

macOS needs **no driver** for the Nexys A7: the board programmer included in NexysVHDL talks to it directly over USB. Connect the board's **PROG/UART** USB port to your Mac, switch the board **ON**, and click **Refresh** in the NexysVHDL Hardware view; then **Program FPGA**.

## If something is wrong

| Message | What to do |
|---|---|
| *FPGA toolchain not installed* | Install it from the `nexysvhdl-toolchain-…` file (step 2b). |
| *The archive content does not match the validated toolchain* | The file is damaged or the wrong one; download the classroom package again. |
| *This archive is the NexysVHDL toolchain for win32-x64* | You chose the Windows toolchain; use the `…-darwin-arm64.tar.gz` file. |
| *Could not create a plain-ASCII path …* | Your home folder's path contains a space or a non-English letter and NexysVHDL could not create its small private link folder in your temporary folder. Restart VS Code; if it persists, ask your instructor. Check and Simulate still work. |
| *GHDL cannot use the file name …* | Rename that VHDL file using only English letters, digits, `_` and `-` (folder names may contain any characters). |
| *No Nexys A7 detected* | USB cable in the **PROG/UART** port, board switched **ON**, try another cable or USB port (some cables only charge). |

**NexysVHDL: Verify FPGA Toolchain** re-checks every installed file. **NexysVHDL: Third-Party Notices** shows the licenses of the included tools.

## Folders with spaces or non-English letters

Project folders like "Documents/Mis Proyectos" or "学生" work, and so does a home folder whose path contains spaces or non-English letters: some FPGA build tools only accept plain English paths, so NexysVHDL then gives them a small private link (in your own temporary folder) that points to its folder in your Library. Your files stay where they are. VHDL *file* names should use English letters (VHDL itself only allows English letters in names).

## Uninstalling

Uninstall the extension in the Extensions view. The FPGA toolchain stays in `~/Library/NexysVHDL` (so a reinstall or update does not need it again). To remove it, in Finder choose **Go → Go to Folder…**, enter `~/Library`, and move the `NexysVHDL` folder to the Trash.
