# Phase 5A: macOS failure-path acceptance

Date: 2026-10-18. The **shipped** setup code (the VSIX from the neutral RC folder, installed in the clean profile) was driven with a scripted student against **isolated roots** (`MIXFPGA_HOME=~/MF5A`, `~/MF5B`, `~/MF5C`, outside the repository). The reference installation in `~/Library/MIX-FPGA` was not modified, except for the final read-only Verify and stopping its VM. Real archives, real hashes, real Lima VM and real Quartus installer; only the answers to the dialogs were scripted. Test inputs: the internal DE10 support archive (internal validation material, not approved for student distribution while L1/L3/L9 are open), the course Nexys archive, and Altera's two files.

| # | Case | Exact message shown to the student | Left behind | Retry / resume | Reference install |
|---|---|---|---|---|---|
| 1a | DE10 support file: Cancel | "DE10-Lite support was not installed because no support file was chosen. Choose Install DE10-Lite Support when you have it." | Empty `toolchains/.staging`; board row "Needs repair"; failure noted in `install-state.json`. No tools, no VM | Retry with the right file: tools installed, VM created | valid |
| 1b | DE10: wrong file (Nexys archive) | "That is not the DE10-Lite support file. Choose mixfpga-de10-lite-support-1.0-macos-arm64.tar.gz, which your course provides." | same as 1a | same | valid |
| 1c | DE10: right name, one byte changed | "The DE10-Lite support file is damaged or incomplete. Copy mixfpga-de10-lite-support-1.0-macos-arm64.tar.gz from your course again and choose it again." | same as 1a (nothing extracted) | same | valid |
| 2a | Nexys support file: Cancel | "A part of the setup did not finish. Choose Repair to try again; Details has more." (Details: `NEXYS_SOURCE_MISSING`) | state files and an empty `support/nexys-a7/toolchains` | Retry with the right file installed (2.6 GB, "Setup finished") | valid |
| 2b | Nexys: wrong archive (the DE10 archive) | same generic message (Details: `TOOLCHAIN_ARCHIVE_INVALID`, "has no toolchain-manifest.json") | as 2a | as 2a | valid |
| 2c | Nexys: corrupted archive | same generic message (Details: "tar header checksum mismatch (damaged archive)") | as 2a | as 2a | valid |
| 3a | Altera: installer and package swapped | "The file you chose is not the one Setup needs. Download it again from Altera." (`FILES_SWAPPED`) | none: no `quartus.json`, `staging/installers` empty | immediate retry possible | valid |
| 3b | Altera: wrong installer content, right name (24 bytes) | same message (`FILE_DIFFERENT_VERSION`, size) | none | yes | valid |
| 3c | Altera: MAX 10 package missing | same message (`FILE_NOT_FOUND`) | none | yes | valid |
| 3d | Altera: MAX 10 package, one byte changed | same message (`FILE_HASH_MISMATCH`) | none | yes | valid |
| 3e | Altera: unrelated file for both | same message (`WRONG_FILE`) | none | yes | valid |
| 4 | Altera licence shown, rejected | "Quartus was not installed because the licence was not accepted." | `quartus.json` records only that the licence was offered (no acceptance, no `installAttemptAt`, so the installer was never started and `--accept_eula` never passed); the two verified temporary copies (2.2 GB) stay in `staging/installers` until the next run, where they were removed on success | The next run with acceptance installed Quartus ("Everything is already set up" afterwards); VM stopped | valid |
| 5 | Interrupted setup (process killed during engine creation, then again 2 s after the Quartus installer started) | After relaunch the page says "Needs repair" and lists the unfinished parts | VM stopped by hand where an orphan host agent remained | A third run completed ("Quartus: installed and verified", "Setup finished", Ready) | valid |
| 8 | Damaged MIX-FPGA tool file (`ghdl/bin/ghwdump`, one byte appended; Quartus untouched) | Verify: FAIL "GHDL: 1 changed" and "MIX-FPGA Toolchain: some parts are missing or damaged", headline "Needs repair". Repair with no support file chosen: the DE10 cancel message above | none | Repair with the support file restored the original hash; Verify then all OK | valid |

## Findings

1. **Nexys picker errors are generic (user-facing quality, not data-risk).** Cancel, wrong file and corrupted file (2a-2c) all end with "A part of the setup did not finish. Choose Repair to try again; Details has more." The DE10 picker and the Altera inputs give specific messages. Candidate fix: map `NEXYS_SOURCE_MISSING`, `TOOLCHAIN_ARCHIVE_INVALID` and `NEXYS_ARCHIVE_MISMATCH` in `studentFailure`. No fix made in this phase.
2. After a rejected licence the two verified Altera copies (2.2 GB) remain in `staging/installers` until the next successful run.
3. Repair of a damaged DE10 tool asks for the DE10 support file again (no payload is kept on the computer).
4. A cancelled first-time DE10 install shows the board as "Needs repair" rather than "Not installed" / "Setup not finished".
5. Killing the setup process can leave the Lima host agent running (stopped by hand); the interrupted state itself recovered correctly.

## Items 6 and 7 (VS Code window checks)

Item 6 was checked in a second clean window whose root is the isolated Nexys-only install: the Setup list shows "Nexys A7-100T Installed" and "DE10-Lite Not installed" with "Install DE10-Lite Support: uses about 12 GB once finished, needs an internet connection…" (observed from a screenshot). The New Project and no-board message texts are still to be recorded.

## Final state

Full macOS suite: 1131 tests, 1120 pass, 0 fail, 11 skipped. Final Verify on the reference installation: all parts OK, headline "Ready"; its VM is stopped.
