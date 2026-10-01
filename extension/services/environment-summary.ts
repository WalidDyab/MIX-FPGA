import type { ToolCompatibility, ToolId } from '../../core';
import type { EnvironmentReport } from '../../runtime/environment';

export type EnvironmentLevel = 'ready' | 'warning' | 'setup-required';

export interface EnvironmentItem {
    readonly label: string;
    readonly ok: boolean;
    /** Found, but the version is untested or unknown. */
    readonly warn: boolean;
    readonly detail: string;
}

export interface EnvironmentSummary {
    readonly level: EnvironmentLevel;
    /** `Ready`, `Ready (untested tool versions)`, `Setup required`. */
    readonly headline: string;
    /** Student-level component list (Show Environment). */
    readonly items: readonly EnvironmentItem[];
    /** Every tool, for advanced details. */
    readonly tools: readonly ToolCompatibility[];
    readonly problems: readonly string[];
}

const STUDENT_TOOLS: ReadonlyArray<readonly [ToolId, string]> = [
    ['ghdl', 'GHDL'],
    ['apio', 'Apio'],
    ['openxc7', 'openXC7'],
];

/** Summarizes the shared doctor/platform inspection for the sidebar. Pure. */
export function summarizeEnvironment(report: EnvironmentReport): EnvironmentSummary {
    const items: EnvironmentItem[] = [];
    for (const [id, label] of STUDENT_TOOLS) {
        const t = report.toolchain.tools.find((x) => x.tool === id);
        const found = t?.detected?.found === true;
        const version = t?.detected?.version;
        items.push({
            label,
            ok: found,
            warn: found && t!.status !== 'compatible',
            detail: found ? `${version ?? 'version unknown'}${t!.status === 'compatible' ? '' : ` (${t!.reason})`}` : (t?.reason ?? 'not checked'),
        });
    }
    const prog = report.programmer;
    items.push({
        label: 'Programmer',
        ok: prog?.availability.available === true,
        warn: false,
        detail: prog ? `${prog.displayName}: ${prog.availability.detail}` : 'not configured on this platform',
    });

    const problems: string[] = [];
    if (!report.providers.ghdl) problems.push('The VHDL tools (GHDL) were not found: Check, Simulate and Build are unavailable.');
    if (!report.providers.apio) problems.push('The FPGA build tools (Apio/openXC7) were not found: Build is unavailable.');
    if (!prog?.availability.available) problems.push('The board programmer is not available: Program is unavailable.');
    problems.push(...report.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.message));

    // Without GHDL/Apio/openXC7 nothing can be built; without a programmer everything but Program works.
    const missing = !report.providers.ghdl || !report.providers.apio || items.slice(0, STUDENT_TOOLS.length).some((i) => !i.ok);
    const noProgrammer = !prog?.availability.available;
    const untested = items.some((i) => i.warn);
    const level: EnvironmentLevel = missing ? 'setup-required' : untested || noProgrammer || problems.length > 0 ? 'warning' : 'ready';
    const headline = missing ? 'Setup required' : noProgrammer ? 'Ready (no programmer)' : untested ? 'Ready (untested tool versions)' : level === 'warning' ? 'Ready (see details)' : 'Ready';
    return { level, headline, items, tools: report.toolchain.tools, problems };
}
