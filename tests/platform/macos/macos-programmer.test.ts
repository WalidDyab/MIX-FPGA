import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type BuildArtifact, type DetectedBoard, type HostInfo, ProgrammingService, sha256File, type ToolInvocation } from '../../../core';
import {
    APIO_REMOTE_CONFIG_ENV,
    classifyOpenFpgaLoaderFailure,
    createMacosAdapter,
    MacosToolLocator,
    OpenFpgaLoaderProgrammer,
    parseBitHeaderPart,
    parseConfigurationStatus,
    parseDetect,
    parseOpenFpgaLoaderVersion,
    parseScanUsb,
    programArgs,
    OPENFPGALOADER_BOARDS,
} from '../../../platform/macos';
import { repoBoards, tempDir } from '../../helpers';
import { argsInclude, fakeSystem, fixture, OFL, type Reply, scriptedRunner, validatedMacFiles } from './macos-fakes';

const SERIAL = '210292BCFFE4';
const NEXYS: DetectedBoard = { selector: `ftdi-serial=${SERIAL}`, serialNumber: SERIAL, productName: 'Digilent USB Device', boardId: 'nexys-a7-100t' };

/** A minimal Xilinx .bit: header fields a/b/c/d/e followed by a fake payload. */
function bitFile(part = 'xc7a100tcsg324-1'): Buffer {
    const field = (key: string, value: string) => {
        const v = Buffer.from(value + '\0', 'latin1');
        const len = Buffer.alloc(2);
        len.writeUInt16BE(v.length);
        return Buffer.concat([Buffer.from(key), len, v]);
    };
    const preamble = Buffer.from([0x00, 0x09, 0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0, 0x00, 0x00, 0x01]);
    const payload = Buffer.from('payload-bytes');
    const e = Buffer.alloc(5);
    e.write('e');
    e.writeUInt32BE(payload.length, 1);
    return Buffer.concat([preamble, field('a', 'top;COMPRESS=FALSE'), field('b', part), field('c', '2026/09/29'), field('d', '12:00:00'), e, payload]);
}

async function canonicalBit(t: Parameters<typeof tempDir>[0], part?: string): Promise<{ artifact: BuildArtifact; outputDir: string }> {
    const root = await tempDir(t);
    const buildDir = join(root, 'impl', '_build', 'default');
    const outputDir = join(root, 'program');
    await mkdir(buildDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    const path = join(buildDir, 'hardware.bit');
    const bytes = bitFile(part);
    await writeFile(path, bytes);
    return { artifact: { kind: 'bitstream', path, canonical: true, sizeBytes: bytes.length }, outputDir };
}

function programmer(replies: Array<[(i: ToolInvocation) => boolean, Reply]>) {
    const runner = scriptedRunner(replies);
    const system = fakeSystem(validatedMacFiles());
    return { runner, provider: new OpenFpgaLoaderProgrammer({ runner, locator: new MacosToolLocator(system) }) };
}

const scanWithBoard: [ReturnType<typeof argsInclude>, Reply] = [argsInclude('--scan-usb'), { stdout: fixture('ofl-scan-usb-nexys.txt') }];
const detectOk: [ReturnType<typeof argsInclude>, Reply] = [argsInclude('--detect'), { stdout: fixture('ofl-detect-nexys.txt') }];

describe('openFPGALoader output parsing', () => {
    it('parses the version', () => {
        assert.equal(parseOpenFpgaLoaderVersion(fixture('ofl-version.txt')), '1.1.1');
        assert.equal(parseOpenFpgaLoaderVersion('garbage'), undefined);
    });

    it('parses --scan-usb with and without a probe', () => {
        assert.deepEqual(parseScanUsb(fixture('ofl-scan-usb-empty.txt')), []);
        const [probe, ...rest] = parseScanUsb(fixture('ofl-scan-usb-nexys.txt'));
        assert.equal(rest.length, 0);
        assert.equal(probe?.vendorId, '0403');
        assert.equal(probe?.productId, '6010');
        assert.equal(probe?.probeType, 'FTDI2232');
        assert.equal(probe?.serialNumber, SERIAL);
        assert.equal(probe?.product, 'Digilent USB Device');
    });

    it('parses --detect (xc7a100, IDCODE 0x3631093)', () => {
        const [dev] = parseDetect(fixture('ofl-detect-nexys.txt'));
        assert.equal(dev?.idcode, 0x3631093);
        assert.equal(dev?.model, 'xc7a100');
        assert.equal(dev?.family, 'artix a7 100t');
        assert.equal(dev?.irLength, 6);
        assert.deepEqual(parseDetect(fixture('ofl-detect-no-probe.txt')), []);
    });

    it('reads the configuration status line, including through progress-bar carriage returns', () => {
        assert.deepEqual(parseConfigurationStatus(fixture('ofl-program-success.txt')), { iscDone: 1, iscEna: 0, init: 1, done: 1 });
        assert.equal(parseConfigurationStatus(fixture('ofl-program-no-probe.txt')), undefined);
    });

    it('classifies failures', () => {
        assert.equal(classifyOpenFpgaLoaderFailure(fixture('ofl-detect-no-probe.txt')), 'no-probe');
        assert.equal(classifyOpenFpgaLoaderFailure(fixture('ofl-program-no-probe.txt')), 'no-probe');
        assert.equal(classifyOpenFpgaLoaderFailure('unable to open ftdi device: -5 (unable to claim usb device)'), 'usb-unavailable');
        assert.equal(classifyOpenFpgaLoaderFailure('JTAG init failed with: something else'), 'jtag-init-failed');
    });

    it('reads the part from a .bit header', () => {
        assert.equal(parseBitHeaderPart(bitFile()), 'xc7a100tcsg324-1');
        assert.equal(parseBitHeaderPart(Buffer.from('not a bitstream')), undefined);
    });

    it('builds an SRAM-only command for the selected probe (never flash)', () => {
        const args = programArgs(OPENFPGALOADER_BOARDS['nexys-a7-100t']!, NEXYS.selector, '/b/hardware.bit');
        assert.deepEqual(args, ['--board', 'nexys_a7_100', '--ftdi-serial', SERIAL, '--write-sram', '--force-terminal-mode', '/b/hardware.bit']);
        assert.ok(!args.includes('--write-flash') && !args.includes('-f'));
        assert.deepEqual(programArgs(OPENFPGALOADER_BOARDS['nexys-a7-100t']!, 'busdev-num=1:4', 'x.bit').slice(2, 4), ['--busdev-num', '1:4']);
        assert.throws(() => programArgs(OPENFPGALOADER_BOARDS['nexys-a7-100t']!, 'bogus', 'x.bit'));
    });
});

describe('macOS OpenFpgaLoaderProgrammer', () => {
    it('reports availability with version and native architecture', async () => {
        const { provider } = programmer([[argsInclude('--Version'), { stdout: fixture('ofl-version.txt') }]]);
        const a = await provider.availability();
        assert.equal(a.available, true);
        assert.match(a.detail, /openFPGALoader 1\.1\.1 .*Apio oss-cad-suite.*native arm64/);
    });

    it('reports openFPGALoader missing', async () => {
        const provider = new OpenFpgaLoaderProgrammer({ runner: scriptedRunner([]), locator: new MacosToolLocator(fakeSystem({})) });
        assert.equal((await provider.availability()).available, false);
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        assert.equal((await provider.detectBoards(board)).diagnostics.at(-1)?.code, 'MACOS_PROGRAMMER_NOT_FOUND');
    });

    it('detects the Nexys A7 by USB identity and a confirmed JTAG IDCODE', async () => {
        const { provider, runner } = programmer([scanWithBoard, detectOk]);
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        const r = await provider.detectBoards(board);
        assert.deepEqual(r.diagnostics, []);
        assert.equal(r.boards.length, 1);
        assert.deepEqual({ ...r.boards[0], transport: undefined }, { ...NEXYS, transport: undefined });
        assert.match(r.boards[0]!.transport!, /FT(DI)?2232.*0403:6010.*xc7a100.*0x3631093/);
        assert.deepEqual(runner.calls[1]!.args, ['--board', 'nexys_a7_100', '--ftdi-serial', SERIAL, '--detect']);
    });

    it('returns no boards when nothing is connected; the service reports PROGRAM_NO_BOARD', async () => {
        const { provider } = programmer([
            [argsInclude('--Version'), { stdout: fixture('ofl-version.txt') }],
            [argsInclude('--scan-usb'), { stdout: fixture('ofl-scan-usb-empty.txt') }],
        ]);
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        const r = await provider.detectBoards(board);
        assert.deepEqual(r.boards, []);
        assert.equal(r.diagnostics[0]?.code, 'MACOS_NO_BOARD');
        const artifact: BuildArtifact = { kind: 'bitstream', path: '/nowhere/hardware.bit', canonical: true };
        const result = await new ProgrammingService(provider).program(artifact, board, '/nowhere');
        assert.equal(result.status, 'failed');
        assert.ok(result.diagnostics.some((d) => d.code === 'PROGRAM_NO_BOARD'));
    });

    it('does not treat a visible FTDI device as a ready board when JTAG fails', async () => {
        const { provider } = programmer([scanWithBoard, [argsInclude('--detect'), { exitCode: 1, stderr: 'unable to open ftdi device: -5 (unable to claim usb device)\nJTAG init failed with: unable to open ftdi device' }]]);
        const r = await provider.detectBoards((await repoBoards()).get('nexys-a7-100t')!);
        assert.deepEqual(r.boards, []);
        assert.equal(r.diagnostics[0]?.code, 'MACOS_USB_VISIBLE_JTAG_UNAVAILABLE');
        assert.match(r.diagnostics[0]!.message, /visible on USB but its JTAG interface could not be opened/);
    });

    it('ignores FTDI devices whose FPGA is not the expected one', async () => {
        const other = fixture('ofl-detect-nexys.txt').replace('0x3631093', '0x362d093').replace('xc7a100', 'xc7a35');
        const { provider } = programmer([scanWithBoard, [argsInclude('--detect'), { stdout: other }]]);
        const r = await provider.detectBoards((await repoBoards()).get('nexys-a7-100t')!);
        assert.deepEqual(r.boards, []);
        assert.match(r.diagnostics[0]!.message, /expected FPGA did not answer/);
    });

    it('prepareArtifact references the canonical bitstream unchanged', async (t) => {
        const { artifact, outputDir } = await canonicalBit(t);
        const before = await readFile(artifact.path);
        const { provider } = programmer([]);
        const prepared = await provider.prepareArtifact({ canonical: artifact, board: (await repoBoards()).get('nexys-a7-100t')!, outputDir });
        assert.deepEqual(prepared, { path: artifact.path, source: artifact, transformation: 'none' });
        assert.deepEqual(await readFile(artifact.path), before);
    });

    it('programs through ProgrammingService: canonical file untouched, DONE=1 reported as success', async (t) => {
        const { artifact, outputDir } = await canonicalBit(t);
        const hash = await sha256File(artifact.path);
        const { provider, runner } = programmer([
            [argsInclude('--Version'), { stdout: fixture('ofl-version.txt') }],
            scanWithBoard,
            detectOk,
            [argsInclude('--write-sram'), { stdout: fixture('ofl-program-success.txt') }],
        ]);
        const result = await new ProgrammingService(provider).program(artifact, (await repoBoards()).get('nexys-a7-100t')!, outputDir);
        assert.equal(result.status, 'succeeded', JSON.stringify(result.diagnostics));
        assert.equal(result.destination, 'volatile');
        assert.equal(result.target?.serialNumber, SERIAL);
        assert.equal(result.artifact?.transformation, 'none');
        assert.equal(result.diagnostics[0]?.code, 'MACOS_PROGRAMMED_SRAM');
        assert.equal(await sha256File(artifact.path), hash);
        const call = runner.calls.find((c) => c.args.includes('--write-sram'))!;
        assert.equal(call.executable, OFL);
        assert.deepEqual(call.args, ['--board', 'nexys_a7_100', '--ftdi-serial', SERIAL, '--write-sram', '--force-terminal-mode', artifact.path]);
        assert.equal(call.env, undefined);
        assert.match(await readFile(result.logs[0]!.path, 'utf8'), /done 1/);
    });

    const programWith = async (t: Parameters<typeof tempDir>[0], reply: Reply, part?: string) => {
        const { artifact, outputDir } = await canonicalBit(t, part);
        const { provider } = programmer([[argsInclude('--write-sram'), reply]]);
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        const prepared = await provider.prepareArtifact({ canonical: artifact, board, outputDir });
        return provider.program({ artifact: prepared, target: NEXYS, board, destination: 'volatile' });
    };

    it('reports a programming failure with a structured, readable diagnostic', async (t) => {
        const r = await programWith(t, { exitCode: 1, stdout: fixture('ofl-program-no-probe.txt') });
        assert.equal(r.status, 'failed');
        assert.equal(r.diagnostics[0]?.code, 'MACOS_PROGRAM_FAILED');
        assert.match(r.diagnostics[0]!.message, /No board was found on USB.*unable to open ftdi device/);
        assert.equal(r.logs.length, 1);
    });

    it('does not report success when configuration DONE is not reached', async (t) => {
        const notDone = fixture('ofl-program-success.txt').replace('init 1 done 1', 'init 0 done 0');
        assert.equal((await programWith(t, { stdout: notDone })).diagnostics[0]?.code, 'MACOS_PROGRAM_DONE_NOT_REACHED');
        assert.equal((await programWith(t, { stdout: 'load program\nDone\n' })).diagnostics[0]?.code, 'MACOS_PROGRAM_DONE_NOT_REACHED');
    });

    it('refuses a bitstream built for another part', async (t) => {
        const r = await programWith(t, { stdout: fixture('ofl-program-success.txt') }, 'xc7a35tcpg236-1');
        assert.equal(r.diagnostics[0]?.code, 'MACOS_BITSTREAM_PART_MISMATCH');
    });
});

describe('createMacosAdapter', () => {
    const host = (arch: string): HostInfo => ({ platform: 'darwin', arch, nodeVersion: 'v24.0.0' });

    it('provides a programmer, a locator and a pinned runner', () => {
        const p = createMacosAdapter(host('arm64'), { system: fakeSystem(validatedMacFiles()), runner: scriptedRunner([]), root: '/Users/student/NexysVHDL' });
        assert.equal(p.id, 'macos');
        assert.ok(p.programmer && p.toolLocator);
        assert.match(p.status, /native arm64/);
        assert.equal(p.apioEnvironment[APIO_REMOTE_CONFIG_ENV], 'file:///Users/student/NexysVHDL/toolchains/apio-remote-config/apio-{major}.{minor}.x.jsonc');
    });

    it('offers no programmer or locator on a non-arm64 (Rosetta/Intel) Node', async () => {
        const p = createMacosAdapter(host('x64'), { system: fakeSystem({}), root: '/Users/student/NexysVHDL' });
        assert.equal(p.programmer, undefined);
        assert.equal(p.toolLocator, undefined);
        assert.deepEqual(await p.providers(), { located: {} });
        assert.match(p.status, /unsupported architecture x64/);
    });
});
