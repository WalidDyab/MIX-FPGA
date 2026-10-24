import type { ComponentDefinition, ComponentId, Inspection } from '../../../core/install/model';
import { aggregate } from '../../../core/install/model';
import { toolUnits, type ToolchainUnit } from '../../shared/install/expected';
import { checkUnit, type CheckDepth, installToolchain, type HostFacts, manifestFileMatches, readMarker, type ToolchainContext, unitProblem } from '../../macos/install/toolchain-installer';
import { TOOLCHAIN_TARGET, TOOLCHAIN_VERSION, type WindowsRuntimeLayout } from './layout';

/** The toolchain MIX-FPGA installs for the DE10-Lite on Windows: Toolchain 1.0 for Windows x64 (GHDL, Yosys, support scripts, notices). */
export type WindowsToolchainContext = ToolchainContext<WindowsRuntimeLayout>;

export function windowsHostSupported(host: HostFacts = { platform: process.platform, arch: process.arch }): boolean {
    return host.platform === 'win32' && host.arch === 'x64';
}

/** Passed to the shared installer so it installs this toolchain, for this host. */
export const WINDOWS_TOOLCHAIN_TARGET = { version: TOOLCHAIN_VERSION, target: TOOLCHAIN_TARGET, supported: windowsHostSupported, unsupportedMessage: 'MIX-FPGA Toolchain 1.1 needs 64-bit Windows.' } as const;

const TOOL_LABEL: Record<string, string> = { ghdl: 'GHDL', yosys: 'Yosys' };

/**
 * The managed part of the Windows DE10-Lite setup: the two tools of MIX-FPGA Toolchain 1.0 and the toolchain as a whole (which also
 * covers the support scripts: the part check Quartus is asked, and the licence/notice files). `depth` is `quick` whenever MIX-FPGA
 * opens and `full` for Verify and Repair.
 */
export function windowsToolchainDefinitions(ctx: Omit<WindowsToolchainContext, 'target'>, depth: CheckDepth = 'quick'): ComponentDefinition[] {
    const full: WindowsToolchainContext = { ...ctx, target: WINDOWS_TOOLCHAIN_TARGET };
    const tools = toolUnits(ctx.expected.toolchain);
    const toolIds = tools.map((t) => t.id);
    const incompatibleHost: Inspection = { state: 'incompatible', ownership: 'managed', code: 'UNSUPPORTED_HOST', detail: WINDOWS_TOOLCHAIN_TARGET.unsupportedMessage };

    const member = (u: ToolchainUnit): ComponentDefinition => ({
        id: u.id,
        label: TOOL_LABEL[u.id] ?? u.name,
        async inspect() {
            if (!windowsHostSupported(ctx.host)) return incompatibleHost;
            const c = await checkUnit(ctx.layout, u, depth);
            if (c.state === 'ok') return { state: 'ready', ownership: 'managed', ...(u.version ? { version: u.version } : {}) };
            if (c.state === 'missing') return { state: 'not-installed', ownership: 'managed' };
            // Present with every file in place but changed content: the user modified it. Usable, not the verified configuration.
            if (c.state === 'modified') return { state: 'modified', ownership: 'managed', code: 'MODIFIED', detail: `${u.name}: ${unitProblem(c)}` };
            return { state: 'repairable', ownership: 'managed', code: 'HASH_MISMATCH', detail: `${u.name}: ${unitProblem(c)}` };
        },
    });

    const toolchain: ComponentDefinition = {
        id: 'toolchain',
        label: 'MIX-FPGA Toolchain',
        inspectAfter: toolIds,
        async inspect(deps) {
            const parts = toolIds.map((id) => deps.get(id)!);
            const a = aggregate(parts, 'managed');
            if (a.state !== 'ready' && a.state !== 'modified') return a;
            const support = await Promise.all(ctx.expected.toolchain.units.filter((u) => u.kind === 'support').map((u) => checkUnit(ctx.layout, u, depth)));
            const bad = support.find((c) => c.state === 'missing' || c.state === 'damaged');
            if (bad) return { state: 'repairable', ownership: 'managed', code: 'SUPPORT_FILES', detail: `${bad.unit.name}: ${unitProblem(bad)}` };
            const changedSupport = support.find((c) => c.state === 'modified');
            if (!(await manifestFileMatches(ctx.layout, ctx.expected))) return { state: 'repairable', ownership: 'managed', code: 'MANIFEST_MISMATCH', detail: 'the toolchain manifest is missing or changed' };
            const marker = await readMarker(ctx.layout);
            if (!marker) return { state: 'repairable', ownership: 'managed', code: 'NOT_COMPLETE', detail: 'the installation was not finished' };
            if (marker.manifestSha256 !== ctx.expected.sha256) return { state: 'repairable', ownership: 'managed', code: 'MARKER_MISMATCH', detail: 'the completion record is for a different toolchain' };
            // Modified but usable: a tool or support file differs from the release because the user changed it.
            if (a.state === 'modified' || changedSupport) return { state: 'modified', ownership: 'managed', code: 'MODIFIED', detail: a.state === 'modified' ? 'files of the installed tools were changed' : `${changedSupport!.unit.name}: ${unitProblem(changedSupport!)}`, version: ctx.expected.toolchain.toolchainVersion };
            return { state: 'ready', ownership: 'managed', version: ctx.expected.toolchain.toolchainVersion };
        },
        install: {
            requires: [],
            userInput: 'none',
            covers: toolIds as ComponentId[],
            run: (request) => installToolchain(full, request),
        },
    };
    return [...tools.map(member), toolchain];
}
