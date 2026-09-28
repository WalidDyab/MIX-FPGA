import { type ToolRunner, succeeded } from '../process/tool-runner';
import type { ToolLocator } from './tool-locator';
import type { DetectedTool, ToolId } from './types';
import { parseApioVersion, parseGhdlVersion, parseNextpnrVersion, parseYosysVersion } from './version-parsers';

interface VersionProbe {
    /** Which located executable to run (Yosys/nextpnr are reached through Apio). */
    readonly via: ToolId;
    readonly args: readonly string[];
    readonly parse: (text: string) => string | undefined;
}

/** Probes that only need a located executable, so they are platform-neutral. */
const PROBES: Partial<Record<ToolId, VersionProbe>> = {
    ghdl: { via: 'ghdl', args: ['--version'], parse: parseGhdlVersion },
    apio: { via: 'apio', args: ['--version'], parse: parseApioVersion },
    yosys: { via: 'apio', args: ['raw', '--', 'yosys', '-V'], parse: parseYosysVersion },
    'nextpnr-xilinx': { via: 'apio', args: ['raw', '--', 'nextpnr-xilinx', '--version'], parse: parseNextpnrVersion },
};

const PROBE_TIMEOUT_MS = 30_000;

/**
 * Detects installed tool versions via a ToolLocator + ToolRunner.
 * Returns undefined for tools it cannot check (e.g. openXC7 package metadata
 * or the programmer backend); those are left to platform adapters.
 */
export class ToolDetector {
    constructor(
        private readonly locator: ToolLocator,
        private readonly runner: ToolRunner,
    ) {}

    async detect(tool: ToolId): Promise<DetectedTool | undefined> {
        const probe = PROBES[tool];
        if (!probe) return undefined;

        const located = await this.locator.locate(probe.via);
        if (!located) return undefined;

        const run = await this.runner.run({ executable: located.path, args: probe.args, timeoutMs: PROBE_TIMEOUT_MS });
        const via = probe.via === tool ? located.method : `${located.method} via ${probe.via}`;
        if (run.outcome === 'spawn-failed') return { tool, found: false, path: located.path, method: via };

        const raw = `${run.stdout}\n${run.stderr}`.trim();
        const version = succeeded(run) ? probe.parse(raw) : undefined;
        const base = { tool, found: true, path: located.path, rawVersion: raw, method: via };
        return version === undefined ? base : { ...base, version };
    }

    async detectAll(tools: readonly ToolId[]): Promise<Map<ToolId, DetectedTool>> {
        const map = new Map<ToolId, DetectedTool>();
        for (const tool of tools) {
            const d = await this.detect(tool);
            if (d) map.set(tool, d);
        }
        return map;
    }
}
