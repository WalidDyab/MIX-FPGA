# NexysVHDL on macOS

For Macs with Apple silicon (M1 or newer). Intel Macs are not supported. You need nothing except the steps below — no drivers, no administrator password.

Files in this folder:

- `NexysVHDL-0.6.0-darwin-arm64.dmg` — the NexysVHDL app (optional: a normal Mac app with a Dock icon; it opens your projects in VS Code, and double-clicking a `.nvproj` project file opens it)
- `nexysvhdl-0.6.0-darwin-arm64.vsix` — the NexysVHDL extension
- `nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz` — the FPGA toolchain (about 630 MB). **Do not double-click or unzip it.** NexysVHDL installs it for you.

## 0. Optional: install the NexysVHDL app

1. Open `NexysVHDL-0.6.0-darwin-arm64.dmg` and drag **NexysVHDL** onto **Applications**.
2. This is an early classroom build that Apple has not notarized. The first time, macOS says it *"cannot verify"* NexysVHDL. Open **System Settings → Privacy & Security**, scroll to the message about **NexysVHDL**, click **Open Anyway**, and confirm. You do this once.
3. Open **NexysVHDL**. **Install NexysVHDL** (one click) adds the extension to VS Code for you, so you can skip step 2 below. **New Project**, **Open Project** and **Recent Projects** work from the app; so does double-clicking a `.nvproj` file.

You still do steps 1 and 3 (VS Code and the FPGA toolchain); the app does not contain the toolchain.

## 1. Install VS Code

Download Visual Studio Code from <https://code.visualstudio.com/> (Apple silicon or Universal) and move it to **Applications**. Version 1.120 or newer (**Code → About Visual Studio Code**).

## 2. Install NexysVHDL

1. In VS Code, open the **Extensions** view (⇧⌘X).
2. Click **…** (top right of the Extensions view) → **Install from VSIX…**
3. Choose `nexysvhdl-0.6.0-darwin-arm64.vsix` from this folder.

## 3. Install the FPGA toolchain (once)

1. Click the **NexysVHDL** icon on the left side of VS Code.
2. Click **Install FPGA Toolchain…** (or ⇧⌘P → **NexysVHDL: Install FPGA Toolchain…**).
3. Choose `nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz` from this folder.
4. Wait until it says it is installed (about a minute).

If macOS asks whether VS Code may access your Documents, Desktop or Downloads folder, click **Allow**.

Check: ⇧⌘P → **NexysVHDL: Show Environment** should show **Bundled FPGA Toolchain — Ready — 1.0**.

## 4. Open Board_Test and connect the board

1. Copy the `Board_Test` folder (next to the `macOS` folder) into your **Documents** folder.
2. In VS Code: **File → Open Folder…** → choose `Documents/Board_Test`.
3. When VS Code asks *"Do you trust the authors…?"*, click **Yes, I trust the authors**.
4. Connect the Nexys A7 with a USB cable to the **PROG/UART** port and turn the board **ON**.

## 5. Check → Simulate → Build → Program

In the NexysVHDL panel (or ⇧⌘P, type `NexysVHDL`), run in this order:

1. **Check VHDL**
2. **Simulate**
3. **Build**
4. **Program FPGA**

On the board: turn **SW0** on → **LED0** blinks. Press **BTNC** (centre button) → the blinking restarts.

## Troubleshooting

| Problem | What to do |
|---|---|
| Buttons are greyed out / VS Code says **Restricted Mode** | Click **Restricted Mode** at the bottom-left of VS Code → **Trust**. NexysVHDL only works in a trusted folder. |
| *FPGA toolchain not installed* | Do step 3 again with the `.tar.gz` file from this folder. |
| *No Nexys A7 detected* | Use the **PROG/UART** USB port, switch the board **ON**, try another cable or USB port (some cables only charge). Then in the NexysVHDL **Hardware** view click **Detect Boards**. |
| You double-clicked the `.tar.gz`, or tools are "blocked" / "cannot be opened" | Delete any folder that was unpacked from it. Install the toolchain **only** with **NexysVHDL: Install FPGA Toolchain…** (step 3). A toolchain unpacked by hand does not work. |

Still stuck? Ask your instructor.
