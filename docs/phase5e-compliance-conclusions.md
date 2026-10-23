# Phase 5E: technical-review conclusions for the macOS Toolchain 1.1 release

These are the project's **technical-review conclusions**, reached from the evidence in `docs/phase5d-counsel-review/` and the Phase 5D product change `35df5a5`. They are engineering findings about what the software and the archives contain and do. **They are not legal advice and no attorney has approved them.** Nothing in the notices or in this file says otherwise.

The Phase 5D files keep their original wording as the record of how each question was asked; this file records how the project now treats each one.

## L3: Yosys, Icarus Verilog and Python with GNU Readline. Technically resolved

- **Icarus Verilog.** The exact pinned source (`sources/oss-iverilog.tar.gz`, revision `6767a079560f4528f4beeae82fb33361eb4bc92a`, SHA-256 `c37c4f4ad72d7c209cbfe9c399c982260c4313d28735875c72643f8ba406679d`) carries, in every Icarus-authored file of `vvp`, `vhdlpp` and the `.vpi` modules that states a licence, the grant "either version 2 of the License, or (at your option) any later version". It is **GPL-2.0-or-later**. No "version 2 only" wording exists in the archive (`docs/phase5d-counsel-review/L3-yosys-readline.md` section 3.1).
- **Combination with GPLv3 Readline.** Because the Icarus grant allows any later version, Icarus Verilog is treated as combinable with GNU Readline 8.2 (GPL-3.0-or-later) under the terms of GPL version 3. The same treatment applies to `yosys`, `yosys-abc` and `yosys-filterlib` (ISC / Berkeley, GPL-compatible): each program that loads `libreadline.8.2.dylib` is distributed with it under GPL version 3, with the GPLv3 text, the complete Corresponding Source of both and the build recipes in the source package. Readline stays a separate, replaceable file.
- **MIT/BSD material.** The third-party code compiled into `system.vpi` (fstapi, LXT, lz4, fastlz, ...) keeps its own notices in the Icarus source and is GPL-compatible. The libraries compiled into Yosys (ISC, MIT, public domain, Berkeley) keep theirs.
- **Python 3.11.** Python 3.11.6 is PSF-2.0, which is GPL-compatible. Its `readline` extension module (`lib/python3.11/lib-dynload/readline.cpython-311-darwin.so`) loads Readline and is distributed with it under GPL version 3. The exact CPython source (revision `8b6ee5ba3bd08368ba3c763cea28ce1464a88e62`, `PY_VERSION` 3.11.6) is in the Nexys source package; the patch YosysHQ applies (`python3.11.6-darwin.diff`) is inside the build recipe archive that the package also holds.
- **Removal.** No binary is removed: the unused Readline-linked programs are covered by the treatment above, and the frozen Phase 5C payload content is unchanged.

## L4: Yosys provenance. Technically resolved

The exact source (Yosys `66306a8c` with the `abc` and `cxxopts` submodules, Readline 8.2 with patch 001), the YosysHQ build recipe (`oss-cad-suite-build` `ac8c7dba`) and the explanation of the `-dirty` suffix (the recipe's compiler-name `sed` on the tracked `Makefile`) are recorded (`docs/phase5c-l4-yosys-rebuild.md`, `docs/phase5d-counsel-review/L4-yosys-provenance.md`). A rebuild from the pinned sources has an identical help text for every command. **A bit-identical rebuild is not required to provide the Corresponding Source**; the shipped binaries are the unmodified upstream release files. The Icarus local-revert provenance (commit `964878382d3f...`, `Makefile.in` only, the reason the program reports `s20251012-140-g5c6cdec6a`) is recorded in the notices and in `binary-to-source.json`.

## L9: replacement and modification rights. Technically resolved after `35df5a5`

With the product change `35df5a5`, an installed toolchain whose files the user changed but that is complete and usable is **"installed but modified"**:

- it remains usable: New Project, Check, Simulate, RTL, Build and Program are not blocked;
- the state is disclosed: "This toolchain has been modified and is no longer the verified MIX-FPGA configuration. You can continue using it, or choose Repair to restore the supported version.";
- nothing is restored silently: Install, start-up and the workflow never write to it; Repair is explicit, asks first, and restores the supported release copy;
- missing, incompatible, wrong-version or structurally invalid installs, and installer/download verification, are not weakened.

Tests: `tests/install/modified-toolchain.test.ts` and the updated installer/setup tests (DE10-Lite and Nexys A7). The notices of both archives now carry a "right to modify and replace" section that describes exactly this behaviour (the DE10-Lite notices gap found in Phase 5D is closed).

## Source delivery. Technically resolved

- Each binary support archive has **one** corresponding-source archive that accompanies it: `MIX-FPGA-Nexys-A7-Support-1.1-Sources.zip` for the Nexys A7 archive and `MIX-FPGA-DE10-Lite-Support-1.1-Sources.zip` for the DE10-Lite archive. Each lists every source with its upstream repository, revision and SHA-256 (`manifest.json`) and maps every binary to its sources (`binary-to-source.json`).
- The source archive is made available in the same place, at the same time, and by the same means as the binary archive, so access to the source is equivalent to access to the binary.
- **No written offer is relied upon** and none is made.

## Not claimed

No legal clearance is claimed. If a licence owner or an adviser later disagrees with any conclusion above, the corresponding treatment (for example removing an unused Readline-linked program in a later toolchain version) is a normal engineering change.
