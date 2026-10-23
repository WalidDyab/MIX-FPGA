import type { ComponentDefinition, ComponentId, Inspection } from '../../../core/install/model';
import { aggregate } from '../../../core/install/model';
import { checkUnit, hostSupported, type CheckDepth, installToolchain, readMarker, manifestFileMatches, type ToolchainContext, unitProblem } from './toolchain-installer';
import { toolUnits, type ToolchainUnit } from './expected';

const TOOL_LABEL: Record<string, string> = { ghdl: 'GHDL', yosys: 'Yosys', openfpgaloader: 'openFPGALoader', lima: 'Lima' };

/**
 * The managed part of the macOS setup: the four tools of MIX-FPGA Toolchain 1.1 and the toolchain as a whole.
 * Each tool is inspected on its own; the `toolchain` step installs or repairs whichever are not ready.
 * `depth` is `quick` whenever MIX-FPGA opens and `full` for Verify.
 */
export function toolchainDefinitions(ctx: ToolchainContext, depth: CheckDepth = 'quick'): ComponentDefinition[] {
    const tools = toolUnits(ctx.expected.toolchain);
    const toolIds = tools.map((t) => t.id);
    const incompatibleHost: Inspection = { state: 'incompatible', ownership: 'managed', code: 'UNSUPPORTED_HOST', detail: 'MIX-FPGA Toolchain 1.1 needs a Mac with Apple silicon' };

    const member = (u: ToolchainUnit): ComponentDefinition => ({
        id: u.id,
        label: TOOL_LABEL[u.id] ?? u.name,
        async inspect() {
            if (!hostSupported(ctx.host)) return incompatibleHost;
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
            run: (request) => installToolchain(ctx, request),
        },
    };
    return [...tools.map(member), toolchain];
}
