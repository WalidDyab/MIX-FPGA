# Phase 4A — VS Code project workspace and design hierarchy

Date: 2026-10-01/02

**Status**

| Area | Result |
|---|---|
| Phase 4A software / Extension Development Host validation | **PASS** (342/342 tests; real-toolchain EDH runs; visual review accepted by the user) |
| Physical FPGA programming through the extension UI | **DEFERRED** until hardware is available (not failed; not yet validated) |

Branch: `phase4/vscode-workspace` (from `main` at `4680caf`). Not merged.
Host: Windows 11 Home 10.0.26200 x64, Node 24.13.0, npm 11.6.2, VS Code 1.139.1.

Phase 4A is the first real NexysVHDL VS Code extension: the student-facing project and workflow UI over the unchanged Phase 3 backend. The student mental model is:

```
Project → Check → Simulate → Build (Synthesis → Implementation → Bitstream) → Program
```

GHDL, Apio, Yosys, nextpnr, openXC7, djtgcfg, openFPGALoader and the platform workarounds stay implementation details: they never appear in the normal sidebar.

## 1. Project folder standard (ADR-006)

```
CounterDemo/                     ← always a new folder named after the project
├── nexysvhdl.json               student-owned: project settings (Phase 3 model)
├── src/        **/*.vhd         student-owned: RTL sources
├── sim/        **/*.vhd         student-owned: testbenches
├── constraints/ **/*.xdc        student-owned: ordinary XDC
├── .gitignore                   ignores .nexysvhdl/
└── .nexysvhdl/                  NexysVHDL-generated (ADR-001 BuildWorkspace)
    ├── check/  sim/  synth/  impl/  program/  logs/
```

Generated files never go into `src/`, `sim/` or `constraints/`. `.nexysvhdl/` is laid out by the shared `BuildWorkspace` (no second workspace concept).

**Create Project** (`NexysVHDL: Create Project`): parent folder → project name (letter first, then letters/digits/`_`/`-`) → board (Nexys A7-100T) → creates `<parent>/<name>/` with `mkdir` that fails if anything already exists, writes the starter files with exclusive-create, removes the folder again if anything fails, and offers to open it. Defaults: VHDL, VHDL-2008, board `nexys-a7-100t`, top `top`. Starter files:

| File | Content |
|---|---|
| `nexysvhdl.json` | name, board, language, standard, `top: "top"`, sources, simulation (`top_tb`), `constraints` |
| `src/top.vhd` | LED0 blinks while SW0 is on; BTNC restarts the counter (generic `BLINK_BITS`) |
| `sim/top_tb.vhd` | self-checking testbench (small `BLINK_BITS`), `ALL TESTS PASSED (33 checks)` |
| `constraints/nexys-a7-100t.xdc` | Vivado-style XDC generated from `boards/nexys-a7-100t/board.json` (validated pins only), commented for students |
| `.gitignore` | `.nexysvhdl/`, waveforms, OS noise |

No `apio.ini` or backend file is ever written into the project.

**Project detection**: the extension activates on `workspaceContains:nexysvhdl.json` (and on its commands/views). The first workspace folder with `nexysvhdl.json` at its root is the project. It is loaded and validated by the Phase 3 `loadProject()`/`validateProject()`; a malformed file is shown as a project error (Project view, Problems on `nexysvhdl.json`, status bar), never guessed around.

## 2. Activity Bar and sidebar

One Activity Bar container, **NexysVHDL**, with native TreeViews:

| View | Content |
|---|---|
| Project | name, board, standard, top (click → Set Top Entity), constraints file, testbench, Environment summary (click → Show Environment), project-setting problems |
| Project Files | logical groups Sources / Simulation / Constraints; `TOP`, `TESTBENCH`, `IN USE` / `not used` tags |
| Design Hierarchy | entity/instance tree from the top; "Not used by top"; Testbenches; indexer warnings |
| Workflow | Check, Simulate, Build (Synthesis / Implementation / Bitstream), Program with idle/running/passed/failed icons |
| Hardware | board(s), serial numbers, explicit choice among several, detection problems |
| Results | latest Check, Simulation and Build results, log files |

With no project open, the Project view shows Create Project / Open Project buttons and the other views are hidden. A webview is used only for the Design Schematic.

## 3. Project Files vs Design Hierarchy

- **Project Files** shows *files* by role (folder contract). It is a logical FPGA view, not a second Explorer: `.nexysvhdl/` is never shown. Clicking opens the file. Context actions: Set as Top Entity (source files), Set Testbench (simulation files), Use This Constraints File (XDC), Refresh.
- **Design Hierarchy** shows *logical VHDL structure*: `top  TOP → u_clock : clock_divider → …`. Instance label and entity type are distinct. Clicking an instance opens its instantiation line; the root opens the entity declaration. Context actions: Set as Top Entity, Open Design Schematic Here, Go to Entity Declaration.

## 4. Hierarchy indexing

`extension/hierarchy/` is an editor-time indexer, separate from the FPGA tools:

1. `vhdl-lexer.ts` tokenizes: `--` and `/* */` comments, strings with `""`, character literals vs attribute ticks (`clk'event`, `t'('0')`), bit strings (`x"F0"`, `8x"FF"`), extended identifiers, numbers, compound delimiters, with line/column.
2. `vhdl-parser.ts` finds design-unit headers (`entity X is`, `architecture A of E is`, `package [body] P is`, `configuration`, `context`) and parses inside them: interface lists (generics/ports, grouped names, modes, subtype text), component declarations, signal declarations, `use` clauses and concurrent instantiations with their port maps.
3. `design-index.ts` builds the cross-file index (case-insensitive names, compile order, duplicate-entity warnings, VHDL default binding = last analysed architecture).
4. `hierarchy.ts` resolves instances from the configured top; `compile-order.ts` gives the dependency order used for the source lists.

**Supported structural subset:**

| Form | Supported |
|---|---|
| `u : entity work.counter [(arch)] [generic map (…)] [port map (…)];` | yes (library `work`; other libraries shown as *external*) |
| `u : component counter …;` and `u : counter port map (…);` | yes, bound by name to an entity in the project |
| `u : counter;` (no maps, no `component`) | only when it names a known entity/component (else it is a labelled procedure call) |
| component declarations in the architecture or in a project package | yes |
| instances inside `for/if/case … generate` | yes, tagged with the generate label |
| instances inside `block` statements | yes |
| named and positional port-map associations | yes (positional resolved through the entity/component port order) |
| `configuration` instantiation / configuration declarations | shown as unresolved / not followed |
| recursion | detected and stopped |
| comments, block comments, strings, mixed case, multiline headers | handled by the lexer |

It is not a VHDL validator: the Phase 3 GHDL Check is authoritative for correctness.

## 5. Automatic refresh

```
save / create / delete / rename / nexysvhdl.json change
        ↓ (VS Code save event + FileSystemWatchers on nexysvhdl.json, src/**, sim/**, constraints/**)
debounced refresh (300 ms; bursts coalesce)
        ↓
reload nexysvhdl.json → scan folders → re-parse changed files (mtime/size cache)
        ↓
sync source lists (ADR-006) → index → hierarchy → Project Files / Hierarchy / Schematic update
```

Nothing runs while typing; unsaved edits are not indexed. `Refresh Hierarchy` / `Refresh Project` force a refresh. `nexysvhdl.checkOnSave` (default on) additionally runs Check (GHDL analysis only, ~1 s) after saving a project VHDL file, so Problems updates on save. A Check requested while one runs joins it; Build/Simulate/Program wait for an automatic check to finish. Build never runs automatically.

## 6. Top entity

The configured top is marked `TOP` in Project Files and in the hierarchy root, and shown in the Project view (with a warning if it is not found). `Set Top Entity` (palette: QuickPick of `src/` entities; context menu on hierarchy entities or source files) writes `top` into `nexysvhdl.json` through the core `updateProjectFile()` (keeps every other field and the key order), stored with the declaration's spelling, then refreshes. Entities in `sim/` are refused as top.

## 7. Direct XDC model

- `constraints/**/*.xdc` files are discovered and listed; the one named by `nexysvhdl.json` → `constraints` is `IN USE`.
- The file is ordinary, editable Vivado-style XDC. NexysVHDL never rewrites it; Build stages a normalized copy (`get_ports {name}`) into `.nexysvhdl/impl/generated.xdc`.
- Build fails at the constraints step, before implementation, if a top-level port bit has no `PACKAGE_PIN` (`XDC_PORT_UNCONSTRAINED`, located in the XDC file → Problems).
- Projects with `pins` still work ("Generated from pins"); "Use This Constraints File" switches after a confirmation that removes `pins`.

## 8. Workflow states

Every action is `idle → running → passed | failed` (or `unavailable` when its tools are not set up, or back to `idle` "Cancelled"). One action runs at a time. Before an action the extension saves the project's dirty editors and re-syncs/validates the project. Check, Simulate, Build and Program call the shared core directly (no `nexysvhdl` CLI process).

## 9. Synthesis / Implementation / Bitstream

| Stage | Student meaning | Backend work (hidden) | Running while |
|---|---|---|---|
| Synthesis | VHDL → logic netlist (LUT, FF, BRAM, DSP) | validate, GHDL check, GHDL `--synth`, Yosys `synth_xilinx` | from Build start until the backend starts placement |
| Implementation | placement, routing, pins, timing | constraints step, nextpnr-xilinx | nextpnr running |
| Bitstream | implemented design → `hardware.bit` | fasm2frames, xc7frames2bit | until Apio finishes |

Live progress comes from two additive core hooks: `ToolInvocation.onOutput` (streamed output; NodeToolRunner, also passed through the macOS pinned runner) and `BuildOptions.onProgress` (`step-started`, `step-finished`, `implementation-stage` from the Apio command echo lines). The final stage states come from the `BuildResult` (`steps`, new `implementationStage`, `timing`): a failure marks the stage it happened in and leaves later stages not run; failed timing fails Implementation and the build even though a bitstream exists. Tool names appear only in the logs.

**Results** shows Timing PASS/FAIL, target and achieved MHz per clock, worst slack, LUTs / Flip-Flops / BRAM / DSP (`used / available`), I/O, the bitstream, and log files, all from the actual `BuildResult`; an unreported value is shown as "not reported".

## 10. Problems integration

Structured Phase 3 diagnostics → `vscode.DiagnosticCollection("nexysvhdl")`: file (project-relative → absolute), 1-based line/column → 0-based range widened to the token at the column, severity, message, `code`, source `NexysVHDL (vhdl|project|board|…)`. Unlocated project/build errors go on `nexysvhdl.json`. Diagnostics are grouped by producing operation (`project`, `vhdl`, `build`), each replaced when its operation runs again, so fixed errors disappear. Testbench `report` notes are not problems. The **NexysVHDL** log OutputChannel (`Show Log`) has every operation, diagnostic and raw log path.

## 11. Hardware view and Program

- Detection runs on project open (setting `nexysvhdl.detectBoardsOnOpen`), on Refresh, and before Program if needed, through `ProgrammingService.detectBoards()`.
- States: not checked, looking, programmer not set up, no board ("Connect your board by USB and turn it on."), one board (name + serial), several boards (explicit choice; the selection survives only while that board stays connected). Structured detection warnings (e.g. JTAG chain unavailable) are listed; info-level notes are not.
- **Program** loads the canonical bitstream and calls the shared `ProgrammingService` (SRAM only); the platform adapter (Windows djtgcfg / macOS openFPGALoader) is selected by the core composition root. It refuses (and offers Build) when there is no bitstream or the last build in this session failed, asks when the bitstream is older than the sources/constraints/`nexysvhdl.json`, and asks for a board when several are connected and none is selected — never choosing silently.

## 12. Status bar

`NexysVHDL: Ready` / `Setup required` / `Project error` / running action with stage (click: sidebar), `Nexys A7 ●/○` (click: detect boards), `Build ✓/✗` after a build (click: Results).

## 13. Design Schematic

`Open Design Schematic` (Hierarchy title bar, Workflow after a passed Check, hierarchy context menu, palette) opens a webview with a component-level block diagram of one hierarchy level:

- the level's entity as a frame, its input ports on the left edge and outputs on the right;
- one block per instantiation: instance label, entity name, its ports (from the entity declaration, else the component declaration);
- wires for connections the port maps state: entity port ↔ block pin and block pin ↔ block pin through a declared signal (positional associations resolved);
- labelled stubs for pins connected to literals/expressions and for signals that are only driven or used by logic in the architecture;
- blocks placed in data-flow columns; feedback edges ignored for placement.

Click a block → its instantiation; ⤵ → that block's own schematic; breadcrumb → back up. It re-renders on every index refresh (on save). A banner says when Check has not passed. Zoom/pan/fit; theme colours.

**Design Schematic vs RTL Schematic** (both are Phase 4A; see §21 for the RTL Schematic):

| | Design Schematic | RTL Schematic |
|---|---|---|
| Question it answers | How is my design *structured*? | What hardware does my VHDL *infer*? |
| Source | editor-time VHDL index (no tools) | GHDL synthesis → Yosys generic RTL netlist |
| Shows | entities, instances, port-map connections | registers, muxes, adders, comparators, gates, constants, slices/concatenations, retained instances |
| Not shown | assignments/processes (logic) | placement, routing, LUTs (no technology mapping) |
| Available | always (banner until Check passes) | after a passed Check, generated on demand |

A later *implemented/technology-mapped* schematic (LUTs, carry chains after `synth_xilinx`) remains out of scope.

It does **not** draw connections made through assignments or processes (e.g. `led0 <= count(26) and sw0;` is logic, not a wire between blocks), does not expand generate loops into copies, and does not show generics.

## 14. Extension-to-core boundary

```
VS Code API            extension.ts, views/, commands/, status/, diagnostics/vscode-diagnostics.ts, schematic/schematic-panel.ts
      │
NexysVHDL services     services/ (NexysVhdlService, workflow/hardware state, results, environment summary)
(no VS Code API)       project/, hierarchy/, schematic model + SVG, diagnostics/problems.ts
      │  NexysBackend (services/backend.ts → CoreBackend)
shared composition     runtime/ (context, environment, bitstream) — also used by the CLI
      │
Phase 3 core           core/ (WorkflowController, ProgrammingService, GHDL/Apio providers, project model)
      │
platform adapters      platform/windows, platform/macos
```

`tests/extension/architecture.test.ts` enforces: no `child_process` or tool runner in `extension/`, no platform/tool binary names, no `process.platform`/`win32`/`darwin`, platform code only through `runtime/`, and no VS Code API in the service/project/hierarchy/schematic-model layers. The CLI's composition root moved from `cli/context.ts` to `runtime/context.ts` (re-exported unchanged), and doctor's data collection to `runtime/environment.ts`, so the extension reuses rather than duplicates them.

## 15. Phase 3 core changes (additive)

| Change | Why |
|---|---|
| `ProjectFile.constraints`, optional `pins`, validation codes `PROJECT_CONSTRAINTS_*` | direct XDC (ADR-006) |
| `core/board/xdc.ts`: normalization, PACKAGE_PIN parsing, netlist port reading, `checkPortConstraints()` | direct XDC, unconstrained-port guard |
| `WorkflowController` constraints step reads the project XDC; port check for both sources; `constraintsSource` in `BuildResult` | direct XDC |
| `ToolInvocation.onOutput`, `ImplementationRequest.onStage`, `ImplementationResult.reachedStage`, `BuildOptions.onProgress`, `BuildResult.implementationStage`, Apio stage parsing | live and final build stages |
| `PROJECT_FOLDERS`, `updateProjectFile()`, `formatProjectFile()` | folder contract, Set Top Entity, source sync |
| `runtime/` extracted from `cli/` | shared composition root |
| `core/rtl/`: `RtlProvider`, `ApioYosysRtlProvider`, `RtlAnalysisResult`; `WorkflowController.rtl()`; `WorkspacePaths.rtl`; `SynthesisOptions.outputDir`; artifact kind `rtl-netlist`; workflow step `rtl` | RTL Schematic (§21.2) |
| `SimulationOptions.vcd`, `SimulationResult.vcd` (sha256), `VCD_FILE`; `WorkflowController.simulate()` requests VCD | Waveform Viewer (§21.3) |

All 222 Phase 3 tests still pass; the workspace test now expects the additional `rtl/` folder (8 distinct folders instead of 7); one CLI fixture whose fake netlist ports did not match its pin mapping was made consistent.

## 16. Tests

`npm test` = build + `node --test`; it never launches VS Code and needs no FPGA tools or hardware (`trapProcesses`, fake platform/runner; `tests/test-isolation.test.ts` now also forbids an un-isolated `CoreBackend`). VS Code adapters are tested against `tests/extension/vscode-fake.ts`.

| File | Covers |
|---|---|
| `tests/extension/project.test.ts` | standard tree, never writes outside, duplicate folder, names, detection/malformed, folder classification, Project Files grouping, XDC discovery, source sync |
| `tests/extension/hierarchy.test.ts` | lexer, entities, architectures, direct/component instantiation, comments/multiline, case-insensitivity, configured top, unreachable, unresolved/external/recursive, compile order |
| `tests/extension/service.test.ts` | refresh after save (debounced), manual refresh, Set Top, constraints selection, workflow transitions, one-at-a-time, check-on-save, join/wait, Simulate testbench choice, build stages, board states, multiple-board choice, program guards |
| `tests/extension/workflow-state.test.ts` | state and build-stage transitions, failure stages, timing failure, hardware selection |
| `tests/extension/schematic.test.ts` | schematic model, honest connectivity, positional associations, stubs, layout, SVG |
| `tests/extension/vscode-adapters.test.ts` | diagnostic conversion and publishing, tree views |
| `tests/extension/architecture.test.ts` | extension boundary rules; backend uses the shared core and platform runner; not-configured without tools |
| `tests/xdc.test.ts` | XDC normalization/parsing/port check, validation, controller XDC path, Apio stage tracking, project writer |
| `tests/extension/rtl.test.ts` | RTL artifacts only under `.nexysvhdl/rtl`, GHDL synth + generic Yosys script, no place/route/`apio build`, student tree untouched, Yosys JSON parsing, ports, registers, MUX, arithmetic, comparison, logic, constants/slices/concatenation/net names, generic fallback, instances/drill-down, exact-only source mapping, real EdhDemo netlist (AND of `sw0` and `blink` into `led0`; counter register/adder/mux feedback), layout/SVG/page, check gating, laziness, staleness, failure reporting |
| `tests/extension/waveform.test.ts` | VCD timescale/header, nested scopes, scalars, vectors (glued/separate range), aliases, x/z/U, left-extension, redundant-transition collapse, real GHDL VCD, cursor lookup, binary/hex formatting, segment reduction, time/ticks/clamping, webview data + page/CSP, `SimulationResult.vcd` (path in `.nexysvhdl/sim`, sha256, GHW kept), student tree untouched, new identity on re-simulation |
| `tests/extension/language.test.ts` | `.vhd`/`.vhdl` → `vhdl`; language configuration (comments, brackets, auto-closing, indentation, folding, word pattern); every grammar regex compiles; required vocabulary scopes, case-insensitive; declarations, instance labels, attribute ticks |

Result: **342 tests, 342 pass, 0 fail** (222 Phase 3 + 85 Phase 4A workspace + 35 RTL/waveform/language). `npm run typecheck`: clean.

## 17. Extension Development Host validation

`tests/integration/edh-suite.ts` runs inside a real VS Code 1.139.1 Extension Development Host (`node dist/tests/integration/run-edh.js <Code.exe> <create|project> <folder> <report.json>`; private user-data and extensions folders), with the real toolchain. Two phases on a fresh folder, both **completed**:

- Create Project (dialogs scripted): new `EdhDemo/` only, correct tree and `nexysvhdl.json`; duplicate name refused.
- Project: activated on open; detected, validation clean; Project Files `src/top.vhd TOP`, `sim/top_tb.vhd`, `constraints/nexys-a7-100t.xdc IN USE`; new `src/blink_counter.vhd` appeared via the watcher (listed as not used by top); a structural edit saved in the editor gave `top → u_blink : blink_counter` and the dependency-ordered source list; manual Refresh Hierarchy; clicking the instance opened `top.vhd` line 28 at `u_blink : entity work.blink_counter`; Set Top Entity wrote `blink_counter` to `nexysvhdl.json` and back; Check passed (top, top_tb); a removed `;` gave 2 GHDL errors in Problems at 32:26 after save, cleared after fixing and saving; Simulate passed at 660 ns (33 checks); Build passed with live stages `running/idle/idle → passed/running/idle → passed/passed/running` → all passed: 57 LUTs, 27 FFs, BRAM 0, DSP 0, timing PASS 409.67 MHz (target 100 MHz), constraints from the XDC file; Design Schematic tab opened with `u_blink : blink_counter`, nets `clk`, `btnc→reset` and the `blink` stub; Environment Ready (GHDL, Apio, openXC7, Programmer); nothing generated outside `.nexysvhdl/`; hardware detection: no board connected at that time.
- Findings fixed during validation: a user Check colliding with check-on-save ("Check is still running") → Check now joins, other actions wait; the first run also showed the host auto-updating an extension in the shared extensions folder → runs now use a private `--extensions-dir`.

## 18. Physical FPGA validation

**DEFERRED** until hardware is available. The Nexys A7 was not available during Phase 4A, so Build → Program through the extension UI on a real board, with the user confirming the LED behaviour (LED0 blinks while SW0 is on; BTNC restarts the counter), has not been performed. This is recorded as deferred, not as a failure, and must not be read as a physical PASS.

What was validated without the board: Build through the extension UI with the real toolchain (bitstream produced, timing PASS 409.67 MHz), board detection through the shared ProgrammingService ("No Nexys A7 detected"), and the Program flow's guards in unit tests (no bitstream, failed build, stale bitstream, several boards). The programming backends themselves were validated on real hardware in Phase 3 (Windows and macOS).

To complete it: connect the board, open a project in the Extension Development Host, run Workflow → Build, then Workflow → Program, and confirm the LED behaviour.

## 19. Known Phase 4A limitations

- Single board (Nexys A7-100T), VHDL-2008 only, one project per window (first workspace folder with `nexysvhdl.json`).
- The indexer covers the structural subset in §4; unusual constructs (configurations, instances via `configuration`, external names) are shown as unresolved, not followed. The schematic draws port-map connections only.
- GHDL reports some errors as two diagnostics at one location (`';' expected …` and `(found: 'end')`); they are shown as GHDL reports them.
- Build is a full clean implementation every time (ADR-001); progress inside each stage is not quantified.
- No toolchain installer: tools must already be installed as on the validated development machines; Show Environment explains what is missing.
- Not packaged as a VSIX, not published; Extension Development Host only.

## 19a. Limitations of the RTL Schematic, Waveform Viewer and VHDL grammar

- RTL Schematic: generic Yosys cells after `proc`/`opt_clean`, not the mapped FPGA netlist; module hierarchy is GHDL's (modules named like `blink_counter_Brtl_26`, shown with the entity name); edges are word-level, so bit-level fan-out inside a bus is summarised by slice labels; the automatic layout is column-based and can become busy for large modules (zoom/pan help); feedback is drawn dashed under the blocks; constants are drawn per use.
- Source links exist only for cells whose Verilog statement GHDL marked; others say "not known exactly".
- Waveform Viewer: digital traces only (no analog, no decimal/signed radix yet), one cursor, no markers/measurements, no signal search, signals are shown in hierarchy order; the whole VCD is loaded into the webview (fine for teaching-sized runs; very long simulations will be slow); VHDL integers/enums appear only as GHDL dumps them; the viewer never shows a waveform whose hash differs from the latest SimulationResult.
- The grammar is a highlighting aid only; GHDL Check stays authoritative. It does not try to scope every VHDL-2008 construct (e.g. PSL, external names).

## 20. Phase 4B handoff

- Graphical pin assignment: map top-level VHDL ports (already parsed by the indexer: names, modes, vector types) to board resources (extend `boards/nexys-a7-100t/board.json` with validated LEDs, switches, buttons, seven-segment, RGB LEDs, Pmods), and write/update the project's real XDC (`constraints/`). `xdcPinAssignments()` reads existing assignments; `checkPortConstraints()` already reports unconstrained/unknown ports.
- Keep the XDC readable (comments, Vivado style); keep normalization in the core.
- Optional editor-time XDC lint using the indexer's top ports (Problems on save, before Build).
- The macOS instance should run `tests/integration/edh-suite.ts` and the physical Program step on Apple silicon.

## 21. RTL Schematic, Waveform Viewer and VHDL language support (Phase 4A additions)

### 21.1 VHDL language support

NexysVHDL contributes the `vhdl` language itself (`.vhd`, `.vhdl`), so a student needs no third-party VHDL extension:

- `resources/vhdl/vhdl.tmLanguage.json`: a NexysVHDL-owned TextMate grammar written for this project (not derived from a third-party grammar). Scopes: design units and their names (entity/architecture/configuration/package/component, instance labels with library and entity), `begin`/`end`/`process`/`generic`/`port`/`map`/`library`/`use`, control (`if`/`then`/`elsif`/`else`/`case`/`when`/`loop`/`for`/`while`/`generate`/...), declarations (`signal`/`variable`/`constant`/`function`/`procedure`/`type`/`subtype`), modes (`in`/`out`/`inout`/`buffer`), standard types (`std_logic`, `std_logic_vector`, `signed`, `unsigned`, `integer`, `natural`, `positive`, `boolean`, ...), standard functions (`rising_edge`, `falling_edge`, `to_integer`, `resize`, ...), attributes (`'event`, `'length`, ...), decimal/based/real numbers, bit strings (`x"F0"`, `8x"FF"`), strings, character literals (not attribute ticks), word and symbol operators, `--` and `/* */` comments. Case-insensitive.
- `resources/vhdl/language-configuration.json`: `--` line and `/* */` block comments, brackets, auto-closing/surrounding pairs, VHDL word pattern, indentation rules (`is`/`begin`/`then`/`else`/`loop`/`generate`/`when … =>` in, `end`/`elsif`/`else`/`begin`/`)` out, case-insensitive), `-- region` folding markers (plus indentation folding).
- Verified in the private Extension Development Host (only built-in extensions present): `src/top.vhd`, `src/blink_counter.vhd` and `sim/top_tb.vhd` open as language `vhdl` and VS Code's own tokenizer (`_workbench.captureSyntaxTokens`) reports grammar scopes (e.g. `entity` → `keyword.other.unit.vhdl`, `signal` → `storage.type.vhdl`, `std_logic` → `support.type.std.vhdl`, `rising_edge` → `support.function.vhdl`, comments → `comment.line.double-dash.vhdl`); 91/157, 101/173 and 231/415 tokens carry a grammar scope. Screenshot: `images/phase4a/vhdl-highlighting.png`.

### 21.2 RTL Schematic

`NexysVHDL: Open RTL Schematic` (Workflow → Check → *Open RTL Schematic*; Design Hierarchy item and title-bar button; palette).

Pipeline (analysis only, no implementation):

```
VHDL sources ──GHDL --synth──▶ .nexysvhdl/rtl/generated.v   (GHDL keeps /*# file:line:col */ comments)
             ──apio raw -- yosys -q -p "read_verilog generated.v; hierarchy -check -top <top>; proc; opt_clean; write_json rtl.json"
             ──▶ .nexysvhdl/rtl/rtl.json   (generic RTL cells, module hierarchy retained)
             ──▶ extension/rtl/rtl-model.ts (student-level nodes/edges)  ──▶ rtl-svg.ts (own SVG renderer) ──▶ webview
```

- Shared core: `WorkflowController.rtl()` (validate → workspace → `VhdlProvider.synthesize(ctx, { outputDir: rtl/ })` → `RtlProvider.elaborate()`), new `RtlProvider` contract and `ApioYosysRtlProvider` (Yosys reached through `apio raw` like the toolchain detector, via the platform-configured runner, so the macOS Apio pin applies), `WorkspacePaths.rtl`, `RtlAnalysisResult`, logs `ghdl-rtl-synth.log` and `yosys-rtl.log`. No `synth_xilinx`, techmap, nextpnr, `apio build` or bitstream. No Graphviz. The extension calls it through `NexysBackend.rtl()`.
- Availability: only after a **passed Check**; generated lazily on first open (Check alone never synthesizes); ~1.8 s for EdhDemo. If Check has not run, the command runs it first; if Check failed it says so and offers Problems. The view tracks a design revision and shows "The VHDL changed since this RTL schematic was generated — Regenerate" instead of silently showing a stale circuit.
- Model: Yosys bits are grouped into word-level edges; a pin fed by several sources gets an explicit concatenation node `{ }` with `[hi:lo]` labels; partial use of a bus is labelled with a slice (e.g. `count[26]`); constant bits become constant nodes (`'1'`, `8'b…`, `27'h0000001`); edges are labelled with the VHDL signal name when the netlist names it (GHDL temporaries `n9`, `n14`, … are hidden).
- Supported cells (student label, raw type in details):

| Student element | Yosys cells |
|---|---|
| Register (width, rising/falling edge, clk/en/rst pins) | `$dff $dffe $adff $adffe $sdff $sdffe $sdffce $aldff $aldffe $dffsr $dffsre $ff`, `$_DFF*` |
| Latch (highlighted: often unintended) | `$dlatch $adlatch $dlatchsr` |
| MUX (inputs 0 / 1 / sel), DEMUX | `$mux $pmux $bmux $demux` |
| Arithmetic `+ − × ÷ mod −x **` | `$add $sub $mul $div $mod $neg $pow` |
| Comparators `= ≠ < ≤ > ≥` | `$eq $ne $eqx $nex $lt $le $gt $ge` |
| Logic AND / OR / XOR / XNOR / NOT | `$and $or $xor $xnor $not $logic_not $logic_and $logic_or` |
| Reductions (AND/OR/XOR/XNOR of all bits, ≠ 0) | `$reduce_and $reduce_or $reduce_xor $reduce_xnor $reduce_bool` |
| Shifts `<< >> <<< >>>` | `$shl $shr $sshl $sshr $shift $shiftx` |
| Buffer | `$pos $buf` |
| Instance (drill-down ⤵ when the module is in the netlist) | any non-`$` cell type |
| Generic block with raw type (never guessed) | any other cell |
| Ports, constants, concatenation `{ }`, slices, named nets | netlist ports/bits/netnames |

- Source navigation: a block links to VHDL only when GHDL's `/*# file:line:col */` comment sits directly above the Verilog statement that the Yosys `src` attribute points to, and the file is inside the project; otherwise the details say "not known exactly". Nothing is fabricated.
- Layout/UX: inputs left, outputs right, logic in data-flow columns; loops are broken at register outputs inside a feedback loop (a counter reads `+ → MUX → Register` with the register output drawn dashed back under the blocks). Shapes: register box with clock mark, MUX trapezoid, operator circles, rounded gates, dashed constant boxes, concatenation bars, double-bordered instances, dashed generic blocks. Zoom (+/−/wheel), pan (drag), Fit, click a block for details (description, raw cell, width, pins, parameters, VHDL link), ⤵ / breadcrumb for hierarchy, legend, Regenerate. Panels open as tabs in editor column 2; in narrow columns the details/legend move under the drawing.

**EdhDemo result** (real tools, real EDH; screenshots `images/phase4a/rtl-schematic-top.png`, `rtl-schematic-blink-counter.png`):
- `top`: inputs `clk`, `btnc`, `sw0`; instance `u_blink : blink_counter`; **AND** with inputs `u_blink.q` (net `blink`) and `sw0`, output to port `led0`, linked to `src/top.vhd:32:19` (`led0 <= blink and sw0;`). The Design Schematic of the same design draws no net into `led0` and only a `blink` stub, because that relationship is an assignment, not a port map: this is exactly the logic the RTL view adds.
- `blink_counter` (drill-down): `+` (27 bits, `count + 27'h0000001`, `blink_counter.vhd:23:32`) → **MUX** (`reset` selects `27'h0000000`, `:20:13`) → **Register** (27 bits · rising edge, `:19:9`) → output `q = count[26]`, register output fed back to the adder.

### 21.3 Waveform Viewer

`NexysVHDL: Open Waveform` (Workflow → Simulate → *Open Waveform* after a simulation; "Open Waveform" button on the simulation result message; palette).

- VCD generation: `SimulationOptions.vcd`; the GHDL provider adds `--vcd=.nexysvhdl/sim/waveform.vcd` next to the existing `--wave` (GHW kept). `SimulationResult.vcd` is a `waveform` BuildArtifact with size and sha256. The sim folder is recreated each run, so an old VCD cannot survive a new simulation. The CLI prints the VCD path too.
- Parser (`extension/waveform/vcd-parser.ts`, pure): token state machine for `$date $version $timescale $comment $scope $upscope $var $enddefinitions`, `$dumpvars/$dumpall/$dumpon/$dumpoff`, `#time`, scalar values (0/1/x/z and VHDL U/X/W/L/H/- mapped to 0/1/x), vectors `b…` left-extended per IEEE 1364, reals `r…`, ranges glued (`count[3:0]`) or separate, aliases (shared identifier codes), nested scopes (GHDL's empty package scopes pruned); consecutive equal values and repeated changes at one time are collapsed; problems become warnings, not crashes.
- Rendering helpers (`wave-render.ts`, no imports): cursor lookup (binary search), binary/hex formatting with x/z, time formatting, nice ticks, view clamping and pixel-level segment reduction (changes closer than 2 px merge into a dense segment, so drawing cost scales with the canvas width, not with the number of events). The compiled file is loaded into the webview unchanged, so the tested code is the drawing code.
- Viewer: scope tree with expand/collapse and show/hide checkboxes (hidden automatically in narrow columns), signal names with the value at the cursor, canvas timeline with time axis, scalar traces (high/low, x shaded red, z mid-line) and bus traces (hexagon segments with the value when it fits), Fit / + / − / ◀ ▶ / wheel zoom around the mouse / drag pan / shift-wheel pan / arrow keys, click to place the cursor, hex/binary for buses. Small dumps (≤ 40 signals) show every signal initially; larger ones show the testbench and its direct children.
- Identity and refresh: the header shows testbench, run number, finish time, stop time, VCD path and the first 8 hex digits of its sha256. After every Simulate an open viewer reloads automatically; while a new simulation runs it shows "Simulating… this waveform (run N) will be replaced"; a VCD whose hash no longer matches the latest SimulationResult is refused; a failed simulation shows its waveform with a "this simulation failed" banner; a simulation without a VCD shows a message, never the previous waveform.

**EdhDemo result** (real GHDL VCD, real EDH; screenshots `images/phase4a/waveform.png`, `waveform-fit.png`): 14 signals shown — `top_tb.clk/btnc/sw0/led0/running`, `dut.clk/btnc/sw0/led0/blink`, `dut.u_blink.clk/reset/q/count[3:0]`; initial view 0–660 ns; cursor at 95 ns gives `clk=1 btnc=0 sw0=0 led0=0 blink=1 q=1 count[3:0]=8` (hex) / `1000` (binary) — consistent with `led0 = blink and sw0`; zoom in 47.5–377.5 ns, pan 130–460 ns, Fit back to 0–660 ns; a second simulation replaced run 2 by run 3 (new sha256) in the open viewer.

### 21.4 EDH validation of the additions

Run with the private profile and a private `--extensions-dir` (installed extensions: only VS Code's built-ins). Both phases completed, plus a screenshot phase captured with Win32 `PrintWindow` of the Extension Development Host window only. Check passed; Design Schematic still opens; RTL Schematic opened (`RTL: top`), webview reported 6 nodes / 5 wires, canvas 352×479, Fit 0.454 → zoom 0.544 → Fit 0.454, selecting the AND worked; drill-down to `blink_counter` worked; Simulate passed (660 ns, 33 checks); Waveform as above; Build still passed (57 LUTs, 27 FFs, 409.67 MHz); `.nexysvhdl/rtl` holds `generated.v rtl.json`, `.nexysvhdl/sim` holds `top_tb.ghw waveform.vcd work-obj08.cf`; the project root contains only `.gitignore .nexysvhdl/ constraints/ nexysvhdl.json sim/ src/`.

Bugs found and fixed during this validation: (1) the RTL page re-rendered on every service event, dropping messages → it now re-renders only when its content changes; (2) Fit on a not-yet-laid-out canvas set scale 0, after which zoom did nothing (also in the Design Schematic) → fit waits for a sized canvas and never sets scale ≤ 0; (3) in a narrow third editor column the fixed details pane squeezed the RTL canvas to width 0 → responsive layout, and all diagram/waveform panels now open as tabs in column 2; (4) the first counter layout put the register first with a long loop → loops are broken at register outputs.
