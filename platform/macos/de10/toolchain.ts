import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ManifestComponent {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly ownership: 'owned' | 'external';
    readonly supplier?: string;
    readonly license?: string;
    readonly executable?: string;
    readonly sha256?: string;
}

export interface ToolchainManifest {
    readonly schemaVersion: number;
    readonly product: string;
    readonly target: string;
    readonly components: readonly ManifestComponent[];
}

export function manifestPath(repoRoot: string): string {
    return join(repoRoot, 'toolchains', 'mixfpga', 'macos-arm64.json');
}

export async function loadManifest(repoRoot: string): Promise<ToolchainManifest | undefined> {
    try {
        const m = JSON.parse(await readFile(manifestPath(repoRoot), 'utf8')) as ToolchainManifest;
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
        else out.push({ component: c, state: (await sha256(path)) === c.sha256 ? 'ok' : 'modified' });
    }
    return out;
}
