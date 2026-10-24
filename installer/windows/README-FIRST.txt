MIX-FPGA 0.7.0 for Windows
FPGA development for Nexys A7 and DE10-Lite
MIX-FPGA is an EMXplore project. Copyright 2026 Walid Dyab.

WHAT YOU NEED
- Windows 10 or 11, 64-bit (Intel or AMD). Not Windows on ARM.
- Visual Studio Code 1.120 or newer (https://code.visualstudio.com; the "User Installer" is fine).
- About 3 GB free for the Nexys A7, about 14 GB free while installing the DE10-Lite (about 9 GB afterwards).
- Nexys A7 only, to PROGRAM the board: Digilent's free Adept Runtime and Adept Utilities
  (https://digilent.com/reference/software/adept/start). MIX-FPGA cannot include them; its Setup page shows the link if they are missing.
- DE10-Lite only: Altera's two free downloads (Quartus Prime Lite 25.1std for Windows, and the MAX 10 device package). MIX-FPGA asks for
  them, shows Altera's own licence and installs them only after you accept it. Nothing from Altera is included here.

HOW TO INSTALL
1. Keep this whole folder together (the installer finds the MIX-FPGA files next to itself and checks each one).
2. Double-click "MIX-FPGA-0.7.0-Windows-x64-Setup.exe". Windows may stop it because this release is not signed (see below).
3. The installer tells you what it found:
   - Fresh Install: you have no MIX-FPGA or NexysVHDL.
   - Upgrade from NexysVHDL: MIX-FPGA is installed over NexysVHDL. Your projects and settings are kept, nothing is uninstalled first, and the
     old tools (Toolchain 1.0) are left where they are. MIX-FPGA 0.7.0 uses Toolchain 1.1, which this installer adds separately.
   - Repair/Reinstall: MIX-FPGA 0.7.0 is already there.
4. Tick Nexys A7, DE10-Lite or both, and press the button. Keep the window open until it says the work is done.
5. Press "Open MIX-FPGA Setup" (or open Visual Studio Code, click the MIX-FPGA icon, choose Show Environment). For the DE10-Lite, choose
   "Install DE10-Lite Support" there to finish with Altera's files: Windows asks for your permission once.

If you prefer not to use the installer, use the Fresh or Upgrade ZIP: it has the same files and a step-by-step guide.

THIS RELEASE IS NOT SIGNED
Windows (SmartScreen) may show a blue window "Windows protected your PC - Microsoft Defender SmartScreen prevented an unrecognized app from
starting" the first time you open the installer. Nothing is wrong with your PC; the program is simply not signed with a publisher certificate.
Only if the file came from your instructor:
1. Click "More info" in that window.
2. Check the file name (MIX-FPGA-0.7.0-Windows-x64-Setup.exe). If you want to be sure, compare its fingerprint: open PowerShell in this
   folder and run  Get-FileHash .\MIX-FPGA-0.7.0-Windows-x64-Setup.exe  ; the result must equal the line for that file in SHA256SUMS.
3. Click "Run anyway".
A file downloaded from the internet can also be marked "blocked": right-click it, choose Properties, tick "Unblock" if it is there, press OK.
Do NOT turn SmartScreen, Windows Defender or any other security setting off; neither is needed. The installer does not change any security setting.

WINDOWS ASKS FOR PERMISSION (DE10-LITE ONLY)
Only Altera's Quartus installer needs administrator rights, so Windows asks once, later, from inside Visual Studio Code, naming "Windows
PowerShell". MIX-FPGA never sees a password. Say No and nothing is installed.

SOURCE CODE
The two corresponding-source packages (MIX-FPGA-...-Sources.zip) sit next to the board-support archives they belong to (there is no written
offer). The notices are in THIRD_PARTY_NOTICES.md and the two THIRD_PARTY_NOTICES-... files.

CHECKING THE FILES
SHA256SUMS lists the checksum of every file. The installer checks the extension and the board-support archives against the values built
into it before it changes anything. If it stops, it writes a log to %TEMP%\MIX-FPGA-Setup.log.
