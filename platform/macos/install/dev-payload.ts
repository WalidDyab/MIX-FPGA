import { join } from 'node:path';
import { DirectoryPayload } from './payload';

/**
 * INSTALLER DEVELOPMENT ONLY. During this phase the validated tools sit in a git-ignored folder
 * (`toolchains/experimental`) and are the provenance of Toolchain 1.0. This reads the variable that
 * points the installer at them. It is used by the installer's entry points and its tests, and is
 * never consulted when MIX-FPGA looks for a tool to run: runtime resolution reads only the installed
 * toolchain (see layout.ts). An independence test enforces that.
 */
export const DEV_PAYLOAD_VARIABLE = 'MIXFPGA_DEV_PAYLOAD';

/** Folder names of the validated tools inside the development payload. */
export const DEV_TOOL_FOLDERS: Readonly<Record<string, string>> = { ghdl: 'ghdl-6.0.0', yosys: 'yosys-0.63', openfpgaloader: 'openfpgaloader-1.1.1', lima: 'lima-2.2.1' };

export function devPayload(opts: { toolsRoot: string; engineDir: string; noticesDir: string }): DirectoryPayload {
    const sources: Record<string, string> = {};
    for (const [id, folder] of Object.entries(DEV_TOOL_FOLDERS)) sources[id] = join(opts.toolsRoot, folder);
    sources['engine'] = opts.engineDir;
    sources['licenses'] = join(opts.noticesDir, 'LICENSES');
    sources['notices'] = join(opts.noticesDir, 'THIRD_PARTY_NOTICES.txt');
    return new DirectoryPayload(sources, 'development folder');
}

export function devPayloadFromEnv(env: Readonly<Record<string, string | undefined>>, repoRoot: string): DirectoryPayload | undefined {
    const toolsRoot = env[DEV_PAYLOAD_VARIABLE];
    if (!toolsRoot) return undefined;
    return devPayload({ toolsRoot, engineDir: join(repoRoot, 'platform', 'macos', 'lima'), noticesDir: join(repoRoot, 'toolchains', 'mixfpga', 'notices', 'macos-arm64') });
}
