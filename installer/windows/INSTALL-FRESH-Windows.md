# MIX-FPGA 0.7.0 for Windows: fresh install (manual route)

MIX-FPGA is an EMXplore project. Copyright 2026 Walid Dyab. Windows 10/11, 64-bit Intel/AMD (x64). **This release is not signed** (see the end).
This is the fallback to `MIX-FPGA-0.7.0-Windows-x64-Setup.exe`: the same files, installed by hand.

## Files in this ZIP (check them first)

`SHA256SUMS` lists the checksum of every file. In PowerShell, in this folder: `Get-FileHash .\<file>` and compare with the line in `SHA256SUMS`.

| File | What it is |
|---|---|
| `nexysvhdl-0.7.0-win32-x64.vsix` | the MIX-FPGA extension |
| `nexysvhdl-toolchain-1.1-win32-x64.tar.gz` | Nexys A7 support (Toolchain 1.1; about 3 GB installed) |
| `mixfpga-de10-lite-support-1.1-windows-x64.tar.gz` | DE10-Lite support (Toolchain 1.1; small) |
| `MIX-FPGA-Nexys-A7-Support-1.1-Windows-x64-Sources.zip`, `MIX-FPGA-DE10-Lite-Support-1.1-Windows-x64-Sources.zip` | corresponding source of each support archive (keep each next to its archive) |
| `THIRD_PARTY_NOTICES*.md/.txt`, `LICENSE` | notices and licence |

## 1. Visual Studio Code
Install it from <https://code.visualstudio.com> (the *User Installer* is fine); version 1.120 or newer (**Help → About**).

## 2. The extension
In Visual Studio Code open the Extensions view (Ctrl+Shift+X), click **…** (top right), **Install from VSIX…**, and choose `nexysvhdl-0.7.0-win32-x64.vsix`.
Or in PowerShell: `code --install-extension .\nexysvhdl-0.7.0-win32-x64.vsix`.

## 3. Board support
Click the MIX-FPGA icon, run **Show Environment**, then **Install FPGA Toolchain**, tick your board(s), and when asked choose the matching support file from this folder (`nexysvhdl-toolchain-1.1-win32-x64.tar.gz` for the Nexys A7, `mixfpga-de10-lite-support-1.1-windows-x64.tar.gz` for the DE10-Lite). MIX-FPGA checks every file against the one this release expects before using it, and says so if you chose the wrong or a damaged file (nothing is changed then).

**DE10-Lite only:** MIX-FPGA then asks for Altera's two free downloads (Quartus Prime Lite 25.1std.0 Build 1129 for Windows, `QuartusLiteSetup-25.1std.0.1129-windows.exe`, and the MAX 10 package `max10-25.1std.0.1129.qdz`), checks them, shows Altera's licence and asks you to accept it. Then **Windows asks for your permission once** to run Altera's installer. Nothing from Altera is in this ZIP. Allow about 14 GB while installing (about 9 GB afterwards). If Quartus 25.1 with MAX 10 support is already installed, MIX-FPGA only checks it.

## 4. Programming
- **Nexys A7:** install Digilent's free **Adept Runtime (2.30 or newer) and Adept Utilities** from <https://digilent.com/reference/software/adept/start> (MIX-FPGA cannot include them; its Setup page shows this link when they are missing). Connect the board's PROG/UART port, switch it on, use **Detect** and **Program**. Everything except **Program** works without Digilent's software.
- **DE10-Lite:** Quartus' own installer provides the standard USB-Blaster driver. Connect the USB-Blaster port, switch the board on, **Detect**, **Program**. MIX-FPGA never installs or changes a driver.

## If Windows blocks something (not signed)
1. Windows may show a blue *"Windows protected your PC"* window for a program from this release. Click **More info**.
2. Check the name and that the file came from your instructor, then click **Run anyway**.
3. A downloaded ZIP's files may be marked "blocked": right-click the file, **Properties**, tick **Unblock** if it is there, **OK**.

Do not turn SmartScreen, Windows Defender or any other security setting off: neither is needed.
