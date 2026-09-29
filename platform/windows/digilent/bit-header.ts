import { createHash } from 'node:crypto';
import { type Diagnostic, errorDiag } from '../../../core';

/**
 * Xilinx `.bit` container, as written by Vivado and openXC7's xc7frames2bit:
 *
 *   u16 9, 0F F0 0F F0 0F F0 0F F0 00     preamble
 *   u16 1
 *   'a' u16 len  text\0                   design name / generator
 *   'b' u16 len  text\0                   part name        <- only field we rewrite
 *   'c' u16 len  text\0                   date
 *   'd' u16 len  text\0                   time
 *   'e' u32 len  payload                  configuration data (sent to the FPGA)
 *
 * All integers are big-endian. The payload must run to the end of the file.
 */

const PREAMBLE = Buffer.from([0x00, 0x09, 0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0, 0x00, 0x00, 0x01]);
const TEXT_KEYS = ['a', 'b', 'c', 'd'] as const;
type TextKey = (typeof TEXT_KEYS)[number];

export interface BitHeader {
    /** Raw field values including the terminating NUL. */
    readonly fields: Readonly<Record<TextKey, Buffer>>;
    readonly payloadOffset: number;
    readonly payloadLength: number;
}

export type BitParseResult = { readonly ok: true; readonly header: BitHeader } | { readonly ok: false; readonly reason: string };

/** Decoded text of a header field (NUL stripped). */
export function fieldText(value: Buffer): string {
    return value.subarray(0, value.length - 1).toString('latin1');
}

/** Structural parse; never throws. Rejects anything that is not exactly the layout above. */
export function parseBitHeader(buf: Buffer): BitParseResult {
    const fail = (reason: string): BitParseResult => ({ ok: false, reason });
    if (buf.length < PREAMBLE.length || !buf.subarray(0, PREAMBLE.length).equals(PREAMBLE)) {
        return fail('not a Xilinx .bit file (bad preamble)');
    }
    let o = PREAMBLE.length;
    const fields: Partial<Record<TextKey, Buffer>> = {};
    for (const key of TEXT_KEYS) {
        if (o + 3 > buf.length) return fail(`truncated before field '${key}'`);
        const actual = String.fromCharCode(buf[o]!);
        if (actual !== key) return fail(`expected field '${key}' at offset ${o}, found 0x${buf[o]!.toString(16).padStart(2, '0')}`);
        const len = buf.readUInt16BE(o + 1);
        o += 3;
        if (len < 1 || o + len > buf.length) return fail(`field '${key}' length ${len} is out of range`);
        const value = buf.subarray(o, o + len);
        if (value[len - 1] !== 0) return fail(`field '${key}' is not NUL-terminated`);
        if (key === 'b' && value.subarray(0, len - 1).some((c) => c < 0x21 || c > 0x7e)) return fail(`part name field 'b' contains unexpected bytes`);
        fields[key] = value;
        o += len;
    }
    if (o + 5 > buf.length || buf[o] !== 0x65 /* 'e' */) return fail(`expected payload field 'e' at offset ${o}`);
    const payloadLength = buf.readUInt32BE(o + 1);
    const payloadOffset = o + 5;
    if (payloadLength === 0) return fail('payload is empty');
    if (payloadOffset + payloadLength !== buf.length) {
        return fail(`payload length ${payloadLength} does not match the ${buf.length - payloadOffset} bytes after the header`);
    }
    return { ok: true, header: { fields: fields as Record<TextKey, Buffer>, payloadOffset, payloadLength } };
}

/** Serialises a header + payload in the layout above. */
export function serializeBit(fields: Readonly<Record<TextKey, Buffer>>, payload: Buffer): Buffer {
    const parts: Buffer[] = [PREAMBLE];
    for (const key of TEXT_KEYS) {
        const len = Buffer.alloc(2);
        len.writeUInt16BE(fields[key].length);
        parts.push(Buffer.from(key, 'latin1'), len, fields[key]);
    }
    const plen = Buffer.alloc(4);
    plen.writeUInt32BE(payload.length);
    parts.push(Buffer.from('e', 'latin1'), plen, payload);
    return Buffer.concat(parts);
}

/**
 * Vivado/Digilent form of a 7-series part name: `xc7a100tcsg324-1` -> `7a100tcsg324`
 * (no `xc` prefix, no speed grade). Undefined if the name is not recognised.
 */
export function digilentPartName(part: string): string | undefined {
    return /^(?:xc)?(7[a-z]\d+t[a-z]+\d+)(?:-\d+l?)?$/i.exec(part.trim())?.[1]?.toLowerCase();
}

export type NormalizeOutcome = 'normalized' | 'already-compatible';

export interface NormalizeDetails {
    readonly outcome: NormalizeOutcome;
    readonly sourcePart: string;
    readonly targetPart: string;
    readonly payloadLength: number;
    readonly payloadSha256: string;
}

export type NormalizeResult =
    | { readonly ok: true; readonly output: Buffer; readonly details: NormalizeDetails }
    | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Produces the Digilent-compatible bytes of a `.bit` file. Pure.
 *
 * - Only header field `b` (part name) may change: from the implementation part
 *   (`expectedPart`, e.g. `xc7a100tcsg324-1`) to its Digilent form (`7a100tcsg324`).
 * - A header that already carries the Digilent form is returned byte-identical
 *   (`already-compatible`).
 * - A part name for any other device, or a malformed file, is rejected.
 * - The result is re-parsed and every other field and the payload are verified
 *   byte-identical before it is returned.
 */
export function normalizeForDigilent(source: Buffer, expectedPart: string): NormalizeResult {
    const reject = (code: string, message: string): NormalizeResult => ({ ok: false, diagnostics: [errorDiag('programming', code, message)] });

    const target = digilentPartName(expectedPart);
    if (!target) return reject('DIGILENT_BIT_PART_UNSUPPORTED', `Board part "${expectedPart}" has no known Digilent header form.`);

    const parsed = parseBitHeader(source);
    if (!parsed.ok) return reject('DIGILENT_BIT_MALFORMED', `The bitstream cannot be prepared for Digilent programming: ${parsed.reason}.`);
    const { fields, payloadOffset, payloadLength } = parsed.header;
    const sourcePart = fieldText(fields.b);
    const payload = source.subarray(payloadOffset);
    const details = (outcome: NormalizeOutcome): NormalizeDetails => ({
        outcome,
        sourcePart,
        targetPart: target,
        payloadLength,
        payloadSha256: sha256(payload),
    });

    if (sourcePart === target) return { ok: true, output: Buffer.from(source), details: details('already-compatible') };
    if (sourcePart.toLowerCase() !== expectedPart.trim().toLowerCase()) {
        return reject(
            'DIGILENT_BIT_PART_MISMATCH',
            `The bitstream header names part "${sourcePart}", but the board uses "${expectedPart}" (Digilent form "${target}"). It was not built for this board.`,
        );
    }

    const newFields = { ...fields, b: Buffer.from(`${target}\0`, 'latin1') };
    const output = serializeBit(newFields, payload);

    // Verify: re-parse and compare everything except field b.
    const check = parseBitHeader(output);
    const problem = !check.ok
        ? `re-parse failed (${check.reason})`
        : fieldText(check.header.fields.b) !== target
          ? 'part name not rewritten'
          : (['a', 'c', 'd'] as const).find((k) => !check.header.fields[k].equals(fields[k]))
            ? 'a header field other than the part name changed'
            : check.header.payloadLength !== payloadLength || !output.subarray(check.header.payloadOffset).equals(payload)
              ? 'payload differs'
              : undefined;
    if (problem) return reject('DIGILENT_BIT_VERIFY_FAILED', `Prepared bitstream failed verification: ${problem}.`);

    return { ok: true, output, details: details('normalized') };
}

/** Payload bytes of a parsed `.bit` buffer, or undefined if it does not parse. */
export function bitPayload(buf: Buffer): Buffer | undefined {
    const p = parseBitHeader(buf);
    return p.ok ? buf.subarray(p.header.payloadOffset) : undefined;
}
