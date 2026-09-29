import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { REPO } from '../../helpers';

export const WINDOWS_FIXTURES = join(REPO, 'tests', 'fixtures', 'windows');
export const DJTGCFG_FIXTURES = join(WINDOWS_FIXTURES, 'djtgcfg');

/** Header strings as openXC7's xc7frames2bit writes them (Phase 1B). */
export const OPENXC7_FIELDS = {
    a: 'build\\default\\hardware.frames;Generator=xc7frames2bit',
    b: 'xc7a100tcsg324-1',
    c: '2026/09/29',
    d: '12:00:00',
};

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * A synthetic configuration payload: random bytes that also contain the part
 * name strings, so a blind find/replace over the file would corrupt it.
 */
export function syntheticPayload(size = 4096): Buffer {
    return Buffer.concat([
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0xaa, 0x99, 0x55, 0x66]), // dummy + sync word
        Buffer.from('xc7a100tcsg324-1\0', 'latin1'),
        randomBytes(size),
        Buffer.from('7a100tcsg324\0b\0xc7a100tcsg324-1', 'latin1'),
    ]);
}

function field(key: string, text: string): Buffer {
    const value = Buffer.from(`${text}\0`, 'latin1');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(value.length);
    return Buffer.concat([Buffer.from(key, 'latin1'), len, value]);
}

/** Builds a Xilinx .bit file (independently of the code under test). */
export function buildBit(fields: Partial<typeof OPENXC7_FIELDS> = {}, payload: Buffer = syntheticPayload()): Buffer {
    const f = { ...OPENXC7_FIELDS, ...fields };
    const plen = Buffer.alloc(4);
    plen.writeUInt32BE(payload.length);
    return Buffer.concat([
        Buffer.from('00090ff00ff00ff00ff0000001', 'hex'), // u16 9, 9-byte preamble, u16 1
        field('a', f.a),
        field('b', f.b),
        field('c', f.c),
        field('d', f.d),
        Buffer.from('e', 'latin1'),
        plen,
        payload,
    ]);
}
