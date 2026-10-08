# NexysVHDL launcher

A small desktop application so a student starts NexysVHDL like any other app (Start Menu, Desktop shortcut) instead of opening VS Code first. NexysVHDL itself stays a VS Code extension; the launcher only opens VS Code for you. It does not fork or redistribute VS Code and does not contain or change the FPGA toolchain.

```
NexysVHDL.exe (window)  ── New Project ───────► vscode://emxplore.nexysvhdl/newProject ─► the extension's own "Create Project"
                        ── Open Project / Recent ► Code.exe "<folder>"  (the extension activates: the folder holds nexysvhdl.json)
                        ── Install NexysVHDL ──► Code's own CLI (cli.js) --install-extension nexysvhdl.vsix   (hidden, only on click)
NexysVHDL-Setup.exe     ── per-user install: Start Menu, optional Desktop shortcut, "Apps & features" entry
```

## Layout

| Folder | Role | Reused for macOS? |
|---|---|---|
| `core/` | `LauncherService` (what can be opened, what to tell the student), `RecentProjects` (JSON state), `ProjectCheck`, `Json`, `IPlatform` | **yes**, unchanged (plain C#, no Windows API; the architecture test enforces it) |
| `windows/WindowsPlatform.cs` | `IPlatform` for Windows: finds VS Code, starts processes hidden, reads per-user folders | replace |
| `windows/FolderPicker.cs`, `MainForm.cs`, `Program.cs` | the window and the shell folder dialog | replace (same screens and wording) |
| `windows/Setup.cs` | the installer | replace (a `.pkg` / drag-to-Applications `.app`) |
| `tests/CoreTests.cs` | tests of `core/` against a fake platform | reuse |

Built with the C# compiler that ships with Windows (.NET Framework 4, `csc.exe`): no SDK and no downloads. `node scripts/launcher/build-windows.mjs [--vsix file]` writes `.artifacts/launcher/NexysVHDL-Setup.exe` (about 370 KB, containing the launcher, the extension VSIX and the icon).

## Contracts

- **Project**: a folder containing `nexysvhdl.json`, or a `.nvproj` project file next to it. Anything else gets a friendly message and nothing is launched.
- **Project file** (`ProjectCheck.ResolveProjectFile`, same rules as `core/project/nvproj.ts`): `{ "format": "nexysvhdl-project", "version": 1, "config": "nexysvhdl.json" }`; `config` is relative to the file and stays inside its folder. Windows runs `NexysVHDL.exe "<path>.nvproj"` for a double-click; the launcher validates it and opens the project folder with `Code.exe "<folder>"` (never a `vscode://` link, so VS Code shows no confirmation). A damaged, foreign, newer or unsafe file is explained in a message box. Moving or copying the whole project folder keeps working.
- **File association** (`windows/Setup.cs`, `FileAssociation`, HKCU only): `.nvproj` -> `NexysVHDL.Project` (only if no other program owns `.nvproj`; otherwise NexysVHDL is offered under Open with), the NexysVHDL icon, `"<install>\NexysVHDL.exe" "%1"`. Uninstalling removes only what Setup wrote. A macOS `.app` registers the same document type and calls `LauncherService.OpenTarget`.
- **Recent projects**: `%APPDATA%\NexysVHDL\Launcher\recent-projects.json` (`{ "version": 1, "projects": [ { "path", "name", "lastOpenedUtc" } ] }`, newest first, at most 10). Per user; nothing is written into a project. Deleted folders are listed as "missing" and dropped when chosen.
- **VS Code discovery** (never PATH): `NEXYSVHDL_VSCODE_PATH` (tests), `%LOCALAPPDATA%\Programs\Microsoft VS Code`, `%ProgramFiles%`/`%ProgramW6432%`/`%ProgramFiles(x86)%` `\Microsoft VS Code`, the uninstall registry keys (HKCU/HKLM, 64/32-bit) and `App Paths\Code.exe`. VS Code Insiders is not used.
- **Extension detection**: `~\.vscode\extensions\emxplore.nexysvhdl-<version>*`, highest version, ignoring folders listed in `.obsolete`.
- **Toolchain**: reads only the marker `%LOCALAPPDATA%\NexysVHDL\toolchains\win32-x64\1.0\.nexysvhdl-installed.json`. A missing toolchain is shown, not fixed: the extension's own install flow offers it when a project opens.
- **Extension link** (`extension/commands/uri-routes.ts`): `/newProject`, `/gettingStarted`, `/showEnvironment` only. VS Code asks the student once to allow the extension to open the link (and offers "Do not ask again"); that prompt is VS Code's and is not bypassed.
- **No terminal**: both programs are Windows-subsystem executables; every child process is started with `CreateNoWindow` (the extension install runs `Code.exe cli.js` with `ELECTRON_RUN_AS_NODE=1`, exactly like VS Code's own `code.cmd`, but directly).
- **Appearance and settings**: the launcher never reads or writes VS Code settings. The Classroom appearance question belongs to the extension and applies at workspace scope.
- **Workspace Trust**: VS Code asks whether to trust a folder the first time it is opened. NexysVHDL needs a trusted folder (the extension declares it does not support untrusted workspaces); the launcher does not change that setting.

## Test hooks (environment variables, tests only)

`NEXYSVHDL_LAUNCHER_STATE_DIR`, `NEXYSVHDL_LAUNCHER_FORCE_NO_VSCODE=1`, `NEXYSVHDL_VSCODE_PATH`, `NEXYSVHDL_VSCODE_EXTENSIONS_DIR`, `NEXYSVHDL_VSCODE_USER_DATA_DIR`, `NEXYSVHDL_LAUNCHER_DATA_ROOT`, `NEXYSVHDL_LAUNCHER_MESSAGE_FILE` (write a problem message to a file instead of a dialog), `NEXYSVHDL_ASSOC_CLASSES_KEY` (scratch registry key for the file association); and the command-line switches `<project>.nvproj`, `--open <folder or .nvproj>`, `--new-project`, `--status-report <file>`.

## Installer switches

`/S` silent, `/desktop`, `/noextension`, `/nolaunch`, `/dir=PATH`, `/uninstall` (also `Uninstall.exe`). Uninstalling removes the application, its shortcuts, its `.nvproj` association and its Apps entry; it keeps projects, the recent list, the VS Code extension and the toolchain.
