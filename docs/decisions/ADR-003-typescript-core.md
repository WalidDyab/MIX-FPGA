# ADR-003: TypeScript/Node shared core

Status: accepted (Phase 3A)

## Context

The intended student UI is a VS Code extension, which is written in TypeScript and runs on Node. The orchestration logic (project model, staging, providers, results) must be shared by a CLI now and that extension later, on Windows and macOS.

## Decision

The core is written in TypeScript and runs on Node.js (≥ 20.12; developed on Node 24). It compiles to CommonJS, the safest module format for VS Code extensions.
- Dependencies are kept minimal: `typescript` and `@types/node` as dev dependencies only.
- Tests use Node's built-in `node:test` runner.
- No runtime dependencies, DI frameworks or separate Python orchestration.
- The existing Python utility (`normalize_bit_header.py`) stays as reference code until Phase 3B ports it.

## Consequences

The CLI and the future extension import the same `core/` module. Contributors need only Node and npm. TypeScript 7 (native compiler) is used, and the build is `tsc` alone.
