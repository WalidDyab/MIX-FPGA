import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { TreeFile, TreeInventory, TreeLink } from '../../../core/install/tree';

/** One top-level entry of the installed toolchain folder: a tool, or support material (engine scripts, licences). */
export interface ToolchainUnit extends TreeInventory {
    readonly id: string;
    readonly kind: 'tool' | 'support';
    readonly name: string;
    readonly version?: string;
    /** Name of the entry inside `toolchains/<version>/<target>/`. */
    readonly path: string;
    /** Tools only: the main executable, relative to the unit; always content-hashed, even by quick checks. */
    readonly executable?: string;
    readonly license?: string;
    readonly source?: string;
    readonly treeSha256: string;
    readonly bytes: number;
}

/**
 * What MIX-FPGA Toolchain 1.0 for macOS is, exactly. Recorded from the validated tools by
 * `scripts/mixfpga/record-toolchain.mjs`, committed, and shipped inside the extension. The
 * installer copies nothing that is not listed here and accepts nothing that differs from it.
 */
export interface ExpectedToolchain {
    readonly schemaVersion: 1;
    readonly product: 'MIX-FPGA';
    readonly toolchainVersion: string;
    readonly target: string;
    readonly units: readonly ToolchainUnit[];
}

export interface LoadedExpected {
    readonly toolchain: ExpectedToolchain;
    /** Exact text of the manifest; the installed `manifest.json` is a byte-for-byte copy of it. */
    readonly text: string;
    readonly sha256: string;
}

export async function loadExpectedToolchain(file: string): Promise<LoadedExpected> {
    const text = await readFile(file, 'utf8');
    const t = JSON.parse(text) as ExpectedToolchain;
    if (t.schemaVersion !== 1 || t.product !== 'MIX-FPGA' || !Array.isArray(t.units) || t.units.length === 0) throw new Error(`${file} is not a MIX-FPGA toolchain manifest`);
    for (const u of t.units) {
        if (!u.id || !u.path || /[\\/]/.test(u.path) || u.path.startsWith('.')) throw new Error(`manifest unit "${u.id}" has an unsafe path`);
        for (const f of u.files as readonly TreeFile[]) if (f.path.split('/').includes('..') || f.path.startsWith('/')) throw new Error(`manifest unit "${u.id}" lists an unsafe file path`);
        for (const l of u.links as readonly TreeLink[]) if (l.path.split('/').includes('..') || l.path.startsWith('/')) throw new Error(`manifest unit "${u.id}" lists an unsafe link path`);
    }
    return { toolchain: t, text, sha256: createHash('sha256').update(text).digest('hex') };
}

export const toolUnits = (t: ExpectedToolchain): readonly ToolchainUnit[] => t.units.filter((u) => u.kind === 'tool');
export const totalBytes = (t: ExpectedToolchain): number => t.units.reduce((n, u) => n + u.bytes, 0);

/** Content-hashed paths during quick checks: each tool's main executable. */
export const executablePaths = (u: ToolchainUnit): ReadonlySet<string> => new Set(u.executable ? [u.executable] : []);
