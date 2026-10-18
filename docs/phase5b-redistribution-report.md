# Phase 5B: macOS redistribution and licensing closure (report)

Date: 2026-10-19. Status: **report for owner review, nothing committed, nothing published.** This is an engineering/compliance assessment, not legal advice. Items that need a decision or counsel are marked **OWNER** or **COUNSEL**.

Deliverables (uncommitted, in `docs/phase5b/`):

| File | What |
|---|---|
| [`THIRD_PARTY_NOTICES.macos-DRAFT.md`](phase5b/THIRD_PARTY_NOTICES.macos-DRAFT.md) | complete draft notices for the macOS release (DRAFT marking kept) |
| [`macos-component-license-inventory.md`](phase5b/macos-component-license-inventory.md) | per-component licence inventory generated from the committed inventories (36 DE10 components, 7 + 58 + 70 Nexys entries) |
| [`macos-source-provenance-manifest.json`](phase5b/macos-source-provenance-manifest.json) | binary-to-source mapping with archive hashes |
| [`upstream-notices/`](phase5b/upstream-notices/) | Lima 2.2.1 NOTICE (missing from the Lima tarball) with provenance |

## A. Baseline

Branch `phase5/release-preparation`; local and `origin/phase5/release-preparation` both `62e7d0a`; working tree clean at the start. macOS suite: **1131 tests, 251 suites: 1120 pass, 0 fail, 11 skipped** (the 11 skips: 9 Windows-only, 1 "no built package", 1 "Altera files not present"). The validated `~/Library/MIX-FPGA` installation was not modified (the one clone used for the Repair experiment lived in the session scratch folder and was deleted).

## B. Inventory

Method: the committed inventories (`toolchains/mixfpga/compliance/macos-arm64.inventory.json` for the DE10 archive, `toolchains/compliance/toolchain-1.0.json` for the Nexys archive) were **checked against the distributed archives**, not trusted as given:

- DE10 archive extracted: 818 files, manifest sha256 `204532e3…`; `otool -L` of `ghdl`, `yosys`, `openFPGALoader` and `limactl` shows the only non-system dependencies are `libreadline.8.2`, `libffi.8`, `libz.1.3`, `libtcl8.6` (yosys) and `libusb-1.0.0`, `libftdi1.2.5.0`, `libhidapi.0`, `libz.1.3` (openFPGALoader), all shipped beside them; GHDL and Lima have none. `ghdl --version` (GNAT 14.2.0, LLVM JIT), `yosys -V` (0.63+173, `66306a8ca-dirty`), `openFPGALoader v1.1.1`, `limactl 2.2.1`.
- Unmodified claim, verified: GHDL, ghwdump, yosys, libreadline, openFPGALoader, libusb and libftdi are byte-identical (sha256) between the Nexys and DE10 archives; the DE10 archive's Lima tree is identical to the official `lima-2.2.1-Darwin-arm64.tar.gz` (`diff -r`, no differences). MIX-FPGA modifies no third-party component; its only authored content is the manifests, the engine VM template and provisioning scripts (Apache-2.0).
- Nexys archive: 34,529 archive entries; tarball sha256 `d8cdf6e2…` equals the pin; `apio/bin/LICENSE` is the GPLv3 text (confirms Apio is GPL-3.0-or-later).
- Existing corresponding-source zip `NexysVHDL-Toolchain-1.0-Sources.zip` (669,964,194 B, sha256 `69f496eb2b852f922ce0f1a7b8322ee467be2e23b1da665e35e6f170d1d095b6`, strict build of 3 Oct): `unzip -t` clean; the 11 archives that the DE10 archive's GPL/LGPL components need (GHDL, Yosys + abc + cxxopts, readline 8.2 + patch 001 + MacPorts port, libusb 1.0.26 + port, libftdi1 1.5 + port) all hash-match the DE10 inventory.

Per-component licence, upstream project, version, source id, class and linking are in the inventory file; the obligation classes are:

| Class | DE10 archive | Nexys archive |
|---|---|---|
| Source must be provided | GHDL (+libghw), Yosys as combined with readline, readline, libusb, libftdi | GHDL, Apio, Apio definitions, GPL/LGPL tools and libraries of the oss-cad-suite, Qt 5.15.3, GTK stack, readline, libusb, libftdi, GMP, EPL/EUPL/MPL pieces |
| Text and notice only | openFPGALoader, Lima (+NOTICE), LLVM, zlib, zstd, hidapi, libffi, Tcl, ncurses, IEEE-2008, Synopsys | Yosys, nextpnr, Project X-Ray, Python, OpenSSL, verible, Boost, ICU, MacPorts/Nix permissive libraries |
| Exception | GNAT/GCC runtime (GPL-3.0 with exception) | same |
| MPL-2.0 pointer | `hashicorp/hcl/v2` v2.24.0 in Lima | certifi, Eigen |

Dynamic vs static linking: every LGPL/GPL library is a separate dylib loaded through `@executable_path`/`@rpath` (replaceable). Statically linked: LLVM in `ghdl` (Apache-2.0 with exception, no source duty), the libraries compiled into `yosys` (all permissive/public domain), Go modules in Lima (one MPL-2.0).

## C. Resolution of the open items

Status words: **CLOSED** = closed by evidence in the shipped bits and sources; **CONDITIONAL** = closed technically, needs a written position; **OPEN** = not closed.

| Id | Finding (evidence) | Status |
|---|---|---|
| **L1** IEEE 1076.3-1995 | The v87/v93 `numeric_bit`/`numeric_std` sources (and compiled forms) carry a header saying they may be distributed unchanged and may not be sold or distributed for profit. They are in **both** archives (same GHDL). MIX-FPGA invokes GHDL only with `--std=08` (`core/vhdl/ghdl/ghdl-provider.ts:12`), and the 2008 IEEE packages carry the Apache-2.0 header, so no MIX-FPGA flow uses the 1995 sets. Free classroom distribution of the unmodified files looks within the stated terms; any sale or bundling with a paid product would not. | **OPEN, OWNER + COUNSEL.** Options: (a) written acceptance limited to free, unmodified distribution; (b) remove `ieee/v87`, `ieee/v93` numeric sets in Toolchain 1.1 (payload change, not done here). |
| **L2** VITAL, UPF | No licence statement in the files; GHDL's own documentation says the VITAL packages are not part of IEEE's open distribution. Unused by MIX-FPGA. | **OPEN, COUNSEL.** Removal candidate for Toolchain 1.1. |
| **L3** Yosys + GPLv3 readline | Confirmed: `yosys` loads `libreadline.8.2.dylib` (GPL-3.0-or-later text shipped; COPYING is GPLv3). Position: treat the pair as a GPLv3 combination (Yosys' ISC is GPL-compatible), provide corresponding source of both with the build recipe, keep readline replaceable. All needed sources are in the source zip and hash-verified. | **CONDITIONAL.** Closed technically; the combined-work position needs COUNSEL confirmation; requires the source package and offer to ship. |
| **L4** `-dirty` Yosys | The recipe (`default/scripts/yosys.sh` of YosysHQ/oss-cad-suite-build `ac8c7dba`, in the zip) builds Yosys at `origin/main` on macOS with `make config-clang` and then `sed -i` on the tracked `Makefile` (compiler substitution). A modified tracked file explains the `-dirty` suffix without source changes. Not proven by a reproduced build. The libraries compiled into Yosys (ezSAT, MiniSat, json11, fstapi, sha1, BigInteger, subcircuit, cxxopts, ABC) are now identified with licences (notices draft, section 6); the texts exist in the source tree. | **CONDITIONAL.** Source + recipe supplied; provenance of the exact binary is an explained inference. Texts of the compiled-in libraries must be copied into the shipped notices. |
| **L5** libusb text | `LICENSES/libusb/COPYING` (LGPL-2.1) is shipped next to the 1.0.24-revision `LICENSE.libusb`; the 1.0.26 source is in the zip. | **CLOSED.** |
| **L6** GHDL build recipe, GNAT origin | The recipe is in the GHDL source tarball: `.github/workflows/Build-MacOS.yml` and `Pipeline.yml` build the `llvm-jit` macOS-15 variant with GNAT FSF build `14.2.0-1` (alire-project/GNAT-FSF-builds) and Homebrew LLVM; this matches `GNAT 14.2.0` and "Homebrew LLVM 22.1.0" in the binary. The runtime exception means no runtime source is required. | **CLOSED** (the official release is not independently rebuilt). |
| **L7** GHDL GPL and output | GHDL's documentation states GRT and `std.textio` are GPLv2 and that executables produced by GHDL may not be distributed without VHDL sources (most GRT files carry a linking exception; the docs do not mention it). MIX-FPGA runs in memory and distributes no student executables. | **CLOSED for MIX-FPGA** by a notice to students (draft, section 6). |
| **L8** headers without licence | `vpi_user.h`, `synth_gates.h`: unchanged. | **OPEN (minor, COUNSEL).** |
| **L9** repair versus replacement rights | Tested, see E. Replacement works and nothing is restored automatically. | **CONDITIONAL.** Behavior acceptable; needs the documentation text (notices section 8) and COUNSEL confirmation. |
| **L10** openFPGALoader bridge bitstreams | 111 bitstreams, no per-file provenance. Unused by MIX-FPGA flows. | **OPEN, COUNSEL.** Removal candidate. |
| **L11** Lima module licences | 100 modules + stdlib collected; one MPL-2.0 module (`hashicorp/hcl/v2` v2.24.0). **New finding:** Lima 2.2.1's own `NOTICE` (Apache-2.0 §4(d)) is not in the official tarball nor in the DE10 archive. | **OPEN:** NOTICE copied to `docs/phase5b/upstream-notices/`; must be added to the shipped notices; hcl needs a source pointer or a copy in the source package. |

Known notice defects, all confirmed in the shipped archive (`THIRD_PARTY_NOTICES.md` inside `nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz`): it labels Apio and Apio definitions "GPL-2.0" (the bundled `LICENSE` is GPLv3; correct is GPL-3.0-or-later and GPL-3.0), ships a Graphviz EPL-2.0 text for an EPL-1.0 binary and a libwdi text not needed on macOS, and says source is "available from the upstream projects". The DE10 archive's `THIRD_PARTY_NOTICES.txt` begins "DRAFT - NOT FOR REDISTRIBUTION". Items the user asked about: Qt 5 (58 frameworks, 67 plugins, six GPL-3.0-only modules; 45 module archives in the zip; unused by MIX-FPGA), libusb/libftdi (covered), OpenSSL (Apache-2.0 texts, in zip supplement), GHDL/GNAT runtime (L6), Apio, oss-cad-suite and openFPGALoader (inventoried; no NOTICE file upstream for openFPGALoader v1.1.1), Lima (L11): all have a source id and licence text in the inventory; the texts that the archives do not carry themselves are in the zip's `licenses/compliance/` and must travel with them.

## D. Corresponding-source package design

`MIX-FPGA-0.7.0-macos-sources/` (or one zip of that name), published at the same place and time as the archives and copied by classroom mirrors:

```
MIX-FPGA-0.7.0-macos-sources/
  README.md                 what it is; which binary maps to which source; how to rebuild/replace (notices section 8)
  manifest.json             sha256 of every file; = docs/phase5b/macos-source-provenance-manifest.json plus hashes
  THIRD_PARTY_NOTICES.md    the final notices
  sources/                  from the existing NexysVHDL-Toolchain-1.0-Sources.zip (reuse byte for byte, hashes recorded):
                            ghdl-6.0.0, oss-yosys (+abc, +cxxopts), yosyshq-oss-cad-suite-build, readline 8.2 + patch 001 + MacPorts port,
                            libusb 1.0.26 / 1.0.30 + ports, libftdi1 1.5 + port, Apio 1.7.0, apio-definitions, tools-oss-cad-suite,
                            tools-openxc7, Qt module archives, MacPorts/Nix recipes, ...  (153 sources in the lock)
                            NEW: hashicorp-hcl-v2.24.0.zip (go proxy, sha256 53fd4e96...f4810)
  licenses/                 shared/, compliance/darwin-arm64/ (texts the archives do not carry), upstream-notices/Lima-2.2.1-NOTICE.txt
  patches/README.md         "none: MIX-FPGA modifies no third-party source" (Qt carries one patch applied by the Qt packager, recorded in mmicko/macos-resources 364d180c in sources/)
  mix-fpga/                 LICENSE, NOTICE, engine scripts (own code)
```

What must accompany vs be offered:

- **Must be provided with (or offered in writing for) the binaries:** GHDL, Yosys + abc + cxxopts + build recipe, readline + patch + port, libusb, libftdi, Apio and its definitions, the GPL/LGPL/EPL/EUPL tools and libraries of the Nexys archive, Qt module archives. GPLv2 §3 and LGPL allow a written offer (valid three years) instead of shipping, but only for the original distributor; shipping the package is the safer mechanism and is what the earlier review used. Recommendation: ship it beside the archives and add the written offer as a backstop (contact and duration: OWNER).
- **May be pointed to upstream (permissive, no source duty):** openFPGALoader, Lima, LLVM, GNAT runtime, zlib/zstd/hidapi, and (unmodified) the MPL-2.0 `hcl` module under MPL §3.2 if the owner prefers; including the module zip in the source package is simpler.
- **Size:** the existing zip is 639 MiB; the 11 archives that the DE10 archive needs total 21.4 MiB (GHDL 7.9 MB, abc 7.2 MB, Yosys 3.6 MB, readline 3.0 MB, and small ones), plus the hcl module, so a student on a DE10-only path need not download the Qt-heavy parts if the package is split per archive (OWNER decision: one package or one per support archive).

## E. Repair semantics versus replacement rights

Code reading plus an experiment on a throw-away clone of the DE10 toolchain (replaced `libftdi1.2.5.0.dylib` by appending a byte, made writable, ad-hoc re-signed):

| Question | Finding |
|---|---|
| Can students replace covered libraries? | Yes. The folder is read-only (`makeReadOnly`) but the user owns it and can `chmod u+w`. On Apple silicon a replaced library needs re-signing (`codesign -f -s -`); with a deliberately invalid signature the tool still ran, so library validation is not enforced. |
| Does Verify only warn, or block execution? | Setup/Verify report "openFPGALoader: 1 changed" (state `repairable`). Nothing blocks execution: tool discovery (`programmer.availability`, `vhdlToolsPresent`) checks presence and version, not hashes, and `openFPGALoader --Version` ran with the modified library. |
| Does Repair overwrite automatically? | No. Repair and Install run only from the student-initiated Repair/Install buttons (`commands.ts` → `controller.repair`) after a confirmation, and need the support file again. No code path repairs silently. |
| Side effect | `isBoardReady()` uses the quick check, which hashes executables and libraries, so a replaced library makes `boardState` not "installed": New Project for that board would show "DE10-Lite support is not installed / Install Support" (read from code, not exercised in the UI). Existing projects still build and program. |
| Documentation | Needed: say plainly that the integrity check is a support aid, how to replace a library, that replaced configurations are unsupported, and that Repair restores originals only on request (draft notices, section 8). |

**Smallest change if counsel wants one:** none to the code is required for the right to modify and replace to hold. Optional: one sentence in the Repair confirmation, "Repair replaces any MIX-FPGA tool files you changed with the originals" (text only), and soften the New Project prompt wording when the state is "needs repair" rather than "not installed". Not implemented.

## F. Notices

Complete draft in [`phase5b/THIRD_PARTY_NOTICES.macos-DRAFT.md`](phase5b/THIRD_PARTY_NOTICES.macos-DRAFT.md); per-component inventory and provenance manifest as listed above. All DRAFT warnings remain (including the ones inside the shipped archives and in `payloads-1.0.json`). Legal conclusions are marked as engineering assessment.

## G. Distribution decision

| Artifact | Status | Exact reason |
|---|---|---|
| **MIX-FPGA VSIX** (`nexysvhdl-0.7.0-darwin-arm64.vsix`) | **READY SUBJECT TO SPECIFIC NOTICE ATTACHMENT** | Own code only (Apache-2.0), no third-party code, privacy audit clean. Its embedded `THIRD_PARTY_NOTICES.md` still describes "NexysVHDL" and omits the DE10 archive, Lima, the engine and the Altera/Canonical/Apple "not included" items; attach/replace with the final notices. `payloads-1.0.json` keeps the internal-use warning until the gate closes (by your instruction), so the VSIX alone installs but its DE10 path cannot be offered to students yet. |
| **Nexys A7 support archive** | **NOT READY** | L1 and L2 (shared GHDL libraries) are open and need an OWNER/COUNSEL decision; the notices inside the archive are wrong in the points listed in C and must be superseded by the final notices; the corresponding-source package and written offer (contact) must ship with it. After L1/L2 are decided and the package is attached it becomes READY SUBJECT TO ATTACHMENT. |
| **DE10-Lite support archive** | **NOT READY** | Same L1/L2; additionally its notices say "DRAFT - NOT FOR REDISTRIBUTION", Lima's NOTICE is missing, the `hcl` MPL-2.0 pointer and the compiled-in Yosys library texts are missing from the notices, L3/L4/L9 need counsel confirmation, and no student-facing source package exists for it yet. |
| **Corresponding-source package** | **READY SUBJECT TO SPECIFIC NOTICE/SOURCE ATTACHMENT** | The existing 639 MiB zip is built, hash-pinned and verified for every GPL/LGPL source of both archives (the 11 DE10-relevant archives re-verified). Needed before use: re-brand/re-describe for MIX-FPGA 0.7.0 with the binary-to-source mapping (drafted), add the `hcl` module archive and the Lima NOTICE, add the final notices, record the new hash. These additions change the package hash, so it must be rebuilt and re-hashed. |

## H. Unresolved items, stated without guessing

1. **L1** IEEE 1995 "not for profit" packages: needs OWNER acceptance (free, unmodified distribution only) or removal in Toolchain 1.1; COUNSEL to confirm either.
2. **L2** VITAL/UPF licence unknown. **L8** two headers without licence. **L10** 111 bitstreams without provenance.
3. **L3** GPLv3 combined-work position for Yosys + readline: COUNSEL.
4. **L4** exact-binary provenance of `-dirty` Yosys is explained by the recipe but not reproduced.
5. **L9** documentation wording and counsel confirmation.
6. Written-offer contact and duration, and hcl pointer-versus-copy: OWNER.
7. Whether the source package is one zip or split per archive: OWNER.
8. The Nexys archive and DE10 archive notices embedded in their (hash-pinned) payloads are wrong or DRAFT; correcting them inside the archive means a new payload and a new tree hash, so the Phase 5B recommendation is to supersede them with the attached final notices now and correct the payloads in Toolchain 1.1 (which can also drop Qt, the GTK stack, VITAL/UPF, the 1995 IEEE sets and the bridge bitstreams).
9. Not verified: no counsel review has taken place; the upstream binaries were not rebuilt; the compiled-in Yosys library copyright lines were identified from the source tree, not extracted into final notice text.

## Next step proposal (nothing done)

On your approval: (1) decide L1/L2 and the offer contact; (2) I assemble the final notices and a rebuilt `MIX-FPGA-0.7.0-macos-sources` package (reusing the verified archives, adding hcl and the Lima NOTICE); (3) rebuild the VSIX with the MIX-FPGA notices; (4) re-hash and re-run this checklist. Nothing has been signed, notarized, uploaded or published.

## Owner decisions recorded (2026-10-19) and what they imply

| # | Decision | Consequence (engineering) |
|---|---|---|
| 1 | L1: remove the unused 1995 `numeric_std`/`numeric_bit` packages in Toolchain 1.1; no reliance on a "classroom-only" reading | Payload change: both archives (GHDL is shared). L1 stays **OPEN until the rebuilt payloads exist**. |
| 2 | L2 + L10: remove VITAL, UPF and the unproven openFPGALoader bridge bitstreams | Payload change: GHDL library tree and `openfpgaloader/share`. L2/L10 stay **OPEN until rebuilt**. |
| 3 | No written offer: ship the complete corresponding-source package beside the binaries; counsel to confirm | The source package becomes mandatory next to each archive; hosting it for as long as the binaries are offered is still an obligation. |
| 4 | Include the exact MPL-2.0 `hcl` module archive in the source package | Add `proxy.golang.org .../hcl/v2/@v/v2.24.0.zip` (sha256 `53fd4e96...f4810`) to the DE10 package. |
| 5 | One source package per support archive; duplication accepted | Nexys A7 package and DE10-Lite package, each with its own manifest, notices and one-to-one mapping. |
| 6 | Correct the notices inside the payloads; rebuild, new hashes, revalidate | New payloads (Toolchain 1.1), new `requirement.json`, regenerated manifests and notices, repeat of the Phase 5A acceptance. |

### Evidence gathered for the removal (scratch copy of the DE10 GHDL tree, nothing in the repository or `~/Library/MIX-FPGA` touched)

- The 1995 sets are `lib/ghdl/src/ieee/v87|v93/numeric_{bit,std}{,-body}.vhdl` (8 files with the "not for profit" header) inside the VHDL-87/93 IEEE libraries (`ieee/v87`, `ieee/v93`: `std_logic_1164` v87/v93 carry the Apache-2.0 header). MIX-FPGA only ever runs `--std=08`.
- VITAL-2000 is **compiled into the 2008 IEEE library index** (`ieee/v08/ieee-obj08.cf` lists `src/vital2000/*`), the VITAL-95 and UPF sources into the 87/93 indexes. So removing VITAL means regenerating `ieee-obj08.cf` (and `ieee-obj19.cf`) rather than only deleting files.
- With `ieee/v87`, `ieee/v93`, `std/v87`, `src/ieee/v87|v93`, `src/vital95`, `src/upf` removed, the real `--std=08` commands (analyse, elaborate, run, `--synth --out=verilog`) pass on `examples/nexys-a7-counter` ("ALL TESTS PASSED (28 checks)"). With `src/vital2000` also removed they still pass, but the index then lists missing files, hence the regeneration.
- openFPGALoader's 111 bridge bitstreams are `share/openFPGALoader/spiOverJtag_*` (110) and `bpiOverJtag_*` (1), 5.9 MB; MIX-FPGA programs SRAM only.
