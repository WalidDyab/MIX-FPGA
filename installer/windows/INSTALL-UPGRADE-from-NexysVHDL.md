# MIX-FPGA 0.7.0 for Windows: upgrade from NexysVHDL (manual route)

MIX-FPGA is an EMXplore project. Copyright 2026 Walid Dyab. Windows 10/11, 64-bit Intel/AMD (x64). **This release is not signed** (see the end).
For students who already use NexysVHDL 0.6.0. `MIX-FPGA-0.7.0-Windows-x64-Setup.exe` does the same steps for you.

## What the upgrade does and does not do
- MIX-FPGA 0.7.0 is installed **over** NexysVHDL (same extension, no uninstall first). Your projects, `.nvproj` and `nexysvhdl.json` files, project folders and settings stay as they are.
- MIX-FPGA 0.7.0 needs **Toolchain 1.1**. The Toolchain 1.0 that NexysVHDL installed is **not** used by 0.7.0; it is **not removed or changed** either (it stays in `%LOCALAPPDATA%\NexysVHDL`, about 3 GB). You can delete that folder yourself later to free the space.
- You install the Nexys A7 Toolchain 1.1 support once from this ZIP (about 3 GB installed, in `%LOCALAPPDATA%\MIX-FPGA`). The DE10-Lite is optional: if you also use it, ask for the Fresh ZIP (or the Setup installer) and follow its guide.
- Programming the Nexys A7 keeps using **Digilent Adept** (Runtime and Utilities), which you already have if NexysVHDL could program.

## Files in this ZIP
Check them first: `Get-FileHash .\<file>` in PowerShell and compare with `SHA256SUMS`.

| File | What it is |
|---|---|
| `nexysvhdl-0.7.0-win32-x64.vsix` | the MIX-FPGA extension |
| `nexysvhdl-toolchain-1.1-win32-x64.tar.gz` | Nexys A7 support (Toolchain 1.1) |
| `MIX-FPGA-Nexys-A7-Support-1.1-Windows-x64-Sources.zip` | corresponding source of that archive (keep it next to the archive) |
| `THIRD_PARTY_NOTICES*.md`, `LICENSE` | notices and licence |

## Steps
1. Visual Studio Code 1.120 or newer is installed (it already is if you use NexysVHDL).
2. Extensions view (Ctrl+Shift+X), **…**, **Install from VSIX…**, choose `nexysvhdl-0.7.0-win32-x64.vsix`. **Do not uninstall NexysVHDL first.** Reload the window if asked.
3. Click the MIX-FPGA icon, run **Show Environment**. It shows the Nexys A7 as *Not installed* (that is the new Toolchain 1.1). Choose **Install Nexys A7-100T Support** and select `nexysvhdl-toolchain-1.1-win32-x64.tar.gz` from this folder. MIX-FPGA checks the file first, then every file it installs.
4. Run **Verify Environment** (it should say the environment is ready), then open your project as before.

## If Windows blocks something (not signed)
1. Windows may show a blue *"Windows protected your PC"* window for a program from this release. Click **More info**.
2. Check the name and that the file came from your instructor, then click **Run anyway**.
3. A downloaded ZIP's files may be marked "blocked": right-click the file, **Properties**, tick **Unblock** if it is there, **OK**.

Do not turn SmartScreen, Windows Defender or any other security setting off: neither is needed.
