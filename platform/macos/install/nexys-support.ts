import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComponentDefinition, Inspection, SetupStepResult } from '../../../core/install/model';
import type { ToolRunner } from '../../../core/process/tool-runner';
import { INSTALLED_MARKER, type InstalledMarker, installedToolchain, installToolchainArchive, storePaths, type ToolchainRequirement } from '../../../core/toolchain/store';
import { inventoryDirectory } from '../../../core/toolchain/tar';
import { sha256File } from '../../../core/util/hash';

/**
 * Nexys A7-100T support on macOS: the NexysVHDL Toolchain 1.0 bundle (GHDL, Apio with oss-cad-suite, Verible, openXC7 and the
 * xc7a100t chip database), byte for byte as validated for NexysVHDL 0.6.0. MIX-FPGA keeps it in its own store
 * (<MIX-FPGA root>/support/nexys-a7). It gets there in one of two ways:
 *   adopt    an upgrading NexysVHDL user's existing store is verified file by file and copied as an APFS clone (no download,
 *            practically no disk space). The NexysVHDL folder is only read.
 *   install  the support archive (the same validated NexysVHDL toolchain archive) is extracted and verified.
 */
export const NEXYS_TARGET = 'darwin-arm64';

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
    readonly runner: ToolRunner;
    readonly freeBytes: (path: string) => Promise<number>;
    /** Where the support archive is, for a machine with nothing to adopt. Undefined: ask the student / not available. */
    readonly archive: () => Promise<NexysArchive | undefined>;
    readonly now?: () => Date;
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
    readonly reasons: readonly string[];
}

/** Read-only. With `verify`, hashes every file of the NexysVHDL store (about half a minute for 2.8 GB). */
export async function planNexysAdoption(d: NexysSupportDeps, opts: { verify: boolean }): Promise<NexysAdoptionPlan> {
    const target = storePaths(d.dataRoot, NEXYS_TARGET, d.requirement.bundleVersion).versionDir;
    const expected = d.requirement.targets[NEXYS_TARGET]?.treeSha256;
    const mine = await installedToolchain(d.dataRoot, NEXYS_TARGET, d.requirement);
    if (mine.status === 'installed') return { status: 'already-installed', target, reasons: ['the MIX-FPGA store already holds the validated toolchain'], ...(expected ? { expectedTreeSha256: expected } : {}) };
    if (mine.status !== 'missing') return { status: 'blocked', target, reasons: mine.diagnostics.map((x) => x.message) };
    for (const root of d.legacyRoots) {
        const old = await installedToolchain(root, NEXYS_TARGET, d.requirement);
        if (old.status !== 'installed') continue;
        const source = old.paths.versionDir;
        const dev = async (p: string) => {
            let at = p;
            for (;;) {
                const s = await stat(at).catch(() => undefined);
                if (s) return s.dev;
                const up = join(at, '..');
                if (up === at) return undefined;
                at = up;
            }
        };
        const sameVolume = (await dev(source)) === (await dev(d.dataRoot));
        if (!opts.verify) return { status: 'adoptable', source, target, files: old.marker.files, bytes: old.marker.bytes, sameVolume, reasons: ['installed marker matches the validated toolchain (content not yet re-hashed)'], ...(expected ? { expectedTreeSha256: expected } : {}) };
        const inv = await inventoryDirectory(source, { exclude: [INSTALLED_MARKER] });
        const ok = inv.treeSha256 === expected;
        return {
            status: ok ? 'adoptable' : 'blocked',
            source,
            target,
            files: inv.entries.length,
            bytes: inv.bytes,
            treeSha256: inv.treeSha256,
            ...(expected ? { expectedTreeSha256: expected } : {}),
            sameVolume,
            reasons: ok ? ['every file matches the validated toolchain'] : ['the NexysVHDL toolchain files differ from the validated toolchain; they are not adopted'],
        };
    }
    return { status: 'nothing-to-adopt', target, reasons: ['no validated NexysVHDL toolchain on this computer'], ...(expected ? { expectedTreeSha256: expected } : {}) };
}

/**
 * Copies the verified NexysVHDL store into the MIX-FPGA store as an APFS clone (`cp -c`: shares the blocks, the original is never
 * modified), verifies the copy file by file, records where it came from, and publishes it with one rename. If the volume cannot
 * clone, a normal copy is made only when there is room for it.
 */
export async function adoptNexys(d: NexysSupportDeps, progress: (m: string) => void = () => undefined, signal?: AbortSignal): Promise<SetupStepResult> {
    progress('Checking your Nexys A7 tools…');
    const plan = await planNexysAdoption(d, { verify: true });
    if (plan.status === 'already-installed') return { ok: true, detail: 'already installed' };
    if (plan.status !== 'adoptable' || !plan.source) return fail('NEXYS_NOT_ADOPTABLE', plan.reasons.join('; '));
    const paths = storePaths(d.dataRoot, NEXYS_TARGET, d.requirement.bundleVersion);
    await mkdir(paths.stagingRoot, { recursive: true });
    const staging = join(paths.stagingRoot, randomBytes(4).toString('hex'));
    try {
        progress('Taking over your Nexys A7 tools…');
        const clone = await d.runner.run({ executable: '/bin/cp', args: ['-c', '-R', '-p', plan.source, staging], timeoutMs: 900_000, ...(signal ? { signal } : {}) });
        if (clone.outcome !== 'exited' || clone.exitCode !== 0) {
            await rm(staging, { recursive: true, force: true });
            const free = await d.freeBytes(d.dataRoot);
            if (free < (plan.bytes ?? 0) * 1.1) return fail('NEXYS_CLONE_UNAVAILABLE', `This disk cannot share the files, and a full copy needs ${gb((plan.bytes ?? 0) * 1.1)} (${gb(free)} free).`);
            const copy = await d.runner.run({ executable: '/bin/cp', args: ['-R', '-p', plan.source, staging], timeoutMs: 1_800_000, ...(signal ? { signal } : {}) });
            if (copy.outcome !== 'exited' || copy.exitCode !== 0) return fail('NEXYS_COPY_FAILED', `The Nexys A7 tools could not be copied: ${(copy.stderr || copy.stdout).trim().slice(0, 200)}`);
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
    const need = (want?.bytes ?? 3e9) * 1.1;
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

/**
 * Is a Nexys A7 toolchain whose content hash differs still usable, i.e. changed rather than damaged? True when the toolchain's own
 * manifest is there and parses, every program it names exists, and no file is missing (the folder has at least as many files as the
 * validated toolchain). A deleted file that was replaced by another one is not detectable here; if the tools cannot then run, the
 * run itself fails and Repair is offered.
 */
export async function nexysModifiedButUsable(versionDir: string, fileCount: number, expectedFiles: number | undefined): Promise<boolean> {
    if (expectedFiles !== undefined && fileCount < expectedFiles) return false;
    try {
        const m = JSON.parse(await readFile(join(versionDir, 'toolchain-manifest.json'), 'utf8')) as { executables?: Record<string, { path?: string }> };
        for (const e of Object.values(m.executables ?? {})) {
            if (!e?.path || !(await stat(join(versionDir, ...e.path.split('/'))).then((x) => x.isFile(), () => false))) return false;
        }
        return Object.keys(m.executables ?? {}).length > 0;
    } catch {
        return false;
    }
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
                // Usable as is (read-only reuse by the Nexys flow); adopting it into the MIX-FPGA store is a separate, verified step.
                if (old.status === 'installed') return { state: 'ready', ownership: 'managed', code: 'REUSED_FROM_NEXYSVHDL', version: `Toolchain ${d.requirement.bundleVersion}`, detail: `using the existing NexysVHDL installation (${root})` };
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
                if (plan.status === 'adoptable') return adoptNexys(d, (m) => request.progress({ message: m }), request.signal);
                const archive = await d.archive();
                if (!archive) return fail('NEXYS_SOURCE_MISSING', 'The Nexys A7 support file is not available.');
                return installNexysFromArchive(d, archive, (m, f) => request.progress({ message: m, ...(f !== undefined ? { fraction: f } : {}) }), request.signal);
            },
        },
    };
}
