import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    type Diagnostic,
    errorDiag,
    type InstallResult,
    installToolchainArchive,
    type ToolchainRequirement,
    type ToolId,
    validateRequirement,
    verifyInstalledToolchain,
} from '../core';
import type { RuntimeContext } from './context';

/** Where a NexysVHDL package records the toolchain version it requires. */
export const REQUIREMENT_FILE = ['toolchains', 'bundle', 'requirement.json'] as const;

/** Student-facing tool names (front ends never spell tool names themselves). */
export const TOOL_LABELS: Readonly<Record<ToolId, string>> = {
    ghdl: 'GHDL',
    apio: 'Apio',
    openxc7: 'openXC7',
    yosys: 'Yosys',
    'nextpnr-xilinx': 'nextpnr-xilinx',
    programmer: 'Programmer',
};

/** Reads and validates the toolchain requirement shipped with this NexysVHDL package. */
export function loadRequirement(packageRoot: string): { requirement?: ToolchainRequirement; diagnostics: Diagnostic[] } {
    const file = join(packageRoot, ...REQUIREMENT_FILE);
    try {
        const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
        const problems = validateRequirement(data);
        if (problems.length) return { diagnostics: problems.map((p) => errorDiag('toolchain', 'TOOLCHAIN_REQUIREMENT_INVALID', `${file}: ${p}`)) };
        return { requirement: data as ToolchainRequirement, diagnostics: [] };
    } catch (err) {
        return { diagnostics: [errorDiag('toolchain', 'TOOLCHAIN_REQUIREMENT_INVALID', `${file}: ${(err as Error).message}`)] };
    }
}

/** Expected archive file name for this host (from the requirement), for the install dialog. */
export function expectedArchiveName(ctx: RuntimeContext): string | undefined {
    const c = ctx.classroom;
    return c ? (c.requirement.targets[c.target]?.archive ?? `nexysvhdl-toolchain-${c.requirement.bundleVersion}-${c.target}.tar.gz`) : undefined;
}

/** Installs a toolchain archive into this user's NexysVHDL store (classroom mode only). */
export async function installClassroomToolchain(
    ctx: RuntimeContext,
    archive: string,
    onProgress?: (fraction: number | undefined, message: string) => void,
    signal?: AbortSignal,
    archiveBytes?: number,
): Promise<InstallResult | { readonly status: 'failed'; readonly diagnostics: readonly Diagnostic[] }> {
    const c = ctx.classroom;
    if (!c?.dataRoot) return { status: 'failed', diagnostics: c?.diagnostics.length ? c.diagnostics : [errorDiag('toolchain', 'TOOLCHAIN_NOT_CLASSROOM', 'Toolchain installation is only available in classroom mode.')] };
    return installToolchainArchive({
        archive,
        dataRoot: c.dataRoot,
        target: c.target,
        requirement: c.requirement,
        ...(signal ? { signal } : {}),
        onProgress: (p) => {
            if (p.phase === 'publishing') onProgress?.(1, 'Finishing…');
            else onProgress?.(archiveBytes ? Math.min(1, p.compressedBytes / archiveBytes) : undefined, `${p.files.toLocaleString('en-US')} files`);
        },
    });
}

/** Re-hashes every installed file and compares with the validated content hash. */
export async function verifyClassroomToolchain(ctx: RuntimeContext, onFile?: (path: string) => void) {
    const c = ctx.classroom;
    if (!c?.dataRoot) return { ok: false, diagnostics: [errorDiag('toolchain', 'TOOLCHAIN_NOT_CLASSROOM', 'Not in classroom mode.')] };
    return verifyInstalledToolchain(c.dataRoot, c.target, c.requirement, onFile);
}
