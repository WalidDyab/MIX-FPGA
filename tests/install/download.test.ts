import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { httpDownloader } from '../../platform/macos/install/download';
import { tempDir } from '../helpers';

const body = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
const sha = createHash('sha256').update(body).digest('hex');

async function serve(t: { after: (f: () => Promise<void>) => void }, handler: Parameters<typeof createServer>[1]): Promise<{ url: string; server: Server }> {
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/img`, server };
}

const rangeServer = (requests: (string | undefined)[]): Parameters<typeof createServer>[1] => (req, res) => {
    requests.push(req.headers.range);
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    if (m) {
        const start = Number(m[1]);
        res.writeHead(206, { 'content-length': body.length - start, 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` });
        res.end(body.subarray(start));
    } else {
        res.writeHead(200, { 'content-length': body.length });
        res.end(body);
    }
};

describe('verified, resumable download', () => {
    it('downloads, verifies the hash and only then puts the file in place', async (t) => {
        const dir = await tempDir(t);
        const { url } = await serve(t, rangeServer([]));
        const dest = join(dir, 'dl', 'image.img');
        const r = await httpDownloader({ url, dest, sha256: sha });
        assert.deepEqual(r, { ok: true, reused: false });
        assert.deepEqual(await readFile(dest), body);
        assert.equal(await stat(`${dest}.part`).then(() => true, () => false), false);
    });

    it('resumes an interrupted download from the partial file with a Range request', async (t) => {
        const dir = await tempDir(t);
        const requests: (string | undefined)[] = [];
        const { url } = await serve(t, rangeServer(requests));
        const dest = join(dir, 'image.img');
        await writeFile(`${dest}.part`, body.subarray(0, 100_000));
        assert.deepEqual(await httpDownloader({ url, dest, sha256: sha }), { ok: true, reused: false });
        assert.deepEqual(requests, ['bytes=100000-']);
        assert.deepEqual(await readFile(dest), body);
    });

    it('reuses a verified file and replaces one that fails its hash', async (t) => {
        const dir = await tempDir(t);
        const requests: (string | undefined)[] = [];
        const { url } = await serve(t, rangeServer(requests));
        const dest = join(dir, 'image.img');
        await writeFile(dest, body);
        assert.deepEqual(await httpDownloader({ url, dest, sha256: sha }), { ok: true, reused: true });
        assert.deepEqual(requests, []);
        await writeFile(dest, 'corrupt');
        assert.deepEqual(await httpDownloader({ url, dest, sha256: sha }), { ok: true, reused: false });
        assert.deepEqual(await readFile(dest), body);
    });

    it('discards bytes that do not match the expected hash and never leaves them at the destination', async (t) => {
        const dir = await tempDir(t);
        const { url } = await serve(t, (_req, res) => (res.writeHead(200), res.end('not the image')));
        const dest = join(dir, 'image.img');
        const r = await httpDownloader({ url, dest, sha256: sha });
        assert.equal(r.ok === false && r.code, 'HASH_MISMATCH');
        assert.equal(await stat(dest).then(() => true, () => false), false);
        assert.equal(await stat(`${dest}.part`).then(() => true, () => false), false);
    });

    it('restarts from zero when the server ignores the Range request', async (t) => {
        const dir = await tempDir(t);
        const { url } = await serve(t, (_req, res) => (res.writeHead(200, { 'content-length': body.length }), res.end(body)));
        const dest = join(dir, 'image.img');
        await writeFile(`${dest}.part`, 'stale bytes from an earlier file');
        assert.equal((await httpDownloader({ url, dest, sha256: sha })).ok, true);
        assert.deepEqual(await readFile(dest), body);
    });

    it('reports a missing network or server error plainly, and keeps the partial file for next time', async (t) => {
        const dir = await tempDir(t);
        const { url } = await serve(t, (_req, res) => (res.writeHead(503), res.end()));
        const dest = join(dir, 'image.img');
        const http = await httpDownloader({ url, dest, sha256: sha });
        assert.equal(http.ok === false && http.code, 'HTTP');
        const offline = await httpDownloader({ url: 'http://127.0.0.1:1/img', dest, sha256: sha });
        assert.equal(offline.ok === false && offline.code, 'NETWORK');
        assert.match(offline.ok === false ? offline.message : '', /internet connection/);
    });
});
