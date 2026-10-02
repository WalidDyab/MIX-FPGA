# NexysVHDL

NexysVHDL is a VHDL-first FPGA workflow in VS Code for the Digilent Nexys A7-100T (XC7A100T-1CSG324C).

**Current stage:** Phase 4B — **Classroom Preview** (0.5.0). It is an installable classroom package with its own FPGA toolchain; it is not on the Visual Studio Marketplace.

Target platforms:
- Windows x64 (Classroom Preview package validated)
- Apple-silicon macOS (Classroom Preview package validated)

## License

NexysVHDL itself is licensed under the [Apache License, Version 2.0](LICENSE) (see also [NOTICE](NOTICE)). The separately distributed FPGA toolchain redistributes third-party tools (GHDL, Apio, Yosys, nextpnr-xilinx, openXC7, openFPGALoader, …) that remain under their own licenses, including the GNU GPL and LGPL: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## For students

See [docs/student-install-windows.md](docs/student-install-windows.md), [docs/student-install-macos.md](docs/student-install-macos.md) and [docs/student-quick-start.md](docs/student-quick-start.md).

A classroom download contains two separately versioned parts:

| Part | File | Size |
|---|---|---|
| NexysVHDL extension | `nexysvhdl-<version>-<platform>.vsix` | about 230 KB |
| NexysVHDL FPGA toolchain | `nexysvhdl-toolchain-<toolchain version>-<platform>.tar.gz` | about 725 MB (Windows) / 630 MB (macOS), installed once per user |

## Repository layout

| Path | Contents |
|---|---|
| `core/` | Platform-neutral TypeScript workflow core (incl. `core/toolchain/bundle.ts`, `store.ts`, `tar.ts`: the bundled toolchain) |
| `platform/` | Windows / macOS platform adapters |
| `runtime/` | Shared composition root used by the CLI and the extension (`classroom.ts`: classroom mode) |
| `extension/` | VS Code extension |
| `cli/` | `nexysvhdl` developer command-line interface (not shipped to students) |
| `boards/` | Board definitions (data) |
| `toolchains/` | Reference tool manifests; `toolchains/bundle/`: classroom toolchain recipes, requirement and license texts |
| `scripts/` | Toolchain assembly/packing and VSIX packaging; validation tools |
| `resources/` | Icons, VHDL grammar, Getting Started pages |
| `examples/` | Example projects |
| `tests/` | Unit tests (`node:test`); `tests/integration/`: EDH and installed-package validation |
| `docs/` | Architecture, ADRs, phase engineering records, student documentation |

## Development

Requires Node.js 20.12 or newer.

```sh
npm install
npm test                         # build + unit tests (no FPGA tools or board needed)
```

Classroom packages (Windows shown; `--target darwin-arm64` / `npm run package:mac` on a Mac):

```sh
npm run toolchain:assemble -- --target win32-x64 --download   # official archives -> toolchain/win32-x64/ (git-ignored)
npm run toolchain:pack -- --target win32-x64                  # -> .artifacts/dist/nexysvhdl-toolchain-1.0-win32-x64.tar.gz
npm run package:win                                           # VSIX + classroom distribution folder/zip
npm run toolchain:install                                     # install the toolchain for this user (developers; students use the extension)
```

To try the extension from source: run the **Run NexysVHDL Extension** launch configuration (F5). It uses the same per-user toolchain store as the installed package (`npm run toolchain:install`). See [docs/phase4b-classroom-bundle.md](docs/phase4b-classroom-bundle.md), [docs/decisions/ADR-007-separately-versioned-classroom-toolchain.md](docs/decisions/ADR-007-separately-versioned-classroom-toolchain.md) and [docs/architecture.md](docs/architecture.md).
