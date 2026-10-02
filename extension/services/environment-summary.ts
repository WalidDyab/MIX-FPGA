import { ALL_TOOL_IDS, type ToolCompatibility, type ToolId } from '../../core';
import { TOOL_LABELS } from '../../runtime/classroom';
import type { EnvironmentReport } from '../../runtime/environment';
import type { HardwareState } from './hardware-state';

export type EnvironmentLevel = 'ready' | 'warning' | 'setup-required';

export interface EnvironmentItem {
    readonly label: string;
    readonly ok: boolean;
    /** Found, but the version is untested or unknown. */
    readonly warn: boolean;
    readonly detail: string;
}

/** One line of the student setup overview (Show Environment, Getting Started). */
export interface SetupRow {
    readonly id: 'toolchain' | 'programmer' | 'board';
    readonly label: string;
    readonly state: 'ready' | 'setup-required' | 'problem' | 'not-connected' | 'not-checked';
    /** e.g. `Ready`, `Setup Required`, `Not Connected`. */
    readonly status: string;
    readonly detail?: string;
}

/** Installed-toolchain facts for Show Environment (classroom mode). */
export interface ToolchainSummary {
    /** `ready`, `not-installed`, `problem` (damaged, conflicting or unusable), `unsupported`. */
    readonly state: 'ready' | 'not-installed' | 'problem' | 'unsupported';
    readonly requiredVersion: string;
    readonly installedVersion?: string;
    readonly platform?: string;
    readonly target: string;
    readonly location?: string;
    readonly dataRoot?: string;
    readonly archiveName?: string;
}

export interface EnvironmentSummary {
    readonly level: EnvironmentLevel;
    /** `Ready`, `Ready (programming needs setup)`, `Setup required`, ... */
    readonly headline: string;
    /** One-line overall status, e.g. `Ready for design and build`. */
    readonly status: string;
    /** Student-level component list (Show Environment). */
    readonly items: readonly EnvironmentItem[];
    /** Extension / toolchain / programmer setup overview (board added by the caller's hardware state). */
    readonly setup: readonly SetupRow[];
    readonly toolchain?: ToolchainSummary;
    /** Programmer setup guidance when it is a system prerequisite (e.g. an official vendor installer). */
    readonly programmerGuide?: { readonly name: string; readonly url?: string; readonly instructions?: string };
    /** Every tool, for advanced details. */
    readonly tools: readonly ToolCompatibility[];
    readonly problems: readonly string[];
}

/** The tools a student sees; the full user-space tool list only for the bundled toolchain. */
const DISCOVERY_TOOLS: readonly ToolId[] = ['ghdl', 'apio', 'openxc7'];
const BUNDLED_TOOLS: readonly ToolId[] = ALL_TOOL_IDS.filter((t) => t !== 'programmer');

function toolchainSummary(report: EnvironmentReport): ToolchainSummary | undefined {
    const c = report.classroom;
    if (!c) return undefined;
    const want = c.requirement.targets[c.target];
    const base = {
        requiredVersion: c.requirement.bundleVersion,
        target: c.target,
        ...(c.dataRoot ? { dataRoot: c.dataRoot } : {}),
        ...(want?.archive ? { archiveName: want.archive } : {}),
    };
    if (!want || want.status !== 'validated' || !c.dataRoot) return { ...base, state: 'unsupported' };
    if (c.installed?.status === 'missing') return { ...base, state: 'not-installed' };
    const m = c.resolution?.manifest;
    return {
        ...base,
        state: c.toolchain && !c.diagnostics.some((d) => d.severity !== 'info') ? 'ready' : 'problem',
        ...(m ? { installedVersion: m.bundleVersion, platform: m.displayPlatform } : {}),
        ...(c.installed ? { location: c.installed.paths.versionDir } : {}),
    };
}

/** Summarizes the shared doctor/platform inspection for the sidebar. Pure. */
export function summarizeEnvironment(report: EnvironmentReport): EnvironmentSummary {
    const toolchain = toolchainSummary(report);
    const items: EnvironmentItem[] = [];
    for (const id of toolchain ? BUNDLED_TOOLS : DISCOVERY_TOOLS) {
        const t = report.toolchain.tools.find((x) => x.tool === id);
        const found = t?.detected?.found === true;
        const version = t?.detected?.version;
        items.push({
            label: TOOL_LABELS[id],
            ok: found,
            warn: found && t!.status !== 'compatible',
            detail: found ? `${version ?? 'version unknown'}${t!.status === 'compatible' ? '' : ` (${t!.reason})`}` : (t?.reason ?? 'not checked'),
        });
    }
    const prog = report.programmer;
    const programmerReady = prog?.availability.available === true;
    const setupInfo = report.programmerSetup;
    const programmerLabel = setupInfo?.name ?? 'Programmer';
    items.push({ label: programmerLabel, ok: programmerReady, warn: false, detail: prog ? `${prog.displayName}: ${prog.availability.detail}` : 'not configured on this platform' });

    const problems: string[] = [];
    if (toolchain && toolchain.state === 'not-installed') problems.push(`The NexysVHDL FPGA toolchain ${toolchain.requiredVersion} is not installed: Check, Simulate and Build are unavailable until it is installed.`);
    else {
        if (!report.providers.ghdl) problems.push('The VHDL tools (GHDL) are not available: Check, Simulate and Build are unavailable.');
        if (!report.providers.apio) problems.push('The FPGA build tools are not available: Build and the RTL Schematic are unavailable.');
    }
    if (!programmerReady) problems.push(setupInfo && !setupInfo.bundled ? `${programmerLabel} is not set up: Program is unavailable (everything else works).` : 'The board programmer is not available: Program is unavailable.');
    problems.push(...report.diagnostics.filter((d) => d.severity !== 'info' && d.code !== 'TOOLCHAIN_NOT_INSTALLED').map((d) => d.message));

    // Without GHDL/Apio nothing can be built; without a programmer everything but Program works.
    const toolItems = items.slice(0, items.length - 1);
    const missing = !report.providers.ghdl || !report.providers.apio || toolItems.some((i) => !i.ok);
    const untested = items.some((i) => i.warn);
    const level: EnvironmentLevel = missing ? 'setup-required' : untested || !programmerReady || problems.length > 0 ? 'warning' : 'ready';
    const headline = missing ? 'Setup required' : !programmerReady ? 'Ready (programming needs setup)' : untested ? 'Ready (untested tool versions)' : level === 'warning' ? 'Ready (see details)' : 'Ready';
    const status = missing
        ? toolchain?.state === 'not-installed'
            ? 'Install the FPGA toolchain to check, simulate and build'
            : 'Setup required: see the problems below'
        : programmerReady
          ? 'Ready for design, build and programming'
          : 'Ready for design and build';

    const setup: SetupRow[] = [];
    if (toolchain) {
        const tcRow: Record<ToolchainSummary['state'], Pick<SetupRow, 'state' | 'status'>> = {
            ready: { state: 'ready', status: 'Ready' },
            'not-installed': { state: 'setup-required', status: 'Not Installed' },
            problem: { state: 'problem', status: missing ? 'Problem' : 'Ready (see notes)' },
            unsupported: { state: 'problem', status: 'Not Available' },
        };
        setup.push({
            id: 'toolchain',
            label: 'Bundled FPGA Toolchain',
            ...tcRow[toolchain.state],
            detail: toolchain.installedVersion ? `${toolchain.installedVersion}${toolchain.platform ? ` (${toolchain.platform})` : ''}` : `version ${toolchain.requiredVersion} required`,
        });
    }
    if (setupInfo && !setupInfo.bundled) {
        setup.push({ id: 'programmer', label: setupInfo.name, state: programmerReady ? 'ready' : 'setup-required', status: programmerReady ? 'Ready' : 'Setup Required', ...(prog ? { detail: prog.availability.detail } : {}) });
    } else if (setupInfo) {
        setup.push({ id: 'programmer', label: setupInfo.name, state: programmerReady ? 'ready' : 'problem', status: programmerReady ? 'Ready (bundled)' : 'Problem' });
    }

    return {
        level,
        headline,
        status,
        items,
        setup,
        ...(toolchain ? { toolchain } : {}),
        ...(setupInfo && !setupInfo.bundled ? { programmerGuide: { name: setupInfo.name, ...(setupInfo.guide ? { url: setupInfo.guide } : {}), ...(setupInfo.instructions ? { instructions: setupInfo.instructions } : {}) } } : {}),
        tools: report.toolchain.tools,
        problems,
    };
}

/** The board row: a missing board is not a setup problem (only Program needs it). */
export function boardRow(hardware: HardwareState): SetupRow {
    switch (hardware.status) {
        case 'one':
        case 'many':
            return { id: 'board', label: 'Board', state: 'ready', status: 'Connected', detail: hardware.boards.map((b) => `${b.productName ?? 'board'}${b.serialNumber ? ` (${b.serialNumber})` : ''}`).join(', ') };
        case 'none':
            return { id: 'board', label: 'Board', state: 'not-connected', status: 'Not Connected', detail: 'Connect the board by USB and turn it on to program it.' };
        case 'unavailable':
            return { id: 'board', label: 'Board', state: 'not-checked', status: 'Not Checked', detail: 'Board detection needs the programmer support.' };
        case 'detecting':
            return { id: 'board', label: 'Board', state: 'not-checked', status: 'Checking…' };
        case 'unknown':
            return { id: 'board', label: 'Board', state: 'not-checked', status: 'Not Checked' };
    }
}
