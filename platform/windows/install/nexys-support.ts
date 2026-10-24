import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComponentDefinition, Inspection, SetupStepResult } from '../../../core/install/model';
import { INSTALLED_MARKER, type InstalledMarker, installedToolchain, installToolchainArchive, storePaths, type ToolchainRequirement } from '../../../core/toolchain/store';
import { inventoryDirectory } from '../../../core/toolchain/tar';
import { sha256File } from '../../../core/util/hash';
import { nexysModifiedButUsable } from '../../macos/install/nexys-support';

/**
 * Nexys A7-100T support on Windows: the NexysVHDL Toolchain 1.0 bundle (GHDL, Apio with oss-cad-suite, Verible, openXC7 and the
 * xc7a100t chip database), byte for byte as validated for NexysVHDL 0.6.0. MIX-FPGA keeps it in its own store
 * (<MIX-FPGA root>\support\nexys-a7). It gets there in one of three ways:
 *   reuse    an upgrading NexysVHDL user's store is verified (installed marker) and used read-only until it is taken over.
 *            Writable tool state is always the MIX-FPGA state area, never a NexysVHDL folder.
 *   adopt    that store is verified file by file and copied (NTFS cannot share blocks, so this is a real copy; no hard links,
 *            so a later repair of the copy can never reach the original). The NexysVHDL folder is only read.
 *   install  the support archive (the same validated NexysVHDL toolchain archive) is extracted and verified.
 */
export const NEXYS_TARGET = 'win32-x64';

export interface NexysArchive {
    readonly path: string;
    /** Recorded sha256 of the archive file, checked before anything is extracted. */
    readonly sha256?: string;
}

export interface NexysSupportDeps {
    readonly requirement: ToolchainRequirement;
    /** The MIX-FPGA store of the Nexys support. */
    readonly dataRoot: string;
    /** NexysVHDL 0.6.0 stores that may hold the same validated toolchain (empty for a fresh or relocated MIX-FPGA). */
    readonly legacyRoots: readonly string[];
    readonly freeBytes: (path: string) => Promise<number>;
    /** Where the support archive is, for a machine with nothing to adopt. Undefined: ask the student / not available. */
    readonly archive: () => Promise<NexysArchive | undefined>;
    readonly now?: () => Date;
    /** Test seam: the recursive copy. */
    readonly copyTree?: (from: string, to: string, signal?: AbortSignal) => Promise<void>;
}

const fail = (code: string, message: string): SetupStepResult => ({ ok: false, code, message });
const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;

export interface NexysAdoptionPlan {
    readonly status: 'adoptable' | 'already-installed' | 'nothing-to-adopt' | 'blocked';
    readonly source?: string;
    readonly target: string;
    readonly files?: number;
    readonly bytes?: number;
    /** The source's content hash, recomputed from every file (only with `verify`). */
    readonly treeSha256?: string;
    readonly expectedTreeSha256?: string;
    readonly sameVolume?: boolean;
    /** Extra disk the copy needs (the whole tree: nothing is shared), and the peak while it is verified. */
    readonly extraBytes?: number;
    readonly reasons: readonly string[];
}

/** Read-only. With `verify`, hashes every file of the NexysVHDL store (about half a minute for 3 GB). */
export async function planNexysAdoption(d: NexysSupportDeps, opts: { verify: boolean }): Promise<NexysAdoptionPlan> {
    const target = storePaths(d.dataRoot, NEXYS_TARGET, d.requirement.bundleVersion).versionDir;
    const expected = d.requirement.targets[NEXYS_TARGET]?.treeSha256;
    const base = { target, ...(expected ? { expectedTreeSha256: expected } : {}) };
    const mine = await installedToolchain(d.dataRoot, NEXYS_TARGET, d.requirement);
    if (mine.status === 'installed') return { ...base, status: 'already-installed', reasons: ['the MIX-FPGA store already holds the validated toolchain'] };
    if (mine.status !== 'missing') return { ...base, status: 'blocked', reasons: mine.diagnostics.map((x) => x.message) };
    for (const root of d.legacyRoots) {
        const old = await installedToolchain(root, NEXYS_TARGET, d.requirement);
        if (old.status !== 'installed') continue;
        const source = old.paths.versionDir;
        const drive = (p: string) => /^[a-z]:/i.exec(p)?.[0]?.toLowerCase();
        const sameVolume = drive(source) !== undefined ? drive(source) === drive(d.dataRoot) : undefined;
        if (!opts.verify) return { ...base, status: 'adoptable', source, files: old.marker.files, bytes: old.marker.bytes, extraBytes: old.marker.bytes, ...(sameVolume !== undefined ? { sameVolume } : {}), reasons: ['installed marker matches the validated toolchain (content not yet re-hashed)'] };
        const inv = await inventoryDirectory(source, { exclude: [INSTALLED_MARKER] });
        const ok = inv.treeSha256 === expected;
        return {
            ...base,
            status: ok ? 'adoptable' : 'blocked',
            source,
            files: inv.entries.length,
            bytes: inv.bytes,
            extraBytes: inv.bytes,
            treeSha256: inv.treeSha256,
            ...(sameVolume !== undefined ? { sameVolume } : {}),
            reasons: ok ? ['every file matches the validated toolchain'] : ['the NexysVHDL toolchain files differ from the validated toolchain; they are not adopted'],
        };
    }
    return { ...base, status: 'nothing-to-adopt', reasons: ['no validated NexysVHDL toolchain on this computer'] };
}

const defaultCopy = (from: string, to: string): Promise<void> => cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });

/**
 * Copies the verified NexysVHDL store into the MIX-FPGA store (a real copy: no links of any kind to the original), verifies the
 * copy file by file, records where it came from, and publishes it with one rename. A copy is made only when there is room.
 */
export async function adoptNexys(d: NexysSupportDeps, progress: (m: string) => void = () => undefined, signal?: AbortSignal): Promise<SetupStepResult> {
    progress('Checking your Nexys A7 tools…');
    const plan = await planNexysAdoption(d, { verify: true });
    if (plan.status === 'already-installed') return { ok: true, detail: 'already installed' };
    if (plan.status !== 'adoptable' || !plan.source) return fail('NEXYS_NOT_ADOPTABLE', plan.reasons.join('; '));
    const paths = storePaths(d.dataRoot, NEXYS_TARGET, d.requirement.bundleVersion);
    const need = Math.ceil((plan.bytes ?? 0) * 1.1);
    const free = await d.freeBytes(d.dataRoot);
    if (free < need) return fail('INSUFFICIENT_DISK', `Taking over the Nexys A7 tools needs a copy of about ${gb(need)}; only ${gb(free)} is free.`);
    await mkdir(paths.stagingRoot, { recursive: true });
    const staging = join(paths.stagingRoot, randomBytes(4).toString('hex'));
    try {
        progress('Taking over your Nexys A7 tools…');
        try {
            await (d.copyTree ?? defaultCopy)(plan.source, staging, signal);
        } catch (err) {
            return fail('NEXYS_COPY_FAILED', `The Nexys A7 tools could not be copied: ${err instanceof Error ? err.message : String(err)}`.slice(0, 240));
        }
        if (signal?.aborted) return fail('CANCELLED', 'Cancelled.');
        progress('Verifying the Nexys A7 tools…');
        const inv = await inventoryDirectory(staging, { exclude: [INSTALLED_MARKER] });
        if (inv.treeSha256 !== plan.expectedTreeSha256) return fail('NEXYS_VERIFY_FAILED', 'The copied Nexys A7 tools do not match the validated toolchain.');
        const old = JSON.parse(await readFile(join(staging, INSTALLED_MARKER), 'utf8')) as InstalledMarker;
        const marker: InstalledMarker = { ...old, files: inv.entries.length, bytes: inv.bytes, installedAt: (d.now ?? (() => new Date()))().toISOString(), source: `adopted from NexysVHDL (${plan.source})` };
        await writeFile(join(staging, INSTALLED_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
        await mkdir(join(paths.versionDir, '..'), { recursive: true });
        await rename(staging, paths.versionDir);
        return { ok: true, detail: `adopted ${inv.entries.length} files from NexysVHDL` };
    } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** Installs the Nexys support from its archive (fresh computers). The archive's own hash is checked first, then every file. */
export async function installNexysFromArchive(d: NexysSupportDeps, archive: NexysArchive, progress: (m: string, f?: number) => void = () => undefined, signal?: AbortSignal): Promise<SetupStepResult> {
    progress('Installing Nexys A7 support…');
    const s = await stat(archive.path).catch(() => undefined);
    if (!s?.isFile()) return fail('NEXYS_ARCHIVE_MISSING', 'The Nexys A7 support file was not found.');
    const want = d.requirement.targets[NEXYS_TARGET];
    const free = await d.freeBytes(d.dataRoot);
    const need = (want?.bytes ?? 3.2e9) * 1.1;
    if (free < need) return fail('INSUFFICIENT_DISK', `Nexys A7 support needs about ${gb(need)} free; only ${gb(free)} is available.`);
    if (archive.sha256 && (await sha256File(archive.path)) !== archive.sha256) return fail('NEXYS_ARCHIVE_MISMATCH', 'The Nexys A7 support file is damaged or not the validated one.');
    const r = await installToolchainArchive({
        archive: archive.path,
        dataRoot: d.dataRoot,
        target: NEXYS_TARGET,
        requirement: d.requirement,
        ...(signal ? { signal } : {}),
        onProgress: (p) => progress(p.phase === 'publishing' ? 'Finishing…' : 'Installing Nexys A7 support…', p.phase === 'publishing' ? 1 : s.size ? Math.min(1, p.compressedBytes / s.size) : undefined),
    });
    if (r.status === 'failed') return fail(r.diagnostics[0]?.code ?? 'NEXYS_INSTALL_FAILED', r.diagnostics[0]?.message ?? 'Nexys A7 support could not be installed.');
    return { ok: true, detail: r.status === 'already-installed' ? 'already installed' : 'installed' };
}

/** The Setup component for the Nexys A7 support. */
export function nexysDefinition(d: NexysSupportDeps, depth: 'quick' | 'full' = 'quick'): ComponentDefinition {
    return {
        id: 'nexys-toolchain',
        label: 'Nexys A7 tools',
        async inspect(): Promise<Inspection> {
            const mine = await installedToolchain(d.dataRoot, NEXYS_TARGET, d.requirement);
            if (mine.status === 'installed') {
                if (depth === 'full') {
                    const inv = await inventoryDirectory(mine.paths.versionDir, { exclude: [INSTALLED_MARKER] });
                    if (inv.treeSha256 !== d.requirement.targets[NEXYS_TARGET]?.treeSha256) {
                        // Changed content with everything still there (same or more files, the recorded programs present): the user modified it.
                        // Something missing or unreadable is damage and stays repairable.
                        if (await nexysModifiedButUsable(mine.paths.versionDir, inv.entries.length, d.requirement.targets[NEXYS_TARGET]?.files)) return { state: 'modified', ownership: 'managed', code: 'NEXYS_MODIFIED', detail: 'files of the Nexys A7 tools were changed', version: `Toolchain ${d.requirement.bundleVersion}` };
                        return { state: 'repairable', ownership: 'managed', code: 'NEXYS_DAMAGED', detail: 'files of the Nexys A7 tools are missing or damaged' };
                    }
                }
                return { state: 'ready', ownership: 'managed', version: `Toolchain ${d.requirement.bundleVersion}` };
            }
            if (mine.status === 'unsupported' || mine.status === 'pending') return { state: 'incompatible', ownership: 'managed', code: 'NEXYS_UNSUPPORTED', detail: mine.diagnostics[0]?.message ?? 'not available for this computer' };
            if (mine.status === 'conflict') return { state: 'repairable', ownership: 'managed', code: 'NEXYS_CONFLICT', detail: mine.diagnostics[0]?.message ?? 'an incomplete or different installation is in the way' };
            for (const root of d.legacyRoots) {
                const old = await installedToolchain(root, NEXYS_TARGET, d.requirement);
                if (old.status !== 'installed') continue;
                // Usable as is (read-only reuse by the Nexys flow). A Full check also proves its content; Repair then takes it over.
                if (depth === 'full') {
                    const inv = await inventoryDirectory(old.paths.versionDir, { exclude: [INSTALLED_MARKER] });
                    if (inv.treeSha256 !== d.requirement.targets[NEXYS_TARGET]?.treeSha256) return { state: 'repairable', ownership: 'managed', code: 'NEXYS_MODIFIED', detail: 'files of the existing NexysVHDL tools were changed' };
                }
                return { state: 'ready', ownership: 'managed', code: 'REUSED_FROM_NEXYSVHDL', version: `Toolchain ${d.requirement.bundleVersion}`, detail: `using the existing NexysVHDL installation (${root})` };
            }
            return { state: 'not-installed', ownership: 'managed' };
        },
        install: {
            requires: [],
            userInput: 'none',
            run: async (request) => {
                // Repair: MIX-FPGA's own copy is damaged (its marker is present but files changed). Only that copy is removed.
                const mine = await installedToolchain(d.dataRoot, NEXYS_TARGET, d.requirement);
                if (mine.status === 'installed') {
                    request.progress({ message: 'Checking the Nexys A7 tools…' });
                    const inv = await inventoryDirectory(mine.paths.versionDir, { exclude: [INSTALLED_MARKER] });
                    if (inv.treeSha256 === d.requirement.targets[NEXYS_TARGET]?.treeSha256) return { ok: true, detail: 'already installed' };
                    const trash = join(mine.paths.stagingRoot, `damaged-${randomBytes(4).toString('hex')}`);
                    await mkdir(mine.paths.stagingRoot, { recursive: true });
                    await rename(mine.paths.versionDir, trash);
                    await rm(trash, { recursive: true, force: true });
                }
                const plan = await planNexysAdoption(d, { verify: false });
                if (plan.status === 'adoptable') {
                    const taken = await adoptNexys(d, (m) => request.progress({ message: m }), request.signal);
                    // A NexysVHDL folder whose files were changed is never taken over; the archive (if there is one) replaces it.
                    if (taken.ok || taken.code !== 'NEXYS_NOT_ADOPTABLE') return taken;
                }
                const archive = await d.archive();
                if (!archive) return fail('NEXYS_SOURCE_MISSING', 'The Nexys A7 support file is not available.');
                return installNexysFromArchive(d, archive, (m, f) => request.progress({ message: m, ...(f !== undefined ? { fraction: f } : {}) }), request.signal);
            },
        },
    };
}
