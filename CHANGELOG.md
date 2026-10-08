# Changelog

## Unreleased — UI polish (not yet versioned)

- **Viewers use the whole editor area:** Waveform, RTL Schematic and Design Schematic open in the active editor group (never beside or in a new split) and are reused when already open.
- **Schematics:** open in Fit All (never below a readable scale: a huge design opens as a scrollable overview); one toolbar for both (100%, Fit Width, Fit All, zoom, Reset = Fit All, Maximize); **Dark/Light** background shared by both and remembered per project; **Export SVG…** and **Export PNG…** of the complete drawing through the native Save dialog (true vector SVG; PNG at up to 3×).
- **Waveform:** **Start Over** reruns the testbench from time 0 with the current duration (disabled while a run is in progress or before the first run); a high-contrast time marker with the selected time on a flag spans every row, stays put through zoom, pan and reruns, and moves with Left/Right.
- **Problems:** *Clear NexysVHDL Problems* removes only NexysVHDL's own diagnostics (command palette; also in the Workflow/Results "..." menus: VS Code has no contribution point for the Problems panel's own context menu).
- **Projects:** the Project section shows only the project name, its board and Environment; **New Project / Open Project / Close Project** are its header actions. *Open Project* switches this window directly to another project (folder, `.nvproj` or an older project) after flushing NexysVHDL's state; *Close Project* flushes and closes the folder, leaving the welcome state. Unsaved VHDL/XDC documents are handled by VS Code's own Save / Don't Save / Cancel prompt, never by NexysVHDL.
- **Sidebar:** per-section colour identity, a status beside each section title, inline row actions on Project rows (Top, Testbench, Simulation length, project settings, environment, project file), stronger section separators in the Classroom theme. **Add File** now shows a single plus.

## Unreleased — Phase 7 project UX refinements (not yet versioned)

- **Reliable saving:** NexysVHDL's own state is written as it changes and flushed before the window closes, reloads or the extension stops (`deactivate()` is awaited). `nexysvhdl.json` is now written atomically and one update at a time. Design mode, waveform signals, Display As, pane widths and the schematic view are remembered with the project in `.nexysvhdl/state.json`. Source documents keep VS Code's normal Save / Auto Save.
- **`.nvproj` project file:** every new project gets `<name>.nvproj` (a small versioned launch descriptor; `nexysvhdl.json` stays the source of truth). Open Project accepts a folder or a `.nvproj`; older projects open unchanged and can add one with *Create NexysVHDL Project File*. On Windows, Setup registers `.nvproj` for the current user (NexysVHDL icon, double-click opens the project, no console window); Uninstall removes only that association.
- **NexysVHDL Console:** one Output channel for Check, Simulate, Build and Program progress, results, warnings and errors, revealed when an action starts or fails; optional detailed mode streams the raw tool output. The previous log is now *NexysVHDL Log*.
- **Design Schematic:** opens as a normal tab at 100% instead of a narrow side column and a Fit-All view; 100% / Fit Width / Fit All / zoom / Reset / Maximize, scrolling, larger text and spacing, collapsible notes, remembered view; source opens beside it.

## Unreleased — Phase 6 pilot hardening (not yet versioned)

- **Fixed:** a top entity with capital letters (`DigitDisplay`) no longer fails synthesis with `GHDL_SYNTH_NO_TOP`; the module spelling GHDL emits is used for Yosys, RTL schematic and Build.
- **Fixed:** Check, Simulate, Build, RTL schematic and Program can no longer run at the same time on one project (duplicate requests answer "Build is already running").
- **Simulation length:** optional `simulation.stopTime` (GHDL `--stop-time`), set from the Project view; a testbench that never ends now gets an explanation instead of a bare time-out. Projects without it behave exactly as before.
- **Design view:** Project Files and Design Hierarchy are one view with Files and Hierarchy modes, and a **+ Add File** workflow (source, simulation testbench, constraint; create new or copy from the computer).
- **Waveform:** per-signal Display As (Binary, Hex, Unsigned Decimal, Signed Decimal), remembered per workspace.
- **Remove from Project** (right-click in Design → Files): the file stays on disk; a removed top entity, testbench or active XDC is cleared explicitly. **Add File → Copy From Computer** takes several files at once (one refresh). **New Project** offers an Empty project (empty src/ and sim/) besides the Starter. Clicking a file reuses its open editor. The waveform signal list has draggable splitters (remembered per workspace).
- **Simulation workspace:** Simulate opens the one waveform viewer at once. The viewer has Run, Stop and Run for (a duration, stored as simulation.stopTime); each Run starts the testbench again at time 0. Stop ends GHDL and keeps the partial waveform. Design → Hierarchy has + Add File too.
- **Optional appearance:** NexysVHDL Classroom color theme, applied to the project folder only.

## 0.5.0 — Classroom Preview (requires NexysVHDL toolchain 1.0)

First installable NexysVHDL package. Not published on the Visual Studio Marketplace; distributed to classes as a download.

**Board and language**
- Digilent Nexys A7-100T (XC7A100T-1CSG324C) only.
- VHDL, VHDL-2008. NexysVHDL's own VHDL syntax highlighting, comments, brackets and indentation.

**Projects**
- Create / Open NexysVHDL Project; starter project (blinking LED, self-checking testbench, XDC).
- Project Files, Design Hierarchy (refreshes on save), Set Top Entity, Set Testbench.
- Pins and clocks in standard Xilinx **XDC** files, edited as text exactly as in Vivado; ports without a pin are reported before implementation.

**Workflow**
- Check (VHDL analysis/elaboration) with errors in Problems; optional check on save.
- Simulate (self-checking testbenches) and the VCD **Waveform Viewer**.
- **Design Schematic** (structure) and **RTL Schematic** (inferred registers, multiplexers, arithmetic, logic).
- Build: **Synthesis → Implementation → Bitstream**, with timing (PASS/FAIL per clock, achieved MHz, worst slack) and resource use (LUT, FF, BRAM, DSP, I/O) in Results.
- Hardware view (board detection) and Program FPGA (SRAM). Programming backends: Digilent Adept `djtgcfg` on Windows (requires the official Digilent support), openFPGALoader on macOS. Programming a physical Nexys A7-100T was validated on both Windows x64 and Apple-silicon macOS (Phase 4B closeout).

**Classroom setup**
- The FPGA toolchain is a **separate, versioned artifact** (toolchain 1.0): installed once per user with *Install FPGA Toolchain…*, verified file by file against the validated content, and reused by later NexysVHDL updates. Toolchain versions install side by side and are never modified.
- NexysVHDL uses **only** its own toolchain: it never uses or changes GHDL, Apio, Yosys, nextpnr, openXC7 or Python installed elsewhere, never uses `~/.apio`, and never updates tools by itself.
- Show Environment (setup overview), Getting Started walkthrough, welcome actions when no project is open, Verify FPGA Toolchain, Third-Party Notices.
- Windows and macOS project folders, Windows user names and macOS home folders with spaces or non-English letters (e.g. "José García", "王小明") work for the complete workflow.
- Results show device capacities from the data sheet (Nexys A7-100T: 63,400 LUTs, 126,800 flip-flops, 135 block RAMs, 240 DSPs, 210 user I/O).

**License**
- NexysVHDL is licensed under the Apache License 2.0 (`LICENSE`, `NOTICE`). The FPGA toolchain's third-party components keep their own licenses (`THIRD_PARTY_NOTICES.md`).

**Supported systems**
- Windows 10/11 x64 (validated).
- macOS on Apple silicon (validated; no Homebrew, Xcode Command Line Tools or USB driver needed).
- VS Code 1.120 or newer.
