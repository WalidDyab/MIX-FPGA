# L9: replacement and modification rights versus MIX-FPGA's integrity check

Engineering description of what the software does, so counsel can judge it. Not a legal conclusion. The behaviour was tested on a copy of the installed toolchain (Phase 5B) and re-checked through the code (this review); hashes of the referenced files are in [EVIDENCE-SHA256.txt](EVIDENCE-SHA256.txt).

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
2. **Detection.** The Setup page does a quick check (it hashes executables and libraries); **Verify Environment** and **Repair** hash every file. A modified or replaced file is reported as *changed* (for example "openFPGALoader: 1 changed", headline "Needs repair"). Nothing is deleted, moved or overwritten by the check.
3. **No silent restore.** The only code that restores files is `controller.install` / `controller.repair`, and the only callers are the commands `nexysvhdl.setup.install` and `nexysvhdl.setup.repair` (the Setup page buttons "Repair" and "Install … Support", and the New Project prompt "…support is not installed" with a modal **Install Support** button that is shown if the check does not report the board as installed). There is no automatic call at start-up, on activation, on Build or on Program (`extension/commands/commands.ts`). A summary dialog (`confirmInstall`) precedes the action.
4. **Repair on request.** The button text is: "Checks every file of the installed boards and puts back anything missing or changed." (`platform/macos/install/setup-view.ts`). Repair replaces a changed MIX-FPGA-owned file with the copy from the supported release archive (the student is asked for the support file) and leaves everything else alone.
5. **Running with a replaced file.** MIX-FPGA does **not** verify hashes before it runs a tool: it locates the tool by path and runs it (`openFPGALoader --Version` ran with a deliberately modified `libftdi1.2.5.0.dylib` that had been re-signed ad hoc; with a corrupt signature the tool also ran, i.e. library validation is not enforced). Builds, Check, Simulate and Program keep working with the replaced library. The user may modify or replace the file again after a Repair.
6. **Side effect to be aware of.** Because New Project looks at the quick check, a replaced library makes it offer "…support is not installed / Install Support" for that board (read from the code, not exercised through the UI); existing projects still build and program.
7. **Re-signing.** On Apple silicon a modified library needs an ad-hoc signature (`codesign -f -s - <file>`); the notices say so.

## 3. Documentation shipped

- **Nexys A7 archive**, `THIRD_PARTY_NOTICES.md`, section "Your right to modify and replace components" (copy in `evidence/nexys-archive-THIRD_PARTY_NOTICES.md`):

  > The GPL and LGPL components are separate files, loaded at run time, which you may replace with your own builds made from the corresponding source, for your own use, and reverse-engineer for debugging. The installed folder is read-only by default; make a file writable, replace it, and on Apple silicon re-sign it (`codesign -f -s - <file>`). The tools keep working with replaced files. The Setup page and Verify report a changed file as "changed", and Repair puts the original back only when you choose Repair. The integrity check is a support aid, not a technical restriction. A configuration with replaced files is not supported.

- **DE10-Lite archive**: **known gap.** Its `THIRD_PARTY_NOTICES.txt` (copy in `evidence/de10-archive-THIRD_PARTY_NOTICES.txt`) states under L9 that "the notices explain how to replace a library", but it contains no dedicated section like the one above. The DE10-Lite source package README points to such a section. We have not changed the payload (the candidate is frozen); the proposed fix is to add the same section to the DE10 notices in the final rebuild after your comments.
- The Setup page button texts quoted in 2.4.

## 4. Questions for counsel

**Q2. Do this behaviour (integrity check that reports changes and never overwrites without an explicit Repair/Install request; Repair restores the supported release copy and the user can modify or replace the file again) and this documentation (once the DE10-Lite notices carry the same section as the Nexys notices) preserve the replacement and modification rights that the LGPL components (LGPL-2.0/2.1/3.0) and the GPLv3 component (Readline) give recipients, and satisfy the MPL-2.0 for the unmodified `hcl` and Eigen code?** Specific points we would like your view on:

1. Is a hash-verified, read-only-by-default install folder that the user can still write to compatible with the LGPL's modification/relinking provisions, given that Verify reports a replaced file as "changed" and a configuration with replaced files is "not supported"?
2. Does GPLv3 section 6 "installation information" or LGPL-3.0 section 4(e) apply to software installed on a general-purpose computer like this (we believe the term "User Product" does not cover it; please confirm)?
3. For the statically linked MPL-2.0 modules (`hcl` in Lima's Go binaries, Eigen in `nextpnr-xilinx`), is making the exact source archive available in the source package (`sources/github.com_hashicorp_hcl_v2@v2.24.0.zip`, Eigen 3.4.0) sufficient, given that the user cannot replace the module separately from the executable?
