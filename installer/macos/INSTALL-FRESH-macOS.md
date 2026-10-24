# MIX-FPGA 0.7.0 for macOS: fresh install (manual route)

MIX-FPGA is an EMXplore project. Copyright 2026 Walid Dyab. Apple silicon Macs only (M1 or newer), macOS 13 or newer.
This is the fallback to the installer in the disk image: the same files, installed by hand. **This release is not signed or notarized** (see the end).

## Files in this ZIP (check them first)

`SHA256SUMS` lists the checksum of every file. In Terminal, in this folder: `shasum -a 256 -c SHA256SUMS` (every line must say OK).

| File | What it is |
|---|---|
| `nexysvhdl-0.7.0-darwin-arm64.vsix` | the MIX-FPGA extension |
| `nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz` | Nexys A7 support (Toolchain 1.1) |
| `mixfpga-de10-lite-support-1.1-macos-arm64.tar.gz` | DE10-Lite support (Toolchain 1.1) |
| `MIX-FPGA-Nexys-A7-Support-1.1-Sources.zip`, `MIX-FPGA-DE10-Lite-Support-1.1-Sources.zip` | corresponding source of each support archive (keep each next to its archive) |
| `THIRD_PARTY_NOTICES.md`, `LICENSE` | notices and licence |

## 1. Visual Studio Code
Install it from <https://code.visualstudio.com> (the Apple silicon download), move it to Applications; version 1.120 or newer.

## 2. The extension
In Visual Studio Code open the Extensions view (Shift-Command-X), click **...**, **Install from VSIX...**, and choose `nexysvhdl-0.7.0-darwin-arm64.vsix`.
Or in Terminal: `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension nexysvhdl-0.7.0-darwin-arm64.vsix`.

## 3. Board support
Click the MIX-FPGA icon, run **Show Environment**, then **Install FPGA Toolchain**, tick your board(s), and when asked choose the matching support file from this folder (`nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz` for the Nexys A7, `mixfpga-de10-lite-support-1.1-macos-arm64.tar.gz` for the DE10-Lite). MIX-FPGA checks every file before it uses it.

**DE10-Lite only:** MIX-FPGA then asks for Altera's two free downloads (Quartus Prime Lite 25.1std.0 Build 1129 for Linux, `QuartusLiteSetup-25.1std.0.1129-linux.run`, and the MAX 10 package `max10-25.1std.0.1129.qdz`), checks them, shows Altera's licence and asks you to accept it. Nothing from Altera is in this ZIP. Allow about 12 GB.

## 4. Programming
macOS needs no driver. Connect the board (Nexys A7: PROG/UART; DE10-Lite: USB-Blaster), switch it on, and use Detect and Program in MIX-FPGA.

## If macOS blocks something (not signed or notarized)
1. Try to open it once. macOS says it is blocked.
2. Open System Settings, then Privacy & Security.
3. Scroll to the message about the blocked MIX-FPGA item and choose **Open Anyway**.
4. Enter your Mac password if asked, and try again.
Do not turn Gatekeeper off or strip security attributes from files: neither is needed.
