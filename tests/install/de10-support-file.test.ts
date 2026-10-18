import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkSupportFile, supportFileMessage, type PayloadPin } from '../../platform/macos/install/de10-support-file';
import { ONLY_MACOS } from '../platform';
import { rig, type Rig } from './setup-rig';
import { stat } from 'node:fs/promises';

const FILE = 'mixfpga-de10-lite-support-1.0-macos-arm64.tar.gz';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const exists = (p: string) => stat(p).then(() => true, () => false);

async function scratch(t: { after(fn: () => unknown): void }): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mf-de10file-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

describe('DE10-Lite support file check (name, size, sha256)', () => {
    const content = Buffer.from('pretend support archive '.repeat(100));
    const pin: PayloadPin = { file: FILE, sha256: sha(content), bytes: content.length };

    it('accepts the exact file', async (t) => {
        const dir = await scratch(t);
        await writeFile(join(dir, FILE), content);
        assert.deepEqual(await checkSupportFile(join(dir, FILE), pin), { ok: true });
    });

    it('accepts a renamed copy of the right bytes (a browser may add "(1)")', async (t) => {
        const dir = await scratch(t);
        await writeFile(join(dir, 'support (1).tar.gz'), content);
        assert.deepEqual(await checkSupportFile(join(dir, 'support (1).tar.gz'), pin), { ok: true });
    });

    it('a different file is the wrong file', async (t) => {
        const dir = await scratch(t);
        await writeFile(join(dir, 'nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz'), Buffer.from('something else entirely'));
        assert.deepEqual(await checkSupportFile(join(dir, 'nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz'), pin), { ok: false, problem: 'wrong-file' });
    });

    it('the right name with a wrong size (truncated download) is damaged, without hashing', async (t) => {
        const dir = await scratch(t);
        await writeFile(join(dir, FILE), content.subarray(0, content.length - 10));
        assert.deepEqual(await checkSupportFile(join(dir, FILE), pin), { ok: false, problem: 'damaged' });
    });

    it('the right name and size with one changed byte is damaged', async (t) => {
        const dir = await scratch(t);
        const bad = Buffer.from(content);
        bad[7] = bad[7]! ^ 0xff;
        await writeFile(join(dir, FILE), bad);
        assert.deepEqual(await checkSupportFile(join(dir, FILE), pin), { ok: false, problem: 'damaged' });
    });

    it('a pin without a recorded size is still checked by sha256', async (t) => {
        const dir = await scratch(t);
        await writeFile(join(dir, FILE), Buffer.from('x'));
        assert.deepEqual(await checkSupportFile(join(dir, FILE), { file: FILE, sha256: pin.sha256 }), { ok: false, problem: 'damaged' });
    });

    it('a missing path or a folder is unreadable', async (t) => {
        const dir = await scratch(t);
        assert.deepEqual(await checkSupportFile(join(dir, 'nope.tar.gz'), pin), { ok: false, problem: 'unreadable' });
        assert.deepEqual(await checkSupportFile(dir, pin), { ok: false, problem: 'unreadable' });
    });

    it('every message names the file the student needs and uses no engineering words', () => {
        for (const p of ['cancelled', 'wrong-file', 'damaged', 'unreadable'] as const) {
            const m = supportFileMessage(p, pin, 'DE10-Lite');
            assert.match(m, /DE10-Lite/);
            if (p !== 'cancelled') assert.ok(m.includes(FILE), m);
            assert.doesNotMatch(m, /sha|hash|archive|payload|manifest/i);
        }
    });
});

describe('DE10-Lite support through the production file picker', () => {
    const nothingInstalled = async (r: Rig) => {
        assert.equal(await exists(r.layout.toolchainDir), false, 'no DE10 tools');
        assert.equal(await exists(r.layout.instanceDir), false, 'no engine');
        assert.equal(r.m.count('create'), 0);
        assert.equal(r.m.quartusInstalls, 0);
    };

    it('correct file: asked once, installed, extracted copy removed; no development folder or variable involved', { skip: ONLY_MACOS }, async (t) => {
        assert.equal(process.env['MIXFPGA_DEV_PAYLOAD'], undefined, 'the student path runs without MIXFPGA_DEV_PAYLOAD');
        const r = await rig(t, { de10Picked: true });
        r.ui.boards = ['de10-lite'];
        const out = await r.ctl.install(r.ui);
        assert.equal(out.outcome, 'complete', `${out.message} ${r.ui.logs.join(' | ')}`);
        assert.equal(r.ui.questions.filter((q) => q === 'de10-file').length, 1);
        assert.equal(await exists(join(r.layout.toolchainDir, 'manifest.json')) || (await exists(r.layout.toolchainDir)), true);
        assert.equal(r.m.count('create'), 1);
        assert.equal(await exists(join(r.layout.root, '.payload')) && (await import('node:fs/promises').then((x) => x.readdir(join(r.layout.root, '.payload')))).length > 0, false, 'extracted payload removed');
    });

    it('wrong file: refused with a plain message, nothing installed, and a retry with the right file works', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t, { de10Picked: true });
        const right = r.ui.de10Archive!;
        r.ui.boards = ['de10-lite'];
        r.ui.de10Archive = r.nexysArchive;
        const out = await r.ctl.install(r.ui);
        assert.equal(out.outcome, 'failed');
        assert.match(out.message, /not the DE10-Lite support file/);
        assert.ok(out.message.includes(FILE));
        await nothingInstalled(r);
        r.ui.de10Archive = right;
        assert.equal((await r.ctl.install(r.ui)).outcome, 'complete');
    });

    it('corrupted file (right name, one byte changed): refused as damaged, nothing installed', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t, { de10Picked: true });
        const dir = join(r.f.dir, 'copied');
        await mkdir(dir);
        const bad = join(dir, FILE);
        await cp(r.ui.de10Archive!, bad);
        const bytes = await readFile(bad);
        bytes[bytes.length >> 1] = bytes[bytes.length >> 1]! ^ 0xff;
        await writeFile(bad, bytes);
        r.ui.boards = ['de10-lite'];
        r.ui.de10Archive = bad;
        const out = await r.ctl.install(r.ui);
        assert.equal(out.outcome, 'failed');
        assert.match(out.message, /damaged or incomplete/);
        await nothingInstalled(r);
    });

    it('Cancel: stops cleanly with nothing installed, and Install later succeeds', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t, { de10Picked: true });
        const right = r.ui.de10Archive!;
        r.ui.boards = ['de10-lite'];
        r.ui.de10Archive = undefined;
        const out = await r.ctl.install(r.ui);
        assert.equal(out.outcome, 'stopped');
        assert.match(out.message, /no support file was chosen/);
        await nothingInstalled(r);
        r.ui.de10Archive = right;
        assert.equal((await r.ctl.install(r.ui)).outcome, 'complete');
    });

    it('is not asked again once the DE10-Lite tools are installed', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t, { de10Picked: true });
        r.ui.boards = ['de10-lite'];
        assert.equal((await r.ctl.install(r.ui)).outcome, 'complete');
        r.ui.questions.length = 0;
        r.ui.de10Archive = undefined;
        const again = await r.ctl.install(r.ui, undefined, ['de10-lite']);
        assert.equal(again.outcome, 'complete');
        assert.ok(!r.ui.questions.includes('de10-file'));
    });

    it('a Nexys-only install never asks for the DE10-Lite file', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t, { de10Picked: true });
        r.ui.boards = ['nexys-a7-100t'];
        assert.equal((await r.ctl.install(r.ui)).outcome, 'complete');
        assert.ok(!r.ui.questions.includes('de10-file'));
    });
});
