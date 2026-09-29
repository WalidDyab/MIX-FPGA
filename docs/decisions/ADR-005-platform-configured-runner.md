# ADR-005: Platform-configured ToolRunner and host-isolated tests

Status: accepted (Phase 3C)

## Context

In Phase 3B the macOS toolchain was only safe when every Apio invocation carried `APIO_REMOTE_CONFIG_URL`, which points at the tracked pin `toolchains/apio-remote-config/`. Without it, Apio replaced the validated openXC7 `2026-09-25` with the incompatible `2026-09-27`. That actually happened during `npm test`.

Two things combined to cause it:
- the CLI composition root gave the shared GHDL/Apio providers and `ToolDetector` a plain `NodeToolRunner`, and platform adapters had no way to configure it;
- the CLI tests used the host's real platform registry.

## Decision

1. **The platform configures the runner.**
   - `PlatformFactory` receives `PlatformContext { runner, env }`, where `runner` is the base runner.
   - An adapter may return `PlatformServices.runner`: a decorator of that base runner.
   - The composition root uses `platform.runner ?? baseRunner` for **every** external tool: detection, GHDL, Apio, the programmer and doctor inspection.
   - The adapter builds its programmer and inspector on the same runner. A later `configureRunner()` call could miss objects that were created earlier, so the runner is fixed when the factory runs.
   - macOS returns a `PinnedApioRunner`, which pins Apio and refuses it if the pin cannot be expressed. Windows returns none.
   - No global `process.env` mutation, no shell profiles.
2. **Doctor goes through the platform.** `PlatformServices.inspectToolchain()` returns detections in the shared `DetectedTool` model plus diagnostics. `doctor` stays platform-neutral.
3. **Registration is by platform and architecture.** Only validated host kinds get an adapter: `win32/x64` and `darwin/arm64`. Everything else is `unsupported`, with a reason.
4. **Unit tests never touch the host.**
   - CLI tests inject a fake host, a fake platform and a runner that refuses everything.
   - `child_process` is trapped during those tests.
   - `tests/test-isolation.test.ts` fails if a test file runs the CLI or builds a context without the isolation helpers.

## Consequences

Per-tool environment needs, such as a future pinned package source on Windows, are solved inside the adapter without changing the core. A new host kind requires an explicit registry entry. A test that reaches a real tool fails instead of silently modifying the developer's toolchain.
