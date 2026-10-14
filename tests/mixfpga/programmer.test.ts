import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DE10_LITE_PROFILE, type ProgrammingArtifactRef } from '../../core/backend';
import type { ToolInvocation, ToolRunResult, ToolRunner } from '../../core';
import { NativeJtagProgrammer, parseDetect, parseScanUsb } from '../../platform/macos/de10/ofl-programmer';
import { tempDir } from '../helpers';
import { testPaths } from './fake-vm';

const SCAN = 'empty\nBus device vid:pid       probe_type  manufacturer serial   product\n001 004 0x09fb:0x6001 usb-blaster Altera 91d28408 USB-Blaster\n';
const DETECT = 'empty\nindex 0:\n\tidcode 0x31050dd\n\tmanufacturer altera\n\tfamily MAX 10\n\tmodel  10M50D\n\tirlength 10\n';
const PROGRAM_OK = 'empty\nUSB-BlasterI has a 24MHz fixed frequency\nend of SVF file\n';

interface Script {
    scan?: string;
    detect?: string | string[];
    detectExit?: number;
    program?: Partial<ToolRunResult>;
    version?: string;
}

class FakeProgrammerBinary implements ToolRunner {
    readonly calls: ToolInvocation[] = [];
    private detects = 0;
    constructor(private readonly s: Script = {}) {}
    async run(inv: ToolInvocation): Promise<ToolRunResult> {
        this.calls.push(inv);
        const r = (o: Partial<ToolRunResult>): ToolRunResult => ({ invocation: inv, outcome: 'exited', exitCode: 0, stdout: '', stderr: '', durationMs: 1, ...o });
        const a = inv.args;
        if (a[0] === '--Version') return r({ stdout: this.s.version ?? 'openFPGALoader v1.1.1\n' });
        if (a[0] === '--scan-usb') return r({ stdout: this.s.scan ?? SCAN });
        if (a[0] === '--detect') {
            const d = this.s.detect ?? DETECT;
            const text = Array.isArray(d) ? d[Math.min(this.detects, d.length - 1)]! : d;
            this.detects++;
            return r({ stdout: text, exitCode: this.s.detectExit ?? 0 });
        }
        return r({ stdout: PROGRAM_OK, ...this.s.program });
    }
    get programCalls() {
        return this.calls.filter((c) => !c.args[0]?.startsWith('--'));
    }
}

async function artifact(t: import('node:test').TestContext, name = 'blink.svf', content = 'SVF'): Promise<ProgrammingArtifactRef> {
    const dir = await tempDir(t);
    const path = join(dir, name);
    await writeFile(path, content);
    return { path, format: name.endsWith('.svf') ? 'svf' : 'bit', sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
}

const make = async (t: import('node:test').TestContext, s: Script = {}) => {
    const { paths } = await testPaths(t);
    const bin = new FakeProgrammerBinary(s);
    return { paths, bin, prog: new NativeJtagProgrammer(paths, bin) };
};

describe('programmer output parsing (real openFPGALoader 1.1.1 output)', () => {
    it('parses the USB-Blaster probe', () => {
        assert.deepEqual(parseScanUsb(SCAN), [{ vendorId: '09fb', productId: '6001', description: 'USB-Blaster (usb-blaster)', serial: '91d28408' }]);
        assert.deepEqual(parseScanUsb('empty\nNo USB devices found\n'), []);
    });
    it('parses the JTAG chain', () => {
        assert.deepEqual(parseDetect(DETECT), [{ index: 0, idcode: 0x31050dd, family: 'MAX 10', model: '10M50D' }]);
        assert.deepEqual(parseDetect('JTAG init failed with: std::exception\n'), []);
    });
});

describe('hardware detection', () => {
    it('confirms the DE10-Lite\'s MAX 10 by JTAG IDCODE', async (t) => {
        const { prog, bin } = await make(t);
        const d = await prog.detect(DE10_LITE_PROFILE);
        assert.equal(d.status, 'detected');
        assert.equal(d.devices[0]?.idcode, 0x031050dd);
        assert.equal(d.probes[0]?.vendorId, '09fb');
        assert.deepEqual(bin.calls.at(-1)!.args, ['--detect', '-b', 'de10lite']);
    });

    it('reports board-absent when no USB-Blaster is on the bus (and does not try JTAG)', async (t) => {
        const { prog, bin } = await make(t, { scan: 'empty\nNo USB devices found\n' });
        const d = await prog.detect(DE10_LITE_PROFILE);
        assert.equal(d.status, 'board-absent');
        assert.equal(d.diagnostics[0]?.code, 'BOARD_ABSENT');
        assert.ok(!bin.calls.some((c) => c.args[0] === '--detect'));
    });

    it('reports board-absent when the cable cannot be opened', async (t) => {
        const { prog } = await make(t, { detect: 'empty\nunable to open ftdi device: -3 (device not found)\nJTAG init failed with: std::exception\n', detectExit: 1 });
        assert.equal((await prog.detect(DE10_LITE_PROFILE)).status, 'board-absent');
    });

    it('reports an empty JTAG chain (unpowered board) as an error, not as absent', async (t) => {
        const { prog } = await make(t, { detect: 'empty\n' });
        const d = await prog.detect(DE10_LITE_PROFILE);
        assert.equal(d.status, 'error');
        assert.equal(d.diagnostics[0]?.code, 'JTAG_NO_DEVICE');
    });

    it('refuses a different FPGA on the chain', async (t) => {
        const { prog } = await make(t, { detect: 'empty\nindex 0:\n\tidcode 0x20f10dd\n\tfamily Cyclone V\n\tmodel 5CEBA4\n' });
        const d = await prog.detect(DE10_LITE_PROFILE);
        assert.equal(d.status, 'unexpected-device');
        assert.match(d.diagnostics[0]!.message, /0x020f10dd.*expected 0x031050dd/);
    });

    it('reports a missing programmer without running anything', async (t) => {
        const { paths, bin, prog } = await make(t);
        await rm(paths.programmer);
        const d = await prog.detect(DE10_LITE_PROFILE);
        assert.equal(d.status, 'programmer-missing');
        assert.equal(d.diagnostics[0]?.code, 'PROGRAMMER_MISSING');
        assert.equal(bin.calls.length, 0);
        assert.equal((await prog.availability()).available, false);
    });

    it('reports availability with the pinned version', async (t) => {
        const { prog } = await make(t);
        assert.deepEqual(await prog.availability(), { available: true, detail: 'openFPGALoader v1.1.1' });
    });
});

describe('programming', () => {
    it('programs an SVF into SRAM and verifies the device is still on the chain', async (t) => {
        const { prog, bin, paths } = await make(t);
        const a = await artifact(t);
        const o = await prog.program({ artifact: a, board: DE10_LITE_PROFILE });
        assert.equal(o.status, 'programmed');
        assert.equal(o.softwareVerified, true);
        assert.deepEqual(bin.programCalls[0]!.args, ['-b', 'de10lite', a.path]);
        assert.equal(bin.programCalls[0]!.env?.OPENFPGALOADER_SOJ_DIR, paths.programmerDataDir);
        assert.ok(o.diagnostics.some((d) => d.code === 'PROGRAMMED_SRAM'));
    });

    it('rejects a .sof with an explanation and runs nothing (the tool cannot load it)', async (t) => {
        const { prog, bin } = await make(t);
        const o = await prog.program({ artifact: await artifact(t, 'blink.sof'), board: DE10_LITE_PROFILE });
        assert.equal(o.status, 'rejected');
        assert.equal(o.diagnostics[0]?.code, 'UNSUPPORTED_ARTIFACT');
        assert.equal(bin.calls.length, 0);
    });

    it('rejects a missing artifact', async (t) => {
        const { prog, bin } = await make(t);
        const a = await artifact(t);
        await rm(a.path);
        const o = await prog.program({ artifact: a, board: DE10_LITE_PROFILE });
        assert.equal(o.status, 'rejected');
        assert.equal(o.diagnostics[0]?.code, 'ARTIFACT_MISSING');
        assert.equal(bin.calls.length, 0);
    });

    it('rejects an artifact that changed since the build', async (t) => {
        const { prog } = await make(t);
        const a = await artifact(t);
        await writeFile(a.path, 'DIFFERENT');
        assert.equal((await prog.program({ artifact: a, board: DE10_LITE_PROFILE })).diagnostics[0]?.code, 'ARTIFACT_CHANGED');
    });

    it('fails with BOARD_ABSENT and does not run the programmer when the board is unplugged', async (t) => {
        const { prog, bin } = await make(t, { scan: 'empty\nNo USB devices found\n' });
        const o = await prog.program({ artifact: await artifact(t), board: DE10_LITE_PROFILE });
        assert.equal(o.status, 'failed');
        assert.equal(o.diagnostics[0]?.code, 'BOARD_ABSENT');
        assert.equal(bin.programCalls.length, 0);
    });

    it('fails when the programmer binary is missing', async (t) => {
        const { paths, prog } = await make(t);
        await rm(paths.programmer);
        const o = await prog.program({ artifact: await artifact(t), board: DE10_LITE_PROFILE });
        assert.equal(o.status, 'failed');
        assert.equal(o.diagnostics[0]?.code, 'PROGRAMMER_MISSING');
    });

    it('does not trust exit code 0: the SVF player must reach the end of the file', async (t) => {
        const { prog } = await make(t, { program: { stdout: 'empty\nUSB-BlasterI has a 24MHz fixed frequency\n' } });
        const o = await prog.program({ artifact: await artifact(t), board: DE10_LITE_PROFILE });
        assert.equal(o.status, 'failed');
        assert.equal(o.softwareVerified, false);
    });

    it('surfaces a tool error line (e.g. the MAX 10 memory-map error) as a failure', async (t) => {
        const { prog } = await make(t, { program: { exitCode: 1, stdout: 'Model not supported. Please update max10_memory_map.\nError: Failed to program FPGA\n' } });
        const o = await prog.program({ artifact: await artifact(t), board: DE10_LITE_PROFILE });
        assert.equal(o.status, 'failed');
        assert.match(o.diagnostics[0]!.message, /Model not supported/);
    });

    it('fails when the device disappears from the JTAG chain after programming', async (t) => {
        const { prog } = await make(t, { detect: [DETECT, 'empty\n'] });
        const o = await prog.program({ artifact: await artifact(t), board: DE10_LITE_PROFILE });
        assert.equal(o.status, 'failed');
        assert.equal(o.softwareVerified, false);
    });

    it('reports cancellation and warns that the board state is undefined', async (t) => {
        const { prog } = await make(t, { program: { outcome: 'cancelled', exitCode: null } });
        const o = await prog.program({ artifact: await artifact(t), board: DE10_LITE_PROFILE });
        assert.equal(o.status, 'cancelled');
        assert.equal(o.diagnostics[0]?.code, 'PROGRAM_CANCELLED');
    });
});
