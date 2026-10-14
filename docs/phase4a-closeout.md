# Phase 4A closeout — macOS student installation

Status: **implemented and validated on the adopted development Mac. Nothing is committed.** Base: `58b9a98` on `phase4/student-installation`.
Checkpoint I hardware path: **PASSED** (LEDR0 blink, SW0 and KEY0 confirmed by the user on the DE10-Lite after programming through the adopted production Toolchain 1.0).

## What now exists
| Area | Where | State |
|---|---|---|
| Installation state model (6 states, ownership managed / external / system, resumable, idempotent, lock) | `core/install/` | tested |
| Production layout `~/Library/MIX-FPGA` (`MIXFPGA_HOME` the only override; Lima socket-length detection, no alias) | `platform/macos/install/layout.ts` | tested |
| Toolchain 1.0 installer (staged, hash-verified, read-only, marker last, repair, interruption-safe) + recorded manifest | `toolchain-installer.ts`, `toolchains/mixfpga/toolchain-1.0-macos-arm64.json` | tested; used for the real adoption |
| Third-party inventory and notices (DRAFT) incl. all 100 Go modules of Lima | `toolchains/mixfpga/compliance/`, `.../notices/`, `docs/phase4-third-party-notices.md` | DRAFT |
| Rosetta detection and consent-gated install | `rosetta.ts` | tested with fakes |
| Managed engine (image download, create, guest setup, resumable, never starts on open) | `engine-provision.ts`, `engine-config.ts`, `download.ts` | tested with fakes |
| Quartus / MAX 10 guided install, Altera licence from the installer's own `--install_lic` output, exact checkbox, acceptance recorded before `--accept_eula` | `quartus-install.ts` | tested with fakes; verification run for real on the existing Quartus |
| Setup page model, controller, VS Code dialogs, licence panel, commands | `setup-view.ts`, `setup-controller.ts`, `extension/setup/`, `runtime/setup.ts` | model and flows tested; **UI not driven** |
| Adoption of the existing Mac (dry run, then performed) | `adopt.ts`, `scripts/mixfpga/adopt-existing.mjs` | **done on this Mac** |
| Runtime resolves tools from the installed Toolchain 1.0 only | `platform/macos/de10/{runtime,backend}.ts`, `runtime/multiboard.ts` | **verified** |

## Validation evidence
* Automated suite: 1,068 tests, 1,067 pass, 0 fail, 1 skipped (baseline was 926 / 925 / 0 / 1).
* Adoption: 7 parts (GHDL, Yosys, openFPGALoader, Lima, engine scripts, licences, notices) copied from the validated payload, verified against the manifest in staging and in place (full tree), sealed read-only, marker written last. Engine adopted by verification only (not started, stopped, edited, moved or recreated). Quartus 25.1std.0 Build 1129 / MAX 10 / `10M50DAF484C7G` verified with a real design; no historical licence acceptance invented.
* Real VS Code Extension Development Host, DE10-Lite project, twice: Check, Simulate, Design Schematic, RTL Schematic, Build (cold about 35 s, warm about 27 s; 27 LEs, Fmax 294.55 MHz), Verify Environment (10 steps). The engine stayed stopped through Check, Simulate and the schematics. Process watcher: 0 processes from `toolchains/experimental` in the second run.
* Nexys A7 example in the same host: Check, Simulate and RTL Schematic passed, engine untouched.
* Hardware: exactly one DE10-Lite, IDCODE `0x031050dd`, installed openFPGALoader, `.svf`, artifact hash and freshness checks passed, SRAM only (`volatile`), programming 3.9 s, JTAG detected again afterwards, LED behaviour confirmed physically.

## Not part of Phase 4A (decisions for later)
* Final DMG, signing, notarization, Windows installer, release archive source for the toolchain, VSIX allowlist for the manifest.
* Legal review before any release: **L1** (IEEE 1076.3-1995 "not for profit"), **L3** (Yosys with GPLv3 readline), **L9** (integrity restore versus the right to replace LGPL/GPL libraries); plus L2, L4, L10 and the minor items in `docs/phase4-third-party-notices.md`. The notices stay DRAFT.
* Retention of the Lima image cache, `staging/vendor` and the stray file; removal of `toolchains/experimental` (kept as the installer payload source until you approve).
* A Nexys A7 Build and Program under the new layout (no board available here).

## Remaining fresh-student Setup validation (the only open Phase 4A work)
Everything above was validated on a Mac that already had Rosetta, the engine and Quartus. These paths have run only against fakes or read-only against the real Quartus, and need an **isolated account or a second Mac with Apple silicon and a clean `~/Library/MIX-FPGA`** (never this Mac's real data):
1. **Rosetta install** from the Setup page: the terminal hand-off to Apple's own installer, Apple's licence prompt, the administrator prompt, and the state turning Ready. (This Mac has Rosetta; it was not removed.)
2. **Real `limactl create`** from the verified local image (`location` as a local file path, digest check), `limactl start`, the Linux libraries over the network, `mixfpga-q` and the `rosettad` repair, then stop. Includes the 60 GiB sparse disk staying small, the free-disk preflight and the resume after an interrupted download.
3. **Quartus guided install end to end:** file picker (including the Downloads shortcut), `--install_lic` run under the Rosetta-translated installer, the licence webview and checkbox in real VS Code, the exact unattended install of quartus + devinfo + max10 only, verification, and removal of the temporary copies; confirm the installer hands `--accept_eula 1` only after the recorded acceptance.
4. **Setup page in the real UI:** the Environment page switching to Install FPGA Toolchain / Repair / Verify, progress messages, Cancel, and the Hardware row.
5. **Toolchain payload source:** the installer currently copies from the development folder (`MIXFPGA_DEV_PAYLOAD`); a student install needs the release archive source. This is release work, but the fresh-install test cannot be run on a clean machine without it.
6. **Account-name edge cases:** a long account name (Lima socket path over 103 bytes: expected clear refusal) and a home folder with spaces or non-ASCII characters.
7. Same-session fresh run of Check, Simulate, Build, Detect and Program on that clean setup.
