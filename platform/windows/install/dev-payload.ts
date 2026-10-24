import { join } from 'node:path';
import { DirectoryPayload } from '../../shared/install/payload';

/**
 * INSTALLER DEVELOPMENT ONLY. During this phase the validated tools sit in a git-ignored folder (`toolchains/experimental`) and are
 * the provenance of Toolchain 1.1 for Windows. This reads the variable that points the installer at them. It is used by the
 * installer's entry points and its tests, and is never consulted when MIX-FPGA looks for a tool to run: runtime resolution reads
 * only the installed toolchain (see layout.ts). An independence test enforces that.
 */
export const WINDOWS_DEV_PAYLOAD_VARIABLE = 'MIXFPGA_DEV_PAYLOAD';

/** Folder names of the validated tools inside the development payload. */
export const WINDOWS_DEV_TOOL_FOLDERS: Readonly<Record<string, string>> = { ghdl: 'ghdl-6.0.0', yosys: 'yosys-0.63' };

export function windowsDevPayload(opts: { toolsRoot: string; scriptsDir: string; noticesDir: string }): DirectoryPayload {
    const sources: Record<string, string> = {};
    for (const [id, folder] of Object.entries(WINDOWS_DEV_TOOL_FOLDERS)) sources[id] = join(opts.toolsRoot, folder);
    sources['scripts'] = opts.scriptsDir;
    sources['licenses'] = join(opts.noticesDir, 'LICENSES');
    sources['notices'] = join(opts.noticesDir, 'THIRD_PARTY_NOTICES.txt');
    return new DirectoryPayload(sources, 'development folder');
}

export function windowsDevPayloadFromEnv(env: Readonly<Record<string, string | undefined>>, repoRoot: string): DirectoryPayload | undefined {
    const toolsRoot = env[WINDOWS_DEV_PAYLOAD_VARIABLE];
    if (!toolsRoot) return undefined;
    return windowsDevPayload({ toolsRoot, scriptsDir: join(repoRoot, 'platform', 'windows', 'scripts'), noticesDir: join(repoRoot, 'toolchains', 'mixfpga', 'notices', 'windows-x64-1.1') });
}

/** INSTALLER DEVELOPMENT ONLY: a folder that holds the support archives named in toolchains/mixfpga/payloads-1.1-windows-x64.json. */
export function windowsDevPayloadDirFromEnv(env: Readonly<Record<string, string | undefined>>): string | undefined {
    return env[WINDOWS_DEV_PAYLOAD_VARIABLE] || undefined;
}
