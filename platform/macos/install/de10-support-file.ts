import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { sha256File } from '../../../core/util/hash';
import type { ToolchainUnit } from './expected';
import { ArchivePayload } from './archive-payload';
import type { PayloadSource } from './payload';

/** What `payloads-1.0.json` records about one support archive. `bytes` is optional so older pins keep working. */
export interface PayloadPin {
    readonly file: string;
    readonly sha256: string;
    readonly bytes?: number;
}

export type SupportFileProblem = 'cancelled' | 'unreadable' | 'wrong-file' | 'damaged';

export type SupportFileCheck = { readonly ok: true } | { readonly ok: false; readonly problem: SupportFileProblem };

/**
 * Is `path` the support archive the pin describes? The sha256 is the identity; the name and size only decide what the student is told.
 *   - not a readable file                         -> unreadable
 *   - same size and sha256                        -> ok (a renamed copy, such as "file (1).tar.gz", is fine)
 *   - the pinned name, but size or sha256 differ  -> damaged (a truncated or corrupted download)
 *   - any other name with different content       -> wrong-file
 */
export async function checkSupportFile(path: string, pin: PayloadPin): Promise<SupportFileCheck> {
    const s = await stat(path).catch(() => undefined);
    if (!s?.isFile()) return { ok: false, problem: 'unreadable' };
    const sameName = basename(path) === pin.file;
    const reject = (): SupportFileCheck => ({ ok: false, problem: sameName ? 'damaged' : 'wrong-file' });
    if (pin.bytes !== undefined && s.size !== pin.bytes) return reject();
    try {
        if ((await sha256File(path)) !== pin.sha256) return reject();
    } catch {
        return { ok: false, problem: 'unreadable' };
    }
    return { ok: true };
}

/** The sentence the student reads for a rejected file. */
export function supportFileMessage(problem: SupportFileProblem, pin: PayloadPin, board: string): string {
    switch (problem) {
        case 'cancelled':
            return `${board} support was not installed because no support file was chosen. Choose Install ${board} Support when you have it.`;
        case 'wrong-file':
            return `That is not the ${board} support file. Choose ${pin.file}, which your course provides.`;
        case 'damaged':
            return `The ${board} support file is damaged or incomplete. Copy ${pin.file} from your course again and choose it again.`;
        case 'unreadable':
            return `The ${board} support file could not be read. Check that ${pin.file} is still there and choose it again.`;
    }
}

/**
 * The DE10-Lite support archive when nothing pinned is on this computer: the first time Setup needs a tool from it, the student is
 * asked for the file. It is checked (identity, size, sha256) before it is opened. A cancelled or rejected file leaves `problem` set and
 * the payload reports "nothing here", so the installer stops before changing anything and the controller says why.
 */
export class PickedArchivePayload implements PayloadSource {
    readonly kind = 'archive' as const;
    problem: SupportFileProblem | undefined;
    private inner: Promise<ArchivePayload | undefined> | undefined;
    private chosen: ArchivePayload | undefined;

    constructor(
        private readonly pin: PayloadPin,
        private readonly ask: () => Promise<string | undefined>,
        private readonly workRoot: string,
    ) {}

    describe(): string {
        return this.pin.file;
    }

    private resolve(): Promise<ArchivePayload | undefined> {
        this.inner ??= (async () => {
            const path = await this.ask();
            if (!path) {
                this.problem = 'cancelled';
                return undefined;
            }
            const check = await checkSupportFile(path, this.pin);
            if (!check.ok) {
                this.problem = check.problem;
                return undefined;
            }
            this.chosen = new ArchivePayload(path, this.pin.sha256, this.workRoot);
            return this.chosen;
        })();
        return this.inner;
    }

    async has(unit: ToolchainUnit): Promise<boolean> {
        const a = await this.resolve();
        return a ? a.has(unit) : false;
    }

    async materialize(unit: ToolchainUnit, dest: string, signal?: AbortSignal): Promise<void> {
        const a = await this.resolve();
        if (!a) throw new Error('The DE10-Lite support file was not accepted.');
        await a.materialize(unit, dest, signal);
    }

    async dispose(): Promise<void> {
        await this.chosen?.dispose();
    }
}
