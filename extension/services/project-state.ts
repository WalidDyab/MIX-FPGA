import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_DIR_NAME, writeFileAtomic } from '../../core';
import { Emitter } from './events';

/** The small key/value store the views use (a VS Code Memento has the same shape). */
export interface StateStore {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

export const PROJECT_STATE_FILE = 'state.json';
const STATE_VERSION = 1;

interface StateFile {
    readonly version: number;
    readonly values: Record<string, unknown>;
}

export interface ProjectStateOptions {
    /** Delay that coalesces bursts of changes (a dragged splitter) into one write (ms). */
    readonly debounceMs?: number;
}

/**
 * NexysVHDL's own per-project workspace state: the choices a student makes in the interface
 * that are not part of the design itself (Design view mode, waveform signals, Display As, pane
 * widths, schematic view). It lives in `<project>/.nexysvhdl/state.json`, so it travels with the
 * project folder and does not depend on VS Code's opaque per-workspace storage.
 *
 * Writes are debounced (a splitter drag fires many updates) but never lost: `flush()` writes
 * whatever is pending right now and waits for any write already in flight; it runs when the
 * project changes, when the window is reloaded and when VS Code shuts the extension down.
 * Files are replaced atomically, so a crash cannot leave a half-written state file, and a
 * damaged one is ignored (the defaults apply) instead of blocking the project.
 */
export class ProjectState implements StateStore {
    private root: string | undefined;
    private values: Record<string, unknown> = {};
    private dirty = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private writing: Promise<void> = Promise.resolve();
    private waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
    private readonly attached = new Emitter<string>();
    /** Fires after a project's saved state has been loaded (views re-read what they remember). */
    readonly onDidAttach = this.attached.event;
    /** Write delay (ms). Public so validation can stretch it to prove the exit flush; nothing else changes it. */
    debounceMs: number;
    /** The most recent write error, for diagnostics; cleared by the next successful write. */
    lastError: Error | undefined;

    constructor(options: ProjectStateOptions = {}) {
        this.debounceMs = options.debounceMs ?? 250;
    }

    get file(): string | undefined {
        return this.root ? join(this.root, WORKSPACE_DIR_NAME, PROJECT_STATE_FILE) : undefined;
    }

    /** True while a change has not reached the disk yet. */
    get pending(): boolean {
        return this.dirty || this.timer !== undefined;
    }

    /**
     * Switches to a project: flushes the previous project's pending changes first, then loads the
     * saved state. Values missing from the file are taken from `legacy` (state an earlier
     * version kept in VS Code's own workspace storage) the first time.
     */
    async attach(root: string, legacy?: { readonly store: StateStore; readonly keys: readonly string[] }): Promise<void> {
        await this.flush();
        this.root = root;
        this.values = await this.read(root);
        let migrated = false;
        if (legacy) {
            for (const key of legacy.keys) {
                const old = legacy.store.get(key);
                if (old !== undefined && !(key in this.values)) {
                    this.values[key] = old;
                    migrated = true;
                }
            }
        }
        if (migrated) this.schedule();
        this.attached.fire(root);
    }

    private async read(root: string): Promise<Record<string, unknown>> {
        try {
            const data = JSON.parse(await readFile(join(root, WORKSPACE_DIR_NAME, PROJECT_STATE_FILE), 'utf8')) as Partial<StateFile>;
            if (typeof data === 'object' && data !== null && typeof data.values === 'object' && data.values !== null && !Array.isArray(data.values)) return { ...data.values };
        } catch {
            /* no saved state yet, or a damaged file: start from the defaults */
        }
        return {};
    }

    get<T>(key: string): T | undefined {
        return this.values[key] as T | undefined;
    }

    /**
     * Records a value. The change is visible at once; the returned promise settles when it has
     * been written to disk (callers that only remember a preference can ignore it).
     */
    update(key: string, value: unknown): Promise<void> {
        if (!this.root) return Promise.resolve();
        if (value === undefined) delete this.values[key];
        else this.values[key] = value;
        return this.schedule();
    }

    private schedule(): Promise<void> {
        this.dirty = true;
        const done = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.writeNow().catch(() => undefined);
        }, this.debounceMs);
        // A caller that ignores the promise must not trigger an unhandled rejection.
        done.catch(() => undefined);
        return done;
    }

    /** Writes pending changes now and waits until nothing is pending or in flight. */
    async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        await this.writeNow();
        await this.writing.catch(() => undefined);
    }

    private writeNow(): Promise<void> {
        // Chained, so two writes never interleave and the later one always wins.
        const run = this.writing.catch(() => undefined).then(async () => {
            const root = this.root;
            if (!this.dirty || !root) {
                this.settle();
                return;
            }
            this.dirty = false;
            const waiting = this.waiters.splice(0);
            try {
                await mkdir(join(root, WORKSPACE_DIR_NAME), { recursive: true });
                const text = JSON.stringify({ version: STATE_VERSION, values: this.values } satisfies StateFile, null, 2) + '\n';
                await writeFileAtomic(join(root, WORKSPACE_DIR_NAME, PROJECT_STATE_FILE), text);
                this.lastError = undefined;
                waiting.forEach((w) => w.resolve());
            } catch (err) {
                this.dirty = true; // keep it: the next flush retries
                this.lastError = err as Error;
                waiting.forEach((w) => w.reject(err));
                throw err;
            }
        });
        this.writing = run;
        return run;
    }

    private settle(): void {
        for (const w of this.waiters.splice(0)) w.resolve();
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.attached.dispose();
    }
}
