# Phase 5E: macOS release candidate and Toolchain 1.1 adoption

Branch `phase5e/macos-release-candidate` from `35df5a5`. The release candidate was built from commit `63748a8`. Unsigned, not notarized, not published. The technical conclusions are in [phase5e-compliance-conclusions.md](phase5e-compliance-conclusions.md); they are not legal advice and nothing here says an attorney approved anything.

## Artifacts (`.artifacts/release-rc/MIX-FPGA-0.7.0-macOS-arm64-RC/`, git-ignored; `SHA256SUMS` and `RELEASE-MANIFEST.json` inside)

| File | Bytes | SHA-256 |
|---|---|---|
| `nexysvhdl-0.7.0-darwin-arm64.vsix` | 599,123 | `53d4ce4ac847c4ca4837596550ca358550d85c2be021435a0e5526808b2bc7bc` (not reproducible: zip timestamps) |
| `nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz` | 652,960,581 | `f84cedece009be5a04ad44a9c2ff1110fccc1c6725f483a20bb0e139c84f3a73` |
| `MIX-FPGA-Nexys-A7-Support-1.1-Sources.zip` | 517,951,374 | `cf6b36b988065c2441cd5fbb9a86352a88778c44ef20933dc7fa4bb7f043efda` |
| `mixfpga-de10-lite-support-1.1-macos-arm64.tar.gz` | 88,873,068 | `19df1593f9266653a4fddbc18cebb4b019e78682271034e0893be264c2d38326` |
| `MIX-FPGA-DE10-Lite-Support-1.1-Sources.zip` | 24,373,057 | `e85dbbff25f489dd212661671d842673c7f74455c0df9aae0fa3cc1adbd5715a` |
| `INSTALL.md`, `THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_NOTICES-Nexys-A7-Support.md`, `THIRD_PARTY_NOTICES-DE10-Lite-Support.txt`, `LICENSE`, `SHA256SUMS`, `RELEASE-MANIFEST.json` | | in `SHA256SUMS` |

Content hashes: Nexys tree `0d0035d3b43ed81cdb3275bd230c5d29d2f1c43c112e2f75fc22550898743b28` (31,541 files, 2,744,215,896 bytes); DE10-Lite manifest `toolchain-1.1-macos-arm64.json` sha256 `b1ef245c071f0a8cac4ae39e4169df5bc900329d21fc5d37f5550e437dd3ec78` (683 files and links). Each binary archive and its source package are companions; there is no written offer.

## Reproducibility

Every archive was built twice with identical hashes: Nexys pack (A/B), DE10-Lite payload (A/B, with identical manifest) and both source packages (A/B).

## What changed against the Phase 5C candidates

Only the notices (plus the recorded recipe hash and compliance block in the Nexys manifest). The DE10-Lite units ghdl, yosys, openfpgaloader, lima, engine and licenses are byte-identical to the candidate; only the `notices` unit changed. The Nexys tree differs in `THIRD_PARTY_NOTICES.md` and `toolchain-manifest.json` only (checked field by field). Candidate hashes therefore changed (expected): Nexys archive `6fc1f3ad...` to `f84cedec...`, DE10 `25317169...` to `19df1593...`, Nexys tree `8b0beda8...` to `0d0035d3...`.

## Notice changes

Nexys: no CANDIDATE marker; new "Licence notes" (Yosys and Readline under GPL version 3, Icarus Verilog GPL-2.0-or-later with the local-revert provenance, MIT/BSD material in `system.vpi`, Python 3.11.6 and its Readline module, Apio, Graphviz EPL-1.0, GHDL, Qt/GTK LGPL libraries, MPL-2.0 Eigen/certifi); a modification/replacement section describing the modified-toolchain behaviour. DE10-Lite: no CANDIDATE marker; new "Your right to modify and replace components" (closes the Phase 5D gap), "Licence notes" (Yosys/Readline, Lima NOTICE and MPL-2.0 hcl, GHDL, openFPGALoader/libusb/libftdi1); all compliance decisions resolved; the "counsel to confirm" wording removed. Nothing removed in Toolchain 1.1 pruning was reintroduced.

## Source packages

Nexys: 242 files, 136 source archives; new `sources/cpython-3.11.6-8b6ee5ba.tar.gz` (SHA-256 `a9e63b0dd848f0ae01f30b99eda9b5eb40e4c0409ef3eb19d0d2af0c429002b7`, CPython revision `8b6ee5ba3bd08368ba3c763cea28ce1464a88e62`, `PY_VERSION` 3.11.6, pinned in `toolchains/compliance/sources-1.1-extra.json`), Icarus `oss-iverilog.tar.gz` (`c37c4f4a...`, revision `6767a079...`), Yosys with abc and cxxopts, Readline 8.2 + patch 001 + MacPorts recipe, the YosysHQ recipe (Python patch, Icarus revert), licence texts. `binary-to-source.json` gains `copyleftPrograms`: yosys, yosys-abc, yosys-filterlib, libreadline, vvp, vhdlpp, the five `.vpi` modules, the Python `readline` module and libpython, each with the SHA-256 of the shipped file and its source archives. DE10-Lite: 178 files, 13 source archives, including the MPL-2.0 `hcl` v2.24.0 archive (`53fd4e96...`).

## Adoption

`TOOLCHAIN_VERSION` 1.1 (install folder `toolchains/1.1/macos-arm64`), pins `payloads-1.1.json`, manifest `toolchain-1.1-macos-arm64.json`, support-file names, `requirement.json` now the 1.1 requirement (macOS only, validated), `.vscodeignore`, INSTALL, README, CHANGELOG, root `THIRD_PARTY_NOTICES.md`. Kept: `requirement-1.0.json` (both targets), 1.0 manifests/pins/recipes/notices/compliance record. The Windows release script still reads `requirement.json`, which no longer has a Windows target; a Windows release must use `requirement-1.0.json` or its own 1.1 (not part of this phase). Behaviour for existing users: Toolchain 1.0 folders are neither used nor removed; the Nexys A7 tools of NexysVHDL 0.6.0 (1.0) are not adopted under 1.1, so the Nexys support file is chosen once (documented in INSTALL and CHANGELOG).

## Validation (isolated root `/private/tmp/claude-501/p5e`, final payloads, product Setup controller)

- Both support archives installed through Setup (every file verified).
- Nexys A7: Check, Simulate (660 ns), RTL schematic, Build (13.0 s, 57 LUTs, 27 FFs) through the backend; Check, Simulate (280 ns), RTL in a real VS Code with the RC VSIX installed.
- DE10-Lite: Check, Simulate (1320 ns), RTL schematic pass. **Build through Lima/Quartus was not performed**: Altera's installer and MAX 10 package are no longer in `~/Downloads`; the engine VM was provisioned but Quartus could not be installed. The Altera licence was not accepted. Build, like physical Programming, stays for the clean-student acceptance.
- `scripts/validation/phase5e-modified-regression.mjs`: 25 checks pass (clean = Ready; modified = Installed (modified) with the wording and no restore by looking; New Project ready for Nexys; Verify reports the modification; declining Repair changes nothing; explicit Repair restores the final hash and the whole Nexys tree hash; missing file/tool = Needs repair and Repair restores; one board does not affect the other). The DE10-Lite board-level rules could not be shown on the real root (board incomplete without Quartus); they are covered by `tests/install/modified-toolchain.test.ts`.
- A fix found on the way: provisioning copied sealed (read-only) guest scripts over earlier copies and failed with EACCES the second time; it now replaces them.

## Full macOS suite

1152 tests, 257 suites, 1141 pass, 0 fail, 11 skipped.

## Toolchain 1.0

`~/Library/MIX-FPGA` untouched (nothing newer than this phase's start); no Toolchain 1.0 record changed since `35df5a5` (`git diff` over the 1.0 files is empty); `.artifacts/dist/nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz` untouched.

## Remaining concerns

DE10-Lite Build and both boards' physical Programming (clean-student acceptance); the VSIX is not byte-reproducible; the macOS app/DMG launcher was not part of this set; Windows requirement handling (above); the conclusions are technical only.
