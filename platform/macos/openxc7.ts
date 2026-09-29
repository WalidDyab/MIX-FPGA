import { posix } from 'node:path';
import { type DetectedTool, type Diagnostic, errorDiag, parseOpenXc7ReleaseTag, warningDiag } from '../../core';
import type { MacosSystem } from './system';

/**
 * openXC7 release identifiers appear in three spellings for the same release:
 *   BUILD-INFO.json "release-tag"  and the pinned config tag: 2026-09-25
 *   `apio packages list` / installed_packages.json "version": 2026.09.25
 *   package file names:                                      20260925
 * The canonical form used by this adapter is Apio's package version, 2026.09.25.
 */
export function normalizeOpenXc7Version(text: string): string | undefined {
    const m = /^\s*(\d{4})[-.]?(\d{2})[-.]?(\d{2})\s*$/.exec(text);
    if (!m) return undefined;
    const [, y, mo, d] = m;
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return undefined;
    return `${y}.${mo}.${d}`;
}

export function sameOpenXc7Release(a: string, b: string): boolean {
    const na = normalizeOpenXc7Version(a);
    return na !== undefined && na === normalizeOpenXc7Version(b);
}

/**
 * Version string to report for the shared compatibility check, which compares
 * strings exactly: the tested entry denoting the same release if there is one
 * (whatever spelling the manifest uses), otherwise the canonical form.
 */
export function reportedOpenXc7Version(detected: string, tested: readonly string[]): string | undefined {
    const canonical = normalizeOpenXc7Version(detected);
    if (canonical === undefined) return undefined;
    return tested.find((t) => normalizeOpenXc7Version(t) === canonical) ?? canonical;
}

/** XILINX-PARTS-INDEX.json schema each Apio minor version accepts (schema 8 broke Apio 1.7.0). */
export const PARTS_INDEX_SCHEMA_FOR_APIO: Readonly<Record<string, number>> = { '1.7': 7 };

export interface OpenXc7Package {
    readonly dir: string;
    /** BUILD-INFO.json "release-tag", verbatim. */
    readonly releaseTag?: string;
    /** installed_packages.json openxc7 "version", verbatim. */
    readonly installedVersion?: string;
    readonly partsIndexSchema?: number;
    readonly nextpnrRevision?: string;
    readonly targetPlatform?: string;
}

function jsonField<T>(text: string | undefined, pick: (data: Record<string, unknown>) => T | undefined): T | undefined {
    if (text === undefined) return undefined;
    try {
        return pick(JSON.parse(text) as Record<string, unknown>);
    } catch {
        return undefined;
    }
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Reads the installed openXC7 package metadata from Apio's home. Read-only. */
export async function readOpenXc7Package(system: MacosSystem, apioHomeDir: string): Promise<OpenXc7Package | undefined> {
    const packages = posix.join(apioHomeDir, 'packages');
    const dir = posix.join(packages, 'openxc7');
    const buildInfo = await system.readText(posix.join(dir, 'BUILD-INFO.json'));
    if (buildInfo === undefined) return undefined;
    const releaseTag = buildInfo ? parseOpenXc7ReleaseTag(buildInfo) : undefined;
    const nextpnrRevision = jsonField(buildInfo, (d) => str(d['nextpnr-xilinx-revision']));
    const targetPlatform = jsonField(buildInfo, (d) => str(d['target-platform']));
    const installedVersion = jsonField(await system.readText(posix.join(packages, 'installed_packages.json')), (d) =>
        str((d['openxc7'] as Record<string, unknown> | undefined)?.['version']),
    );
    const partsIndexSchema = jsonField(await system.readText(posix.join(dir, 'XILINX-PARTS-INDEX.json')), (d) =>
        typeof d['schema'] === 'number' ? d['schema'] : undefined,
    );
    return {
        dir,
        ...(releaseTag !== undefined ? { releaseTag } : {}),
        ...(installedVersion !== undefined ? { installedVersion } : {}),
        ...(partsIndexSchema !== undefined ? { partsIndexSchema } : {}),
        ...(nextpnrRevision !== undefined ? { nextpnrRevision } : {}),
        ...(targetPlatform !== undefined ? { targetPlatform } : {}),
    };
}

export interface OpenXc7CheckContext {
    /** Detected Apio version, e.g. `1.7.0`. */
    readonly apioVersion?: string;
    /** openxc7 tag in the pinned config, e.g. `2026-09-25`. */
    readonly pinnedTag?: string;
    readonly expectedPlatform?: string;
}

/** Consistency and compatibility checks for an installed openXC7 package. */
export function checkOpenXc7Package(pkg: OpenXc7Package, ctx: OpenXc7CheckContext = {}): Diagnostic[] {
    const out: Diagnostic[] = [];
    const version = pkg.releaseTag ?? pkg.installedVersion;
    if (pkg.releaseTag && pkg.installedVersion && !sameOpenXc7Release(pkg.releaseTag, pkg.installedVersion)) {
        out.push(warningDiag('toolchain', 'MACOS_OPENXC7_METADATA_MISMATCH', `openXC7 BUILD-INFO.json says ${pkg.releaseTag} but Apio recorded ${pkg.installedVersion}.`));
    }
    if (ctx.pinnedTag && version && !sameOpenXc7Release(version, ctx.pinnedTag)) {
        out.push(
            errorDiag(
                'toolchain',
                'MACOS_OPENXC7_NOT_PINNED_RELEASE',
                `Installed openXC7 ${version} is not the pinned release ${ctx.pinnedTag}. Reinstall packages with the pinned config (apio packages install with APIO_REMOTE_CONFIG_URL set).`,
            ),
        );
    }
    const apioMinor = ctx.apioVersion ? /^(\d+\.\d+)\./.exec(ctx.apioVersion)?.[1] : undefined;
    const expectedSchema = apioMinor ? PARTS_INDEX_SCHEMA_FOR_APIO[apioMinor] : undefined;
    if (expectedSchema !== undefined && pkg.partsIndexSchema !== undefined && pkg.partsIndexSchema !== expectedSchema) {
        out.push(
            errorDiag(
                'toolchain',
                'MACOS_OPENXC7_SCHEMA_INCOMPATIBLE',
                `openXC7 ${version ?? '?'} uses XILINX-PARTS-INDEX schema ${pkg.partsIndexSchema}; Apio ${ctx.apioVersion} expects ${expectedSchema} and would fail with "Unexpected schema version".`,
            ),
        );
    }
    if (ctx.expectedPlatform && pkg.targetPlatform && pkg.targetPlatform !== ctx.expectedPlatform) {
        out.push(errorDiag('toolchain', 'MACOS_OPENXC7_WRONG_PLATFORM', `openXC7 package targets ${pkg.targetPlatform}, not ${ctx.expectedPlatform}.`));
    }
    return out;
}

/** DetectedTool for openXC7, with the version spelled so the shared compatibility check compares releases. */
export function openXc7Detected(pkg: OpenXc7Package | undefined, tested: readonly string[]): DetectedTool {
    if (!pkg) return { tool: 'openxc7', found: false, method: 'Apio openxc7 package' };
    const raw = pkg.releaseTag ?? pkg.installedVersion;
    const version = raw !== undefined ? reportedOpenXc7Version(raw, tested) : undefined;
    const base: DetectedTool = { tool: 'openxc7', found: true, path: pkg.dir, method: 'Apio openxc7 package (BUILD-INFO.json)', ...(raw !== undefined ? { rawVersion: raw } : {}) };
    return version === undefined ? base : { ...base, version };
}
