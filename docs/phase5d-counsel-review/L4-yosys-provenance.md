# L4 residual: provenance of the shipped Yosys binary

> **Phase 5E update (technical review, not legal advice; no attorney has approved anything):** the questions in this file are recorded as technically resolved in [../phase5e-compliance-conclusions.md](../phase5e-compliance-conclusions.md). The text below is kept as the record of how the question was put and what was known at the time.

Engineering evidence, not a legal conclusion. Long form: [docs/phase5c-l4-yosys-rebuild.md](../phase5c-l4-yosys-rebuild.md) (also inside both source packages as `mix-fpga-build/yosys-rebuild-evidence.md`). Hashes of every file named here: [EVIDENCE-SHA256.txt](EVIDENCE-SHA256.txt).

## 1. The question

The shipped binary reports `Yosys 0.63+173 (git sha1 66306a8ca-dirty, aarch64-apple-darwin23.5-clang++ 18.1.8 -fPIC -O3)`. "`-dirty`" normally means the tree it was built from had uncommitted changes. Is the source we ship (the pinned commit and submodules, plus the build recipe) really the corresponding source of this binary?

## 2. Pinned source

Commit `66306a8ca34cb1dcdafe12a5838fa8f0c1a7f4c2` of https://github.com/YosysHQ/yosys (`git describe`: `v0.63-173-g66306a8ca`, `git rev-list --count v0.63..HEAD` = 173, which is the "+173" in the version string), submodules `abc` `b4a657e75b16b68c514a7326642ea074f8460939` and `libs/cxxopts` `4bf61f08697b110d9e3991864650a405b3dd515d`. These are the archives in the source packages (`sources/oss-yosys.tar.gz`, `oss-yosys--abc.tar.gz`, `oss-yosys--libs-cxxopts.tar.gz`, hashes in [L3](L3-yosys-readline.md)).

## 3. Why the original reports `-dirty`

The YosysHQ build recipe (`oss-cad-suite-build` `ac8c7dba2517ce371959cd5d95cd9163a54c350d`, file `default/scripts/yosys.sh`, in the source packages as `sources/yosyshq-oss-cad-suite-build-2026-03-24.tar.gz`) builds Yosys for macOS arm64 with:

```
make config-clang
sed -i -re "s,CXX = clang\+\+,CXX = ${CXX},g" Makefile
make PREFIX=${INSTALL_PREFIX} DESTDIR=${OUTPUT_DIR} install -j${NPROC}
```

The `sed` edits the tracked file `Makefile`. Yosys' own Makefile appends `-dirty` when `git diff --exit-code --quiet` fails (Makefile lines 191-192 of the pinned commit). The edit is a compiler-name substitution in two lines; [evidence/yosys-makefile-recipe-sed.diff](evidence/yosys-makefile-recipe-sed.diff) is the exact diff on the pinned `Makefile`. The compiler text in the version string (`aarch64-apple-darwin23.5-clang++ 18.1.8`) is that substituted `CXX`, which independently shows the `sed` was applied in the real build.

Reproduced on a checkout of the pinned commit (Apple clang 21.0.0, arm64):

| State | Version string produced |
|---|---|
| clean tree plus `make config-clang` | `Yosys 0.63+173 (git sha1 66306a8ca, clang++ 21.0.0 -fPIC -O3)` |
| after only the recipe's `sed` | `git status`: ` M Makefile`; version string ends `66306a8ca-dirty` |

## 4. Native rebuild and comparison

We rebuilt Yosys from that checkout on a Mac: GNU Readline 8.2 with patch 001 built from the verified source archives of the source package; GNU bison 3.8.2 (sha256 `9bba0214ccf7f1079c5d59210045227bcf619519840ebfa80cd3849cff5a5bf2`) and flex 2.6.4 (sha256 `e87aae032bf07c26f85ac0ed3250998c37621d95f8bd748b31f15b33c45ee995`) as build tools only (macOS' bison 2.3 and flex header are not accepted by Yosys); the SDK's libffi, Tcl and zlib; `make -j8 yosys`.

Comparison against the shipped binary (`beb67bee34580810390f41553a9f012902526d455e6eaa4788d7552b91d34502`, 25,559,128 bytes; rebuilt: `95d412bbd31e7a21c260a73163308f6350106beb34a9004a04c5ca978d1b5994`, 21,661,360 bytes):

- `yosys -p 'help -all'` prints the help text of every command, pass, frontend, backend and techlib: **11,515 lines for both**. They are identical except three lines (the version line, a timing line, the closing version line): [evidence/yosys-help-all.diff](evidence/yosys-help-all.diff); full outputs in `evidence/yosys-help-all-shipped.txt` and `evidence/yosys-help-all-rebuilt.txt`. SHA-256 of the output without those three lines: `7b1aff6742eb62c930558b2faa36f9fb7f4e57bb358f00684fb848781f363c66` for both. The script's logfile hash is `f5dede9581` for both.
- So the shipped binary registers exactly the commands, options and help text of commit `66306a8c`: no pass is missing or added.

## 5. Why the rebuild is not bit-identical

The original was cross-compiled in YosysHQ's Docker build image (clang 18.1.8 and a macOS SDK, target `aarch64-apple-darwin23.5`). That image is not available to us (no Docker on the build Mac, and the image is not part of what we redistribute), so we built natively with a different compiler (clang 21), different link settings and a system SDK. Binaries from different compilers are not expected to match byte for byte; sizes differ (25.6 MB versus 21.7 MB).

## 6. Question for counsel

**Q3. Is this provenance evidence sufficient for redistribution of the shipped Yosys binary, assuming we also supply the exact corresponding source (pinned commit and submodules) and the build instructions/recipe (the `oss-cad-suite-build` archive and the Makefile diff above)?** If you require a bit-identical rebuild, please say so; we cannot supply one without YosysHQ's build image.
