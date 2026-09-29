import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
    classifyDjtgcfgError,
    parseAdeptRuntimeVersion,
    parseDjtgcfgVersion,
    parseEnumOutput,
    parseInitOutput,
    programmingSucceeded,
} from '../../../platform/windows/digilent/djtgcfg-output';
import { DJTGCFG_FIXTURES } from './windows-bit-builder';

const fixture = (name: string) => readFile(join(DJTGCFG_FIXTURES, name), 'utf8');

describe('Windows: djtgcfg output parsers', () => {
    it('parses a real one-board enumeration (LF and CRLF)', async () => {
        const text = await fixture('enum-one-board.txt');
        for (const variant of [text, text.replace(/\n/g, '\r\n')]) {
            const r = parseEnumOutput(variant);
            assert.ok(r.ok);
            assert.equal(r.reportedCount, 1);
            assert.deepEqual(r.devices, [
                { name: 'NexysA7', productName: 'Digilent Nexys A7 -100T', userName: 'NexysA7', serialNumber: '210292BCFFE4', transport: 'USB' },
            ]);
        }
    });

    it('parses "No devices found" as an empty list', async () => {
        const r = parseEnumOutput(await fixture('enum-no-devices.txt'));
        assert.ok(r.ok);
        assert.equal(r.devices.length, 0);
    });

    it('keeps every board of a multi-board enumeration with its own serial', async () => {
        const r = parseEnumOutput(await fixture('enum-two-boards.synthetic.txt'));
        assert.ok(r.ok);
        assert.deepEqual(r.devices.map((d) => d.serialNumber), ['210292BCFFE4', '210292ABCDEF']);
        assert.equal(r.reportedCount, 2);
    });

    it('rejects unrecognised enumeration output', async () => {
        assert.equal(parseEnumOutput(await fixture('enum-malformed.synthetic.txt')).ok, false);
        assert.equal(parseEnumOutput('').ok, false);
    });

    it('parses the JTAG scan chain from init', async () => {
        assert.deepEqual(parseInitOutput(await fixture('init-ok.txt')), { idcodes: ['13631093'], devices: ['XC7A100T'] });
        assert.equal(parseInitOutput(await fixture('init-scan-chain-failed.txt')), undefined);
    });

    it('classifies real djtgcfg errors', async () => {
        assert.equal(classifyDjtgcfgError(await fixture('init-scan-chain-failed.txt')), 'scan-chain');
        assert.equal(classifyDjtgcfgError(await fixture('open-device-failed.txt')), 'open-device');
        assert.equal(classifyDjtgcfgError(await fixture('prog-bad-header.txt')), 'file-rejected');
        assert.equal(classifyDjtgcfgError('ERROR: could not open "C:\\x y\\a.bit" for reading'), 'file-unreadable');
        assert.equal(classifyDjtgcfgError('ERROR: something new'), 'unknown');
    });

    it('recognises the success line only when present', async () => {
        assert.equal(programmingSucceeded(await fixture('prog-ok.txt')), true);
        assert.equal(programmingSucceeded(await fixture('prog-bad-header.txt')), false);
        assert.equal(programmingSucceeded('Programming device. Do not touch your board.'), false);
    });

    it('parses djtgcfg and Adept Runtime versions', async () => {
        assert.equal(parseDjtgcfgVersion(await fixture('version.txt')), '2.6.1');
        assert.equal(parseDjtgcfgVersion('Usage: djtgcfg.exe [-help]'), undefined);
        const log = '\n<<<<< Digilent Adept Runtime Setup >>>>>\nInstaller version: 1.9.18\n\n<<<<< Digilent Adept Runtime 2.30.4 >>>>>\nCleaning before installation...\n';
        assert.equal(parseAdeptRuntimeVersion(log), '2.30.4');
        assert.equal(parseAdeptRuntimeVersion('<<<<< Digilent Adept Runtime Setup >>>>>\nInstaller version: 1.5.8'), undefined);
    });
});
