MIX-FPGA 0.7.0
FPGA development for Nexys A7 and DE10-Lite
MIX-FPGA is an EMXplore project. Copyright 2026 Walid Dyab.

WHAT YOU NEED
- A Mac with Apple silicon (M1 or newer), macOS 13 or newer.
- Visual Studio Code 1.120 or newer (https://code.visualstudio.com, the Apple silicon download, moved to Applications).
- About 3 GB free for the Nexys A7, about 12 GB more for the DE10-Lite.
- For the DE10-Lite only: Altera's two free downloads (Quartus Prime Lite 25.1 for Linux and the MAX 10 device package). MIX-FPGA asks for them
  and shows Altera's own licence; nothing from Altera is included here.

HOW TO INSTALL
1. Double-click "MIX-FPGA Installer" in this window (run it from here, not after copying it somewhere else: the board support files are
   in the "Support" folder next to it).
2. The installer tells you what it found:
   - Fresh Install: you have no MIX-FPGA or NexysVHDL.
   - Upgrade from NexysVHDL: MIX-FPGA is installed over NexysVHDL. Your projects and settings are kept, nothing is uninstalled first, and the
     old tools (Toolchain 1.0) are left where they are. MIX-FPGA 0.7.0 uses Toolchain 1.1, which this installer adds.
   - Repair/Reinstall: MIX-FPGA 0.7.0 is already there.
3. Tick Nexys A7, DE10-Lite or both, and press the button. Keep the window open until it says the work is done.
4. Open Visual Studio Code, click the MIX-FPGA icon and choose Show Environment. For the DE10-Lite, choose "Install DE10-Lite Support" there to
   finish with Altera's files.

If you prefer not to use the installer, use the Fresh or Upgrade ZIP: it has the same files and a step-by-step guide.

THIS RELEASE IS NOT SIGNED OR NOTARIZED
macOS may refuse to open the installer, or a MIX-FPGA tool, the first time because it is not signed by Apple. Nothing is wrong with your Mac. If that
happens:
1. Try to open it once (double-click). macOS shows a message and does not open it.
2. Open System Settings, then Privacy & Security.
3. Scroll down to the message about the blocked MIX-FPGA item and choose "Open Anyway".
4. Enter your Mac password if asked.
5. Open it again.
Do not turn Gatekeeper off, and do not run commands that remove security attributes from your files: neither is needed.

SOURCE CODE
The "Source" folder holds the corresponding source of the board-support archives, next to the archives (there is no written offer). The notices are
in THIRD_PARTY_NOTICES.md.

CHECKING THE FILES
Support/SHA256SUMS lists the checksum of every file in Support. The installer checks them before it changes anything.
