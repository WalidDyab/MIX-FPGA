# L3: Yosys distributed with GNU Readline

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

## 3. Scope: what else links Readline

- **DE10-Lite archive:** only `yosys/libexec/yosys` links `libreadline.8.2.dylib`.
- **Nexys A7 archive** (the unmodified Apio / YosysHQ oss-cad-suite package): `libreadline.8.2.dylib` is linked by `yosys`, `yosys-abc`, `yosys-filterlib`, Icarus Verilog's `vvp` and `vhdlpp` and five of its `lib/ivl/*.vpi` modules, and by the Python 3.11 `readline` extension module. A Python 3.12 `readline` module in the openXC7 package references `libreadline.8.dylib` but the library is not in that package (the module cannot load). MIX-FPGA runs `yosys` and `yosys-abc`; it does not run `vvp`, `vhdlpp` or the Python readline module.
- Icarus Verilog is recorded as GPL-2.0 in our inventory (its `license/LICENSE.iverilog`, upstream revision `6767a079560f4528f4beeae82fb33361eb4bc92a`); we have not established whether it is "GPL-2.0-only" or "or later". **Please advise whether this combination (GPLv3 library with a GPLv2 program) matters for a classroom redistribution of programs MIX-FPGA never runs, or whether you want those programs removed in a later toolchain version.**

## 4. Proposed treatment (conservative)

Treat the distributed `yosys` (and `yosys-abc`, `yosys-filterlib`) together with `libreadline.8.2.dylib` as a combined work distributed under the obligations of the GNU GPL version 3:

- ship the GPLv3 text with the archive (`licenses/GPL-3.0.txt` in the Nexys archive; `LICENSES/gcc-runtime/GPL-3.0.txt` and `LICENSES/readline/COPYING` in the DE10 archive);
- ship the complete corresponding source of both (below) next to the archive, and the build scripts;
- keep Readline a separate, replaceable file (see L9);
- keep Yosys' ISC and the other embedded-library notices (`LICENSES/yosys-libs/` in the DE10 archive).

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

`licence-texts/GPL-3.0.txt`, `readline-8.2-COPYING-GPL-3.0.txt`, `Yosys-ISC-COPYING.txt`; `evidence/de10-archive-THIRD_PARTY_NOTICES.txt` and `evidence/nexys-archive-THIRD_PARTY_NOTICES.md` (exactly what ships in the archives); `toolchains/mixfpga/compliance/macos-arm64-1.1.inventory.json`; [L4-yosys-provenance.md](L4-yosys-provenance.md).

## 7. Question for counsel

**Q1. Is distributing Yosys (and `yosys-abc`, `yosys-filterlib`) combined with GNU Readline under the obligations applicable to GPLv3, as described in section 4 with the source material in section 5, sufficient? If not, what else is required?** Please include your view on section 3 (Icarus Verilog and Python modules in the Nexys archive that also link Readline).
