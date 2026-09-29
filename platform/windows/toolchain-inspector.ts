import { win32 } from 'node:path';
import { type DetectedTool, parseOpenXc7ReleaseTag, ToolDetector, type ToolId, type ToolLocator, type ToolRunner } from '../../core';
import { inspectAdept } from './digilent/adept-environment';
import type { WindowsHostEnvironment } from './host-environment';
import { apioHome } from './tool-locator';

/**
 * Windows tool/version detection for doctor-style reports. GHDL, Apio, Yosys
 * and nextpnr-xilinx use the core ToolDetector (version probes through the
 * located executables). openXC7 and the programmer need Windows knowledge:
 *  - openXC7: `release-tag` of Apio's `packages\openxc7\BUILD-INFO.json`;
 *  - programmer: Adept Utilities version derived from `djtgcfg -version`,
 *    with the Adept Runtime version from Digilent's install log.
 * Read-only: nothing is installed, updated or reconfigured.
 */
export class WindowsToolchainInspector {
    private readonly core: ToolDetector;

    constructor(
        private readonly locator: ToolLocator,
        private readonly runner: ToolRunner,
        private readonly host: WindowsHostEnvironment,
    ) {
        this.core = new ToolDetector(locator, runner);
    }

    async detect(tool: ToolId): Promise<DetectedTool | undefined> {
        switch (tool) {
            case 'openxc7':
                return this.detectOpenXc7();
            case 'programmer':
                return this.detectProgrammer();
            default:
                return this.core.detect(tool);
        }
    }

    async detectAll(tools: readonly ToolId[]): Promise<Map<ToolId, DetectedTool>> {
        const map = new Map<ToolId, DetectedTool>();
        for (const tool of tools) {
            const d = await this.detect(tool);
            if (d) map.set(tool, d);
        }
        return map;
    }

    /** Apio package metadata; Apio itself must be locatable for the package to be usable. */
    private async detectOpenXc7(): Promise<DetectedTool> {
        const method = 'Apio packages folder';
        const home = apioHome(this.host.env);
        if (!home) return { tool: 'openxc7', found: false, method: `${method} (no USERPROFILE/APIO_HOME)` };
        const path = win32.join(home, 'packages', 'openxc7', 'BUILD-INFO.json');
        const buf = await this.host.fs.readFile(path);
        if (!buf) return { tool: 'openxc7', found: false, path, method };
        const raw = buf.toString('utf8');
        const version = parseOpenXc7ReleaseTag(raw);
        const base = { tool: 'openxc7' as const, found: true, path, method, rawVersion: raw.trim() };
        return version === undefined ? base : { ...base, version };
    }

    private async detectProgrammer(): Promise<DetectedTool> {
        const adept = await inspectAdept(this.locator, this.runner, this.host);
        if (!adept.djtgcfg) return { tool: 'programmer', found: false, method: 'Digilent Adept Utilities default install / PATH' };
        const raw = [
            adept.rawVersion,
            adept.djtgcfgVersion ? `djtgcfg ${adept.djtgcfgVersion}${adept.utilitiesVersion ? ` => Adept Utilities ${adept.utilitiesVersion}` : ' (unknown Adept Utilities package)'}` : undefined,
            `Adept Runtime ${adept.runtimeVersion ?? 'unknown'}`,
            adept.problem,
        ]
            .filter((s): s is string => !!s)
            .join('\n');
        const base = { tool: 'programmer' as const, found: adept.usable, path: adept.djtgcfg.path, method: adept.djtgcfg.method, rawVersion: raw };
        return adept.utilitiesVersion && adept.usable ? { ...base, version: adept.utilitiesVersion } : base;
    }
}
