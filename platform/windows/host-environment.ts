import { readdir, readFile, stat } from 'node:fs/promises';

/**
 * The parts of the Windows host the adapter reads: environment variables and
 * the filesystem. Injected so discovery logic is testable on any OS without
 * Windows paths or tools being present.
 */
export interface WindowsFileSystem {
    isFile(path: string): Promise<boolean>;
    /** Names of the sub-directories of `path` (empty if unreadable). */
    listDirectories(path: string): Promise<string[]>;
    /** File contents, or undefined if unreadable. */
    readFile(path: string): Promise<Buffer | undefined>;
}

export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

export interface WindowsHostEnvironment {
    readonly env: EnvironmentVariables;
    readonly fs: WindowsFileSystem;
    /** NexysVHDL package root (for the package-local `tools/` folder), if known. */
    readonly packageRoot?: string;
}

export const nodeWindowsFileSystem: WindowsFileSystem = {
    async isFile(path) {
        try {
            return (await stat(path)).isFile();
        } catch {
            return false;
        }
    },
    async listDirectories(path) {
        try {
            return (await readdir(path, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
        } catch {
            return [];
        }
    },
    async readFile(path) {
        try {
            return await readFile(path);
        } catch {
            return undefined;
        }
    },
};

/**
 * Case-insensitive environment lookup: Windows variable names are
 * case-insensitive, but a plain object copy of them is not.
 */
export function getEnv(env: EnvironmentVariables, name: string): string | undefined {
    const direct = env[name];
    if (direct !== undefined && direct !== '') return direct;
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(env)) {
        if (key.toLowerCase() === lower && value !== undefined && value !== '') return value;
    }
    return undefined;
}

/**
 * Decodes a small text file written by a Windows installer: UTF-16LE with a
 * BOM (e.g. the Digilent install log), UTF-8 with or without a BOM otherwise.
 */
export function decodeWindowsText(buf: Buffer): string {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
    return buf.toString('utf8');
}
