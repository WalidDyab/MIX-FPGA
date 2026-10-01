import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { apioBitstreamPath, type BuildArtifact, BuildWorkspace, type Project, sha256File, WORKSPACE_DIR_NAME } from '../core';

/** The project's build workspace paths (default location, `<project>/.nexysvhdl`). */
export function workspacePaths(project: Project) {
    return BuildWorkspace.pathsFor(join(project.root, WORKSPACE_DIR_NAME));
}

/** Location of the canonical bitstream produced by the last build. */
export function canonicalBitstreamPath(project: Project): string {
    return apioBitstreamPath(workspacePaths(project).impl);
}

/** The canonical bitstream as a BuildArtifact, or undefined if no build has produced one. */
export async function loadCanonicalBitstream(project: Project): Promise<(BuildArtifact & { readonly modifiedMs: number }) | undefined> {
    const path = canonicalBitstreamPath(project);
    try {
        const s = await stat(path);
        if (!s.isFile()) return undefined;
        return { kind: 'bitstream', path, canonical: true, sizeBytes: s.size, sha256: await sha256File(path), modifiedMs: s.mtimeMs };
    } catch {
        return undefined;
    }
}
