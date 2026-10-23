import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compareTree, describeDifference, inventoryTree, makeReadOnly, makeWritable, treeIsIdentical, type TreeDifference } from '../../../core/install/tree';
import type { InstallRequest, SetupStepResult } from '../../../core/install/model';
import { writeFileAtomic } from '../../../core/util/atomic-write';
import { sha256File } from '../../../core/util/hash';
import { executablePaths, type LoadedExpected, totalBytes, type ToolchainUnit } from './expected';
import { isInsideForeignProduct, type RuntimeLayout, TOOLCHAIN_TARGET, TOOLCHAIN_VERSION } from './layout';

/** The part of a layout the installer uses: the macOS RuntimeLayout and the Windows layout both provide it. */
export type ToolchainLayout = Pick<RuntimeLayout, 'root' | 'toolchainStaging' | 'toolchainDir' | 'manifestFile' | 'stateDir' | 'toolchainMarker' | 'unit'>;
import type { PayloadSource } from './payload';

export interface HostFacts {
    readonly platform: string;
    readonly arch: string;
}

/** Test seams: a hook may throw to stop the installer at an exact point. A `SimulatedCrash` leaves everything as it is, like a real crash. */
export interface InstallHooks {
    afterUnitStaged?(unitId: string): void | Promise<void>;
    beforeActivate?(): void | Promise<void>;
    afterActivate?(): void | Promise<void>;
    beforeMarker?(): void | Promise<void>;
}

export class SimulatedCrash extends Error {
    override readonly name = 'SimulatedCrash';
}

export interface ToolchainContext<L extends ToolchainLayout = RuntimeLayout> {
    readonly layout: L;
    /** The toolchain version and target this host installs, and whether it can run here. Default: macOS Apple silicon, Toolchain 1.0. */
    readonly target?: { readonly version: string; readonly target: string; readonly supported: (host?: HostFacts) => boolean; readonly unsupportedMessage: string };
    readonly expected: LoadedExpected;
    readonly payload: PayloadSource;
    readonly host?: HostFacts;
    /** Free bytes on the volume holding `path`. Default: the real volume. */
    readonly freeBytes?: (path: string) => Promise<number>;
    readonly hooks?: InstallHooks;
    readonly now?: () => Date;
}

const MARKER_SCHEMA = 1;

export interface CompleteMarker {
    readonly schemaVersion: 1;
    readonly product: 'MIX-FPGA';
    readonly toolchainVersion: string;
    readonly target: string;
    readonly manifestSha256: string;
    readonly installedAt: string;
    readonly source: string;
    readonly units: readonly { readonly id: string; readonly treeSha256: string }[];
}

export type CheckDepth = 'quick' | 'full';

export interface UnitCheck {
    readonly unit: ToolchainUnit;
    /**
     * `modified`: every recorded file is present with the recorded type, permissions and links, but the content of some differs
     * (or extra files were added): the user changed it. It is usable; it is not "damaged" and not "not installed".
     * `damaged`: something is missing, unreadable, lost its executable permission or is a different kind of entry.
     */
    readonly state: 'ok' | 'missing' | 'modified' | 'damaged';
    readonly difference?: TreeDifference;
}

/** Modified but usable: only changed content and/or added files; nothing missing, no permission or link change. */
export const isModifiedOnly = (d: TreeDifference): boolean => d.missing.length === 0 && d.modeChanged.length === 0 && d.linkChanged.length === 0 && d.modified.length + d.extra.length > 0;

export function hostSupported(host: HostFacts = { platform: process.platform, arch: process.arch }): boolean {
    return host.platform === 'darwin' && host.arch === 'arm64';
}

/**
 * `quick` (every time MIX-FPGA opens): the files exist, have the recorded size, permissions and links, and each
 * tool's main executable has the recorded hash. `full` (Verify, and after every install): every byte is hashed.
 */
export async function checkUnit(layout: ToolchainLayout, unit: ToolchainUnit, depth: CheckDepth): Promise<UnitCheck> {
    const path = layout.unit(unit.path);
    if (!(await lstat(path).then(() => true, () => false))) return { unit, state: 'missing' };
    try {
        const full = depth === 'full';
        const actual = await inventoryTree(path, { hash: full });
        const hashPaths = executablePaths(unit);
        const checked = full
            ? actual
            : { ...actual, files: await Promise.all(actual.files.map(async (f) => (hashPaths.has(f.path) ? { ...f, sha256: await sha256File(join(path, f.path)) } : f))) };
        const difference = compareTree(unit, checked, { quick: !full, hashPaths });
        if (treeIsIdentical(difference)) return { unit, state: 'ok' };
        return { unit, state: isModifiedOnly(difference) ? 'modified' : 'damaged', difference };
    } catch (err) {
        return { unit, state: 'damaged', difference: { missing: [], extra: [], modified: [err instanceof Error ? err.message : String(err)], modeChanged: [], linkChanged: [] } };
    }
}

export async function manifestFileMatches(layout: ToolchainLayout, expected: LoadedExpected): Promise<boolean> {
    return sha256File(layout.manifestFile).then((h) => h === expected.sha256, () => false);
}

export async function readMarker(layout: ToolchainLayout): Promise<CompleteMarker | undefined> {
    try {
        const m = JSON.parse(await readFile(layout.toolchainMarker, 'utf8')) as CompleteMarker;
        return m.schemaVersion === MARKER_SCHEMA ? m : undefined;
    } catch {
        return undefined;
    }
}

export const unitProblem = (c: UnitCheck): string => (c.state === 'missing' ? 'not installed' : c.difference ? describeDifference(c.difference) : 'damaged');

const PROGRESS: Record<string, string> = {
    ghdl: 'Installing VHDL tools…',
    yosys: 'Installing VHDL tools…',
    openfpgaloader: 'Installing the programmer…',
    lima: 'Preparing the FPGA engine…',
};

async function freeBytesOf(path: string): Promise<number> {
    let dir = path;
    while (!(await lstat(dir).then(() => true, () => false))) {
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
}

async function removeTree(path: string): Promise<void> {
    await makeWritable(path).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
}

const fail = (code: string, message: string): SetupStepResult => ({ ok: false, code, message });
const gb = (n: number): string => `${(n / 1e9).toFixed(1)} GB`;

/**
 * Installs or repairs MIX-FPGA Toolchain 1.0 for macOS under `<root>/toolchains/1.0/macos-arm64`.
 *
 *  - Everything is first copied into `toolchains/.staging/<id>/` and verified byte for byte against the manifest.
 *  - A whole install appears with one rename; a repair swaps single units. A half-finished staging area is never used.
 *  - The folder is read-only afterwards, verified again in place, and only then is the completion marker written.
 *  - Running it again on a good install changes nothing; running it after any interruption continues from what is there.
 *  - Nothing outside this MIX-FPGA root is touched (in particular not NexysVHDL Toolchain 1.0).
 */
export async function installToolchain<L extends ToolchainLayout = RuntimeLayout>(ctx: ToolchainContext<L>, request: Pick<InstallRequest, 'signal' | 'progress' | 'repairModified'>): Promise<SetupStepResult> {
    const { layout, expected, payload } = ctx;
    const hooks = ctx.hooks ?? {};
    const cancelled = (): boolean => request.signal?.aborted === true;
    if (isInsideForeignProduct(layout.root)) return fail('FOREIGN_PRODUCT_PATH', 'MIX-FPGA will not install inside another product\'s folder.');
    const want = ctx.target ?? { version: TOOLCHAIN_VERSION, target: TOOLCHAIN_TARGET, supported: hostSupported, unsupportedMessage: 'MIX-FPGA Toolchain 1.0 needs a Mac with Apple silicon.' };
    if (!want.supported(ctx.host)) return fail('UNSUPPORTED_HOST', want.unsupportedMessage);
    if (expected.toolchain.toolchainVersion !== want.version || expected.toolchain.target !== want.target) {
        return fail('MANIFEST_MISMATCH', `The toolchain manifest is for ${expected.toolchain.toolchainVersion} ${expected.toolchain.target}, not ${want.version} ${want.target}.`);
    }

    const opId = randomBytes(5).toString('hex');
    const stage = join(layout.toolchainStaging, opId);
    try {
        // A previous run that died leaves staging folders behind; they are never trusted, only removed.
        await mkdir(layout.toolchainStaging, { recursive: true });
        for (const leftover of await readdir(layout.toolchainStaging)) await removeTree(join(layout.toolchainStaging, leftover));

        request.progress({ message: 'Checking the installed tools…' });
        const checks = await Promise.all(expected.toolchain.units.map((u) => checkUnit(layout, u, 'full')));
        const manifestOk = await manifestFileMatches(layout, expected);
        const versionDirExists = await lstat(layout.toolchainDir).then((s) => s.isDirectory(), () => false);
        // A unit the user modified (present, usable) is replaced only when the user chose Repair; installing something else never touches it.
        const restoreModified = request.repairModified === true;
        const need = checks.filter((c) => c.state === 'missing' || c.state === 'damaged' || (c.state === 'modified' && restoreModified)).map((c) => c.unit);
        const wholeInstall = !versionDirExists;
        const toCopy = wholeInstall ? [...expected.toolchain.units] : need;

        if (toCopy.length > 0) {
            for (const u of toCopy) if (!(await payload.has(u))) return fail('PAYLOAD_INCOMPLETE', `The installation source does not contain ${u.name}.`);
            const required = Math.ceil(toCopy.reduce((n, u) => n + u.bytes, 0) * 1.1) + 64e6;
            const free = await (ctx.freeBytes ?? freeBytesOf)(layout.root);
            if (free < required) return fail('INSUFFICIENT_DISK', `MIX-FPGA needs about ${gb(required)} free to install its tools; only ${gb(free)} is available.`);

            // 1. Stage and verify every unit before anything visible changes.
            const tree = join(stage, 'tree');
            await mkdir(tree, { recursive: true });
            for (const u of toCopy) {
                if (cancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true });
                request.progress({ message: PROGRESS[u.id] ?? 'Verifying installation…' });
                await payload.materialize(u, join(tree, u.path), request.signal);
                const diff = compareTree(u, await inventoryTree(join(tree, u.path)));
                if (!treeIsIdentical(diff)) return fail('PAYLOAD_VERIFY_FAILED', `${u.name} from the installation source does not match the validated version (${describeDifference(diff)}).`);
                await hooks.afterUnitStaged?.(u.id);
            }
            if (wholeInstall || !manifestOk) await writeFile(join(tree, 'manifest.json'), expected.text, 'utf8');

            // 2. Make it visible: one rename for a whole install, one rename per unit for a repair.
            if (cancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true });
            await hooks.beforeActivate?.();
            if (wholeInstall) {
                await mkdir(dirname(layout.toolchainDir), { recursive: true });
                await rename(tree, layout.toolchainDir);
            } else {
                await chmod(layout.toolchainDir, 0o755);
                try {
                    for (const u of toCopy) {
                        const target = layout.unit(u.path);
                        if (await lstat(target).then(() => true, () => false)) {
                            await makeWritable(target); // moving a folder to another parent needs write access to the folder itself
                            await rename(target, join(stage, `old-${u.id}`));
                        }
                        await rename(join(tree, u.path), target);
                    }
                    if (!manifestOk) {
                        await rm(layout.manifestFile, { force: true });
                        await rename(join(tree, 'manifest.json'), layout.manifestFile);
                    }
                } finally {
                    await chmod(layout.toolchainDir, 0o755);
                }
            }
            await hooks.afterActivate?.();
            if (wholeInstall) await makeReadOnly(layout.toolchainDir);
            else {
                // Seal only what was copied: a unit the user modified keeps the permissions the user gave it.
                for (const u of toCopy) await makeReadOnly(layout.unit(u.path));
                if (!manifestOk) await chmod(layout.manifestFile, 0o444);
                await chmod(layout.toolchainDir, 0o555);
            }
        }

        // 3. Prove the installed folder, then and only then mark the install complete.
        request.progress({ message: 'Verifying installation…' });
        const after = await Promise.all(expected.toolchain.units.map((u) => checkUnit(layout, u, 'full')));
        // A modified unit that was not restored stays as the user left it; everything else must verify.
        const bad = after.filter((c) => c.state !== 'ok' && !(c.state === 'modified' && !toCopy.some((u) => u.id === c.unit.id)));
        if (bad.length > 0 || !(await manifestFileMatches(layout, expected))) {
            return fail('POST_VERIFY_FAILED', `After installing, ${bad.map((c) => `${c.unit.name} (${unitProblem(c)})`).join(', ') || 'the manifest'} did not verify.`);
        }
        await hooks.beforeMarker?.();
        await mkdir(layout.stateDir, { recursive: true });
        const marker: CompleteMarker = {
            schemaVersion: MARKER_SCHEMA,
            product: 'MIX-FPGA',
            toolchainVersion: expected.toolchain.toolchainVersion,
            target: expected.toolchain.target,
            manifestSha256: expected.sha256,
            installedAt: (ctx.now ?? (() => new Date()))().toISOString(),
            source: payload.describe(),
            units: expected.toolchain.units.map((u) => ({ id: u.id, treeSha256: u.treeSha256 })),
        };
        await writeFileAtomic(layout.toolchainMarker, `${JSON.stringify(marker, null, 2)}\n`);
        await removeTree(stage);
        await rm(layout.toolchainStaging, { recursive: true, force: true }).catch(() => undefined);
        return { ok: true, detail: toCopy.length === 0 ? 'already installed' : `installed ${toCopy.map((u) => u.id).join(', ')} (${gb(totalBytes({ ...expected.toolchain, units: toCopy }))})` };
    } catch (err) {
        if (err instanceof SimulatedCrash) throw err;
        await removeTree(stage).catch(() => undefined);
        if ((err as { cancelled?: boolean }).cancelled) return fail('CANCELLED', 'Installation was cancelled.');
        return fail('INSTALL_FAILED', err instanceof Error ? err.message : String(err));
    }
}
