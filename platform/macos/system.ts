import { constants } from 'node:fs';
import { access, open, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';

/**
 * The parts of the host the macOS adapter reads. Injected so that discovery,
 * pin and package checks are unit-testable on any OS without macOS tools.
 * All paths handled through this interface are POSIX paths.
 */
export interface MacosSystem {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly homeDir: string;
    /**
     * Node's `process.arch`. On Apple silicon `x64` means Node itself runs
     * translated by Rosetta, which NexysVHDL does not support.
     */
    readonly processArch: string;
    isFile(path: string): Promise<boolean>;
    isExecutable(path: string): Promise<boolean>;
    readText(path: string): Promise<string | undefined>;
    /** First `bytes` bytes of a file (for executable headers). */
    readHead(path: string, bytes: number): Promise<Uint8Array | undefined>;
}

/** The real host. */
export function nodeSystem(env: Readonly<Record<string, string | undefined>> = process.env): MacosSystem {
    return {
        env,
        homeDir: homedir(),
        processArch: process.arch,
        async isFile(path) {
            try {
                return (await stat(path)).isFile();
            } catch {
                return false;
            }
        },
        async isExecutable(path) {
            try {
                if (!(await stat(path)).isFile()) return false;
                await access(path, constants.X_OK);
                return true;
            } catch {
                return false;
            }
        },
        async readText(path) {
            try {
                return await readFile(path, 'utf8');
            } catch {
                return undefined;
            }
        },
        async readHead(path, bytes) {
            try {
                const handle = await open(await realpath(path), 'r');
                try {
                    const buffer = Buffer.alloc(bytes);
                    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
                    return buffer.subarray(0, bytesRead);
                } finally {
                    await handle.close();
                }
            } catch {
                return undefined;
            }
        },
    };
}
