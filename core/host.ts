import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Description of the machine NexysVHDL runs on. The core only reports and
 * passes this along (e.g. to select a toolchain manifest from data); it never
 * branches on it. Platform differences live in platform/ adapters.
 */
export interface HostInfo {
    /** Node's platform name, e.g. `win32`, `darwin`, `linux`. */
    readonly platform: string;
    /** Node's arch name, e.g. `x64`, `arm64`. */
    readonly arch: string;
    readonly nodeVersion: string;
}

/**
 * Ends a tool process and every process it started. On Windows `child.kill()` ends only the
 * process itself, so a tool that starts helpers (a simulator that runs an elaborated design)
 * would leave them running; `taskkill /T` ends the whole tree. Elsewhere the process itself is
 * ended (the supported tools run in one process there). A second, forceful signal follows if
 * the tool ignores the first. Never throws.
 */
export function terminateProcessTree(child: ChildProcess): void {
    const pid = child.pid;
    try {
        if (process.platform === 'win32' && pid !== undefined) {
            const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => child.kill());
            return;
        }
        child.kill();
        const force = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 2000);
        force.unref();
    } catch {
        /* the process may already be gone */
    }
}

export function currentHost(): HostInfo {
    return { platform: process.platform, arch: process.arch, nodeVersion: process.version };
}
