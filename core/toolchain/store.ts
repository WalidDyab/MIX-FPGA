import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Diagnostic, errorDiag, warningDiag } from '../results/diagnostic';
import { BUNDLE_MANIFEST, type BundleManifest } from './bundle';
import { type ExtractProgress, extractTarGz, inventoryDirectory } from './tar';

/**
 * Per-user store of installed NexysVHDL toolchain versions. The toolchain is
 * versioned independently of the extension: an extension declares the bundle
 * version it requires (toolchains/bundle/requirement.json, shipped in the
 * VSIX), and any number of extension updates reuse the same installed
 * version. New toolchain versions are installed side by side; an installed
 * version is never modified.
 *
 *   <data root>/
 *     toolchains/<target>/<version>/        immutable bundle (+ .nexysvhdl-installed.json)
 *     toolchains/.staging/<random>/          extraction in progress (renamed into place when verified)
 *     state/<target>-<version>/apio-home/    writable tool state for that version
 */

export const INSTALLED_MARKER = '.nexysvhdl-installed.json';

/** What one extension version requires; tracked in Git and shipped in the VSIX. */
export interface ToolchainRequirement {
    readonly schemaVersion: 1;
    readonly bundleVersion: string;
    readonly targets: Readonly<
        Record<
            string,
            {
                /** `validated`: treeSha256 is known; `pending`: no package for this target yet. */
                readonly status: 'validated' | 'pending';
                readonly treeSha256?: string;
                readonly files?: number;
                readonly bytes?: number;
                /** File name of the distributable archive. */
                readonly archive?: string;
                readonly notes?: string;
            }
        >
    >;
}

export interface InstalledMarker {
    readonly product: 'NexysVHDL toolchain';
    readonly target: string;
    readonly bundleVersion: string;
    readonly treeSha256: string;
    readonly files: number;
    readonly bytes: number;
    readonly installedAt: string;
    readonly source: string;
}

export interface StorePaths {
    readonly dataRoot: string;
    readonly versionDir: string;
    readonly stagingRoot: string;
    readonly stateDir: string;
}

export function storePaths(dataRoot: string, target: string, version: string): StorePaths {
    return {
        dataRoot,
        versionDir: join(dataRoot, 'toolchains', target, version),
        stagingRoot: join(dataRoot, 'toolchains', '.staging'),
        stateDir: join(dataRoot, 'state', `${target}-${version}`),
    };
}

export function validateRequirement(data: unknown): string[] {
    const r = data as Partial<ToolchainRequirement> | null;
    const p: string[] = [];
    if (typeof r !== 'object' || r === null) return ['not a JSON object'];
    if (r.schemaVersion !== 1) p.push('schemaVersion must be 1');
    if (typeof r.bundleVersion !== 'string' || !/^\d+\.\d+(\.\d+)?$/.test(r.bundleVersion)) p.push('bundleVersion must look like 1.0');
    for (const [target, t] of Object.entries(r.targets ?? {})) {
        if (t.status === 'validated' && !/^[0-9a-f]{64}$/.test(t.treeSha256 ?? '')) p.push(`${target}: a validated target needs treeSha256`);
        if (t.status !== 'validated' && t.status !== 'pending') p.push(`${target}: unknown status`);
    }
    if (!r.targets || Object.keys(r.targets).length === 0) p.push('no targets');
    return p;
}

export type InstalledState =
    | { readonly status: 'installed'; readonly paths: StorePaths; readonly marker: InstalledMarker }
    | { readonly status: 'missing' | 'pending' | 'unsupported'; readonly paths: StorePaths; readonly diagnostics: readonly Diagnostic[] }
    | { readonly status: 'conflict'; readonly paths: StorePaths; readonly diagnostics: readonly Diagnostic[] };

/** Is the required version installed (fast: marker only; content was verified at install time)? */
export async function installedToolchain(dataRoot: string, target: string, requirement: ToolchainRequirement): Promise<InstalledState> {
    const paths = storePaths(dataRoot, target, requirement.bundleVersion);
    const want = requirement.targets[target];
    if (!want) return { status: 'unsupported', paths, diagnostics: [errorDiag('toolchain', 'TOOLCHAIN_TARGET_UNSUPPORTED', `NexysVHDL has no FPGA toolchain for ${target}.`)] };
    if (want.status !== 'validated') {
        return { status: 'pending', paths, diagnostics: [errorDiag('toolchain', 'TOOLCHAIN_TARGET_PENDING', `The NexysVHDL toolchain ${requirement.bundleVersion} for ${target} is not available yet.`)] };
    }
    let marker: InstalledMarker | undefined;
    try {
        marker = JSON.parse(await readFile(join(paths.versionDir, INSTALLED_MARKER), 'utf8')) as InstalledMarker;
    } catch {
        marker = undefined;
    }
    const exists = await stat(paths.versionDir).then(
        () => true,
        () => false,
    );
    if (!marker) {
        return exists
            ? { status: 'conflict', paths, diagnostics: [errorDiag('toolchain', 'TOOLCHAIN_INSTALL_INCOMPLETE', `${paths.versionDir} exists but is not a complete NexysVHDL toolchain installation.`)] }
            : { status: 'missing', paths, diagnostics: [errorDiag('toolchain', 'TOOLCHAIN_NOT_INSTALLED', `The NexysVHDL FPGA toolchain ${requirement.bundleVersion} is not installed.`)] };
    }
    if (marker.treeSha256 !== want.treeSha256 || marker.bundleVersion !== requirement.bundleVersion || marker.target !== target) {
        return {
            status: 'conflict',
            paths,
            diagnostics: [
                errorDiag(
                    'toolchain',
                    'TOOLCHAIN_VERSION_CONFLICT',
                    `The installed NexysVHDL toolchain ${marker.bundleVersion} (${paths.versionDir}) is not the toolchain this NexysVHDL release was validated with. An installed toolchain version is never changed in place.`,
                ),
            ],
        };
    }
    return { status: 'installed', paths, marker };
}

export type InstallResult =
    | { readonly status: 'installed' | 'already-installed'; readonly paths: StorePaths; readonly marker: InstalledMarker }
    | { readonly status: 'failed'; readonly paths: StorePaths; readonly diagnostics: readonly Diagnostic[] };

export interface InstallOptions {
    readonly archive: string;
    readonly dataRoot: string;
    readonly target: string;
    readonly requirement: ToolchainRequirement;
    readonly onProgress?: (p: ExtractProgress & { readonly phase: 'extracting' | 'publishing' }) => void;
    readonly signal?: AbortSignal;
    /** Injected for tests. */
    readonly now?: () => Date;
}

async function renameWithRetry(from: string, to: string): Promise<void> {
    // Windows virus scanners briefly lock freshly written files; a rename may need a few tries.
    for (let attempt = 0; ; attempt++) {
        try {
            await rename(from, to);
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        }
    }
}

/**
 * Installs a toolchain archive as a new immutable version folder:
 * extract into a private staging folder, verify the content hash against the
 * extension's requirement, then publish with one rename. A version that is
 * already installed is reused untouched; a different folder with the same
 * version is never overwritten.
 */
export async function installToolchainArchive(options: InstallOptions): Promise<InstallResult> {
    const { requirement, target } = options;
    const before = await installedToolchain(options.dataRoot, target, requirement);
    const paths = before.paths;
    const failed = (code: string, message: string): InstallResult => ({ status: 'failed', paths, diagnostics: [errorDiag('toolchain', code, message)] });
    if (before.status === 'installed') return { status: 'already-installed', paths, marker: before.marker };
    if (before.status !== 'missing') return { status: 'failed', paths, diagnostics: before.diagnostics };
    const want = requirement.targets[target]!;

    await mkdir(paths.stagingRoot, { recursive: true });
    const staging = join(paths.stagingRoot, randomBytes(4).toString('hex'));
    await mkdir(staging);
    try {
        let extracted;
        try {
            extracted = await extractTarGz(options.archive, staging, {
                ...(options.onProgress ? { onProgress: (p: ExtractProgress) => options.onProgress!({ ...p, phase: 'extracting' }) } : {}),
                ...(options.signal ? { signal: options.signal } : {}),
            });
        } catch (err) {
            return failed('TOOLCHAIN_ARCHIVE_INVALID', `The file is not a valid NexysVHDL toolchain archive: ${(err as Error).message}`);
        }
        let manifest: BundleManifest;
        try {
            manifest = JSON.parse(await readFile(join(staging, BUNDLE_MANIFEST), 'utf8')) as BundleManifest;
        } catch {
            return failed('TOOLCHAIN_ARCHIVE_INVALID', `The archive has no ${BUNDLE_MANIFEST}; it is not a NexysVHDL toolchain.`);
        }
        if (manifest.target !== target) return failed('TOOLCHAIN_ARCHIVE_WRONG_PLATFORM', `This archive is the NexysVHDL toolchain for ${manifest.target}; this computer needs ${target}.`);
        if (manifest.bundleVersion !== requirement.bundleVersion) {
            return failed('TOOLCHAIN_ARCHIVE_WRONG_VERSION', `This archive contains toolchain ${manifest.bundleVersion}; this NexysVHDL release requires toolchain ${requirement.bundleVersion}.`);
        }
        if (extracted.treeSha256 !== want.treeSha256) {
            return failed('TOOLCHAIN_ARCHIVE_MISMATCH', `The archive content does not match the validated toolchain ${requirement.bundleVersion} (content hash ${extracted.treeSha256.slice(0, 12)}…, expected ${want.treeSha256!.slice(0, 12)}…). It may be damaged or modified.`);
        }
        const marker: InstalledMarker = {
            product: 'NexysVHDL toolchain',
            target,
            bundleVersion: requirement.bundleVersion,
            treeSha256: extracted.treeSha256,
            files: extracted.entries.length,
            bytes: extracted.entries.reduce((n, e) => n + e.size, 0),
            installedAt: (options.now?.() ?? new Date()).toISOString(),
            source: options.archive.split(/[\\/]/).pop() ?? options.archive,
        };
        await writeFile(join(staging, INSTALLED_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
        options.onProgress?.({ phase: 'publishing', compressedBytes: 0, files: marker.files });
        await mkdir(join(paths.versionDir, '..'), { recursive: true });
        try {
            await renameWithRetry(staging, paths.versionDir);
        } catch (err) {
            // Another window may have finished the same install first.
            const now = await installedToolchain(options.dataRoot, target, requirement);
            if (now.status === 'installed') return { status: 'already-installed', paths, marker: now.marker };
            return failed('TOOLCHAIN_INSTALL_FAILED', `Could not move the toolchain into ${paths.versionDir}: ${(err as Error).message}`);
        }
        return { status: 'installed', paths, marker };
    } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        // Leave no empty staging folder behind (rmdir fails, harmlessly, while another install is staging).
        await rmdir(paths.stagingRoot).catch(() => undefined);
    }
}

/** Full content check of an installed version (Verify Toolchain): every file hashed, compared with the requirement. */
export async function verifyInstalledToolchain(
    dataRoot: string,
    target: string,
    requirement: ToolchainRequirement,
    onFile?: (path: string) => void,
): Promise<{ ok: boolean; treeSha256?: string; files?: number; diagnostics: Diagnostic[] }> {
    const state = await installedToolchain(dataRoot, target, requirement);
    if (state.status !== 'installed') return { ok: false, diagnostics: [...state.diagnostics] };
    const inv = await inventoryDirectory(state.paths.versionDir, { exclude: [INSTALLED_MARKER], ...(onFile ? { onFile } : {}) });
    const ok = inv.treeSha256 === requirement.targets[target]!.treeSha256;
    return {
        ok,
        treeSha256: inv.treeSha256,
        files: inv.entries.length,
        diagnostics: ok
            ? []
            : [warningDiag('toolchain', 'TOOLCHAIN_MODIFIED', `This toolchain has been modified and is no longer the verified MIX-FPGA configuration (installed in ${state.paths.versionDir}, content hash ${inv.treeSha256.slice(0, 12)}…). You can continue using it, or choose Repair to restore the supported version.`)],
    };
}
