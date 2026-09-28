/**
 * Extract version strings from tool `--version` output. Pure; each parser was
 * written against real output recorded in Phases 1–2 (see tests/fixtures).
 */

/** `GHDL 6.0.0 (6.0.0.r0.ge589c698c.dirty) [Dunoon edition]` -> `6.0.0` */
export function parseGhdlVersion(text: string): string | undefined {
    return /^GHDL\s+(\d+\.\d+\.\d+(?:[-.][\w.]+)?)\s/m.exec(text)?.[1];
}

/** `Apio CLI version 1.6.0 (pyinst-windows-amd64-2026-09-15)` -> `1.6.0` */
export function parseApioVersion(text: string): string | undefined {
    return /Apio(?: CLI)? version\s+(\d+\.\d+\.\d+)/i.exec(text)?.[1];
}

/** `Yosys 0.63+173 (git sha1 66306a8ca-dirty, ...)` -> `0.63+173` */
export function parseYosysVersion(text: string): string | undefined {
    return /Yosys\s+(\d+\.\d+(?:\+\d+)?)/.exec(text)?.[1];
}

/** `"nextpnr-xilinx" -- Next Generation Place and Route (Version 0eae9fb)` -> `0eae9fb` */
export function parseNextpnrVersion(text: string): string | undefined {
    return /\(Version\s+([^)\s]+)\)/.exec(text)?.[1];
}

/** openXC7 package release tag from its BUILD-INFO.json text -> e.g. `2026-09-24`. */
export function parseOpenXc7ReleaseTag(buildInfoJson: string): string | undefined {
    try {
        const tag = (JSON.parse(buildInfoJson) as { 'release-tag'?: unknown })['release-tag'];
        return typeof tag === 'string' ? tag : undefined;
    } catch {
        return undefined;
    }
}
