# NexysVHDL on Windows

For Windows 10/11 (x64). You need nothing except the steps below.

Files in this folder:

- `NexysVHDL-Setup-0.6.0-win32-x64.exe` — the Windows installer (optional: installs NexysVHDL for your Windows account, with a Start Menu entry; double-clicking a `.nvproj` project file then opens it)
- `nexysvhdl-0.6.0-win32-x64.vsix` — the NexysVHDL extension
- `nexysvhdl-toolchain-1.0-win32-x64.tar.gz` — the FPGA toolchain (about 700 MB). **Do not unzip it.** NexysVHDL installs it for you.

## 1. Install VS Code

Download and install Visual Studio Code from <https://code.visualstudio.com/>. Version 1.120 or newer (**Help → About**).

## 2. Install Digilent USB/JTAG support (for programming the board)

Install both of these official Digilent programs from <https://digilent.com/reference/software/adept/start>:

- **Digilent Adept Runtime**
- **Digilent Adept Utilities**

If you are not sure whether you already have them, skip this step: NexysVHDL tells you in step 5 if they are missing.

## 3. Install NexysVHDL

1. In VS Code, open the **Extensions** view (Ctrl+Shift+X).
2. Click **…** (top right of the Extensions view) → **Install from VSIX…**
3. Choose `nexysvhdl-0.6.0-win32-x64.vsix` from this folder.

## 4. Install the FPGA toolchain (once)

1. Click the **NexysVHDL** icon on the left side of VS Code.
2. Click **Install FPGA Toolchain…** (or Ctrl+Shift+P → **NexysVHDL: Install FPGA Toolchain…**).
3. Choose `nexysvhdl-toolchain-1.0-win32-x64.tar.gz` from this folder.
4. Wait until it says it is installed (a minute or two).

## 5. Check your setup

Ctrl+Shift+P → **NexysVHDL: Show Environment**. You want:

- Bundled FPGA Toolchain — **Ready — 1.0**
- Digilent USB/JTAG Support — **Ready** (if it says *Setup Required*, do step 2)

## 6. Open Board_Test and connect the board

1. Copy the `Board_Test` folder (next to the `Windows` folder) into your **Documents** folder.
2. In VS Code: **File → Open Folder…** → choose `Documents\Board_Test`.
3. When VS Code asks *"Do you trust the authors…?"*, click **Yes, I trust the authors**.
4. Connect the Nexys A7 with a USB cable to the **PROG/UART** port and turn the board **ON**.

## 7. Check → Simulate → Build → Program

In the NexysVHDL panel (or Ctrl+Shift+P, type `NexysVHDL`), run in this order:

1. **Check VHDL**
2. **Simulate**
3. **Build**
4. **Program FPGA**

On the board: turn **SW0** on → **LED0** blinks. Press **BTNC** (centre button) → the blinking restarts.

## Troubleshooting

| Problem | What to do |
|---|---|
| Buttons are greyed out / VS Code says **Restricted Mode** | Click **Restricted Mode** at the bottom-left of VS Code → **Trust**. NexysVHDL only works in a trusted folder. |
| *FPGA toolchain not installed* | Do step 4 again with the `.tar.gz` file from this folder. |
| *No Nexys A7 detected* | Use the **PROG/UART** USB port, switch the board **ON**, try another cable. Then in the NexysVHDL **Hardware** view click **Detect Boards**. |
| *Digilent USB/JTAG Support — Setup Required* | Install **Adept Runtime** and **Adept Utilities** (step 2), then run **NexysVHDL: Show Environment** again. |

Still stuck? Ask your instructor.
