import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Writes a text file so a reader (or a crash) never sees half of it: the text goes to a
 * temporary file beside the target, which then replaces the target in one rename. On Windows
 * the rename can be refused for a moment while a watcher or antivirus scanner holds the target;
 * it is retried briefly, and as a last resort the target is written directly.
 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
    const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, text, 'utf8');
    for (let attempt = 0; ; attempt++) {
        try {
            await rename(tmp, file);
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < 6) {
                await sleep(25 * (attempt + 1));
                continue;
            }
            await rm(tmp, { force: true });
            if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
                await writeFile(file, text, 'utf8');
                return;
            }
            throw err;
        }
    }
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Runs read-modify-write jobs on one file strictly one after another, so two updates that
 * start together can never overwrite each other with stale content.
 */
export function serializeFileJob<T>(file: string, job: () => Promise<T>): Promise<T> {
    const key = file;
    const run = (queues.get(key) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
}

/** Resolves once every queued file job has finished (including jobs queued while waiting). Used to flush before exit. */
export async function whenFileJobsSettled(): Promise<void> {
    while (queues.size > 0) await Promise.all([...queues.values()]);
}
