# Phase 5 — Classroom Preview release 0.5.0

Date: 2026-10-03
Branch: `phase5/classroom-release`, from `1e626b5` (Phase 4B closeout). Status: **READY FOR CLASSROOM USE** (Windows x64 and Apple-silicon macOS, §7).

## 1. Scope

Package the artifacts already validated in Phase 4B as a student-ready **Classroom Preview** distribution. This phase does no new development.

- **No rebuilds.** The VSIX and Toolchain 1.0 archives are copied byte-for-byte from the Phase 4B outputs.
- **Nothing frozen was modified:** no changes to the Toolchain 1.0 payloads, the FPGA build/runtime code, the compliance manifests or the source locks.
- Not published: no GitHub release, no commit, no push.

Staging folder (git-ignored): `.artifacts/classroom-release/NexysVHDL-Classroom-Preview-0.5.0/`

```
README-FIRST.md                 which folder to open (students)
Windows/   nexysvhdl-0.5.0-win32-x64.vsix, nexysvhdl-toolchain-1.0-win32-x64.tar.gz, README-WINDOWS.md
macOS/     nexysvhdl-0.5.0-darwin-arm64.vsix, nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz, README-MACOS.md
Board_Test/                     the physically validated demo project (sources only)
Licenses_and_Source/            LICENSE, NOTICE, THIRD_PARTY_NOTICES.md, NexysVHDL-Toolchain-1.0-Sources.zip
SHA256SUMS.txt                  SHA-256 of every file in the package
```

**Why `Licenses_and_Source/` is included.** It was not in the requested layout. It is required because [`toolchain-1.0-redistribution.md`](toolchain-1.0-redistribution.md) §10 says the corresponding-source package ships with any Toolchain 1.0 archive, in the same place and at the same time, and that classroom mirrors must copy it.

**Student instructions are tracked in Git.** The authoritative versions are [`docs/classroom/README-FIRST.md`](classroom/README-FIRST.md), [`README-WINDOWS.md`](classroom/README-WINDOWS.md) and [`README-MACOS.md`](classroom/README-MACOS.md). The package copies are generated from these files and are never edited by hand.

`.artifacts/classroom-release/stage.sh` (not shipped to students) has three commands:

- `stage.sh sums` regenerates and verifies `SHA256SUMS.txt`.
- `stage.sh sync-docs` copies the three READMEs from `docs/classroom/` into the package, then runs `sums`.
- `stage.sh add-macos <vsix> <tar.gz>` checks the macOS artifacts against the recorded size and SHA-256 of the validated build, copies them in, then runs `sync-docs`.

## 2. Supported platforms and board

| | |
|---|---|
| Windows | Windows 10/11 x64 (not Windows on ARM) |
| macOS | Apple silicon (darwin-arm64), M1 or newer. Intel Macs are not supported. |
| Editor | Visual Studio Code 1.120 or newer |
| Board | Digilent Nexys A7-100T (xc7a100tcsg324) |
| Windows programming | the official Digilent Adept Runtime and Adept Utilities, installed by the student from Digilent (NexysVHDL does not redistribute them) |
| macOS programming | openFPGALoader, bundled in Toolchain 1.0; no driver needed |

## 3. Frozen versions

| Item | Value |
|---|---|
| NexysVHDL extension | 0.5.0 (Apache-2.0) |
| Windows VSIX | `nexysvhdl-0.5.0-win32-x64.vsix`: 250,330 B, SHA-256 `ad74cd13999ae938756a2f252cd6b9ca333e05655047377c5126d5b312fdc1dc` |
| Windows Toolchain 1.0 | `nexysvhdl-toolchain-1.0-win32-x64.tar.gz`: 744,121,124 B, SHA-256 `83aeb26539fbd2d4a2aabd0c53015011bb9655da1b8cbfcdde9d841ce5508315`, tree `57f0f0da89e6565d6e46d20780fa57af86f8ac36d45a78b750203fc8f381820b` (21,208 files) |
| macOS VSIX | `nexysvhdl-0.5.0-darwin-arm64.vsix`: 248,875 B, SHA-256 `1447b20bf1fd0c92a8333a0625f2fd308873eca0365131877fece30123db0a00`, built from `47738f2` (see below) |
| macOS Toolchain 1.0 | `nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz`: 657,363,463 B, SHA-256 `d8cdf6e2a6c082d05189396b10892b1a6605a267b2f2b884c9911c9140a2359d` (matches Phase 4B §17.6), tree `f04022180f9bb746dc5dc467bc7d1d379512f302159763f8c4a8c0ed50b2aac7` (31,699 entries) |
| Toolchain sources | `NexysVHDL-Toolchain-1.0-Sources.zip`: 669,964,194 B, SHA-256 `69f496eb2b852f922ce0f1a7b8322ee467be2e23b1da665e35e6f170d1d095b6` |
| Requirement | `toolchains/bundle/requirement.json`: identical to the copy inside the Windows VSIX; the macOS VSIX has the same `darwin-arm64` entry |

**Identity of the Windows VSIX.** The extension installed in the normal VS Code profile for the Windows physical-programming run is `~/.vscode/extensions/emxplore.nexysvhdl-0.5.0`, installed 2026-10-03 18:43Z. Its files are byte-identical to the VSIX above. The only difference is VS Code's own `__metadata` key in `package.json`. The toolchain store used for that run reports tree `57f0f0da…`, installed 18:47Z from `nexysvhdl-toolchain-1.0-win32-x64.tar.gz`.

**Identity of the macOS artifacts.** Both files were transferred from the Mac on 2026-10-03 as the validated macOS artifacts.

- **Toolchain:** its size and full SHA-256 match the Phase 4B record.
- **VSIX: not the build recorded in Phase 4B.** It is not the `5c1ae73a…` (248,794 B) build recorded in §17.15. Its file time is 2026-10-02 21:41, one minute before commit `47738f2` ("add macOS bundled toolchain distribution", 21:42), and it matches that commit:
  - `readme`, `changelog`, `THIRD_PARTY_NOTICES.md`, LICENSE, NOTICE and all 18 files under `docs/`, `resources/`, `boards/` and `toolchains/` are byte-identical to `47738f2`;
  - the VSIX manifest targets `darwin-arm64`; the extension version is 0.5.0.
- **Compared with the validated Windows VSIX** (built later, from the Phase 4B compliance work), the compiled runtime differs in exactly one file, `dist/core/toolchain/tar.js`. That difference is the only runtime source change since `47738f2` (`core/toolchain/tar.ts`): a fix that normalises Windows link-target separators, and does nothing on macOS. The rest of that diff is the compliance tar writer, which the Mac runtime does not use.
- **Toolchain requirement:** the VSIX's embedded `requirement.json` has the same `darwin-arm64` entry as HEAD (tree `f0402218…`). Its `win32-x64` entry is the earlier internal candidate `43b3fb80…`, which is unused on a Mac.
- **Verified on the Mac (2026-10-03):** this VSIX matches the extension installed in the normal VS Code profile used for the successful macOS physical-board validation. The check was:

  ```bash
  unzip -q nexysvhdl-0.5.0-darwin-arm64.vsix -d /tmp/nxv && diff -r /tmp/nxv/extension ~/.vscode/extensions/emxplore.nexysvhdl-0.5.0
  ```

  The only differences were VS Code's installed `.vsixmanifest`, and VS Code's formatting and `__metadata` in `package.json`. This is the same result as the Windows check above.
- **Phase 4B record:** the `5c1ae73a…` hash recorded in Phase 4B §17.15 belongs to an earlier rebuild. The physically validated macOS VSIX is `1447b20b…`.

**Board_Test.** Copied unchanged from `D:\Vivado_Projects\Term261\Board_Test`, the project built and programmed in the Windows closeout at 21:50–21:51 local time. The copy includes `.gitignore`, `nexysvhdl.json`, `src/top.vhd`, `sim/top_tb.vhd` and `constraints/nexys-a7-100t.xdc`. The generated `.nexysvhdl/` folder is left out: it holds the bitstream, logs and waveforms, about 28 MB, and is recreated by Check/Simulate/Build. The project contains no absolute paths.

## 4. Inherited Phase 4B validation

From [`phase4b-classroom-bundle.md`](phase4b-classroom-bundle.md) §10, §16, §17 and §20–§21. The same VSIX and toolchain archives were validated in Phase 4B.

| | Windows x64 | macOS arm64 |
|---|---|---|
| Installed-package validation (private profile, standard and hostile paths) | PASS | PASS |
| Bundled-only tools (process trace), external tools untouched | PASS | PASS |
| Check / Simulate / Build | PASS | PASS |
| Hardware detection | PASS (Digilent `djtgcfg`) | PASS (bundled openFPGALoader) |
| Program, with physical behaviour on a Nexys A7-100T (SW0 → LED0 blinks, BTNC restarts) | PASS | PASS |
| Redistribution/license | READY (0 blocking items) | READY |

## 5. Classroom acceptance criteria

The release counts as accepted for the pilot when a student on a supported computer, following only `README-FIRST.md` and their platform README:

1. installs VS Code and the VSIX with **Install from VSIX…**;
2. installs Toolchain 1.0 with **NexysVHDL: Install FPGA Toolchain…**, and **Show Environment** reports *Bundled FPGA Toolchain — Ready — 1.0*;
3. Windows only: has *Digilent USB/JTAG Support — Ready* after installing the official Adept Runtime and Adept Utilities;
4. opens a trusted copy of `Board_Test`; **Check VHDL**, **Simulate** and **Build** succeed;
5. connects a Nexys A7-100T, which is detected, and **Program FPGA** succeeds;
6. observes SW0 → LED0 blinking, and BTNC restarting it;
7. installs no other software: no Node, npm, Python, Git, Homebrew, Vivado or FPGA command-line tools.

The instructor checks the package with `SHA256SUMS.txt` before handing it out:

- Windows (Git Bash) or Linux: `sha256sum -c SHA256SUMS.txt`
- macOS: `shasum -a 256 -c SHA256SUMS.txt`

## 6. Known limitations

- **Classroom Preview.** Not on the Marketplace, no auto-update, no telemetry. Install is two steps (VSIX, then toolchain archive), and the toolchain stays on disk after uninstall. Installed size: about 3.0 GB on Windows and 2.6 GiB on macOS.
- **Workspace Trust.** NexysVHDL does not run in Restricted Mode, so the project folder must be trusted.
- **Windows programming** needs Digilent Adept Runtime 2.30 or newer and Adept Utilities, installed by the student. A Vivado driver install alone is not enough.
- **macOS toolchain binaries** are ad-hoc signed and not notarized (upstream binaries).
  - Installed through NexysVHDL, they work.
  - Extracted by hand, they are blocked by quarantine.
  - Managed Macs with strict MDM policies are untested.
- **Notices inside the VSIX.** The `THIRD_PARTY_NOTICES.md` inside both VSIXs (the macOS copy is the one from `47738f2`, older still) is the summary from before the final compliance audit (`f6ca6fa`). It still says the review has open items. The current text is `Licenses_and_Source/THIRD_PARTY_NOTICES.md` in this package, and `README-FIRST.md` names it as the authoritative notices for this distribution. The VSIX was not rebuilt, so that it stays the validated build. Refresh the VSIX copy in the next VSIX release.
- **macOS payload notice errata** ([`toolchain-1.0-redistribution.md`](toolchain-1.0-redistribution.md) §9): Apio/definitions are labelled GPL-2.0 (correct: GPL-3.0), and the Graphviz license text is wrong. Both are deferred to the next Mac toolchain version. The payload is frozen.
- **Unsupported:** Intel Macs, Windows on ARM and Linux.
- **Path limits** carried over from Phase 4B §14 and §17.13:
  - VHDL *file* names must use only English letters;
  - a Windows machine that forbids `%ProgramData%\NexysVHDL\links` breaks Build/RTL for accounts with non-ASCII names;
  - very long Windows user names are untested.
- **Board_Test** must be copied to a writable folder, for example Documents, before it is opened.

## 7. Release status and the 2026-10-04 classroom pilot

The package is complete:

- both platforms' VSIX and Toolchain 1.0 archives, Board_Test, and Licenses_and_Source;
- 16 files, 2,071,988,597 B (1.93 GiB);
- every SHA-256 in `SHA256SUMS.txt` verified;
- the README copies are identical to `docs/classroom/`.

The macOS files were added with `stage.sh add-macos` from `.artifacts/incoming-macos/`. The macOS VSIX was verified on the Mac as the physically validated build (§3).

| Classroom status | |
|---|---|
| Windows x64 | **READY** |
| macOS Apple silicon | **READY** |
| Package `NexysVHDL-Classroom-Preview-0.5.0` | **READY FOR CLASSROOM USE** |

The class on 2026-10-04 is the **initial user pilot** of the Classroom Preview: the first use by students rather than developers. Record for each student:

- platform and OS version;
- whether each acceptance step (§5) passed;
- install time;
- every message or confusion, especially at Workspace Trust, the Digilent setup and the toolchain installation.

Pilot findings go into the next patch release (0.5.x, UI-only, reusing Toolchain 1.0). They do not go into Toolchain 1.0, which stays frozen.
