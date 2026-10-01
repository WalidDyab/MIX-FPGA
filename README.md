# NexysVHDL

NexysVHDL is an **in-development** cross-platform VHDL workflow targeting the Digilent Nexys A7-100T (XC7A100T-1CSG324C). It is not ready for student use yet.

**Current development stage:** Phase 4 — VS Code student interface (Phase 4A: project workspace, design hierarchy, workflow UI). It runs only in a VS Code Extension Development Host on the validated development machines; there is no installer or packaged extension yet.

Target platforms:
- Windows x64
- Apple-silicon macOS

Validated backend technologies (Phases 1–2, on real hardware):
- GHDL (VHDL-2008 analysis, simulation, synthesis to Verilog)
- Apio / openXC7
- Yosys
- nextpnr-xilinx
- Project X-Ray

## Repository layout

| Path | Contents |
|---|---|
| `core/` | Platform-neutral TypeScript workflow core |
| `platform/` | Windows / macOS platform adapters |
| `runtime/` | Shared composition root used by the CLI and the extension |
| `extension/` | VS Code extension (Phase 4A) |
| `cli/` | `nexysvhdl` command-line interface |
| `boards/` | Board definitions (data) |
| `toolchains/` | Tested tool-version manifests (data) |
| `examples/` | Example student projects |
| `tests/` | Unit tests (`node:test`) |
| `docs/` | Architecture, plans, ADRs, phase engineering records |
| `experiments/`, `notes/` | Phase 1–2 experiments and raw logs |

## Development

Requires Node.js 20.12 or newer.

```sh
npm install
npm test                    # build + unit tests (no FPGA tools or board needed)
node dist/cli/main.js doctor
```

To try the extension: open this folder in VS Code and run the **Run NexysVHDL Extension** launch configuration (F5), then open or create a NexysVHDL project in the Extension Development Host. See [docs/phase4a-vscode-workspace.md](docs/phase4a-vscode-workspace.md).

See [docs/architecture.md](docs/architecture.md) and [docs/phase3-plan.md](docs/phase3-plan.md).
