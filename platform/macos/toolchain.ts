import {
    type DetectedTool,
    type Diagnostic,
    errorDiag,
    expectationFor,
    type ToolchainManifest,
    ToolDetector,
    type ToolId,
    type ToolRunner,
} from '../../core';
import { type ApioPinStatus, checkApioPin, PinnedApioRunner } from './apio-pin';
import type { ArchitectureReport } from './executable';
import { parseOpenFpgaLoaderVersion } from './openfpgaloader';
import { checkOpenXc7Package, openXc7Detected, readOpenXc7Package } from './openxc7';
import type { MacosSystem } from './system';
import { apioHome, type MacosToolLocator } from './tool-locator';

export interface MacosToolchainReport {
    readonly tools: ReadonlyMap<ToolId, DetectedTool>;
    /** Per-executable architecture verdicts (ghdl, apio, programmer). */
    readonly architectures: ReadonlyMap<ToolId, ArchitectureReport>;
    readonly pin: ApioPinStatus;
    readonly diagnostics: readonly Diagnostic[];
}

/**
 * Detects the full macOS toolchain: GHDL/Apio/Yosys/nextpnr through the shared
 * ToolDetector (Yosys and nextpnr via `apio raw`, with the pinned environment),
 * plus the openXC7 package metadata and openFPGALoader, which the core leaves
 * to platform adapters.
 */
export class MacosToolchainDetector {
    constructor(
        private readonly system: MacosSystem,
        private readonly locator: MacosToolLocator,
        private readonly runner: ToolRunner,
        private readonly pinnedConfigDir: string,
    ) {}

    async detect(manifest?: ToolchainManifest): Promise<MacosToolchainReport> {
        const diagnostics: Diagnostic[] = [];
        const tools = new Map<ToolId, DetectedTool>();
        const architectures = new Map<ToolId, ArchitectureReport>();

        if (this.system.processArch !== 'arm64') {
            diagnostics.push(
                errorDiag('toolchain', 'MACOS_UNSUPPORTED_ARCH', `Node is running as ${this.system.processArch}; NexysVHDL on macOS requires native arm64 (Apple silicon, no Rosetta).`),
            );
        }

        for (const tool of ['ghdl', 'apio', 'programmer'] as const) {
            const found = await this.locator.discover(tool);
            diagnostics.push(...found.diagnostics);
            if (found.located) architectures.set(tool, found.located.architecture);
            else tools.set(tool, { tool, found: false, method: found.rejected.map((r) => `${r.method}: ${r.path}`).join('; ') || 'no candidates' });
        }

        // The pin URL does not depend on the Apio version, so no Apio command ever runs without it.
        const base = await checkApioPin(this.system, this.pinnedConfigDir);
        const detector = new ToolDetector(this.locator, base.env ? new PinnedApioRunner(this.runner, base.env) : this.runner);
        const apio = base.env && architectures.has('apio') ? await detector.detect('apio') : undefined;
        if (apio) tools.set('apio', apio);
        // With the Apio version known, check the config file Apio will actually read.
        const pin = apio?.version ? await checkApioPin(this.system, this.pinnedConfigDir, apio.version) : base;
        diagnostics.push(...pin.diagnostics);

        if (architectures.has('ghdl')) {
            const ghdl = await detector.detect('ghdl');
            if (ghdl) tools.set('ghdl', ghdl);
        }
        if (pin.env && pin.file && apio?.found) {
            for (const tool of ['yosys', 'nextpnr-xilinx'] as const) {
                const d = await detector.detect(tool);
                if (d) tools.set(tool, d);
            }
        }

        const pkg = await readOpenXc7Package(this.system, apioHome(this.system));
        const tested = expectationFor(manifest, 'openxc7')?.testedVersions ?? [];
        tools.set('openxc7', openXc7Detected(pkg, tested));
        if (pkg) {
            diagnostics.push(
                ...checkOpenXc7Package(pkg, {
                    ...(apio?.version ? { apioVersion: apio.version } : {}),
                    ...(pin.tags['openxc7'] ? { pinnedTag: pin.tags['openxc7'] } : {}),
                    expectedPlatform: 'darwin-arm64',
                }),
            );
        }

        const programmer = await this.locator.discover('programmer');
        if (programmer.located) {
            const run = await this.runner.run({ executable: programmer.located.path, args: ['--Version'], timeoutMs: 15_000 });
            const raw = `${run.stdout}\n${run.stderr}`.trim();
            const version = run.outcome === 'exited' ? parseOpenFpgaLoaderVersion(raw) : undefined;
            const base: DetectedTool = { tool: 'programmer', found: run.outcome !== 'spawn-failed', path: programmer.located.path, method: programmer.located.method, rawVersion: raw };
            tools.set('programmer', version ? { ...base, version } : base);
        }

        return { tools, architectures, pin, diagnostics };
    }
}
