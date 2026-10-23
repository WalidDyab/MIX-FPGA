# L3: Yosys distributed with GNU Readline

> **Phase 5E update (technical review, not legal advice; no attorney has approved anything):** the questions in this file are recorded as technically resolved in [../phase5e-compliance-conclusions.md](../phase5e-compliance-conclusions.md). The text below is kept as the record of how the question was put and what was known at the time.

Engineering facts for counsel. Nothing here is a legal conclusion. Paths are relative to the repository root; hashes are in [EVIDENCE-SHA256.txt](EVIDENCE-SHA256.txt).

## 1. What is distributed

| | Yosys | GNU Readline |
|---|---|---|
| Version | `Yosys 0.63+173`, commit `66306a8ca34cb1dcdafe12a5838fa8f0c1a7f4c2` (tag `v0.63` plus 173 commits) | 8.2 with upstream patch 001 (`readline82-001`) |
| Upstream | https://github.com/YosysHQ/yosys, with submodules `abc` `b4a657e75b16b68c514a7326642ea074f8460939` and `libs/cxxopts` `4bf61f08697b110d9e3991864650a405b3dd515d` | GNU Readline 8.2 |
| Licence | ISC (`licence-texts/Yosys-ISC-COPYING.txt`); libraries compiled into it: ISC (ezSAT, subcircuit), MIT (MiniSat, json11, fstapi, cxxopts), public domain (sha1, BigInteger), Berkeley licence (ABC) | GPL-3.0-or-later (`licence-texts/readline-8.2-COPYING-GPL-3.0.txt`) |
| Built by | YosysHQ OSS CAD Suite build, `oss-cad-suite-build` revision `ac8c7dba2517ce371959cd5d95cd9163a54c350d`, release 2026-03-24 | MacPorts binary package `readline-8.2.001_0.darwin_21.arm64.tbz2` (macOS ports tree commit `556ec864a7d91fb89eb261b7ed380098e2c308dc`), used by the same build environment |
| Modified by MIX-FPGA | **No.** The files are the upstream release content, byte-identical in both archives (checked by SHA-256) | **No.** Same |

## 2. How they are linked

Dynamic linking, separate files, resolved at load time next to the executable (`otool -L`):

```
yosys/libexec/yosys  ->  @executable_path/../lib/libreadline.8.2.dylib   (also libffi, libz, libtcl8.6)
yosys/lib/libreadline.8.2.dylib  ->  libncurses.6.dylib, libSystem
```

Files (SHA-256 in the evidence list): DE10-Lite archive `yosys/libexec/yosys` `beb67bee34580810390f41553a9f012902526d455e6eaa4788d7552b91d34502`, `yosys/lib/libreadline.8.2.dylib` `be7552f0f9ce7cda5731faba2018b0e62db6af6a712ebe1ceeb7c400d9ac183a`; the same two files, byte for byte, are in the Nexys A7 archive under `apio/packages/oss-cad-suite/libexec/yosys` and `.../lib/libreadline.8.2.dylib`.

MIX-FPGA itself runs `yosys` (RTL schematic; in the Nexys flow through Apio, together with `yosys-abc`). Yosys is built with readline for its interactive shell.

## 3. The entire observed Readline-linked footprint

We scanned both archives (`otool -L` on every Mach-O file that mentions `libreadline`). Result:

**DE10-Lite candidate:** only `yosys/libexec/yosys` links `libreadline.8.2.dylib`.

**Nexys A7 candidate** (the unmodified Apio / YosysHQ oss-cad-suite and openXC7 packages) contains, under `apio/packages/oss-cad-suite/`, these Readline-linked files, all loading `lib/libreadline.8.2.dylib` (GPL-3.0-or-later):

| # | Component (file) | Licence as recorded in our inventory | Invoked by MIX-FPGA? |
|---|---|---|---|
| 1 | `yosys` (`libexec/yosys`) | ISC | **Yes**, directly (RTL schematic in both boards' flows) and through Apio's synthesis for the Nexys A7 |
| 2 | `yosys-abc` (`libexec/yosys-abc`) | Berkeley licence (ABC) | **Yes, indirectly**: started by Yosys' `abc` pass; observed in the process trace of the validated Nexys workflow (`docs/toolchain-1.0-redistribution.md` section 13.1) |
| 3 | `yosys-filterlib` (`libexec/yosys-filterlib`) | ISC (Yosys) | **No.** Present only; not seen in the process trace of the validated workflows (we believe it serves liberty-file flows that MIX-FPGA does not run; not verified) |
| 4 | Icarus Verilog `vvp` (`libexec/vvp`) | GPL-2.0-or-later by the file headers of the pinned source (section 3.1) | **No.** Present only |
| 5 | Icarus Verilog `vhdlpp` (`libexec/vhdlpp`) | GPL-2.0-or-later (section 3.1) | **No.** Present only |
| 6-10 | five Icarus plugin modules: `lib/ivl/system.vpi`, `v2009.vpi`, `vhdl_sys.vpi`, `vhdl_textio.vpi`, `vpi_debug.vpi` | GPL-2.0-or-later for the Icarus code; `system.vpi` also contains MIT/BSD-style third-party code (section 3.1) | **No.** Present only |
| 11 | Python 3.11 `readline` extension module (`lib/python3.11/lib-dynload/readline.cpython-311-darwin.so`) | PSF-2.0 (Python) | **No.** Present only; it is loaded only if Python code imports `readline` (an interactive Python session), which no MIX-FPGA flow does; on macOS the traced Python is openXC7's 3.12, not this one |

Additionally a Python 3.12 `readline` module in the openXC7 package references `libreadline.8.dylib`, but that library is not in the openXC7 package (the module cannot load); it is inert and listed only for completeness.

**Icarus Verilog licence status.** The file `license/LICENSE.iverilog` shipped by YosysHQ (copy: `licence-texts/iverilog-LICENSE.iverilog-as-shipped-by-YosysHQ.txt`) is YosysHQ's provenance note (upstream `https://github.com/steveicarus/iverilog`, revision `6767a079560f4528f4beeae82fb33361eb4bc92a`) followed by the GPL version 2 text, which alone does not say "only" or "or later". In Phase 5D we examined the file headers of the exact pinned source; the result is section 3.1.

### 3.1 Icarus Verilog: exact pinned-source verification (Phase 5D, engineering evidence, not a legal conclusion)

**Method.** We extracted the archive that is actually in the Nexys A7 source package and read the licence statements in its files, not upstream master.

| Item | Result |
|---|---|
| Source archive | `sources/oss-iverilog.tar.gz` in `MIX-FPGA-Nexys-A7-Support-1.1-Sources.zip`; SHA-256 `c37c4f4ad72d7c209cbfe9c399c982260c4313d28735875c72643f8ba406679d` (equal to the hash in the package `manifest.json`) |
| Mapping to the binaries | `binary-to-source.json`, `ossCadSuiteTools`: tool `iverilog` -> source `oss-iverilog`, upstream `https://github.com/steveicarus/iverilog`. The tool `iverilog` is the one that provides `libexec/vvp`, `libexec/vhdlpp` and `lib/ivl/*.vpi` |
| Revision | `6767a079560f4528f4beeae82fb33361eb4bc92a` (named in YosysHQ's `LICENSE.iverilog`) |
| Version | `version_base.h` in the archive: 14.0 (devel). Release line `s20251012` of the upstream tags |
| Why the binary says `s20251012-140-g5c6cdec6a` | `vvp -V` reports that string. The OSS CAD Suite recipe applies a local `git revert 964878382d3fa77285b73d4657be5bbf95a9aacd -m 1` before building, which creates a commit that exists only in the build tree (hence the hash `5c6cdec6a` is not an upstream hash). That revert changes only `Makefile.in` and `vvp/Makefile.in`. The binaries therefore correspond to the pinned revision plus that recipe step, both of which are in the source package (recipe in `yosyshq-oss-cad-suite-build-2026-03-24.tar.gz`) |

**Licence statement in the pinned source.** The programs the binaries come from carry this header (shown from `vvp/main.cc`; the same wording is in `vhdlpp/main.cc`, `vpi/v2009_array.c`, `vpi/vpi_debug.c` and the other source files of those directories):

> This source code is free software; you can redistribute it and/or modify it in source code form under the terms of the GNU General Public License as published by the Free Software Foundation; either version 2 of the License, or (at your option) any later version.

The top-level `COPYING` is the GPL version 2 text (it states "Version 2, June 1991"); it contains no restriction to version 2 only. We found **no** `GPL-2.0-only`, "version 2 only" or "only version 2" statement anywhere in the archive. Two files carry an SPDX identifier for the Icarus code (`map_named_args.cc` and `map_named_args.h`, `SPDX-License-Identifier: GPL-2.0-or-later`).

**Counts (source files of the directories that are built into the Readline-linked binaries; the whole archive has 1,386 files that mention the GPL, of which 1,303 carry the "or any later version" sentence, the rest being tests, man pages and `config.guess` / `config.sub`):**

| Directory | Built into | Source files checked (`.c .cc .h .y .lex .in`) | With the "version 2 ... or any later version" header | Without it |
|---|---|---|---|---|
| `vvp/` | `vvp` | 107 | 104 | 3: `libvvp.h` (interface comment only, no licence text), `vvp_vpi.cc` (an empty stub), `vvp.man.in` (man page) |
| `vhdlpp/` | `vhdlpp` | 63 | 62 | 1: `vhdlnum.h` (a stub, no licence text) |
| `vpi/` | the five `.vpi` modules | 68 | 56 | 12 third-party files, none GPL: `fstapi.c/.h`, `fst_win_unistd.h`, `wavealloca.h`, `fastlz.c/.h` (SPDX `MIT`) and `lz4.c/.h`, `lxt_write.c/.h`, `lxt2_write.c/.h` (MIT/BSD-style notices in the files) |

**Technical finding.** For every Icarus-authored source file of `vvp`, `vhdlpp` and the `.vpi` modules in the pinned archive that states a licence, the statement is "GNU General Public License ... either version 2 of the License, or (at your option) any later version", i.e. GPL-2.0-or-later. The four files without a statement are stubs or interface/man files that contain no licensed implementation. The `system.vpi` module also contains the MIT/BSD-style third-party code listed above. **L3 question 1(b) is therefore technically supported by exact-source evidence** (the `GPL-2.0-only` possibility is not borne out by the pinned source); whether GPL-2.0-or-later code may be combined with GPLv3 Readline in this way, and the treatment of the third-party files, remain for counsel.

**Source delivery.** The Readline-linked Icarus components need only `oss-iverilog.tar.gz` plus the build recipe; both are already in the Nexys source package and are listed in its `manifest.json` and `binary-to-source.json`. The package contains no Readline-linked Icarus component whose source is missing. (The DE10-Lite archive contains no Icarus component.)

## 4. Proposed treatment (conservative)

For the **Yosys-linked components** (rows 1-3: `yosys`, `yosys-abc`, `yosys-filterlib`, and `yosys` in the DE10-Lite archive), treat each program together with `libreadline.8.2.dylib` as a combined work distributed under the obligations of the GNU GPL version 3:

- ship the GPLv3 text with the archive (`licenses/GPL-3.0.txt` in the Nexys archive; `LICENSES/gcc-runtime/GPL-3.0.txt` and `LICENSES/readline/COPYING` in the DE10-Lite archive);
- ship the complete corresponding source of both (section 5) next to the archive, and the build scripts;
- keep Readline a separate, replaceable file (see L9);
- keep Yosys' ISC and the other embedded-library notices (`LICENSES/yosys-libs/` in the DE10-Lite archive).

For rows 4-11 (Icarus Verilog, the Python module) we have **no proposed treatment yet**: they are not run by MIX-FPGA. For rows 4-10 the licence version is now established from the pinned source (section 3.1: GPL-2.0-or-later); whether they may be distributed with GPLv3 Readline, and row 11, depend on your view. Because the release candidate is frozen we have not removed them; they could be removed in the next toolchain version.

## 5. Corresponding source we intend to ship (all in the source packages, hash-pinned)

DE10-Lite source package `MIX-FPGA-DE10-Lite-Support-1.1-Sources.zip` (and the Nexys A7 package, which holds the same archives plus the others):

| Binary file | Source archive in `sources/` | SHA-256 |
|---|---|---|
| `yosys` | `oss-yosys.tar.gz` (Yosys at `66306a8c`) | `649a106a04cf19e5688993707694a8e855636d60b5d8a90310c4ec208cf54e5d` |
| `yosys` (submodule abc) | `oss-yosys--abc.tar.gz` (`b4a657e7`) | `3bb0aa3128e6c047d56ba4e00c0d770d7947a612052d96621d3abd53739e54aa` |
| `yosys` (submodule cxxopts) | `oss-yosys--libs-cxxopts.tar.gz` (`4bf61f08`) | `b9bda1476317d87d9ed79889aec48de43b10808b682d3f5f8b278542007d58fc` |
| build scripts for `yosys` | `yosyshq-oss-cad-suite-build-2026-03-24.tar.gz` (`ac8c7dba`, `default/scripts/yosys.sh`) | `94093aadb7b0deb0f254198e9a2c240e36668d4d4b3bf0b303beb330e4c01529` |
| `libreadline.8.2.dylib` | `readline--readline-8.2.tar.gz` | `3feb7171f16a84ee82ca18a36d7b9be109a52c04f492a053331d7d1095007c35` |
| patch 001 | `readline--readline82-001` | `bbf97f1ec40a929edab5aa81998c1e2ef435436c597754916e6a5868f273aff7` |
| build recipe for the library | `macports-port-readline-556ec864a7d9.tar.gz` (MacPorts `devel/readline` Portfile) | `1b29eceff876048e36fa9459049e92f1e4dde49374523a37264fd5db8c45a11c` |

The complete mapping (every binary file to its source archives, with full hashes) is `binary-to-source.json` inside each source package; the full hash of every source file is in its `manifest.json`. The Nexys package additionally contains the sources of `iverilog` (`oss-iverilog.tar.gz`) and of the other GPL/LGPL tools.

## 6. Evidence files

`licence-texts/GPL-3.0.txt`, `readline-8.2-COPYING-GPL-3.0.txt`, `Yosys-ISC-COPYING.txt`, `GPL-2.0.txt`, `iverilog-LICENSE.iverilog-as-shipped-by-YosysHQ.txt`; the process trace statement: `docs/toolchain-1.0-redistribution.md` section 13.1; `evidence/de10-archive-THIRD_PARTY_NOTICES.txt` and `evidence/nexys-archive-THIRD_PARTY_NOTICES.md` (exactly what ships in the archives); `toolchains/mixfpga/compliance/macos-arm64-1.1.inventory.json`; [L4-yosys-provenance.md](L4-yosys-provenance.md).

## 7. Questions for counsel (Q1 covers the whole footprint above)

**Q1. Please answer each part (yes/no, and what is needed if no):**

1. **Yosys-linked components.** Is our proposed GPLv3 treatment (section 4, with the source material of section 5) sufficient for `yosys`, `yosys-abc` and `yosys-filterlib` combined with GNU Readline 8.2, in the Nexys A7 archive, and for `yosys` in the DE10-Lite archive?
2. **Icarus Verilog.** The pinned source's file headers grant "version 2 ... or (at your option) any later version" (section 3.1), so the licence version is established as GPL-2.0-or-later. May the Icarus Verilog components (`vvp`, `vhdlpp` and the five `.vpi` modules), including the MIT/BSD-style third-party code in `system.vpi`, legally be distributed together with GPLv3 Readline on that basis?
3. **Removal.** If their compatibility cannot be established, should the unused Readline-linked binaries (rows 3-11, as you see fit) be removed from the release candidate before distribution?
4. **Python.** Does the Python 3.11 `readline` extension module, which links GPLv3 Readline and is not used by MIX-FPGA, create any separate redistribution issue?
