# Counsel review package: MIX-FPGA 0.7.0 macOS support archives (Toolchain 1.1 candidate)

**Status: candidate for review. Nothing here is legal advice and we claim no legal clearance.** The product still requires Toolchain 1.0; Toolchain 1.1 and its notices are marked CANDIDATE; nothing is published. This folder covers only the four questions still open after the engineering work (L1, L2, L5-L8, L10 and L11 were closed by removing the content or by evidence; see the Phase 5C report if you want the history, you do not need it).

## What is to be distributed (macOS, Apple silicon, free classroom use)

MIX-FPGA is an Apache-2.0 VS Code extension (Walid Dyab, an EMXplore project). Students also receive two **support archives** that bundle third-party programs, unmodified except for the omissions and regenerated index files listed in their notices, each together with its **own corresponding-source package**:

| Archive | Contents | Source package |
|---|---|---|
| Nexys A7 support, `nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz`, SHA-256 `6fc1f3ad3f0343fc04b2e270f669824db30f84bf71b91bd38640482f20433f0f` | official Apio 1.7.0 and YosysHQ oss-cad-suite packages, GHDL 6.0.0, openXC7 | `MIX-FPGA-Nexys-A7-Support-1.1-Sources.zip`, `5ccdc8f3f9389945fc9500a0dd24e871aa9d36d568567b140e229db5d867c2e1` |
| DE10-Lite support, `mixfpga-de10-lite-support-1.1-macos-arm64.tar.gz`, SHA-256 `25317169b9bab2a636cf5cf420238eab43ad2c955dd82acddcf566244b3f6aa2` | GHDL 6.0.0, Yosys 0.63+173, openFPGALoader 1.1.1, Lima 2.2.1 | `MIX-FPGA-DE10-Lite-Support-1.1-Sources.zip`, `8c76974eb5cf91c2ad79743bcf59739fdb7ede7933fd756412078494563824fa` |

The shipped notices are copied in `evidence/` (`nexys-archive-THIRD_PARTY_NOTICES.md`, `de10-archive-THIRD_PARTY_NOTICES.txt`); licence texts are in `licence-texts/`; every evidence file is listed with its SHA-256 in [EVIDENCE-SHA256.txt](EVIDENCE-SHA256.txt).

## The four questions (please answer yes or no, and say what is needed if no)

1. **L3 ([L3-yosys-readline.md](L3-yosys-readline.md)).** Yosys (and `yosys-abc`, `yosys-filterlib`) dynamically links GNU Readline 8.2 (GPL-3.0-or-later). We propose to distribute the combination under the obligations of GPLv3 (GPLv3 text, complete corresponding source and build scripts, Readline kept replaceable). **Is that sufficient?**
2. **L9 ([L9-replacement-rights.md](L9-replacement-rights.md)).** The installed toolchain is hash-verified and read-only by default; a changed library is reported as "changed" and never overwritten except on an explicit Repair/Install request, which restores the supported release copy; the tools run with a replaced library; the user can replace it again. **Do this behaviour and our documentation preserve the replacement/modification rights under the LGPL and GPLv3 components and satisfy the MPL-2.0 for the unmodified compiled-in `hcl` and Eigen code?**
3. **L4 ([L4-yosys-provenance.md](L4-yosys-provenance.md)).** The shipped Yosys reports `-dirty`; the recipe's compiler-name `sed` on the tracked Makefile reproduces that; a native rebuild from the pinned commit has an identical 11,515-line help text but is not bit-identical (original cross-compile image unavailable). **Is this provenance evidence sufficient, given exact corresponding source and the build recipe?**
4. **Source delivery ([source-distribution-model.md](source-distribution-model.md)).** Each archive is distributed with its own hash-pinned source package at the same place and time; no written offer. **Does this satisfy the GPL/LGPL/MPL source-delivery requirements for this classroom release?**

## Things we want you to know up front

- The **DE10-Lite archive's notices lack the dedicated "right to modify and replace" section** that the Nexys archive's notices have, although their L9 paragraph says they explain it. It will be added in the final rebuild after your answers (the candidate is frozen).
- In the **Nexys archive**, `libreadline` is also linked by Icarus Verilog (`vvp`, `vhdlpp`, `ivl` modules; recorded as GPL-2.0, "only" versus "or later" not yet established), `yosys-abc`, `yosys-filterlib` and Python 3.11's `readline` module. MIX-FPGA runs only `yosys` and `yosys-abc` from that set. We can remove the unused programs in a later toolchain version if you advise (L3 section 3).
- The rebuilt Yosys is not bit-identical to the shipped one (L4 section 5).
- No Digilent, Altera, Apple or Canonical software is redistributed (Altera Quartus is supplied by the student; Ubuntu is downloaded on the student's computer).
