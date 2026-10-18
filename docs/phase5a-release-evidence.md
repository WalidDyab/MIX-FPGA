# Phase 5A — Release evidence (macOS clean-machine validation, pre-cleanup)

Recorded 2026-10-18 on the macOS development Mac, before any cleanup. Documentation only; no binary payloads are stored in the repository.

## Baseline

| Item | Value |
|---|---|
| Branch | `phase5/release-preparation` |
| Base commit | `0b0eda7302a652319282362bdfe446d940889d81` (`main` == `origin/main`) |
| Extension / product version | 0.7.0 |
| macOS | 27.0.1 (26A434), arm64 (Apple M4) |
| VS Code | 1.141.2 (arm64) |
| Rosetta | installed (`com.apple.pkg.RosettaUpdateAuto`); not to be removed |
| macOS test suite (`npm test`) | 1117 tests, 249 suites: **1107 pass, 0 fail, 10 skipped** |

## Phase 4 final artifacts (macOS arm64, git-ignored under `.artifacts/`)

| Artifact | SHA-256 |
|---|---|
| `dist/nexysvhdl-0.7.0-darwin-arm64.vsix` | `5f0447f909a2ad46566fb93032c085f2c07b9a9bed718d16ffd9f0dbc21c152a` |
| `dist/NexysVHDL-0.7.0-darwin-arm64.zip` | `9f7d0adb25f34656bd561b0db30923c8cf433c5bcfc08ed5bbbad40f20f620a6` |
| `nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz` (Nexys A7 support) | `d8cdf6e2a6c082d05189396b10892b1a6605a267b2f2b884c9911c9140a2359d` |
| `mixfpga-de10-lite-support-1.0-macos-arm64.tar.gz` | `f8cbe33f56b54018204ba4f3f9c0a6cf4a4ad8e66145e36787c3b8e47f70eebb` |
| `lima-2.2.1-Darwin-arm64.tar.gz` | `9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e` |

## Toolchain 1.0 (macos-arm64) installed marker

Manifest SHA-256 `204532e3b49d8edad92a47577982e1bf383904cc3c889e70df63f8c7453fafe9`.

| Unit | Version | Tree SHA-256 |
|---|---|---|
| ghdl | 6.0.0 | `980068e535411aebdb9a4aba896fefb3014fa3dc1f208e67733ed599dcc4488d` |
| yosys | 0.63 | `d02397e9081cd0a74cd5be95305dcaa20870a21619918817a63e600079c2e47b` |
| openfpgaloader | 1.1.1 | `eb05f1fa037d842e2499582af6b2a0f27b34801fdf97aeed569fafb6f0683d25` |
| lima | 2.2.1 | `1e31ca89a2807eaa910e39a19ac1e03ddfde40b00e74fc96f35d59faf774a530` |
| engine | scripts | `25a880d8819542130a8bb1782e51e3ca309ac8eb965e6ebf1186d91553c22356` |
| licenses | — | `4b677b56800e40b30cbf1401138b7523e763e1b8960a7bd90ddb9ea416930584` |
| notices | — | `77cef48e4bee565f37d7d47ce59ee0cf4b92cd79ce1e3d9bde3ec0afc2f2fcb3` |

Nexys A7 support bundle (apio 1.7.0, openxc7 2026-09-25, yosys 0.63+173, nextpnr-xilinx e860c9c8, openFPGALoader 1.1.1): ghdl executable `38a99c1cc18b…`, apio `a9000808a018…`, programmer `06457ddf53f3…` (prefixes of the bundle's per-executable SHA-256).

## Board definitions (repo)

| File | SHA-256 |
|---|---|
| `boards/de10-lite/board.json` | `a18b9b85b4b396b4f8682136ce0140a8e5f4b1d83805021badb06ff12abfc118` |
| `boards/nexys-a7-100t/board.json` | `1b595a96ec399f286ab7ec59202154c2d3cd0e8e4d34976488042fee02beb8c5` |

## Validated Quartus

Quartus Prime Lite 25.1std.0 Build 1129 with MAX 10 support, device `10M50DAF484C7G`, run inside the MIX-FPGA Lima VM under Rosetta.

| Vendor file | SHA-256 |
|---|---|
| `QuartusLiteSetup-25.1std.0.1129-linux.run` | `518433ec7dcd61725560af653353f7a5c320cce9e528b22747b8a8df3674c4eb` |
| `max10-25.1std.0.1129.qdz` | `8057844b0b91c2ba7ef2b37b1986d198ec4f1831cc9be0a52d18e5feb4c19ce9` |

## Previous physical acceptance (from earlier phase records)

- **DE10-Lite (macOS, extension 0.7.0):** one board, USB-Blaster; MAX 10 IDCODE `0x031050dd` (10M50D); `top.svf` sha256 `9d51ef21…99458d`; openFPGALoader `-b de10lite`, SRAM only, ~3.9 s; user confirmed LEDs/SW0/KEY0. PASSED. ([phase4b-board-support.md](phase4b-board-support.md))
- **Nexys A7-100T (macOS, extension 0.7.0):** serial `210292BCFFE4`, xc7a100 idcode `0x3631093`; `hardware.bit` 3,825,910 B sha256 `60db725a…1cea`; openFPGALoader `--write-sram`, ~5.3 s; user confirmed. PASSED.
- **Nexys A7-100T (Windows):** JTAG ID `0x13631093`, Digilent `djtgcfg`, 3.9–4.1 s; PASSED. **DE10-Lite (Windows):** IDCODE `031050DD`, `quartus_pgm`, SRAM only, 9.5 s; PASSED. ([phase4c-windows-installation.md](phase4c-windows-installation.md))
- Quartus verification on this Mac (Build 1129, `10M50DAF484C7G`, map/fit/asm smoke build): passed in 22 s ([phase4-install-services.md](phase4-install-services.md)).

## Open items not covered by earlier evidence

- A fresh Quartus installation on a no-Quartus macOS machine has never been run end to end (existing Quartus was adopted by verification only). Phase 5A clean-machine testing is intended to close this.
