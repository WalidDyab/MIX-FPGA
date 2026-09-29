import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { sha256File } from '../../../core';
import { digilentPartName, normalizeForDigilent, parseBitHeader } from '../../../platform/windows/digilent/bit-header';
import { PREPARED_BITSTREAM_NAME, prepareDigilentBitstream } from '../../../platform/windows/digilent/digilent-programmer';
import { repoBoards, tempDir } from '../../helpers';
import { buildBit, OPENXC7_FIELDS, sha256, syntheticPayload } from './windows-bit-builder';

const PART = 'xc7a100tcsg324-1';

describe('Windows: .bit header parsing', () => {
    it('parses the openXC7 layout and locates the payload', () => {
        const payload = syntheticPayload();
        const buf = buildBit({}, payload);
        const p = parseBitHeader(buf);
        assert.ok(p.ok);
        assert.equal(p.header.fields.b.toString('latin1'), `${PART}\0`);
        assert.equal(p.header.payloadLength, payload.length);
        assert.ok(buf.subarray(p.header.payloadOffset).equals(payload));
    });

    it('rejects malformed files with a reason instead of throwing', () => {
        const good = buildBit();
        const withoutNul = Buffer.from(good);
        withoutNul[13 + 3 + OPENXC7_FIELDS.a.length] = 0x41; // 'a' field's terminating NUL
        const lengthOff = good.length - syntheticPayload().length - 4;
        const cases: Record<string, Buffer> = {
            empty: Buffer.alloc(0),
            'bad preamble': Buffer.concat([Buffer.from([1]), good.subarray(1)]),
            'text file': Buffer.from('this is not a bitstream'),
            'truncated header': good.subarray(0, 30),
            'truncated payload': good.subarray(0, good.length - 10),
            'trailing bytes': Buffer.concat([good, Buffer.from([0])]),
            'missing NUL': withoutNul,
            'empty payload': buildBit({}, Buffer.alloc(0)),
            'wrong field order': Buffer.from(good.toString('latin1').replace('b\0', 'x\0'), 'latin1'),
            'bogus payload length': (() => {
                const b = Buffer.from(good);
                b.writeUInt32BE(0xffffffff, lengthOff);
                return b;
            })(),
        };
        for (const [name, buf] of Object.entries(cases)) {
            const p = parseBitHeader(buf);
            assert.equal(p.ok, false, name);
            assert.ok(!p.ok && p.reason.length > 0, name);
        }
    });

    it('maps implementation part names to the Digilent/Vivado form', () => {
        assert.equal(digilentPartName('xc7a100tcsg324-1'), '7a100tcsg324');
        assert.equal(digilentPartName('XC7A35TCPG236-1'), '7a35tcpg236');
        assert.equal(digilentPartName('7a100tcsg324'), '7a100tcsg324');
        assert.equal(digilentPartName('xc7a100tcsg324-2L'), '7a100tcsg324');
        assert.equal(digilentPartName('ice40hx8k'), undefined);
    });
});

describe('Windows: header normalization for djtgcfg', () => {
    it('changes only field b; the configuration payload stays byte-identical', () => {
        const payload = syntheticPayload();
        const source = buildBit({}, payload);
        const r = normalizeForDigilent(source, PART);
        assert.ok(r.ok);
        assert.equal(r.details.outcome, 'normalized');
        assert.equal(r.details.sourcePart, PART);
        assert.equal(r.details.targetPart, '7a100tcsg324');
        assert.equal(r.details.payloadSha256, sha256(payload));

        // The output is exactly what an independent builder produces with only b changed.
        assert.ok(r.output.equals(buildBit({ b: '7a100tcsg324' }, payload)));

        const before = parseBitHeader(source);
        const after = parseBitHeader(r.output);
        assert.ok(before.ok && after.ok);
        for (const k of ['a', 'c', 'd'] as const) assert.ok(after.header.fields[k].equals(before.header.fields[k]), `field ${k}`);
        assert.equal(after.header.fields.b.toString('latin1'), '7a100tcsg324\0');
        assert.ok(r.output.subarray(after.header.payloadOffset).equals(payload));
        assert.equal(r.output.length, source.length - 4); // "xc" and "-1" removed from the header only
    });

    it('is not a blind string replacement: part-name bytes inside the payload survive', () => {
        const payload = syntheticPayload();
        assert.ok(payload.includes('xc7a100tcsg324-1'));
        const r = normalizeForDigilent(buildBit({}, payload), PART);
        assert.ok(r.ok);
        const p = parseBitHeader(r.output);
        assert.ok(p.ok);
        assert.ok(r.output.subarray(p.header.payloadOffset).includes('xc7a100tcsg324-1'));
    });

    it('defines "already compatible": a Digilent-form header is returned byte-identical', () => {
        const source = buildBit({ a: 'top;UserID=0XFFFFFFFF;Version=2024.1', b: '7a100tcsg324' });
        const r = normalizeForDigilent(source, PART);
        assert.ok(r.ok);
        assert.equal(r.details.outcome, 'already-compatible');
        assert.ok(r.output.equals(source));
    });

    it('rejects a bitstream built for another part', () => {
        const r = normalizeForDigilent(buildBit({ b: 'xc7a35tcpg236-1' }), PART);
        assert.equal(r.ok, false);
        assert.equal(!r.ok && r.diagnostics[0]!.code, 'DIGILENT_BIT_PART_MISMATCH');
    });

    it('rejects malformed input and unknown board parts with structured diagnostics', () => {
        const bad = normalizeForDigilent(Buffer.from('garbage'), PART);
        assert.equal(!bad.ok && bad.diagnostics[0]!.code, 'DIGILENT_BIT_MALFORMED');
        assert.equal(!bad.ok && bad.diagnostics[0]!.source, 'programming');
        const unknown = normalizeForDigilent(buildBit(), 'ice40hx8k-ct256');
        assert.equal(!unknown.ok && unknown.diagnostics[0]!.code, 'DIGILENT_BIT_PART_UNSUPPORTED');
    });
});

describe('Windows: preparing the programming artifact on disk', () => {
    async function setup(t: Parameters<typeof tempDir>[0], bit: Buffer = buildBit()) {
        const dir = await tempDir(t);
        const canonical = join(dir, 'impl', 'hardware.bit');
        await mkdir(join(dir, 'impl'), { recursive: true });
        await writeFile(canonical, bit);
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        return { dir, canonical, outputDir: join(dir, 'program'), board };
    }

    it('writes a separate prepared file and never modifies the canonical file', async (t) => {
        const payload = syntheticPayload();
        const { canonical, outputDir, board } = await setup(t, buildBit({}, payload));
        const canonicalBytes = await readFile(canonical);
        const hashBefore = await sha256File(canonical);

        const r = await prepareDigilentBitstream(canonical, outputDir, board);
        assert.ok(r.ok);
        assert.equal(r.path, join(outputDir, PREPARED_BITSTREAM_NAME));
        assert.notEqual(resolve(r.path), resolve(canonical));

        assert.equal(await sha256File(canonical), hashBefore);
        assert.ok((await readFile(canonical)).equals(canonicalBytes));

        const prepared = await readFile(r.path);
        const p = parseBitHeader(prepared);
        assert.ok(p.ok);
        assert.equal(sha256(prepared.subarray(p.header.payloadOffset)), sha256(payload));
        assert.equal(r.sha256, sha256(prepared));
        assert.deepEqual((await readdir(outputDir)).sort(), [PREPARED_BITSTREAM_NAME]); // no temp files left
    });

    it('refuses to write over the canonical file', async (t) => {
        const { dir, board } = await setup(t);
        const canonical = join(dir, 'program', PREPARED_BITSTREAM_NAME);
        await mkdir(join(dir, 'program'), { recursive: true });
        await writeFile(canonical, buildBit());
        const r = await prepareDigilentBitstream(canonical, join(dir, 'program'), board);
        assert.equal(!r.ok && r.diagnostics[0]!.code, 'DIGILENT_PREPARE_WOULD_OVERWRITE');
    });

    it('reports a missing or malformed canonical file without writing anything', async (t) => {
        const { dir, canonical, outputDir, board } = await setup(t, Buffer.from('not a bitstream'));
        const malformed = await prepareDigilentBitstream(canonical, outputDir, board);
        assert.equal(!malformed.ok && malformed.diagnostics[0]!.code, 'DIGILENT_BIT_MALFORMED');
        const missing = await prepareDigilentBitstream(join(dir, 'nope.bit'), outputDir, board);
        assert.equal(!missing.ok && missing.diagnostics[0]!.code, 'DIGILENT_BIT_UNREADABLE');
        await assert.rejects(readdir(outputDir));
    });
});
