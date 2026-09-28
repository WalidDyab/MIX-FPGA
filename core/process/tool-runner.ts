import { spawn } from 'node:child_process';

/**
 * One external tool invocation. Arguments are passed as an array and never
 * joined into a shell command line, so paths with spaces stay single arguments
 * and no shell (cmd, PowerShell, bash) syntax is involved.
 */
export interface ToolInvocation {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    /** Merged over the current environment. A value of `undefined` removes the variable. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Kill the process after this many milliseconds. */
    readonly timeoutMs?: number;
    /** External cancellation (e.g. a UI "Cancel" button). */
    readonly signal?: AbortSignal;
}

export type ToolRunOutcome = 'exited' | 'timed-out' | 'cancelled' | 'spawn-failed';

export interface ToolRunResult {
    readonly invocation: ToolInvocation;
    readonly outcome: ToolRunOutcome;
    /** Process exit code; null unless outcome is `exited`. */
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly durationMs: number;
    /** Set when outcome is `spawn-failed` (e.g. executable not found). */
    readonly errorMessage?: string;
}

/** Injectable process boundary; tests substitute a fake. */
export interface ToolRunner {
    run(invocation: ToolInvocation): Promise<ToolRunResult>;
}

export function succeeded(result: ToolRunResult): boolean {
    return result.outcome === 'exited' && result.exitCode === 0;
}

function mergeEnv(overrides: ToolInvocation['env']): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
            if (value === undefined) delete env[key];
            else env[key] = value;
        }
    }
    return env;
}

/** ToolRunner backed by child_process.spawn with `shell: false`. */
export class NodeToolRunner implements ToolRunner {
    run(invocation: ToolInvocation): Promise<ToolRunResult> {
        const started = performance.now();
        return new Promise((resolve) => {
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let outcome: ToolRunOutcome = 'exited';
            let settled = false;

            const finish = (exitCode: number | null, errorMessage?: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                invocation.signal?.removeEventListener('abort', onAbort);
                const result: ToolRunResult = {
                    invocation,
                    outcome,
                    exitCode: outcome === 'exited' ? exitCode : null,
                    stdout: Buffer.concat(stdout).toString('utf8'),
                    stderr: Buffer.concat(stderr).toString('utf8'),
                    durationMs: Math.round(performance.now() - started),
                };
                resolve(errorMessage === undefined ? result : { ...result, errorMessage });
            };

            if (invocation.signal?.aborted) {
                outcome = 'cancelled';
                finish(null);
                return;
            }

            const child = spawn(invocation.executable, [...invocation.args], {
                cwd: invocation.cwd,
                env: mergeEnv(invocation.env),
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            const onAbort = () => {
                outcome = 'cancelled';
                child.kill();
            };
            invocation.signal?.addEventListener('abort', onAbort, { once: true });

            const timer =
                invocation.timeoutMs === undefined
                    ? undefined
                    : setTimeout(() => {
                          outcome = 'timed-out';
                          child.kill();
                      }, invocation.timeoutMs);

            child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
            child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
            child.on('error', (err) => {
                outcome = 'spawn-failed';
                finish(null, err.message);
            });
            child.on('close', (code) => finish(code));
        });
    }
}
