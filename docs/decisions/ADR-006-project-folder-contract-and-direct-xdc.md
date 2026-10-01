# ADR-006: Project folder contract and direct XDC constraints

Status: accepted (Phase 4A)

## Context

Phase 3 projects listed their RTL sources explicitly and described pins only as a JSON mapping (`pins`), from which NexysVHDL generated the XDC. For the student interface:

- Students create, rename and delete VHDL files from the editor. A source list they must maintain by hand gets out of date, and GHDL needs the files in dependency order (a package before its users, an entity before a file that instantiates it with `entity work.x`).
- Course material, Digilent's master files and Vivado all use ordinary XDC. A pin mapping hidden in JSON is not pedagogically useful, and Phase 4B's graphical pin tool needs a real file to read and update.
- nextpnr-xilinx's XDC reader asserts on `[get_ports { name }]` (spaces inside the braces, Phase 1), which is exactly the form the Digilent master files use.

## Decision

1. **Folder contract.** A NexysVHDL project is one folder: `nexysvhdl.json`, `src/` (RTL), `sim/` (testbenches), `constraints/` (XDC) are student-owned; `.nexysvhdl/` holds everything NexysVHDL generates (the ADR-001 build workspace). Create Project always makes a new folder named after the project and never writes outside it.
2. **Source lists follow the folders.** The extension keeps `sources` and `simulation.sources` in `nexysvhdl.json` equal to `src/**/*.vhd` and `sim/**/*.vhd`, in dependency order computed by its structural VHDL indexer. The sort is stable (an existing order is kept unless a dependency forces a change), files listed outside the standard folders are kept, and the file is written only when the lists change. `nexysvhdl.json` remains the single project description: the CLI and the extension build the same thing.
3. **Direct XDC.** `ProjectFile.constraints` names the project's own XDC file (e.g. `constraints/nexys-a7-100t.xdc`). A project uses either `constraints` or `pins`, never both (`PROJECT_CONSTRAINTS_AND_PINS`). The student's file is never modified. The copy staged for implementation (`impl/generated.xdc`) has its `get_ports` braces tightened to `{name}` by `normalizeXdcForImplementation()`, a backend detail like the Windows bit-header normalization.
4. **Every top-level port must be constrained.** For both constraint sources, the constraints step reads the top module's ports from GHDL's Verilog netlist and fails with `XDC_PORT_UNCONSTRAINED` (located in the XDC file) if any port bit has no `PACKAGE_PIN`. Pins assigned to non-existent ports give `XDC_PORT_UNKNOWN` warnings. An unconstrained port would otherwise be placed on an arbitrary package pin.

## Consequences

- New projects use `constraints`; `pins` projects (e.g. `examples/nexys-a7-counter`) keep working unchanged. Switching a project from `pins` to an XDC file is an explicit, confirmed action.
- The starter XDC is generated from `boards/<id>/board.json`, so it only contains hardware-validated pins; Phase 4B extends the board data and writes into the same file.
- A Phase 3 test fixture whose fake netlist ports did not match its pin mapping now (correctly) fails the constraints step; the fixture was made consistent.
- The source-list sync depends on the editor-time indexer handling the student's VHDL. Where it cannot see a dependency, GHDL reports the analysis error (Check stays authoritative), and the student can reorder the list by hand: the stable sort keeps that order.
