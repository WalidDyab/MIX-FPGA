import { type DetectedTool, packageVersion, type Project, toolEnvVar, type ToolId } from '../../core';
import { inspectEnvironment } from '../../runtime/environment';
import type { CliContext } from '../context';
import { EXIT, type ExitCode, formatDiagnostic, type Output } from '../output';

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

    const env = await inspectEnvironment(ctx, project);
    const { manifest, requestedManifest: explicit } = env;
    out.line('Toolchain expectations:');
    out.line(
        manifest
            ? `  manifest: ${manifest.id} (${manifest.status})`
            : `  manifest: none for ${ctx.host.platform}/${ctx.host.arch}${explicit ? ` (requested "${explicit}" not found)` : ''}`,
    );
    for (const t of env.toolchain.tools) {
        out.line(`  ${TOOL_LABEL[t.tool]}${t.expected?.name ? ` (${t.expected.name})` : ''}:`);
        out.line(`    expected: ${t.expected && t.expected.testedVersions.length ? t.expected.testedVersions.join(', ') : 'none recorded'}`);
        out.line(`    detected: ${detectedText(t.detected)}`);
        out.line(`    status:   ${t.status}`);
    }
    out.line(`  overall:  ${env.toolchain.overall}`);
    for (const d of env.diagnostics) out.line(`  ${formatDiagnostic(d).trim()}`);
    out.line();

    const { ghdl, apio } = env.providers;
    const programmer = env.programmer;
    out.line('Providers:');
    out.line(`  VHDL (GHDL):             ${ghdl ? `configured via ${ghdl.method}` : `not configured (set ${toolEnvVar('ghdl')} or install it where the platform adapter looks)`}`);
    out.line(`  Implementation (Apio):   ${apio ? `configured via ${apio.method}` : `not configured (set ${toolEnvVar('apio')} or install it where the platform adapter looks)`}`);
    out.line(`  Programmer:              ${programmer ? `${programmer.displayName}: ${programmer.availability.available ? 'available' : 'unavailable'} — ${programmer.availability.detail}` : 'not configured'}`);

    return EXIT.ok;
}
