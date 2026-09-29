# Pinned Apio remote config

`apio-1.7.x.jsonc` is the Apio 1.7.x remote config that the macOS Phase 1/2 runs used
(`docs/phase1-macos.md`, Issue 1; `docs/phase2-macos.md` §3). It pins the release tag of every Apio
package, so `apio packages install` reproduces the validated toolchain instead of following upstream.

## Why it exists

Apio refreshes its remote config daily. On 2026-09-28 the upstream config moved openxc7 to
`2026-09-27`, whose `XILINX-PARTS-INDEX.json` uses schema 8; Apio 1.7.0 expects schema 7 and fails
with `Unexpected schema version 8, expected 7`.

## Contents

The upstream Apio 1.7.x remote config as fetched on 2026-09-28, with one change:

| Package | Upstream tag | Pinned tag |
|---|---|---|
| openxc7 | `2026-09-27` | **`2026-09-25`** |

All other tags are the upstream values of that day: definitions `2026-09-17`, drivers `2026-09-15`,
graphviz `2026-09-15`, oss-cad-suite `2026-09-15`, verible `2026-09-20`.

The file is Apio's own format, unedited apart from that tag (its header comment still says "1.6.x"
upstream). It contains no paths or credentials; `${PLATFORM}` is expanded by Apio, so the same file is
valid for any host running Apio 1.7.x.

sha256 `0ade3af13de6e202657d0c75ad6a8b652bc121eb4dc50a5be5758e5f048f2aad`

## How to use it

Apio selects a remote config through its documented `APIO_REMOTE_CONFIG_URL` variable and substitutes
`{major}`/`{minor}` with its own version. Point it at this folder with an absolute `file://` URL:

```sh
export APIO_REMOTE_CONFIG_URL="file://<repo>/toolchains/apio-remote-config/apio-{major}.{minor}.x.jsonc"
apio packages install
apio packages list      # expect: openxc7 2026.09.25
```

Every Apio command (`packages`, `build`, `upload`, ...) must run with the variable set; otherwise Apio
fetches the upstream config and reinstalls the incompatible package. Apio prints
`Active env options [APIO_REMOTE_CONFIG_URL]` when it is in effect.

## Scope and Phase 3B notes

- Only Apio 1.7.x is covered. There is no `apio-1.6.x.jsonc`; the Windows Phase 2 run (Apio 1.6.0,
  openxc7 `2026-09-24`) did not use a pin. With Apio 1.6.x the variable must not point here.
- The adapter that runs Apio should set `APIO_REMOTE_CONFIG_URL` in the tool invocation's
  environment (not in the user's shell), building the `file://` URL from the resolved absolute path of
  this folder.
- Remove or replace the pin deliberately once Apio and openxc7 are realigned upstream (ADR-004).
