# ADR-002: Platform programming behind ProgrammerProvider

Status: accepted (Phase 3A)

## Context

Programming differs completely per platform. Windows must keep the Digilent/FTDI driver that Vivado uses, and needs a bitstream with a Vivado-style header part name (Phase 1B). macOS programs the canonical bitstream directly with a different backend. Driver-changing approaches are ruled out.

## Decision

The core defines one contract, `ProgrammerProvider`, with the methods `availability()`, `detectBoards()`, `prepareArtifact()` and `program()`. Platform adapters in `platform/<os>/` implement it. The core never names a backend, driver or vendor utility (enforced by `tests/architecture.test.ts`).

- The canonical `hardware.bit` is immutable. `prepareArtifact()` returns a separate `ProgrammingArtifact`: a transformed copy in the workspace `program/` folder, or the canonical path with `transformation: 'none'`.
- `ProgrammingService` hashes the canonical file before and after preparation. It refuses to program if the file changed, or if a transformed artifact uses the canonical path.
- Boards are addressed through `DetectedBoard { selector, serialNumber, productName, boardId }`. With several boards the service requires a serial number instead of guessing.
- Only volatile (SRAM) programming exists for now.

## Consequences

The Windows and macOS agents implement programming independently in Phase 3B, without touching the core. A missing adapter shows up as "Programming provider is not configured for this platform." and never as a fake success.
