import { win32 } from 'node:path';
import { type LocatedTool, type ToolId, type ToolLocator, toolEnvVar } from '../../core';
import { type EnvironmentVariables, getEnv, type WindowsFileSystem, type WindowsHostEnvironment } from './host-environment';

/** Windows paths regardless of the OS running the code (tests run on macOS too). */
const { join, delimiter } = win32;

/** Executable file name searched on PATH for each tool. `.exe` only: `.cmd`/`.bat` would need a shell. */
const EXECUTABLE: Partial<Record<ToolId, string>> = {
    ghdl: 'ghdl.exe',
    apio: 'apio.exe',
    programmer: 'djtgcfg.exe',
};

interface Candidate {
    readonly path: string;
    readonly method: string;
}

/** Directory names under a `tools/` folder that may hold GHDL, newest version first. */
function ghdlFolders(names: readonly string[]): string[] {
    const version = (n: string) => (/^ghdl-(\d+(?:\.\d+)*)$/i.exec(n)?.[1] ?? '').split('.').map(Number);
    const cmp = (a: string, b: string) => {
        const va = version(a);
        const vb = version(b);
        for (let i = 0; i < Math.max(va.length, vb.length); i++) {
            const d = (vb[i] ?? 0) - (va[i] ?? 0);
            if (d !== 0) return d;
        }
        return 0;
    };
    const plain = names.filter((n) => n.toLowerCase() === 'ghdl');
    return [...plain, ...names.filter((n) => /^ghdl-\d+(\.\d+)*$/i.test(n)).sort(cmp)];
}

/** Apio's home folder: `APIO_HOME` if set, else `%USERPROFILE%\.apio`. */
export function apioHome(env: EnvironmentVariables): string | undefined {
    const explicit = getEnv(env, 'APIO_HOME');
    if (explicit) return explicit;
    const profile = getEnv(env, 'USERPROFILE');
    return profile ? join(profile, '.apio') : undefined;
}

/** Folders that may contain the Digilent Adept Utilities (32-bit installer first). */
export function digilentUtilityFolders(env: EnvironmentVariables): string[] {
    const roots = [getEnv(env, 'ProgramFiles(x86)'), getEnv(env, 'ProgramFiles')].filter((r): r is string => r !== undefined);
    return [...new Set(roots)].map((r) => join(r, 'Digilent', 'AdeptUtilities'));
}

/**
 * Tool discovery on Windows. Order (first hit wins):
 *  1. explicit `NEXYSVHDL_<TOOL>` environment override (same variable the core's
 *     ConfiguredToolLocator reads, so the programmer honours it too);
 *  2. NexysVHDL-managed folders: `<package>\tools\ghdl*\bin`, then
 *     `%LOCALAPPDATA%\NexysVHDL\tools\ghdl*\bin`;
 *  3. standard install locations: Apio's `%USERPROFILE%\.apio\bin` (or
 *     `APIO_HOME\bin`), MSYS2 GHDL, Digilent `Program Files` folders;
 *  4. PATH (`.exe` files only).
 * Only files are checked; nothing is executed and no shell is involved.
 * Project-level tool paths are applied by the composition root in front of this.
 */
export class WindowsToolLocator implements ToolLocator {
    private readonly env: EnvironmentVariables;
    private readonly fs: WindowsFileSystem;

    constructor(private readonly host: WindowsHostEnvironment) {
        this.env = host.env;
        this.fs = host.fs;
    }

    async locate(tool: ToolId): Promise<LocatedTool | undefined> {
        for (const c of await this.candidates(tool)) {
            if (await this.fs.isFile(c.path)) return { path: c.path, method: c.method };
        }
        return undefined;
    }

    /** Every path that would be checked for `tool`, in order (for diagnostics and tests). */
    async candidates(tool: ToolId): Promise<Candidate[]> {
        const list: Candidate[] = [];
        const override = getEnv(this.env, toolEnvVar(tool));
        if (override) list.push({ path: override, method: toolEnvVar(tool) });

        switch (tool) {
            case 'ghdl':
                list.push(...(await this.managedGhdl()), ...this.msys2Ghdl());
                break;
            case 'apio': {
                const home = apioHome(this.env);
                if (home) list.push({ path: join(home, 'bin', 'apio.exe'), method: 'Apio default install' });
                break;
            }
            case 'programmer':
                for (const dir of digilentUtilityFolders(this.env)) {
                    list.push({ path: join(dir, 'djtgcfg.exe'), method: 'Digilent Adept Utilities default install' });
                }
                break;
            default:
                // Yosys, nextpnr-xilinx and openXC7 are reached through Apio, not located directly.
                return list;
        }

        const exe = EXECUTABLE[tool];
        const path = getEnv(this.env, 'PATH');
        if (exe && path) {
            for (const dir of path.split(delimiter)) {
                const d = dir.trim().replace(/^"(.*)"$/, '$1');
                if (d) list.push({ path: join(d, exe), method: 'PATH' });
            }
        }
        return list;
    }

    private async managedGhdl(): Promise<Candidate[]> {
        const roots: Array<{ dir: string; method: string }> = [];
        if (this.host.packageRoot) roots.push({ dir: join(this.host.packageRoot, 'tools'), method: 'NexysVHDL tools folder' });
        const local = getEnv(this.env, 'LOCALAPPDATA');
        if (local) roots.push({ dir: join(local, 'NexysVHDL', 'tools'), method: 'NexysVHDL per-user tools' });

        const out: Candidate[] = [];
        for (const { dir, method } of roots) {
            for (const name of ghdlFolders(await this.fs.listDirectories(dir))) {
                out.push({ path: join(dir, name, 'bin', 'ghdl.exe'), method });
            }
        }
        return out;
    }

    private msys2Ghdl(): Candidate[] {
        const drive = getEnv(this.env, 'SystemDrive') ?? 'C:';
        return ['ucrt64', 'mingw64', 'clang64'].map((env) => ({
            path: join(`${drive}\\`, 'msys64', env, 'bin', 'ghdl.exe'),
            method: `MSYS2 ${env}`,
        }));
    }
}
