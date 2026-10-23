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

1. **L3 ([L3-yosys-readline.md](L3-yosys-readline.md)): the entire Readline-linked footprint, not only Yosys.** GNU Readline 8.2 (GPL-3.0-or-later) is linked by `yosys` in the DE10-Lite candidate. The **Nexys A7 candidate contains these Readline-linked files**: `yosys`, `yosys-abc`, `yosys-filterlib`, Icarus Verilog `vvp`, Icarus Verilog `vhdlpp`, five Icarus plugin modules (`system.vpi`, `v2009.vpi`, `vhdl_sys.vpi`, `vhdl_textio.vpi`, `vpi_debug.vpi`) and the Python 3.11 `readline` module. **MIX-FPGA invokes only `yosys` (directly) and `yosys-abc` (started by Yosys); everything else is merely present in the archive** (L3 section 3 has the table). Our proposed GPLv3 treatment applies to the Yosys-linked components; for the rest we have no proposal yet. Please answer:
   - **(a)** Is our proposed GPLv3 treatment sufficient for the Yosys-linked components (`yosys`, `yosys-abc`, `yosys-filterlib`)?
   - **(b)** May the Icarus Verilog components be distributed together with GPLv3 Readline, given that our material identifies Icarus only as GPL-2.0 and **we have not established whether that is `GPL-2.0-only` or `GPL-2.0-or-later`**?
   - **(c)** If compatibility cannot be established, should the unused Readline-linked binaries be removed from the release candidate?
   - **(d)** Does the Python `readline` module create any separate redistribution issue?
2. **L9 ([L9-replacement-rights.md](L9-replacement-rights.md)).** The installed toolchain is hash-verified and read-only by default; a changed library is reported as "changed" and never overwritten except on an explicit Repair/Install request, which restores the supported release copy; the tools run with a replaced library; the user can replace it again. **Do this behaviour and our documentation preserve the replacement/modification rights under the LGPL and GPLv3 components and satisfy the MPL-2.0 for the unmodified compiled-in `hcl` and Eigen code?**
3. **L4 ([L4-yosys-provenance.md](L4-yosys-provenance.md)).** The shipped Yosys reports `-dirty`; the recipe's compiler-name `sed` on the tracked Makefile reproduces that; a native rebuild from the pinned commit has an identical 11,515-line help text but is not bit-identical (original cross-compile image unavailable). **Is this provenance evidence sufficient, given exact corresponding source and the build recipe?**
4. **Source delivery ([source-distribution-model.md](source-distribution-model.md)).** Each archive is distributed with its own hash-pinned source package at the same place and time; no written offer. **Does this satisfy the GPL/LGPL/MPL source-delivery requirements for this classroom release?**

## Findings, disclosed as found (to be handled in the final rebuild after your answers; the candidates are frozen and unchanged)

1. **DE10-Lite notices gap.** The DE10-Lite archive's `THIRD_PARTY_NOTICES.txt` says under L9 that "the notices explain how to replace a library", but it contains no dedicated "right to modify and replace" section; the Nexys archive's notices have one. Proposed: add the same section to the DE10-Lite notices in the final rebuild.
2. **New Project / Repair behaviour.** MIX-FPGA restores files only when the user explicitly runs Repair or Install (button or command, with a confirmation dialog); it never overwrites a replaced file silently and the tools run with a replaced library. One side effect, read from the code and **not exercised through the UI**: because New Project uses the quick integrity check, a replaced library makes it offer "…support is not installed / Install Support" for that board; accepting restores the release copy, declining changes nothing. Details in [L9-replacement-rights.md](L9-replacement-rights.md) (sections 2.3, 2.6). Proposed: soften that prompt's wording for the "needs repair" state in the final rebuild if you consider it relevant.
3. **Readline footprint in the Nexys archive** (item 1 above): unused Readline-linked programs are present; the Icarus Verilog licence version is unknown.
4. **Rebuilt Yosys is not bit-identical** to the shipped one (L4 section 5).
5. No Digilent, Altera, Apple or Canonical software is redistributed (Altera Quartus is supplied by the student; Ubuntu is downloaded on the student's computer).
