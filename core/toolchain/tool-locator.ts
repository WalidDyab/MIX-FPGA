import type { ToolId } from './types';

export interface LocatedTool {
    readonly path: string;
    /** How it was found, for doctor output (e.g. `NEXYSVHDL_GHDL`, `project setting`). */
    readonly method: string;
}

/**
 * Finds tool executables. Platform adapters (Phase 3B) implement real
 * discovery; the core only ships explicit-configuration locators.
 */
export interface ToolLocator {
    locate(tool: ToolId): Promise<LocatedTool | undefined>;
}

/** Environment variable holding an explicit path for a tool, e.g. `NEXYSVHDL_NEXTPNR_XILINX`. */
export function toolEnvVar(tool: ToolId): string {
    return `NEXYSVHDL_${tool.toUpperCase().replace(/-/g, '_')}`;
}

/** Explicit paths only: a map (e.g. project settings) and/or environment variables. */
export class ConfiguredToolLocator implements ToolLocator {
    constructor(
        private readonly paths: Partial<Readonly<Record<ToolId, string>>> = {},
        private readonly env: Readonly<Record<string, string | undefined>> = {},
        private readonly pathsLabel = 'project setting',
    ) {}

    async locate(tool: ToolId): Promise<LocatedTool | undefined> {
        const fromMap = this.paths[tool];
        if (fromMap) return { path: fromMap, method: this.pathsLabel };
        const variable = toolEnvVar(tool);
        const fromEnv = this.env[variable];
        if (fromEnv) return { path: fromEnv, method: variable };
        return undefined;
    }
}

/** Tries locators in order; the first hit wins. */
export class ChainedToolLocator implements ToolLocator {
    constructor(private readonly locators: readonly ToolLocator[]) {}

    async locate(tool: ToolId): Promise<LocatedTool | undefined> {
        for (const locator of this.locators) {
            const found = await locator.locate(tool);
            if (found) return found;
        }
        return undefined;
    }
}
