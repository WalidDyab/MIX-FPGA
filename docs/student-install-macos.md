# Installing NexysVHDL on macOS

> **Status: pending.** The macOS classroom package has not been built and validated yet (Phase 4B Mac step). These instructions describe the intended installation and will be confirmed when the macOS package is validated on an Apple-silicon Mac.

NexysVHDL — **Classroom Preview** — for the Digilent Nexys A7-100T.
Supported: **macOS on Apple silicon (M1 or newer)**. Intel Macs are not supported.

You need two things. Nothing else: the VHDL simulator, the FPGA build tools and the board programmer (openFPGALoader) come with NexysVHDL. You do **not** need Homebrew, Python, Xcode, Vivado or Digilent software.

| # | What |
|---|---|
| 1 | Visual Studio Code **1.120 or newer**, the *Apple silicon* build |
| 2 | **NexysVHDL** (extension + FPGA toolchain) |

## 1. Visual Studio Code

Install VS Code from <https://code.visualstudio.com/> (Apple silicon). Check **Code → About Visual Studio Code**: version 1.120 or newer.

## 2. NexysVHDL

Unzip the classroom download `NexysVHDL-<version>-darwin-arm64.zip`:

| File | What it is |
|---|---|
| `nexysvhdl-<version>-darwin-arm64.vsix` | the NexysVHDL extension |
| `nexysvhdl-toolchain-<toolchain version>-darwin-arm64.tar.gz` | the NexysVHDL FPGA toolchain |

1. In VS Code: Extensions view → **…** → **Install from VSIX…** → choose the `.vsix`.
2. Click the **NexysVHDL** icon in the Activity Bar → **Install FPGA Toolchain…** → choose the `nexysvhdl-toolchain-…tar.gz` file. It is installed for your user account in `~/Library/NexysVHDL` and reused by NexysVHDL updates.
3. Run **NexysVHDL: Show Environment**: `Bundled FPGA Toolchain — Ready`. `Board — Not Connected` is fine until you program.

To program, connect the Nexys A7 to the **PROG/UART** USB port and switch it on.

## Uninstalling

Uninstall the extension in the Extensions view; delete `~/Library/NexysVHDL` to remove the toolchain.
