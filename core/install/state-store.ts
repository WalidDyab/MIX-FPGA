import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from '../util/atomic-write';
import type { ComponentId } from './model';

/**
 * What survives a crash. Only facts that cannot be re-derived from the machine are stored:
 * that an operation was running (so a dead one can be reported as interrupted) and why the
 * last attempt failed. Readiness itself is always inspected, never read from here.
 */
export interface PersistedComponent {
    readonly operation?: { readonly id: string; readonly pid: number; readonly startedAt: string };
    readonly failure?: { readonly code: string; readonly message: string; readonly at: string };
    /** A previous operation died without finishing. Cleared by the next success. */
    readonly interrupted?: boolean;
}

export interface InstallStateFile {
    readonly schemaVersion: 1;
    readonly components: Readonly<Record<ComponentId, PersistedComponent>>;
}

const EMPTY: InstallStateFile = { schemaVersion: 1, components: {} };

/** Operations running in this process, so a live one is never mistaken for a dead one that shares our pid. */
const liveOperations = new Set<string>();

export function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export function operationAlive(op: { id: string; pid: number }, isPidAlive: (pid: number) => boolean = pidAlive): boolean {
    return op.pid === process.pid ? liveOperations.has(op.id) : isPidAlive(op.pid);
}

export class InstallStateStore {
    constructor(
        readonly file: string,
        readonly lockFile: string,
        private readonly isPidAlive: (pid: number) => boolean = pidAlive,
    ) {}

    /** A missing, unreadable or foreign file is an empty state: readiness is re-derived anyway. */
    async read(): Promise<InstallStateFile> {
        try {
            const parsed = JSON.parse(await readFile(this.file, 'utf8')) as InstallStateFile;
            return parsed.schemaVersion === 1 && parsed.components && typeof parsed.components === 'object' ? parsed : EMPTY;
        } catch {
            return EMPTY;
        }
    }

    private async write(state: InstallStateFile): Promise<void> {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
    }

    private async update(ids: readonly ComponentId[], change: (c: PersistedComponent) => PersistedComponent | undefined): Promise<void> {
        const state = await this.read();
        const components: Record<ComponentId, PersistedComponent> = { ...state.components };
        for (const id of ids) {
            const next = change(components[id] ?? {});
            if (next && Object.keys(next).length > 0) components[id] = next;
            else delete components[id];
        }
        await this.write({ schemaVersion: 1, components });
    }

    async begin(ids: readonly ComponentId[], opId: string): Promise<void> {
        liveOperations.add(opId);
        await this.update(ids, (c) => ({ ...(c.interrupted ? { interrupted: true } : {}), operation: { id: opId, pid: process.pid, startedAt: new Date().toISOString() } }));
    }

    async succeed(ids: readonly ComponentId[], opId: string): Promise<void> {
        liveOperations.delete(opId);
        await this.update(ids, () => undefined);
    }

    async fail(ids: readonly ComponentId[], opId: string, failure: { code: string; message: string }): Promise<void> {
        liveOperations.delete(opId);
        await this.update(ids, () => ({ failure: { ...failure, at: new Date().toISOString() } }));
    }

    /** Release an operation without recording an outcome (cancelled by the student). */
    async release(ids: readonly ComponentId[], opId: string): Promise<void> {
        liveOperations.delete(opId);
        await this.update(ids, (c) => {
            const { operation: _op, ...rest } = c;
            return rest;
        });
    }

    /** Turn operations whose process is gone into `interrupted`, so the next run resumes and the UI says "repairable". */
    async markDeadOperationsInterrupted(): Promise<void> {
        const state = await this.read();
        const dead = Object.entries(state.components).filter(([, c]) => c.operation && !operationAlive(c.operation, this.isPidAlive)).map(([id]) => id);
        if (dead.length === 0) return;
        await this.update(dead, (c) => {
            const { operation: _op, ...rest } = c;
            return { ...rest, interrupted: true };
        });
    }

    /**
     * One setup run at a time across processes. A lock whose owner is gone is taken over.
     * Returns a release function, or undefined when a live run holds it.
     */
    async acquireLock(opId: string): Promise<(() => Promise<void>) | undefined> {
        await mkdir(dirname(this.lockFile), { recursive: true });
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await writeFile(this.lockFile, JSON.stringify({ pid: process.pid, op: opId }), { flag: 'wx' });
                liveOperations.add(opId);
                return async () => {
                    liveOperations.delete(opId);
                    await rm(this.lockFile, { force: true });
                };
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
                const owner = await readFile(this.lockFile, 'utf8').then((t) => JSON.parse(t) as { pid?: number; op?: string }, () => ({}) as { pid?: number; op?: string });
                if (typeof owner.pid === 'number' && operationAlive({ id: owner.op ?? '', pid: owner.pid }, this.isPidAlive)) return undefined;
                await rm(this.lockFile, { force: true });
            }
        }
        return undefined;
    }
}
