import type { Project } from '../../core';
import { canonicalBitstreamPath, loadCanonicalBitstream, workspacePaths } from '../../runtime/bitstream';
import { type CliContext, programmingFor } from '../context';
import { EXIT, type ExitCode, type Output, printDiagnostics, STATUS_LABEL, statusExit } from '../output';

export { canonicalBitstreamPath };

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
    const loaded = await loadCanonicalBitstream(project);
    if (!loaded) {
        out.line(`No bitstream found at ${canonicalBitstreamPath(project)}. Run "nexysvhdl build" first.`);
        return EXIT.failed;
    }
    const { modifiedMs: _modified, ...canonical } = loaded;

    const result = await service.program(canonical, board, workspacePaths(project).program, serialNumber !== undefined ? { serialNumber } : {});
    out.line(`Program: ${STATUS_LABEL[result.status]}`);
    if (result.target) out.line(`  target: ${result.target.productName ?? '?'} (serial ${result.target.serialNumber ?? '?'})`);
    if (result.artifact) out.line(`  file:   ${result.artifact.path} (${result.artifact.transformation})`);
    printDiagnostics(out, result.diagnostics);
    return statusExit(result.status);
}
