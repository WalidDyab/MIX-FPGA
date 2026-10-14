import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { sha256File } from '../../../core/util/hash';

export interface DownloadRequest {
    readonly url: string;
    readonly dest: string;
    readonly sha256: string;
    readonly bytes?: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: (done: number, total: number | undefined) => void;
}

export type DownloadResult = { readonly ok: true; readonly reused: boolean } | { readonly ok: false; readonly code: 'NETWORK' | 'HASH_MISMATCH' | 'CANCELLED' | 'HTTP'; readonly message: string };

/** A downloader the installer can replace in tests. */
export type Downloader = (req: DownloadRequest) => Promise<DownloadResult>;

const exists = (p: string) => stat(p).then((s) => s.isFile(), () => false);

/**
 * Downloads `url` into `dest`, verified against `sha256`, resumable.
 *  - A file already at `dest` is trusted only after its hash is checked (a bad one is replaced, never used).
 *  - Bytes arrive in `dest.part`; an interrupted download continues from there with a Range request.
 *  - The file appears at `dest` (by rename) only after its hash matches.
 */
export const httpDownloader: Downloader = async (req) => {
    try {
        if (await exists(req.dest)) {
            if ((await sha256File(req.dest)) === req.sha256) return { ok: true, reused: true };
            await rm(req.dest, { force: true });
        }
        await mkdir(dirname(req.dest), { recursive: true });
        const part = `${req.dest}.part`;
        let have = (await stat(part).then((s) => s.size, () => 0)) || 0;
        const res = await fetch(req.url, { ...(have > 0 ? { headers: { Range: `bytes=${have}-` } } : {}), ...(req.signal ? { signal: req.signal } : {}) });
        if (res.status === 416 && have > 0) {
            // The partial file already holds everything (or is longer than the file): start over from its hash.
            if ((await sha256File(part)) === req.sha256) {
                await rename(part, req.dest);
                return { ok: true, reused: false };
            }
            await rm(part, { force: true });
            return httpDownloader(req);
        }
        if (!res.ok || !res.body) return { ok: false, code: 'HTTP', message: `The download server answered ${res.status}.` };
        if (res.status === 200 && have > 0) {
            // The server ignored the Range request: restart from zero.
            await rm(part, { force: true });
            have = 0;
        }
        const total = res.headers.get('content-length') ? Number(res.headers.get('content-length')) + have : req.bytes;
        const out = createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
        let done = have;
        const reader = res.body.getReader();
        try {
            for (;;) {
                const { value, done: finished } = await reader.read();
                if (finished) break;
                if (!out.write(value)) await new Promise<void>((r) => out.once('drain', r));
                done += value.length;
                req.onProgress?.(done, total);
            }
        } finally {
            await new Promise<void>((r) => out.end(r));
        }
        if ((await sha256File(part)) !== req.sha256) {
            await rm(part, { force: true });
            return { ok: false, code: 'HASH_MISMATCH', message: 'The downloaded file does not match the expected checksum and was discarded.' };
        }
        await rename(part, req.dest);
        return { ok: true, reused: false };
    } catch (err) {
        if (req.signal?.aborted) return { ok: false, code: 'CANCELLED', message: 'Download cancelled; it can be resumed.' };
        return { ok: false, code: 'NETWORK', message: `The download could not be completed (${err instanceof Error ? err.message : String(err)}). Check the internet connection and try again; it will continue where it stopped.` };
    }
};
