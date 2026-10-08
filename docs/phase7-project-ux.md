# Phase 7 — project UX refinements

Four changes, no new FPGA capability. Toolchain 1.0 and the extension version are untouched.

## 1. Persistence and save-before-exit

Two kinds of state, two homes:

| State | Where | Written |
|---|---|---|
| Top entity, testbench, active XDC, `simulation.stopTime`, source lists, simulation source lists, excluded files (Remove from Project) | `nexysvhdl.json` (single source of truth, unchanged) | the moment each command runs, **atomically** and serialized per file (`core/util/atomic-write.ts`: temp file + rename, one job at a time per file) |
| Design view mode (Files / Hierarchy), waveform selected signals (per testbench), Display As radix, signal-pane width, names-column width, Design Schematic zoom mode / scroll position per level / notes state | `<project>/.nexysvhdl/state.json` (`extension/services/project-state.ts`) | debounced (250 ms), flushed on project switch, window blur, window reload and extension shutdown |

`ProjectState` is the flush abstraction. `update()` is visible immediately and settles when the value is on disk; `flush()` writes what is pending now and waits for a write in flight; a damaged file is ignored (defaults apply); values an earlier version kept in VS Code workspace storage are migrated once. `.nexysvhdl/` is git-ignored, so personal view state is never committed, and it travels with the project folder.

`NexysVhdlService.flush()` completes a debounced re-index (which may carry the source-list update for `nexysvhdl.json`) and awaits queued `nexysvhdl.json` writes. `deactivate()` is `async` and awaits both flushes, so VS Code's shutdown, window-close and window-reload paths wait for them.

**What is *not* done:** `.vhd` / `.xdc` editor buffers are never force-saved on exit; VS Code's own Save / Auto Save / unsaved-document prompt owns them. (Check, Simulate and Build still save the project's dirty source files first, as before, because the tools read from disk.)

Test hook: `NEXYSVHDL_STATE_DEBOUNCE_MS` stretches the write delay so validation can prove that only the exit flush saved the state.

## 2. The `.nvproj` project file

```json
{ "format": "nexysvhdl-project", "version": 1, "config": "nexysvhdl.json" }
```

A launch descriptor, not a copy of the settings. `config` is a path relative to the `.nvproj` (forward or back slashes), never absolute, never containing `.` or `..` segments, and its last segment must be `nexysvhdl.json`; the project root is the folder holding that file. Unknown extra fields and a UTF-8 BOM are accepted; `version` must be an integer ≥ 1, and a newer version is refused with "update NexysVHDL". Rules live in `core/project/nvproj.ts` (TypeScript) and `ProjectCheck` in `launcher/core/LauncherService.cs` (C#, platform-neutral, reused by a future macOS launcher); `tests/nvproj.test.ts` and `launcher/tests/CoreTests.cs` run the same cases.

- **New Project** (Empty and Starter) creates `<name>.nvproj` beside `nexysvhdl.json`.
- **Open Project** accepts a folder, a `.nvproj` or a `nexysvhdl.json` (`extension/project/open-target.ts`).
- **Legacy projects** (no `.nvproj`) open exactly as before. *NexysVHDL: Create NexysVHDL Project File* adds `<folder>.nvproj` on request (the Project view offers it too); it never overwrites a file and touches nothing else.
- **Windows**: `NexysVHDL.exe "<file>.nvproj"` validates the file, resolves the root and opens the folder through the existing launcher path (`Code.exe "<folder>"`): no `vscode://` link, so no VS Code confirmation prompt, and no console window (Windows-subsystem program). A damaged file gets a plain message box and nothing is started.
- **Installer** (`windows/Setup.cs`, `FileAssociation`), HKCU only: `Software\Classes\.nvproj` (default `NexysVHDL.Project`, only if no other program owns `.nvproj`), `.nvproj\OpenWithProgids`, and `NexysVHDL.Project` with `DefaultIcon` = the NexysVHDL icon and `shell\open\command` = `"<install>\NexysVHDL.exe" "%1"`. The uninstaller removes only those values and keys. Test hook: `NEXYSVHDL_ASSOC_CLASSES_KEY` points the code at a scratch registry key.
- **macOS later**: the same descriptor is the document type (`CFBundleDocumentTypes`, `UTExportedTypeDeclarations` for `.nvproj`); the `.app` passes the opened path to `LauncherService.OpenTarget`.

## 3. NexysVHDL Console

An Output channel named **NexysVHDL Console** (`extension/services/console.ts`, VS Code-free; the channel is created in `extension.ts`). It is the single place a student reads workflow messages; the old engineering log is now **NexysVHDL Log** (*Show NexysVHDL Log (details)*), where diagnostic codes, timestamps and log-file paths still go.

```
[Check] Analysing VHDL files...
[Check] PASS

[Build] Starting build...      [Build] Synthesis...      [Build] Implementation...
[Build] Generating bitstream...      [Build] Timing met (531.63 MHz)      [Build] Bitstream ready

[Check] ERROR
no declaration for "missing_signal"
src/broken.vhd:8:14
[Check] FAIL — 1 error
```

Reveal policy: an action reveals the console when it **begins**, and once more if it reports an error or important warning. Nothing else reveals it, so a hidden console is not fought mid-run and the next action brings it back. The terminal is never used. Problems-panel diagnostics are unchanged.

Streaming reuses the existing tool path: `runtime/context.ts` can wrap the shared `ToolRunner` in an `OutputTeeRunner` (`core/process/output-tee-runner.ts`); the console receives live stdout/stderr of GHDL, Yosys, nextpnr and the programmer. Normal output keeps only the testbench `report`/`assert` lines during Simulate; `nexysvhdl.console.detail = detailed` (or *Toggle Detailed Console Output*) streams every tool line under a `|`.

## 4. Design Schematic readability

- Opens as a normal tab in the **active editor group** (`ViewColumn.Active`), at **100%** (or the remembered view). The VHDL a block opens goes **beside** it, so the schematic keeps the full width.
- Toolbar: **100%**, **Fit Width**, **Fit All**, **−**, zoom label, **+**, **Reset**, **Maximize** (`workbench.action.toggleMaximizeEditorGroup`). Fit Width/Fit All never magnify past 150%. Mouse wheel zooms at the pointer, drag pans, Shift+wheel scrolls sideways, native scrollbars show that the diagram continues. The SVG is resized with its `viewBox`, so it stays vector-crisp.
- Layout grew (pin pitch 22, block ≥ 180 × 72, column gap 160, diagram text 12–14 px at 100%), so labels never overlap.
- The notes are a collapsible "About this view".
- Zoom mode, scroll position of every hierarchy level and the notes state are remembered per project and survive the automatic re-render on save (`extension/schematic/schematic-view.ts`).

## Not in scope (deliberately)

No Verilog export. `.nexysvhdl/rtl/generated.v` stays an internal artifact of the RTL flow; it is not listed as a project source and no command exposes it.

## Validation

`npm test`, plus real-VS-Code runs of the packaged VSIX (`tests/integration/phase7-suite.ts`, stages `a`/`b`/`r` persistence, `n` project file, `s` schematic, `c`/`d` console) and the installed launcher (double-click of a `.nvproj`). Run them with `run-phase6.ts` and `NEXYS_P6_SUITE=phase7`; see the header of `phase7-suite.ts`.
