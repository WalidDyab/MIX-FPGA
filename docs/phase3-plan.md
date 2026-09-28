# Phase 3 plan — multi-agent product engineering

Two Claude instances work in parallel after Phase 3A: one on Windows x64 and one on Apple-silicon macOS. This plan fixes who owns what, so their work merges without conflicts.

## Phase 3A — shared core and interfaces

Owner: **Windows Claude**. Branch `phase3/core`. Complete when reviewed and merged into `main`.

Delivered:
- TypeScript core (`core/`): project, board, toolchain, process, workspace, VHDL (GHDL), implementation (Apio), programming contract and service, workflow controller, structured results.
- Board data `boards/nexys-a7-100t/board.json`, reference toolchain manifests `toolchains/*.json`, example project `examples/nexys-a7-counter/`.
- Placeholder adapters `platform/windows/`, `platform/macos/` and the adapter registry `platform/index.ts`.
- CLI (`cli/`), unit tests (`tests/`), `docs/architecture.md`, ADR-001 … ADR-004.

## Phase 3B — parallel platform implementation

Both agents start from the merged Phase 3A `main`, each on its own branch.

### Windows Claude — branch `phase3/windows`

Owns `platform/windows/` only:
- `ProgrammerProvider` for the Digilent Adept stack:
  - detection and serial-number selection;
  - preparing a header-normalized copy of `hardware.bit` (port of `experiments/phase1b-windows-programmer/normalize_bit_header.py`, with payload-identity verification);
  - volatile (SRAM) programming;
  - Adept Runtime / Utilities availability and version reporting (e.g. the Runtime ≥ 2.30 requirement).
- `ToolLocator` for Windows discovery of GHDL and Apio, plus openXC7 package metadata and programmer version detection.
- Windows-specific tests under `tests/platform/windows/` (must skip cleanly on other hosts).

### Mac Claude — branch `phase3/macos`

Owns `platform/macos/` only:
- `ProgrammerProvider` for the macOS backend: detection, artifact preparation (normally the canonical file unchanged, `transformation: 'none'`), and volatile programming.
- `ToolLocator` for macOS/Apple-silicon discovery of GHDL, Apio, openXC7 metadata and the programmer backend.
- Completing `toolchains/reference-phase2-macos-arm64.json` (programmer version, exact openXC7 tag format) and adding the macOS Phase 1/2 engineering records under `docs/`.
- macOS-specific tests under `tests/platform/macos/` (must skip cleanly on other hosts).

### Rules for both agents

1. **Do not edit `core/`, `cli/`, `boards/` or another agent's `platform/` folder.**
   - If a core contract must change, write the proposal in `docs/decisions/` (new ADR) or a PR comment, and let the owner of Phase 3A review it.
   - Small additive exports agreed in review are fine; silent contract changes are not.
2. Register adapters only through `platform/index.ts`. That is the single shared line, and both agents append to it; resolve trivially on merge.
3. `core/` must stay free of product names and platform branches, and `tests/architecture.test.ts` must keep passing.
4. Never modify a canonical `hardware.bit`; programming uses a `ProgrammingArtifact`.
5. No USB driver changes: no Zadig/WinUSB on Windows, and no system driver changes on macOS.
6. `npm test` must pass on both hosts before merge. Hardware tests are manual and recorded in `docs/`.

## Phase 3C — integration and regression

Both machines pull the integrated `main` and run the full real-hardware regression with `examples/nexys-a7-counter`:

`doctor` (all tools `compatible`) → `check` → `simulate` → `build` (100 MHz timing PASS) → `program` → physical blink/reset check

Results are recorded per platform in `docs/`. Only after Phase 3C does GUI (VS Code extension) work begin.
