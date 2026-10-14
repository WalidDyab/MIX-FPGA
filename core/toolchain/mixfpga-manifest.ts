import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export interface ManifestComponent {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly ownership: 'owned' | 'external';
    readonly supplier?: string;
    readonly license?: string;
    /** Upstream project or release the component came from. */
    readonly source?: string;
    readonly executable?: string;
    readonly sha256?: string;
    /** Folder of the component under the toolchain root, when it is more than one file. */
    readonly dir?: string;
    readonly treeSha256?: string;
}

export interface ToolchainManifest {
    readonly schemaVersion: number;
    readonly product: string;
    readonly target: string;
    readonly components: readonly ManifestComponent[];
}

/** Target keys of the committed manifests (toolchains/mixfpga/<target>.json). */
export type ManifestTarget = 'macos-arm64' | 'windows-x64';

export function manifestPath(repoRoot: string, target: ManifestTarget = 'macos-arm64'): string {
    return join(repoRoot, 'toolchains', 'mixfpga', `${target}.json`);
}

export async function loadManifest(repoRoot: string, target: ManifestTarget = 'macos-arm64'): Promise<ToolchainManifest | undefined> {
    try {
        const m = JSON.parse(await readFile(manifestPath(repoRoot, target), 'utf8')) as ToolchainManifest;
        return Array.isArray(m.components) ? m : undefined;
    } catch {
        return undefined;
    }
}

const sha256 = (path: string): Promise<string> =>
    new Promise((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });

async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else if (e.isFile()) out.push(p);
    }
    return out;
}

/** Same definition as scripts/mixfpga/toolchain.mjs: sorted relative paths with the hash of each file. */
export async function treeSha256(dir: string): Promise<string> {
    const files = (await walk(dir)).map((p) => relative(dir, p).split(sep).join('/')).sort();
    const h = createHash('sha256');
    for (const rel of files) h.update(`${await sha256(join(dir, ...rel.split('/')))}  ${rel}\n`);
    return h.digest('hex');
}

export type ComponentIntegrity = 'ok' | 'missing' | 'modified' | 'unrecorded';

/** Hash check of every component MIX-FPGA owns, against the committed manifest. Reads files; runs nothing. */
export async function verifyOwnedComponents(manifest: ToolchainManifest, toolchainRoot: string): Promise<{ component: ManifestComponent; state: ComponentIntegrity }[]> {
    const out: { component: ManifestComponent; state: ComponentIntegrity }[] = [];
    for (const c of manifest.components) {
        if (c.ownership !== 'owned' || !c.executable) continue;
        const path = join(toolchainRoot, c.executable);
        const present = await stat(path).then((s) => s.isFile(), () => false);
        if (!present) out.push({ component: c, state: 'missing' });
        else if (!c.sha256) out.push({ component: c, state: 'unrecorded' });
        else if ((await sha256(path)) !== c.sha256) out.push({ component: c, state: 'modified' });
        // A multi-file component (the Windows tools with their DLLs and data) is checked as a whole folder.
        else if (c.dir && c.treeSha256) out.push({ component: c, state: (await treeSha256(join(toolchainRoot, c.dir)).catch(() => '')) === c.treeSha256 ? 'ok' : 'modified' });
        else out.push({ component: c, state: 'ok' });
    }
    return out;
}
