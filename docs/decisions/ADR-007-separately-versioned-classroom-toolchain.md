# ADR-007: Separately versioned, bundled-only classroom toolchain

Status: accepted for review (Phase 4B, Windows); macOS addendum for review

## Context

Phase 4B turns NexysVHDL into a classroom product. Students must not install GHDL, Apio, Yosys, nextpnr, openXC7 or Python. The validated Windows toolchain is about 3 GB installed (21,465 files; mostly the Apio oss-cad-suite and openXC7 packages), or 725 MB compressed.

Things found while staging it:

- Apio refreshes its remote config daily and "repairs" its packages folder: it deletes packages whose version differs from the config, deletes unknown entries, and downloads replacements. On macOS this already replaced a validated openXC7 package once (ADR-004).
- Apio reads and writes `~/.apio` unless told otherwise. Its documented environment options (`apio/utils/env_options.py` at the validated commit) are `APIO_HOME`, `APIO_PACKAGES` (the path must contain "packages"), `APIO_PLATFORM`, `APIO_REMOTE_CONFIG_URL` and `APIO_DEBUG`. Both paths must be ASCII 33–127 with no spaces.
- openXC7's `fasm2frames.cmd`, `bit2fasm.cmd` and `xc7pll.cmd` run a bare `python` from PATH. In Phases 1–4A this silently ran the developer machine's `C:\Python314\python.exe`. A clean student PC has no such Python.
- Python writes `__pycache__` files next to the packages it runs (80 such files were found in the validated `~/.apio/packages/openxc7`), so running the tools would modify the installed toolchain.
- A UI-only extension update must not re-download or re-copy hundreds of MB of unchanged tools.

## Decision

1. **Two artifacts, two versions.**
   - The **extension** (`nexysvhdl-<version>-<target>.vsix`, about 230 KB) contains only NexysVHDL code and data.
   - The **toolchain** (`nexysvhdl-toolchain-<bundle version>-<target>.tar.gz`) is a separate artifact with its own version (`1.0`).
   - The extension declares the toolchain version it requires, and the content hash per platform, in `toolchains/bundle/requirement.json`, which ships in the VSIX.
2. **Per-user store, immutable versions.**
   - Toolchains are installed into `<data root>/toolchains/<target>/<version>/`. The data root is `%LOCALAPPDATA%\NexysVHDL` on Windows (local, not roaming, and shared by every VS Code flavour/profile) and `~/Library/NexysVHDL` on macOS (no space: Apio's rule).
   - Installing extracts into a private staging folder and checks the full content hash against the requirement. Only then is the folder published, with one rename.
   - An installed version is never modified. A different folder with the same version is refused (`TOOLCHAIN_VERSION_CONFLICT`). New versions install side by side. Extension updates that require the same version reuse it untouched.
3. **Bundled-only.**
   - In classroom mode (the extension), the composition root resolves tools only from the installed version folder: `BundledToolLocator`, plus the official Digilent install folders for the Windows programmer.
   - There is no PATH search, no `NEXYSVHDL_*` or project tool override, and no fallback. A missing toolchain makes Check/Simulate/Build unavailable, never "found elsewhere".
   - The developer CLI keeps Phase 3 discovery.
4. **Apio isolation.** Every tool process gets:
   - `APIO_HOME=<data root>/state/<target>-<version>/apio-home` (writable state);
   - `APIO_PACKAGES=<bundle>/apio/packages` (read-only);
   - `APIO_REMOTE_CONFIG_URL=file://<bundle>/apio/remote-config/apio-{major}.{minor}.x.jsonc`, which pins every package to the installed version, so Apio's scan finds nothing to repair or download.

   The loader checks this consistency on every start and disables Apio if it does not hold.
5. **Process environment.** Every bundled tool runs with:
   - PATH set to the bundle's `shims` folder followed by the operating-system folders only;
   - inherited `PATH`, `APIO_*` and `PYTHON*` variables removed;
   - `PYTHONDONTWRITEBYTECODE=1`.

   A NexysVHDL-authored `shims/python.cmd` runs the CPython 3.11.6 that ships inside the official oss-cad-suite package. Its fasm2frames output was verified to be byte-identical to the validated Python 3.14.3 run.
6. **Payload lifecycle (clarified 2026-10-03).**
   - A toolchain payload becomes **immutable at release freeze / first external distribution** of that toolchain version.
   - *Before* the first external release, the payload validated for a version is an **internal pre-release validation candidate**: it may be replaced by a new candidate of the same version, deliberately (assemble, re-validate, update `requirement.json` by hand; `pack --update-requirement` still refuses to overwrite a validated hash on its own).
   - *After* release, any payload change requires a **new toolchain version** (e.g. 1.0.1 or 1.1), installed side by side.
   - This is a build/release rule only. The **runtime integrity rule is unchanged**: if the installed folder of a version has a different content hash from the one the extension requires, NexysVHDL reports `TOOLCHAIN_VERSION_CONFLICT` and never modifies, repairs or replaces it in place.
   - Applied once: Windows Toolchain 1.0 candidate `43b3fb80…` (21,465 files, internal validation only, never distributed externally) was replaced before release by `57f0f0da89e6565d6e46d20780fa57af86f8ac36d45a78b750203fc8f381820b` (21,208 files; the unused Apio drivers and graphviz packages became compatibility placeholders, see `docs/toolchain-1.0-redistribution.md`). macOS Toolchain 1.0 (`f0402218…`) is unchanged.
7. **Provenance.** The toolchain is assembled from the official release archives listed in `toolchains/bundle/<target>.json`, each checked by size and SHA-256. It is never copied from a developer's tool folders. Nothing is upgraded for uniformity across platforms.

## Consequences

- The student flow is: install the VSIX, then **Install FPGA Toolchain…** once, from the classroom download. That is one extra click compared with an all-in-one VSIX, and it is what makes small extension updates possible.
- A future toolchain (e.g. 1.1) is a new artifact and a new requirement. Old versions stay on disk until removed (no automatic cleanup yet).
- Windows profile or project paths with spaces or non-ASCII characters (follow-up, same phase):
  - Apio refuses such `APIO_HOME`/`APIO_PACKAGES` paths by design (a deliberate ASCII check in `apio/utils/util.py`, introduced for the Gowin tools; Unicode *project* folders are allowed).
  - GHDL 6.0.0 writes the source paths it is given into `work-obj08.cf` and cannot read some non-ASCII bytes back (e.g. CJK; spaces are fine).
  - Fixes:
    - Apio and all bundled tools run through an ASCII alias: a directory junction `%ProgramData%\NexysVHDL\links\<hash>` pointing at the user's own toolchain or state folder. It is created only when needed, needs no administrator rights, and is used only after its target is verified.
    - GHDL is given workspace-relative paths only, so the project location never reaches it.
  - The toolchain files, their immutability and the per-user store are unchanged.
  - The remaining limit is non-ASCII VHDL *file names*, which get a clear Check error.
- Uninstalling the extension leaves the toolchain in the data root (documented). VS Code has no reliable hook to tell an uninstall from an update.

## Addendum: macOS (Phase 4B Mac step, 2026-10-02)

The decision applies unchanged to darwin-arm64 (store `~/Library/NexysVHDL`, same recipe/assembler/store/loader). Three points were needed for macOS; see `docs/phase4b-classroom-bundle.md` §17.

1. **Symbolic links in the toolchain archive.** The official macOS archives contain relative links (PyInstaller's `Python` → `Python.framework/Versions/3.14/Python`, Qt framework `Versions/Current`, dylib and Python aliases). Copying them as files would make dyld load two copies of a library. The archive format therefore accepts a link only when its target provably stays inside the tree (relative, `../` only as a prefix and never above the root, then plain names); nothing is written through a link and links are created last. The content hash covers link targets; a tree without links hashes exactly as before, so the released Windows toolchain is unaffected.
2. **No system linker.** GHDL's ahead-of-time LLVM build links each elaborated design with the system `cc`/`ld`, which only exist on a Mac with Xcode Command Line Tools and cannot be redistributed. The macOS toolchain uses the official LLVM-JIT build of the same GHDL 6.0.0 release, which elaborates in memory; simulation output, waveforms and synthesized Verilog were verified identical and the full installed workflow passed. (Approved by the owner, 2026-10-02.)
3. **Home folders with spaces or non-English characters.** As on Windows, the real store stays where it is and the tools get an ASCII alias only when needed: a symbolic link in the user's private `$TMPDIR/NexysVHDL-links` (0700, ownership and target verified before reuse, recreated if purged), registered through the same `pathAlias` hook.
4. **Platform-specific license texts** live in `toolchains/bundle/licenses-<target>/`, merged into the toolchain's `licenses/` for that target only, so adding a text for one platform never changes another platform's released content.

No Python shim is needed on macOS (openXC7's wrappers run the package's own Python), and the programmer (openFPGALoader with its libusb/libftdi) is part of the toolchain; macOS needs no FPGA USB driver.
