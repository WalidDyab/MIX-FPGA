# MIX-FPGA 0.7.0 for macOS: upgrade from NexysVHDL (manual route)

MIX-FPGA is an EMXplore project. Copyright 2026 Walid Dyab. Apple silicon Macs only, macOS 13 or newer. **This release is not signed or notarized** (see the end).
For students who already use NexysVHDL 0.6.0. The installer in the disk image does the same steps for you.

## What the upgrade does and does not do
- MIX-FPGA 0.7.0 is installed **over** NexysVHDL (same extension, no uninstall first). Your projects, `.nvproj` and `nexysvhdl.json` files, project folders and settings stay as they are.
- MIX-FPGA 0.7.0 needs **Toolchain 1.1**. The Toolchain 1.0 that NexysVHDL installed is **not** enough for it and is **not used**; it is not removed or changed either (it stays in `~/Library/NexysVHDL`). You can delete it yourself later to free the space.
- You install the Nexys A7 Toolchain 1.1 support once from this ZIP. The DE10-Lite is optional: if you also use it, ask for the Fresh ZIP (or the disk image) and follow its guide.

## Files in this ZIP
Check them first: `shasum -a 256 -c SHA256SUMS` in this folder (every line OK).

| File | What it is |
|---|---|
| `nexysvhdl-0.7.0-darwin-arm64.vsix` | the MIX-FPGA extension |
| `nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz` | Nexys A7 support (Toolchain 1.1) |
| `MIX-FPGA-Nexys-A7-Support-1.1-Sources.zip` | corresponding source of that archive (keep it next to the archive) |
| `THIRD_PARTY_NOTICES.md`, `LICENSE` | notices and licence |

## Steps
1. Visual Studio Code 1.120 or newer is installed (it already is if you use NexysVHDL).
2. Extensions view (Shift-Command-X), **...**, **Install from VSIX...**, choose `nexysvhdl-0.7.0-darwin-arm64.vsix`. Do not uninstall NexysVHDL first. Reload the window if asked.
3. Click the MIX-FPGA icon, run **Show Environment**. It shows the Nexys A7 as *Not installed* (that is the new Toolchain 1.1). Choose **Install Nexys A7-100T Support** and select `nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz` from this folder. MIX-FPGA checks every file.
4. Run **Verify Environment** (it should say the environment is ready), then open your project as before.

## If macOS blocks something (not signed or notarized)
1. Try to open it once. macOS says it is blocked.
2. Open System Settings, then Privacy & Security.
3. Scroll to the message about the blocked MIX-FPGA item and choose **Open Anyway**.
4. Enter your Mac password if asked, and try again.
Do not turn Gatekeeper off or strip security attributes from files: neither is needed.
