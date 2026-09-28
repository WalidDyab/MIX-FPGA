import {
    ALL_TOOL_IDS,
    type DetectedTool,
    evaluateToolchain,
    packageVersion,
    type Project,
    selectManifest,
    ToolDetector,
    toolEnvVar,
    type ToolId,
} from '../../core';
import { type CliContext, providersFor, toolLocatorFor } from '../context';
import { EXIT, type ExitCode, type Output } from '../output';

const TOOL_LABEL: Record<ToolId, string> = {
    ghdl: 'GHDL',
    apio: 'Apio',
    openxc7: 'openXC7',
    yosys: 'Yosys',
    'nextpnr-xilinx': 'nextpnr-xilinx',
    programmer: 'Programmer',
};

function detectedText(d: DetectedTool | undefined): string {
    if (!d) return 'not checked';
    if (!d.found) return `not found (${d.method})`;
    return `${d.version ?? 'version unknown'}  [${d.method}]`;
}

/** Environment and configuration report. Never requires hardware. */
export async function doctor(ctx: CliContext, out: Output, project?: Project): Promise<ExitCode> {
    out.line('NexysVHDL Doctor');
    out.line(`  version: ${packageVersion()}`);
    out.line();
    out.line('Host:');
    out.line(`  platform: ${ctx.host.platform}`);
    out.line(`  arch:     ${ctx.host.arch}`);
    out.line(`  node:     ${ctx.host.nodeVersion}`);
    out.line(`  adapter:  ${ctx.platform.displayName} — ${ctx.platform.status}`);
    out.line();

    out.line('Board support:');
    for (const b of ctx.boards.all()) out.line(`  ${b.id.padEnd(16)} ${b.name} (${b.fpga.device}, part ${b.fpga.part})`);
    for (const d of ctx.boardDiagnostics) out.line(`  problem: ${d.message}`);
    out.line();

    const explicit = project?.config.toolchain?.manifest;
    const manifest = selectManifest(ctx.manifests, ctx.host, explicit);
    out.line('Toolchain expectations:');
    out.line(
        manifest
            ? `  manifest: ${manifest.id} (${manifest.status})`
            : `  manifest: none for ${ctx.host.platform}/${ctx.host.arch}${explicit ? ` (requested "${explicit}" not found)` : ''}`,
    );

    const detector = new ToolDetector(toolLocatorFor(ctx, project), ctx.runner);
    const detected = await detector.detectAll(ALL_TOOL_IDS);
    const evaluation = evaluateToolchain(manifest, detected, ALL_TOOL_IDS);
    for (const t of evaluation.tools) {
        out.line(`  ${TOOL_LABEL[t.tool]}${t.expected?.name ? ` (${t.expected.name})` : ''}:`);
        out.line(`    expected: ${t.expected && t.expected.testedVersions.length ? t.expected.testedVersions.join(', ') : 'none recorded'}`);
        out.line(`    detected: ${detectedText(t.detected)}`);
        out.line(`    status:   ${t.status}`);
    }
    out.line(`  overall:  ${evaluation.overall}`);
    out.line();

    const providers = await providersFor(ctx, project);
    const programmer = ctx.platform.programmer;
    const availability = programmer ? await programmer.availability() : undefined;
    out.line('Providers:');
    out.line(`  VHDL (GHDL):             ${providers.located.ghdl ? `configured via ${providers.located.ghdl.method}` : `not configured (set ${toolEnvVar('ghdl')} or wait for platform discovery)`}`);
    out.line(`  Implementation (Apio):   ${providers.located.apio ? `configured via ${providers.located.apio.method}` : `not configured (set ${toolEnvVar('apio')} or wait for platform discovery)`}`);
    out.line(`  Programmer:              ${programmer ? `${programmer.displayName}: ${availability!.available ? 'available' : 'unavailable'} — ${availability!.detail}` : 'not configured'}`);

    return EXIT.ok;
}
