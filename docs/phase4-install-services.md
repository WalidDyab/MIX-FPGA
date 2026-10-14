# Phase 4 · Checkpoints F–H — Rosetta, FPGA engine, Quartus/MAX 10 installation services

Status: implemented and tested against fake and isolated roots. Nothing was migrated, no VM was created, Quartus was not reinstalled.

## F · Rosetta (`platform/macos/install/rosetta.ts`)
* State: `ready` only if Apple's runtime file exists **and** an x86-64 program really starts (`arch -x86_64`); missing → `not-installed`; present but not translating → `repairable`; Intel Mac → `incompatible`. Ownership is `system`.
* Installation is always user-initiated and never silent. Apple's documented installer is `softwareupdate --install-rosetta`; its `--agree-to-license` flag means "agree without user interaction" (`softwareupdate -h`). Two supported modes:
  * `apple-prompt` (recommended): the command runs in a terminal the student can see; Apple shows its licence and the student types the agreement and the administrator password there. MIX-FPGA never passes `--agree-to-license`, never sees the password.
  * `agree-to-license`: only if the Setup page showed Apple's licence reference and the student explicitly ticked acceptance (`studentAcceptedAppleLicense: true`).
* No consent → the engine reports `awaiting-input` and no command exists to run. Rosetta is never bundled or redistributed.
* **Pending fresh-Mac validation:** this Mac already has Rosetta and it was not uninstalled. The real `softwareupdate` run, the Terminal hand-off and the OS administrator prompt are untested. State and action boundaries are unit-tested.

## G · Managed FPGA engine (`engine-provision.ts`, `engine-config.ts`, `download.ts`)
* Same validated configuration (Lima 2.2.1, `vz`, aarch64, 4 CPU, 8 GiB, 60 GiB **sparse maximum**, Rosetta + binfmt, only `staging/` shared writable). The template `engine/mix-fpga-de10.yaml` gets the local, digest-verified image and the real staging folder filled in.
* Ubuntu image: downloaded to `downloads/`, resumable (Range), published by rename only after sha256 `1d6bffe6…cefc55` matches (the copy cached on this Mac has exactly that hash, 620,224,512 bytes).
* Inspection reads `limactl list --json` only. It never starts the VM or enters it. Opening MIX-FPGA, Check, Simulate and Schematic therefore never start it; only Build (existing code) and setup do.
* Setup is resumable by phase (`state/linux-vm.json`). A broken engine of ours is replaced; one that ever held Quartus is never deleted automatically (`RECREATE_NEEDS_CONFIRMATION`). A different configuration under our name is `incompatible` and is left alone. Settings drift is repaired in place.
* Preflights: free disk (20 GB), Lima socket-path length (detection only, no alias).
* Student-facing storage numbers (`EXPECTED_STORAGE`): ≈0.6 GB image, ≈2.4 GB after Linux, ≈12 GB after Quartus (measured), 2.3 GB of temporary installer copies; 60 GB is only a limit.
* `ensureReady()` (existing, unchanged) still repairs the known `rosettad` condition; `installedDe10Paths()` points it at the installed `engine/` scripts.
* **Not validated against real Lima:** `limactl create` with a local image path and `limactl edit` are exercised only through a fake. They need the approved isolated VM test.

## H · Quartus / MAX 10 (`quartus-install.ts`)
* Flow: student picks the two Altera files → size and sha256 are checked (name is never trusted; swapped, damaged and wrong files are told apart) → Altera licence requirement shown → explicit acceptance recorded (what was shown, when) **before** the installer is run → verified temporary copies in `staging/installers/` (originals untouched) → unattended install of only quartus, devinfo and max10, no GUI, no shortcuts → verification → copies removed.
* Verification (`verifyQuartus`): exact Build 1129, six command-line tools, MAX 10 family, device `10M50DAF484C7G`, and a tiny design through `quartus_map`, `quartus_fit`, `quartus_asm` for that device. **Run for real against the existing Quartus on this Mac (read-only; scratch folder removed): passed in 22 s.**
* An interrupted install is `repairable`; the retry removes only the unfinished install folder, reuses the verified copies, and finishes. A working Quartus of the right build is never reinstalled over.
* The pinned hashes equal those of the real files on this Mac (checked read-only).
* **Open:** the exact Altera licence text or link the Setup page must show is not fixed here; the UI step must take it from Altera's official source. No internet is needed by this step.
