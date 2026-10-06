import { resolve } from 'node:path';
import { errorDiag, type Diagnostic } from '../results/diagnostic';

/** Operations that read or rewrite a project's build workspace (`.nexysvhdl/`) and bitstream. */
export type PipelineOperation = 'check' | 'simulate' | 'build' | 'program' | 'rtl';

const LABEL: Record<PipelineOperation, string> = {
    check: 'Check',
    simulate: 'Simulation',
    build: 'Build',
    program: 'Programming',
    rtl: 'RTL schematic generation',
};

/** Operations that currently hold a project, by normalized project root. */
const active = new Map<string, PipelineOperation>();

const keyOf = (projectRoot: string) => resolve(projectRoot).toLowerCase();

/** The operation currently running on this project, if any. */
export function activeOperation(projectRoot: string): PipelineOperation | undefined {
    return active.get(keyOf(projectRoot));
}

/** `Build is already running.` — the message shown for a duplicate request. */
export function busyMessage(op: PipelineOperation): string {
    return `${LABEL[op]} is already running.`;
}

export function busyDiagnostic(op: PipelineOperation): Diagnostic {
    return errorDiag('workflow', 'PIPELINE_BUSY', busyMessage(op));
}

/**
 * Single-flight guard per project. Check, Simulate, Build, RTL and Program
 * all rewrite or read the same directories under `.nexysvhdl/`, so at most
 * one runs at a time for a project. `fn` runs only when the project is free;
 * otherwise `busy` is returned (it receives the operation already running)
 * and nothing is started. The claim is taken synchronously and released in a
 * `finally`, so success, failure, cancellation, timeout and exceptions all
 * free the project.
 *
 * The registry is module-wide, so every controller and backend instance in
 * this process shares it.
 */
export async function withProjectLock<T>(projectRoot: string, op: PipelineOperation, fn: () => Promise<T>, busy: (running: PipelineOperation) => T): Promise<T> {
    const key = keyOf(projectRoot);
    const running = active.get(key);
    if (running !== undefined) return busy(running);
    active.set(key, op);
    try {
        return await fn();
    } finally {
        if (active.get(key) === op) active.delete(key);
    }
}
