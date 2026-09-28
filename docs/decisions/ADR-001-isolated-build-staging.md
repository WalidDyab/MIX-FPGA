# ADR-001: Isolated build staging

Status: accepted (Phase 3A)

## Context

Apio collects every `*.v` file in its project tree recursively. It also auto-selects the constraint file only when exactly one exists. In Phase 2, a stray comparison copy of `generated.v` in a subfolder caused `ERROR: Re-definition of module counter_Brtl_27` (`notes/phase2-windows-compare/apio-rebuild-attempt1-stray-v.log`). Student folders will routinely contain such files.

## Decision

Apio/openXC7 never runs over the student's source tree. NexysVHDL owns a per-project build workspace (`<project>/.nexysvhdl/`). Its `impl/` folder is deleted and recreated on every build, holding exactly `generated.v`, `generated.xdc` and a generated `apio.ini` with an explicit `constraint-file`. Apio runs with that folder as its working directory. `BuildWorkspace.stageImplementation()` verifies the folder contains nothing else, and `checkIsolation()` rejects a workspace that is the project root or contains sources.

## Consequences

- Stray `.v`/`.xdc` files in student folders are harmless. This was verified with a real build using a stray duplicate-module file, an extra `.xdc` and a path with spaces.
- Each build is a clean implementation run (~14 s for the reference design). Incremental builds are not a goal yet.
- Students never edit `apio.ini` or XDC.
