import { posix } from 'node:path';
import { type Diagnostic, errorDiag, type LocatedTool, type ToolId, type ToolLocator, toolEnvVar, warningDiag } from '../../core';
import { type ArchitectureReport, inspectArchitecture } from './executable';
import type { MacosSystem } from './system';

/** Where NexysVHDL itself keeps tools it manages (none are installed by this adapter). */
export const MANAGED_TOOLS_ENV = 'NEXYSVHDL_TOOLS_DIR';

/** Apio's standard macOS installer location. */
export const APIO_APP_PATH = '/Applications/Apio/apio';

export interface ToolCandidate {
    readonly path: string;
    /** How the candidate was derived, shown by `doctor`. */
    readonly method: string;
    /** An explicit user override: if it is unusable, discovery stops instead of silently falling back. */
    readonly explicit?: boolean;
}

export interface MacosLocatedTool extends LocatedTool {
    readonly architecture: ArchitectureReport;
}

export interface RejectedCandidate extends ToolCandidate {
    readonly reason: string;
}

export interface ToolDiscovery {
    readonly tool: ToolId;
    readonly located?: MacosLocatedTool;
    readonly rejected: readonly RejectedCandidate[];
    readonly diagnostics: readonly Diagnostic[];
}

export interface MacosLocatorOptions {
    /** Extra locations tried last, e.g. a development install from an earlier phase. */
    readonly developmentLocations?: Partial<Readonly<Record<ToolId, readonly ToolCandidate[]>>>;
}

/** Apio's home directory (packages live in `<home>/packages`). */
export function apioHome(system: MacosSystem): string {
    return system.env['APIO_HOME'] || posix.join(system.homeDir, '.apio');
}

export function managedToolsDir(system: MacosSystem): string {
    return system.env[MANAGED_TOOLS_ENV] || posix.join(system.homeDir, 'Library', 'Application Support', 'NexysVHDL', 'tools');
}

/** Executable names searched on PATH; tools reached through Apio are not searched. */
const PATH_NAMES: Partial<Record<ToolId, string>> = { ghdl: 'ghdl', apio: 'apio', programmer: 'openFPGALoader' };

/**
 * macOS tool discovery. Priority per tool:
 *   1. explicit override (`NEXYSVHDL_<TOOL>`)
 *   2. NexysVHDL-managed location (`NEXYSVHDL_TOOLS_DIR`, default ~/Library/Application Support/NexysVHDL/tools)
 *   3. tool-specific standard location (Apio app; openFPGALoader from Apio's oss-cad-suite)
 *   4. PATH
 *   5. development locations supplied by the caller
 * Every hit must be an executable file; x86_64-only binaries are rejected (no Rosetta).
 */
export class MacosToolLocator implements ToolLocator {
    constructor(
        private readonly system: MacosSystem,
        private readonly options: MacosLocatorOptions = {},
    ) {}

    candidates(tool: ToolId): ToolCandidate[] {
        const out: ToolCandidate[] = [];
        const variable = toolEnvVar(tool);
        const override = this.system.env[variable];
        if (override) out.push({ path: override, method: variable, explicit: true });

        const managed = managedToolsDir(this.system);
        switch (tool) {
            case 'ghdl':
                out.push({ path: posix.join(managed, 'ghdl', 'bin', 'ghdl'), method: 'NexysVHDL tools folder' });
                break;
            case 'apio':
                out.push({ path: posix.join(managed, 'apio', 'apio'), method: 'NexysVHDL tools folder' });
                out.push({ path: APIO_APP_PATH, method: 'Apio installer location' });
                out.push({ path: posix.join(this.system.homeDir, 'Applications', 'Apio', 'apio'), method: 'Apio installer location (user)' });
                break;
            case 'programmer':
                // The exact executable `apio upload` ran in Phases 1–2 (Apio puts this bin/ on PATH).
                out.push({ path: posix.join(apioHome(this.system), 'packages', 'oss-cad-suite', 'bin', 'openFPGALoader'), method: 'Apio oss-cad-suite package' });
                break;
            default:
                break;
        }

        const name = PATH_NAMES[tool];
        if (name) {
            for (const dir of (this.system.env['PATH'] ?? '').split(':')) {
                if (dir) out.push({ path: posix.join(dir, name), method: 'PATH' });
            }
        }
        out.push(...(this.options.developmentLocations?.[tool] ?? []));

        // Keep the first occurrence of each path (PATH may repeat a standard location).
        const seen = new Set<string>();
        return out.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
    }

    async discover(tool: ToolId): Promise<ToolDiscovery> {
        const rejected: RejectedCandidate[] = [];
        const diagnostics: Diagnostic[] = [];
        for (const candidate of this.candidates(tool)) {
            const reject = (reason: string) => rejected.push({ ...candidate, reason });
            if (!(await this.system.isExecutable(candidate.path))) {
                reject('not an executable file');
                if (candidate.explicit) {
                    diagnostics.push(errorDiag('toolchain', 'MACOS_TOOL_OVERRIDE_INVALID', `${candidate.method} points to ${candidate.path}, which is not an executable file.`));
                    break;
                }
                continue;
            }
            const architecture = await inspectArchitecture(this.system, candidate.path);
            if (architecture.status === 'x86_64-only') {
                reject('x86_64-only binary (Rosetta is not used)');
                diagnostics.push(
                    errorDiag('toolchain', 'MACOS_TOOL_UNSUPPORTED_ARCH', `${candidate.path} is built for x86_64 only; NexysVHDL requires native arm64 tools and does not use Rosetta.`),
                );
                if (candidate.explicit) break;
                continue;
            }
            if (architecture.status === 'unknown') {
                diagnostics.push(warningDiag('toolchain', 'MACOS_TOOL_ARCH_UNKNOWN', `Could not determine the CPU architecture of ${candidate.path}.`));
            }
            return { tool, located: { path: candidate.path, method: candidate.method, architecture }, rejected, diagnostics };
        }
        return { tool, rejected, diagnostics };
    }

    async locate(tool: ToolId): Promise<LocatedTool | undefined> {
        const { located } = await this.discover(tool);
        return located ? { path: located.path, method: located.method } : undefined;
    }
}
