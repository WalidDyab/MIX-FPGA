import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Diagnostic, errorDiag } from '../results/diagnostic';
import { ALL_TOOL_IDS, type ToolchainManifest } from './types';

function validateManifest(data: unknown, origin: string): Diagnostic[] {
    const m = data as Partial<ToolchainManifest> | null;
    const problems: Diagnostic[] = [];
    const fail = (message: string) => problems.push(errorDiag('toolchain', 'TOOLCHAIN_MANIFEST_INVALID', `${origin}: ${message}`));
    if (typeof m !== 'object' || m === null) return (fail('not a JSON object'), problems);
    if (m.schemaVersion !== 1) fail(`unsupported schemaVersion ${String(m.schemaVersion)}`);
    if (typeof m.id !== 'string' || m.id === '') fail('missing "id"');
    if (!m.host || typeof m.host.platform !== 'string' || typeof m.host.arch !== 'string') fail('missing "host.platform"/"host.arch"');
    if (!Array.isArray(m.tools)) return (fail('missing "tools" array'), problems);
    for (const t of m.tools) {
        if (!ALL_TOOL_IDS.includes(t.tool)) fail(`unknown tool id "${String(t.tool)}"`);
        if (!Array.isArray(t.testedVersions)) fail(`tool "${String(t.tool)}" needs a "testedVersions" array`);
    }
    return problems;
}

/** Loads every *.json manifest in a directory. */
export async function loadManifests(dir: string): Promise<{ manifests: ToolchainManifest[]; diagnostics: Diagnostic[] }> {
    const manifests: ToolchainManifest[] = [];
    const diagnostics: Diagnostic[] = [];
    let files: string[];
    try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    } catch (err) {
        return { manifests, diagnostics: [errorDiag('toolchain', 'TOOLCHAIN_DIR_UNREADABLE', `cannot read ${dir}: ${String(err)}`)] };
    }
    for (const f of files) {
        const path = join(dir, f);
        try {
            const data: unknown = JSON.parse(await readFile(path, 'utf8'));
            const problems = validateManifest(data, path);
            if (problems.length) diagnostics.push(...problems);
            else manifests.push(data as ToolchainManifest);
        } catch (err) {
            diagnostics.push(errorDiag('toolchain', 'TOOLCHAIN_MANIFEST_INVALID', `${path}: ${String(err)}`));
        }
    }
    return { manifests, diagnostics };
}

/**
 * Picks the manifest for this host: an explicit id wins, otherwise the first
 * manifest whose host matches. Data-driven; no platform branches.
 */
export function selectManifest(
    manifests: readonly ToolchainManifest[],
    host: { platform: string; arch: string },
    explicitId?: string,
): ToolchainManifest | undefined {
    if (explicitId !== undefined) return manifests.find((m) => m.id === explicitId);
    return manifests.find((m) => m.host.platform === host.platform && m.host.arch === host.arch);
}
