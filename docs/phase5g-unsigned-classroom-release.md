# Phase 5G-U2: native installer and unsigned classroom distribution (macOS arm64)

Built from commit `188d285` on `phase5g/unsigned-classroom-release` (base: Phase 5F acceptance `b87a0df`). **Unsigned and not notarized** (the installer app carries only the ad-hoc signature Apple silicon requires; no Developer ID, no Gatekeeper or security change anywhere). Nothing was published. Toolchain 1.1 binaries were not rebuilt. Technical record only; no legal clearance is claimed.

## Classroom set (`.artifacts/classroom/`, git-ignored; `SHA256SUMS` and `CLASSROOM-MANIFEST.json` there)

| File | Bytes | SHA-256 |
|---|---|---|
| `MIX-FPGA-0.7.0-macOS-arm64.dmg` | 1,248,853,111 | `1c3c8e71918816760786ed018d88f13d98236d8e240730d6ed685a7e335c8933` |
| `MIX-FPGA-0.7.0-macOS-arm64-Fresh.zip` | 1,251,193,468 | `c317e3e53caf602ff3bd7a60b6189acc01f40c96b7c15920d27595892c9af37e` |
| `MIX-FPGA-0.7.0-macOS-arm64-Upgrade-from-NexysVHDL.zip` | 1,138,267,420 | `02fe3e350564798e04883cb84032c537c8aa30b93569738484853634a4915c9a` |

The installer executable (`MIXFPGAInstaller`, inside the app) is sha256 `0354020c...5347`. The DMG and ZIPs are not byte-reproducible (timestamps); the accepted artifacts inside them are.

## Contents
- **DMG** (volume `MIX-FPGA 0.7.0`): `MIX-FPGA Installer.app`, `README-FIRST.txt` (what to do, and the Open Anyway steps for unsigned software), `THIRD_PARTY_NOTICES.md`, `LICENSE`, `Support/` (VSIX, Nexys A7 support 1.1, DE10-Lite support 1.1, the two archive notices, `SHA256SUMS`), `Source/` (the two corresponding-source packages, next to the archives; no written offer).
- **Fresh ZIP**: VSIX, both support archives, both source packages, `INSTALL-FRESH-macOS.md`, `THIRD_PARTY_NOTICES.md` (+ the two archive notices), `LICENSE`, `SHA256SUMS`, `RELEASE-MANIFEST.json`.
- **Upgrade ZIP**: VSIX, Nexys A7 support 1.1, Nexys source package, `INSTALL-UPGRADE-from-NexysVHDL.md`, `THIRD_PARTY_NOTICES.md` (+ Nexys notices), `LICENSE`, `SHA256SUMS`, `RELEASE-MANIFEST.json`. DE10-Lite is not included (optional: Fresh ZIP or DMG).

## Accepted artifacts are byte-identical
Copied (never unpacked or repacked) and checked by the build against the Phase 5F hashes before and after, and re-hashed inside the final DMG and both ZIPs: VSIX `53d4ce4a...`, Nexys support `f84cedec...`, Nexys sources `cf6b36b9...`, DE10 support `19df1593...`, DE10 sources `e85dbbff...` (full hashes in `docs/phase5f-acceptance-report.md`).

## Design
The app (AppKit, Swift, `installer/macos`) detects Visual Studio Code and the installed `emxplore.nexysvhdl` version (Fresh / Upgrade from NexysVHDL / Repair-Reinstall), asks Nexys A7, DE10-Lite or both, checks the files in `Support/` against `SHA256SUMS`, installs the VSIX with VS Code's own CLI (`--install-extension --force`: the same extension id, so NexysVHDL upgrades in place, nothing is uninstalled), then installs the chosen board support by running the setup code that ships inside the installed extension (`bridge.js` under VS Code's own Node), with the exact support archives from `Support/`. It runs Verify for a Nexys-only install. Rosetta and Altera (Quartus, MAX 10, licence page, explicit acceptance) are left to the extension's Setup; the installer says so and never touches Altera files. The support archives live beside the app in the DMG, so the hashes stay exact (the app must be run from the mounted DMG). If Visual Studio Code is missing it says so and offers Retry (nothing is downloaded).

## Validation (private HOMEs; the mounted DMG; real VS Code 1.143.1; headless mode runs the same code as the window)
| Test | Result |
|---|---|
| Fresh, Nexys only | PASS: extension 0.7.0, support installed, tree `0d0035d3...`, Verify OK; the real extension then shows Nexys Installed, Ready |
| Fresh, DE10-Lite only | PASS: extension, DE10 toolchain, Lima engine installed; stops at Altera with the "continue in MIX-FPGA Setup" message |
| Fresh, both | PASS: Nexys Installed; DE10 "Setup not finished" in the real extension page (continues via Setup) |
| Upgrade from NexysVHDL 0.6.0 (project, `.nvproj`, settings, Toolchain 1.0 store present) | PASS: detected as upgrade, 0.7.0 installed over 0.6.0, project files and settings hashes unchanged, Toolchain 1.0 tree unchanged (`f0402218...`), Toolchain 1.1 installed, Verify OK, the upgraded project passes Check and Simulate |
| Reinstall (0.7.0 present) | PASS: offered as Repair/Reinstall; nothing re-copied (marker and tree unchanged) |
| Failures: VS Code missing; corrupted support archive; missing archive; corrupted VSIX | PASS: "Nothing was changed"; the existing NexysVHDL 0.6.0, project and Toolchain 1.0 untouched |
| Cancel (SIGTERM) and hard kill (SIGKILL) of the installer mid-install | PASS: extension installed and usable, nothing half-visible, project and 1.0 store intact; the next run completes and verifies |
| Window (GUI) | PASS: welcome, board choice, progress and done pages driven once with real clicks |
| Manual route from the Upgrade ZIP (VSIX by CLI, support picked in the extension) | PASS |
| Full suite | 1152 tests, 0 failures, 11 skipped |

Evidence: `docs/phase5g-evidence/`. Test roots were deleted, test VMs stopped, the reference `~/Library/MIX-FPGA` untouched.

## Supported boards
Nexys A7-100T and DE10-Lite on Apple silicon Macs (macOS 13 or newer), Visual Studio Code 1.120 or newer.

## Known non-blocking issues
1. A hard-killed support install leaves an orphan `.staging` folder (about 0.5 GB for Nexys) that later installs do not remove (also seen in Phase 5F).
2. The installer must be run from the mounted DMG (the support files are beside it); copied elsewhere it says the files are missing.
3. The installer does not open MIX-FPGA Setup by itself (VS Code has no entry point for that without changing the extension); the last page says what to click.
4. DE10-Lite still needs the Altera step in Setup afterwards, and Rosetta if absent.
5. The DMG is plain (no custom background); a downloaded copy shows macOS's "not verified" prompts until the student uses Open Anyway (README-FIRST explains).
6. The Nexys Setup-page limitations of Phase 5F (modified/missing shown by Verify) are unchanged.
7. The 0.6.0 extension folder remains in `~/.vscode/extensions` marked obsolete by VS Code, as with any extension update.

## Classification
**READY FOR DIRECT CLASSROOM DISTRIBUTION — UNSIGNED.**
