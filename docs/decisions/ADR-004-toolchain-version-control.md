# ADR-004: Explicit toolchain version control

Status: accepted (Phase 3A)

## Context

The FPGA toolchain (GHDL, Apio, openXC7, Yosys, nextpnr-xilinx and the programmer backend) is a set of independently released tools. We already hit an Apio/openXC7 schema-version incompatibility, and Windows and macOS currently run different Apio/openXC7/nextpnr versions. Following "latest" would break students' builds unpredictably.

## Decision

Tested tool combinations are data: `toolchains/*.json` manifests list, per host, the versions validated for each `ToolId`. The code keeps what was tested (`ToolExpectation`) separate from what is installed (`DetectedTool`). `evaluateCompatibility()` reports `compatible | incompatible | unknown | missing` per tool, and the worst status overall. `nexysvhdl doctor` shows both values side by side.

The two current manifests are **reference** records from Phase 2. A release matrix (and whether both platforms must share identical versions) is decided later. No automatic updates.

## Consequences

Upgrading a tool becomes a deliberate step: validate, then add or replace a manifest. Doctor and the future UI can warn about untested versions instead of failing mysteriously. Detection of openXC7 package metadata and programmer versions is platform-specific and is left to Phase 3B adapters.
