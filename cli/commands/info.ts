import { findResource, generateXdc, type Project, validateProject } from '../../core';
import type { CliContext } from '../context';
import { EXIT, type ExitCode, type Output, printDiagnostics } from '../output';

export function boards(ctx: CliContext, out: Output): ExitCode {
    for (const b of ctx.boards.all()) {
        out.line(`${b.id} — ${b.name}`);
        out.line(`  FPGA: ${b.fpga.device} (part ${b.fpga.part})`);
        out.line('  Resources:');
        for (const r of b.resources) {
            const clock = r.clock ? `, ${r.clock.frequencyHz / 1e6} MHz` : '';
            out.line(`    ${r.id.padEnd(10)} ${r.kind.padEnd(7)} pin ${r.pins.join(',')} ${r.ioStandard}${clock}`);
        }
    }
    printDiagnostics(out, ctx.boardDiagnostics);
    return ctx.boards.ids().length > 0 ? EXIT.ok : EXIT.failed;
}

export async function projectInfo(ctx: CliContext, out: Output, project: Project): Promise<ExitCode> {
    const c = project.config;
    const validation = await validateProject(project, ctx.boards);
    const board = ctx.boards.get(c.board);

    out.line(`Project: ${c.name}`);
    out.line(`  file:     ${project.file}`);
    out.line(`  board:    ${c.board}${board ? ` (${board.name})` : ' (unsupported)'}`);
    out.line(`  language: VHDL-${c.standard}`);
    out.line(`  top:      ${c.top}`);
    out.line(`  sources:  ${c.sources?.join(', ') || '(none)'}`);
    if (c.simulation) {
        out.line(`  sim:      ${c.simulation.sources.join(', ') || '(none)'}${c.simulation.testbench ? `  testbench: ${c.simulation.testbench}` : ''}`);
    }
    out.line('  pins:');
    for (const [port, id] of Object.entries(c.pins ?? {})) {
        const r = board ? findResource(board, id) : undefined;
        out.line(`    ${port.padEnd(12)} -> ${id}${r ? ` (pin ${r.pins.join(',')}${r.clock ? `, ${r.clock.frequencyHz / 1e6} MHz` : ''})` : ' (unknown resource)'}`);
    }
    out.line();
    out.line(`Validation: ${validation.valid ? 'OK' : 'FAILED'}`);
    printDiagnostics(out, validation.diagnostics, true);

    if (validation.valid && board) {
        out.line();
        out.line('Generated constraints (preview):');
        for (const l of generateXdc(board, c.pins).xdc.trimEnd().split('\n')) out.line(`  ${l}`);
    }
    return validation.valid ? EXIT.ok : EXIT.usage;
}
