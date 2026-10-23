# Phase 5C, L4: rebuilding Yosys from the documented recipe

Question (Phase 5B): the shipped `yosys` reports `Yosys 0.63+173 (git sha1 66306a8ca-dirty, aarch64-apple-darwin23.5-clang++ 18.1.8 -fPIC -O3)`. Is the source we provide (commit `66306a8ca34cb1dcdafe12a5838fa8f0c1a7f4c2` with its `abc` and `cxxopts` submodules, plus the YosysHQ build recipe) the corresponding source of that binary, or did the build add local changes?

Date 2026-10-22, on the development Mac (Apple clang 21.0.0, arm64). Engineering evidence, not a legal opinion.

## 1. The recipe and the `-dirty` mechanism

`YosysHQ/oss-cad-suite-build` at `ac8c7dba` (in both source packages), `default/scripts/yosys.sh`, darwin branch:

```
make config-clang
sed -i -re "s,CXX = clang\+\+,CXX = ${CXX},g" Makefile
make PREFIX=... install
```

The `sed` edits the tracked `Makefile`. Yosys' Makefile appends `-dirty` when `git diff --exit-code --quiet` fails. Reproduced on a checkout of the pinned commit:

- clean checkout plus `make config-clang` (untracked `Makefile.conf` only): `Yosys 0.63+173 (git sha1 66306a8ca, clang++ 21.0.0 -fPIC -O3)`; `git rev-list --count v0.63..HEAD` = 173, `v0.63-173-g66306a8ca`.
- after applying only the recipe's `sed` (compiler name replaced): `git status` shows ` M Makefile`, `git diff --stat` = `Makefile | 4 ++--` (two `CXX = clang++` lines), and the generated version string becomes `Yosys 0.63+173 (git sha1 66306a8ca-dirty, clang++ 21.0.0 -fPIC -O3)`.

The compiler text in the shipped string (`aarch64-apple-darwin23.5-clang++ 18.1.8`) is the substituted `CXX`, i.e. the `sed` was applied in the real build. The submodule revisions of the checkout are the pinned ones: `abc` `b4a657e75b16b68c514a7326642ea074f8460939`, `libs/cxxopts` `4bf61f08697b110d9e3991864650a405b3dd515d`.

## 2. A rebuild from the pinned source

Built natively (not the YosysHQ cross-compile image: Docker is not available here and the original used clang 18.1.8 with a macOS SDK cross toolchain, so a byte-identical binary is not expected). Build inputs: the pinned Yosys checkout; GNU readline 8.2 with patch 001 built from the verified source archives of the source package (`readline--readline-8.2.tar.gz`, `readline--readline82-001`); GNU bison 3.8.2 (sha256 `9bba0214ccf7f1079c5d59210045227bcf619519840ebfa80cd3849cff5a5bf2`) and flex 2.6.4 (sha256 `e87aae032bf07c26f85ac0ed3250998c37621d95f8bd748b31f15b33c45ee995`) as build tools only (macOS ships bison 2.3 and a flex header that Yosys does not accept); the SDK's libffi, Tcl and zlib. Command: `make -j8 yosys`.

Comparison with the shipped `yosys` (`beb67bee…d34502`, 25,559,128 bytes) of the Toolchain 1.1 candidate; the rebuilt binary is `95d412bb…b5994`, 21,661,360 bytes:

| Check | Result |
|---|---|
| `yosys -V` | identical except the suffix `-dirty` and the compiler text |
| `yosys -p 'help -all'` (the help text of every command, pass, backend, frontend and techlib: 11,515 lines) | **identical** apart from 3 lines (the two version lines and the timing line); SHA-256 of the output without those lines is `7b1aff6742eb62c930558b2faa36f9fb7f4e57bb358f00684fb848781f363c66` for both; the script's logfile hash is `f5dede9581` for both |

So the shipped binary registers exactly the commands, options and help of commit `66306a8c`; no pass is missing or added. The residual is that the two binaries were produced by different compilers and are not bit-identical, which cannot be removed without the original cross-compile image.

## 3. Conclusion (engineering)

The `-dirty` suffix is fully explained by the recipe's compiler-name `sed` on the tracked `Makefile` and does not indicate source changes; the source package (pinned commit, submodules, recipe) is the corresponding source; the functional identity of every command is shown by the rebuild. L4 is closed on this evidence, with the residual above recorded in the notices. Counsel may still ask for a byte-identical rebuild; that is not available.
