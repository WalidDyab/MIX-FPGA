import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { apioBitstreamPath, type BuildArtifact, BuildWorkspace, type Project, sha256File, WORKSPACE_DIR_NAME } from '../../core';
import { type CliContext, programmingFor } from '../context';
import { EXIT, type ExitCode, type Output, printDiagnostics, STATUS_LABEL, statusExit } from '../output';

/** Location of the canonical bitstream produced by the last `build`. */
export function canonicalBitstreamPath(project: Project): string {
    return apioBitstreamPath(BuildWorkspace.pathsFor(join(project.root, WORKSPACE_DIR_NAME)).impl);
}

export async function program(ctx: CliContext, out: Output, project: Project, serialNumber?: string): Promise<ExitCode> {
    const service = programmingFor(ctx);
    if (!service.configured) {
        out.line('Programming provider is not configured for this platform.');
        out.line(`  (${ctx.platform.displayName} adapter: ${ctx.platform.status})`);
        return EXIT.notConfigured;
    }

    const board = ctx.boards.get(project.config.board);
    if (!board) {
        out.line(`Board "${project.config.board}" is not supported.`);
        return EXIT.usage;
    }
    const path = canonicalBitstreamPath(project);
    let canonical: BuildArtifact;
    try {
        const s = await stat(path);
        canonical = { kind: 'bitstream', path, canonical: true, sizeBytes: s.size, sha256: await sha256File(path) };
    } catch {
        out.line(`No bitstream found at ${path}. Run "nexysvhdl build" first.`);
        return EXIT.failed;
    }

    const programDir = BuildWorkspace.pathsFor(join(project.root, WORKSPACE_DIR_NAME)).program;
    const result = await service.program(canonical, board, programDir, serialNumber !== undefined ? { serialNumber } : {});
    out.line(`Program: ${STATUS_LABEL[result.status]}`);
    if (result.target) out.line(`  target: ${result.target.productName ?? '?'} (serial ${result.target.serialNumber ?? '?'})`);
    if (result.artifact) out.line(`  file:   ${result.artifact.path} (${result.artifact.transformation})`);
    printDiagnostics(out, result.diagnostics);
    return statusExit(result.status);
}
