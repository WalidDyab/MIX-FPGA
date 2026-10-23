# L9: replacement and modification rights versus MIX-FPGA's integrity check

Engineering description of what the software does, so counsel can judge it. Not a legal conclusion. The behaviour was tested on a copy of the installed toolchain (Phase 5B), re-checked through the code (Phase 5D review) and **changed in Phase 5D (engineering closure)**: sections 2.2, 2.3, 2.5 and 2.6 describe the behaviour after that change, and section 2a records what it replaced. Hashes of the referenced files are in [EVIDENCE-SHA256.txt](EVIDENCE-SHA256.txt).

## 1. Where the covered components are

| Component | Licence | Linking | Archive |
|---|---|---|---|
| libusb 1.0.26 (and 1.0.30 inside the Apio bundle), libftdi1 1.5 (LGPL-2.0), libghw (LGPL-2.1+) | LGPL | separate `.dylib` files, loaded at run time through `@executable_path` / `@rpath` | DE10-Lite: `openfpgaloader/lib/`, `ghdl/lib/`; Nexys: `apio/packages/oss-cad-suite/lib/`, `apio/bin/_internal/` |
| GNU Readline 8.2 | GPL-3.0-or-later | separate `.dylib` | both (see L3) |
| Qt 5.15.3 frameworks (LGPL-3.0 modules), GTK/GLib/Pango/Cairo/etc. (LGPL) | LGPL | separate frameworks / `.dylib` files, never loaded by MIX-FPGA | Nexys only |
| `github.com/hashicorp/hcl/v2` v2.24.0 | MPL-2.0 | compiled into Lima's Go executables (`limactl`, `lima-driver-krunkit`, guest agents), unmodified | DE10-Lite |
| Eigen (MPL-2.0 headers) | MPL-2.0 | compiled into `nextpnr-xilinx`, unmodified | Nexys |
| Python `certifi` (MPL-2.0) | MPL-2.0 | a data file inside the Apio bundle | Nexys |

MIX-FPGA modifies none of these (they are the upstream release files).

## 2. What MIX-FPGA does with the installed files

1. **Installation.** The toolchain is copied from the archive into a folder owned by the user (`~/Library/MIX-FPGA/...`), every file is checked against a SHA-256 manifest, and the folder is then made read-only (`makeReadOnly`, `platform/macos/install/toolchain-installer.ts`). The user owns it and can make any file writable (`chmod`).
2. **Detection and four states.** The Setup page does a quick check (it hashes executables and libraries); **Verify Environment** and **Repair** hash every file. Each part of the installation is in exactly one of four states:
   - **not installed**: nothing of it is there;
   - **installed and verified**: every file matches the release;
   - **installed but modified** (new in Phase 5D): everything the part needs is present and every difference is a *content* difference or an extra file (a replaced library, an edited file, a file added). Shown as "Installed (modified)"; headline "Ready (modified toolchain)". The text is: "This toolchain has been modified and is no longer the verified MIX-FPGA configuration. You can continue using it, or choose Repair to restore the supported version.";
   - **repairable / broken**: a file or tool is **missing**, an executable lost its permission bit, a link changed, the manifest or installation record does not match, or (Nexys A7) the tree no longer has the files or the tool list the toolchain needs. Shown as "Needs repair".
   A hash mismatch alone is never "not installed" and never "needs repair". Nothing is deleted, moved or overwritten by any check. The classification is `isModifiedOnly` / `checkUnit` in `platform/macos/install/toolchain-installer.ts` and `nexysModifiedButUsable` in `platform/macos/install/nexys-support.ts`.
3. **No silent restore.** The only code that restores a *modified* file is `controller.repair`, reached only from the command `nexysvhdl.setup.repair` (the Setup page buttons "Repair" / "Repair … Support", or the "Repair" button of the modified-toolchain message), after the confirmation dialog `confirmInstall`, which says "Files you changed in the installed toolchain will be replaced by the supported version." (`replacesChanges`). `controller.install` and the New Project prompt never touch a modified part (`repairModified` is set only by Repair). Missing or broken parts are still installed or repaired by Install / Repair as before. There is no automatic call at start-up, on activation, on Build, Simulate, Check, RTL or Program (`extension/commands/commands.ts`).
4. **Repair on request.** The button text is: "Checks every file of the installed boards and puts back anything missing or changed." (`platform/macos/install/setup-view.ts`). Repair replaces a changed MIX-FPGA-owned file with the copy from the supported release archive (the student is asked for the support file) and leaves everything else alone.
5. **Running with a replaced file.** MIX-FPGA does **not** verify hashes before it runs a tool: it locates the tool by path and runs it (`openFPGALoader --Version` ran with a deliberately modified `libftdi1.2.5.0.dylib` that had been re-signed ad hoc; with a corrupt signature the tool also ran, i.e. library validation is not enforced). Builds, Check, Simulate, RTL and Program keep working with the replaced library. The user may modify or replace the file again after a Repair. Phase 5D inspected every path that could refuse on a hash (runtime tool resolution in `core/toolchain/bundle.ts` is marker-only; only the Setup model, Verify and Repair hash); none refuses solely because a covered file changed.
6. **New Project (changed in Phase 5D).** A board whose files the user changed counts as ready: New Project is **not** blocked and does **not** offer "Install Support" for it. It shows a non-blocking note with the text above and an optional **Repair** button (`extension/commands/commands.ts`, `controller.isBoardModified`). A missing or broken part still gets the "support is not installed" / Install Support prompt.
   - **Verify Environment** (`controller.verify`, `DE10 runtime.verify`) reports a modified part as `modified: …` with the text above, passes (`ok`), sets `modified`, and offers Repair in the message; a missing or broken part still fails. **Verify Toolchain** (`core/toolchain/store.ts`) reports `TOOLCHAIN_MODIFIED` as a warning with the same text instead of an error ("Remove that folder and install again").
   - Not weakened: installation, download and archive verification (`installToolchain` for an install, adoption in `adopt.ts`, `installToolchainArchive`) still require every file to match; the change applies only to post-install modification of an existing installation.
   - The Setup page's quick look does not hash every file of the Nexys A7 tools; it shows them as installed, and Verify / Repair (full) then report "modified". Modified Nexys files are therefore reported by Verify and Repair, not by the page itself.
   - Tested in `tests/install/modified-toolchain.test.ts` (DE10-Lite and Nexys A7), `tests/install/toolchain-installer.test.ts` and `tests/install/setup.test.ts`: modified-but-usable (status, board ready, New Project unaffected, nothing restored by Setup or Install), explicit Repair (confirmation, restores the file and hash, back to "Installed"), declining Repair leaves the file, a missing file or tool stays "Needs repair", and one board's modification does not affect the other.
7. **Re-signing.** On Apple silicon a modified library needs an ad-hoc signature (`codesign -f -s - <file>`); the notices say so.

## 3. Documentation shipped

- **Nexys A7 archive**, `THIRD_PARTY_NOTICES.md`, section "Your right to modify and replace components" (copy in `evidence/nexys-archive-THIRD_PARTY_NOTICES.md`):

  > The GPL and LGPL components are separate files, loaded at run time, which you may replace with your own builds made from the corresponding source, for your own use, and reverse-engineer for debugging. The installed folder is read-only by default; make a file writable, replace it, and on Apple silicon re-sign it (`codesign -f -s - <file>`). The tools keep working with replaced files. The Setup page and Verify report a changed file as "changed", and Repair puts the original back only when you choose Repair. The integrity check is a support aid, not a technical restriction. A configuration with replaced files is not supported.

- **DE10-Lite archive**: **finding for the final rebuild (a documentation gap).** Its `THIRD_PARTY_NOTICES.txt` (copy in `evidence/de10-archive-THIRD_PARTY_NOTICES.txt`) states under L9 that "the notices explain how to replace a library", but it contains no dedicated section like the one above. The DE10-Lite source package README points to such a section. We have not changed the payload (the candidate is frozen); the proposed fix is to add the same section to the DE10 notices in the final rebuild after your comments.
- The Setup page button texts quoted in 2.4.

## 3a. What changed in Phase 5D (old versus new behaviour)

| | Before | After |
|---|---|---|
| A replaced or edited covered file | the part is "Needs repair" (headline "Needs repair"); New Project says "…support is not installed" and offers Install Support; Verify fails | the part is "Installed (modified)"; headline "Ready (modified toolchain)"; New Project proceeds with a non-blocking note; Verify passes with a `modified` report |
| Repair | restores it (on request) | restores it (on request, after a dialog that says changed files are replaced) |
| Install, start-up, Build, Program | never restore | never restore (unchanged) |
| A missing file, a missing tool, a lost executable bit, a changed manifest | "Needs repair" | "Needs repair" (unchanged) |
| Installing from the archive | every file verified | every file verified (unchanged) |

The text "Your right to modify and replace components" in the Nexys notices (section 3) already says Setup reports a changed file as "changed"; the wording in the shipped archive was **not** changed (the candidate is frozen). The product text now says "modified" and "no longer the verified MIX-FPGA configuration"; the final rebuild's notices should say the same. This is an engineering finding, not legal advice.

## 4. Questions for counsel

**Q2. Do this behaviour (integrity check that reports changes and never overwrites without an explicit Repair/Install request; Repair restores the supported release copy and the user can modify or replace the file again) and this documentation (once the DE10-Lite notices carry the same section as the Nexys notices) preserve the replacement and modification rights that the LGPL components (LGPL-2.0/2.1/3.0) and the GPLv3 component (Readline) give recipients, and satisfy the MPL-2.0 for the unmodified `hcl` and Eigen code?** Specific points we would like your view on:

1. Is a hash-verified, read-only-by-default install folder that the user can still write to compatible with the LGPL's modification/relinking provisions, given that Verify reports a replaced file as "changed" and a configuration with replaced files is "not supported"?
2. Does GPLv3 section 6 "installation information" or LGPL-3.0 section 4(e) apply to software installed on a general-purpose computer like this (we believe the term "User Product" does not cover it; please confirm)?
3. For the statically linked MPL-2.0 modules (`hcl` in Lima's Go binaries, Eigen in `nextpnr-xilinx`), is making the exact source archive available in the source package (`sources/github.com_hashicorp_hcl_v2@v2.24.0.zip`, Eigen 3.4.0) sufficient, given that the user cannot replace the module separately from the executable?
