import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
    type BuildArtifact,
    type DetectedBoard,
    ProgrammingService,
    sha256File,
    type ToolInvocation,
    type ToolLocator,
    type ToolRunResult,
} from '../../../core';
import { DigilentArtifactError, DigilentProgrammer, PREPARED_BITSTREAM_NAME, PROGRAM_LOG_NAME } from '../../../platform/windows/digilent/digilent-programmer';
import { parseBitHeader } from '../../../platform/windows/digilent/bit-header';
import type { WindowsHostEnvironment } from '../../../platform/windows/host-environment';
import { FakeRunner, repoBoards, tempDir } from '../../helpers';
import { buildBit, DJTGCFG_FIXTURES, sha256, syntheticPayload } from './windows-bit-builder';

const DJTGCFG = 'C:\\Program Files (x86)\\Digilent\\AdeptUtilities\\djtgcfg.exe';
const found: ToolLocator = { locate: async (t) => (t === 'programmer' ? { path: DJTGCFG, method: 'test' } : undefined) };
const missing: ToolLocator = { locate: async () => undefined };
const NO_FILES: WindowsHostEnvironment = {
    env: {},
    fs: { isFile: async () => false, listDirectories: async () => [], readFile: async () => undefined },
};

const fx = async (name: string) => readFile(join(DJTGCFG_FIXTURES, name), 'utf8');
const ok = (stdout: string): Partial<ToolRunResult> => ({ exitCode: 0, stdout });
const err = (stdout: string): Partial<ToolRunResult> => ({ exitCode: 1, stdout });

type Answers = Partial<Record<'-version' | 'enum' | 'init' | 'prog', Partial<ToolRunResult>>>;

/** A FakeRunner answering djtgcfg sub-commands from fixtures; never executes anything. */
async function djtgcfg(answers: Answers = {}): Promise<FakeRunner> {
    const defaults: Required<Answers> = {
        '-version': ok(await fx('version.txt')),
        enum: ok(await fx('enum-one-board.txt')),
        init: ok(await fx('init-ok.txt')),
        prog: ok(await fx('prog-ok.txt')),
    };
    const table = { ...defaults, ...answers };
    return new FakeRunner((inv: ToolInvocation) => table[inv.args[0] as keyof Answers] ?? { exitCode: 1, stdout: 'unexpected' });
}

const commands = (r: FakeRunner) => r.calls.map((c) => c.args[0]);

async function nexys() {
    return (await repoBoards()).get('nexys-a7-100t')!;
}

async function workspace(t: Parameters<typeof tempDir>[0], bit: Buffer = buildBit()) {
    const dir = await tempDir(t);
    await mkdir(join(dir, 'impl'), { recursive: true });
    const path = join(dir, 'impl', 'hardware.bit');
    await writeFile(path, bit);
    const canonical: BuildArtifact = { kind: 'bitstream', path, canonical: true, sizeBytes: bit.length, sha256: sha256(bit) };
    return { dir, canonical, outputDir: join(dir, 'program') };
}

describe('Windows DigilentProgrammer: availability', () => {
    it('reports djtgcfg/Adept versions when djtgcfg runs', async () => {
        const runtimeLog = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<<<<< Digilent Adept Runtime 2.30.4 >>>>>\r\n', 'utf16le')]);
        const host: WindowsHostEnvironment = {
            env: { ProgramFiles: 'C:\\Program Files' },
            fs: { ...NO_FILES.fs, readFile: async (p) => (p === 'C:\\Program Files\\Digilent\\install.log' ? runtimeLog : undefined) },
        };
        const runner = await djtgcfg();
        const a = await new DigilentProgrammer(found, runner, host).availability();
        assert.equal(a.available, true);
        assert.match(a.detail, /djtgcfg 2\.6\.1 \(Adept Utilities 2\.7\.1\), Adept Runtime 2\.30\.4/);
        assert.deepEqual(runner.calls[0]!.args, ['-version']);
    });

    it('is unavailable (never an installer launch) when djtgcfg is missing', async () => {
        const runner = await djtgcfg();
        const a = await new DigilentProgrammer(missing, runner, NO_FILES).availability();
        assert.equal(a.available, false);
        assert.match(a.detail, /djtgcfg\.exe not found/);
        assert.equal(runner.calls.length, 0);
    });

    it('explains a too-old Adept Runtime (entry point not found at start-up)', async () => {
        const runner = await djtgcfg({ '-version': { exitCode: 0xc0000139, stdout: '' } });
        const a = await new DigilentProgrammer(found, runner, NO_FILES).availability();
        assert.equal(a.available, false);
        assert.match(a.detail, /Adept Runtime 2\.30 or newer/);
    });
});

describe('Windows DigilentProgrammer: board detection', () => {
    it('maps a real enumeration to DetectedBoard with an SN: selector', async () => {
        const runner = await djtgcfg();
        const r = await new DigilentProgrammer(found, runner, NO_FILES).detectBoards(await nexys());
        assert.deepEqual(r.boards, [
            { selector: 'SN:210292BCFFE4', serialNumber: '210292BCFFE4', productName: 'Digilent Nexys A7 -100T', boardId: 'nexys-a7-100t', transport: 'USB' },
        ]);
        assert.deepEqual(r.diagnostics, []);
        assert.deepEqual(runner.calls.map((c) => c.args), [['enum'], ['init', '-d', 'SN:210292BCFFE4']]);
        assert.equal(runner.calls[0]!.executable, DJTGCFG);
    });

    it('returns no boards (and no error) when none is connected', async () => {
        const runner = await djtgcfg({ enum: ok(await fx('enum-no-devices.txt')) });
        const r = await new DigilentProgrammer(found, runner, NO_FILES).detectBoards(await nexys());
        assert.equal(r.boards.length, 0);
        assert.deepEqual(r.diagnostics, []);
    });

    it('represents several boards and lets the service refuse to guess', async (t) => {
        const runner = await djtgcfg({ enum: ok(await fx('enum-two-boards.synthetic.txt')) });
        const programmer = new DigilentProgrammer(found, runner, NO_FILES);
        const board = await nexys();
        const r = await programmer.detectBoards(board);
        assert.deepEqual(r.boards.map((b) => b.selector), ['SN:210292BCFFE4', 'SN:210292ABCDEF']);

        const { canonical, outputDir } = await workspace(t);
        const result = await new ProgrammingService(programmer).program(canonical, board, outputDir);
        assert.equal(result.status, 'failed');
        assert.ok(result.diagnostics.some((d) => d.code === 'PROGRAM_MULTIPLE_BOARDS'));
        assert.ok(!commands(runner).includes('prog'));
    });

    it('ignores other Digilent products, reporting them as info', async () => {
        const runner = await djtgcfg({ enum: ok(await fx('enum-mixed-devices.synthetic.txt')) });
        const r = await new DigilentProgrammer(found, runner, NO_FILES).detectBoards(await nexys());
        assert.deepEqual(r.boards.map((b) => b.serialNumber), ['210292BCFFE4']);
        const ignored = r.diagnostics.filter((d) => d.code === 'DIGILENT_OTHER_DEVICE');
        assert.equal(ignored.length, 2);
        assert.ok(ignored.every((d) => d.severity === 'info'));
        assert.match(ignored.map((d) => d.message).join(' '), /Basys3.*Nexys A7 -50T/);
    });

    it('warns that a USB-visible board with a dead JTAG chain is probably switched off', async () => {
        const runner = await djtgcfg({ init: err(await fx('init-scan-chain-failed.txt')) });
        const r = await new DigilentProgrammer(found, runner, NO_FILES).detectBoards(await nexys());
        assert.equal(r.boards.length, 1); // still listed, so it can be selected once powered
        const d = r.diagnostics.find((x) => x.code === 'DIGILENT_JTAG_UNAVAILABLE');
        assert.ok(d);
        assert.equal(d.severity, 'warning');
        assert.match(d.message, /connected by USB but the FPGA\/JTAG chain is unavailable\. Check that the board power switch is ON\./);
        assert.match(d.message, /210292BCFFE4/);
    });

    it('can skip the JTAG probe', async () => {
        const runner = await djtgcfg();
        await new DigilentProgrammer(found, runner, NO_FILES, { probeJtagOnDetect: false }).detectBoards(await nexys());
        assert.deepEqual(commands(runner), ['enum']);
    });

    it('reports malformed enumeration output and enum failures structurally', async () => {
        const board = await nexys();
        const malformed = await new DigilentProgrammer(found, await djtgcfg({ enum: ok(await fx('enum-malformed.synthetic.txt')) }), NO_FILES).detectBoards(board);
        assert.deepEqual(malformed.diagnostics.map((d) => d.code), ['DIGILENT_ENUM_UNRECOGNIZED']);
        const failed = await new DigilentProgrammer(found, await djtgcfg({ enum: { outcome: 'spawn-failed', exitCode: null, errorMessage: 'ENOENT' } }), NO_FILES).detectBoards(board);
        assert.deepEqual(failed.diagnostics.map((d) => d.code), ['DIGILENT_ENUM_FAILED']);
        const absent = await new DigilentProgrammer(missing, await djtgcfg(), NO_FILES).detectBoards(board);
        assert.deepEqual(absent.diagnostics.map((d) => d.code), ['DIGILENT_DJTGCFG_MISSING']);
    });
});

describe('Windows DigilentProgrammer: artifact preparation', () => {
    it('produces hardware-digilent.bit beside, never over, the canonical file', async (t) => {
        const payload = syntheticPayload();
        const { canonical, outputDir } = await workspace(t, buildBit({}, payload));
        const before = await sha256File(canonical.path);
        const artifact = await new DigilentProgrammer(found, await djtgcfg(), NO_FILES).prepareArtifact({ canonical, board: await nexys(), outputDir });

        assert.equal(await sha256File(canonical.path), before);
        assert.equal(artifact.path, join(outputDir, PREPARED_BITSTREAM_NAME));
        assert.notEqual(resolve(artifact.path), resolve(canonical.path));
        assert.equal(artifact.source, canonical);
        assert.match(artifact.transformation, /"xc7a100tcsg324-1" -> "7a100tcsg324"/);
        const prepared = await readFile(artifact.path);
        const p = parseBitHeader(prepared);
        assert.ok(p.ok);
        assert.ok(prepared.subarray(p.header.payloadOffset).equals(payload));
    });

    it('uses transformation "none" for an already Digilent-compatible header (verbatim copy)', async (t) => {
        const bit = buildBit({ b: '7a100tcsg324' });
        const { canonical, outputDir } = await workspace(t, bit);
        const artifact = await new DigilentProgrammer(found, await djtgcfg(), NO_FILES).prepareArtifact({ canonical, board: await nexys(), outputDir });
        assert.equal(artifact.transformation, 'none');
        assert.ok((await readFile(artifact.path)).equals(bit));
    });

    it('throws DigilentArtifactError with diagnostics for an unusable bitstream', async (t) => {
        const { canonical, outputDir } = await workspace(t, buildBit({ b: 'xc7a35tcpg236-1' }));
        await assert.rejects(
            new DigilentProgrammer(found, await djtgcfg(), NO_FILES).prepareArtifact({ canonical, board: await nexys(), outputDir }),
            (e: unknown) => e instanceof DigilentArtifactError && e.diagnostics[0]!.code === 'DIGILENT_BIT_PART_MISMATCH',
        );
    });
});

describe('Windows DigilentProgrammer: programming (FPGA SRAM)', () => {
    const TARGET: DetectedBoard = { selector: 'SN:210292BCFFE4', serialNumber: '210292BCFFE4', productName: 'Digilent Nexys A7 -100T', boardId: 'nexys-a7-100t' };

    async function prepared(t: Parameters<typeof tempDir>[0], runnerAnswers: Answers = {}) {
        const { canonical, outputDir } = await workspace(t);
        const runner = await djtgcfg(runnerAnswers);
        const programmer = new DigilentProgrammer(found, runner, NO_FILES);
        const board = await nexys();
        const artifact = await programmer.prepareArtifact({ canonical, board, outputDir });
        return { runner, programmer, board, artifact, canonical, outputDir };
    }

    it('end to end through ProgrammingService: detect, select by serial, prepare, init, prog', async (t) => {
        const { canonical, outputDir } = await workspace(t);
        const runner = await djtgcfg({ enum: ok(await fx('enum-two-boards.synthetic.txt')) });
        const before = await sha256File(canonical.path);
        const result = await new ProgrammingService(new DigilentProgrammer(found, runner, NO_FILES)).program(canonical, await nexys(), outputDir, {
            serialNumber: '210292ABCDEF',
        });
        assert.equal(result.status, 'succeeded', JSON.stringify(result.diagnostics));
        assert.equal(result.destination, 'volatile');
        assert.equal(result.target?.serialNumber, '210292ABCDEF');
        assert.equal(await sha256File(canonical.path), before);

        const prog = runner.calls.find((c) => c.args[0] === 'prog')!;
        assert.deepEqual(prog.args, ['prog', '-d', 'SN:210292ABCDEF', '-index', '0', '-file', join(outputDir, PREPARED_BITSTREAM_NAME)]);
        assert.equal(prog.executable, DJTGCFG);
        for (const c of runner.calls) assert.ok(!c.args.includes('erase') && !c.args.some((a) => /flash|spi/i.test(a)));
    });

    it('succeeds on exit code 0 + "Programming succeeded." and writes a raw log', async (t) => {
        const { programmer, board, artifact, runner } = await prepared(t);
        const r = await programmer.program({ artifact, target: TARGET, board, destination: 'volatile' });
        assert.equal(r.status, 'succeeded');
        assert.deepEqual(commands(runner), ['init', 'prog']);
        assert.equal(r.logs[0]!.label, 'djtgcfg-program');
        assert.equal(r.logs[0]!.path, join(artifact.path, '..', PROGRAM_LOG_NAME));
        const log = await readFile(r.logs[0]!.path, 'utf8');
        assert.match(log, /exitCode=0/);
        assert.match(log, /Programming succeeded\./);
        assert.ok(r.durationMs >= 0);
    });

    it('turns a dead JTAG chain into the board-power diagnostic and does not run prog', async (t) => {
        const { programmer, board, artifact, runner } = await prepared(t, { init: err(await fx('init-scan-chain-failed.txt')) });
        const r = await programmer.program({ artifact, target: TARGET, board, destination: 'volatile' });
        assert.equal(r.status, 'failed');
        assert.equal(r.diagnostics[0]!.code, 'DIGILENT_JTAG_UNAVAILABLE');
        assert.match(r.diagnostics[0]!.message, /power switch is ON/);
        assert.deepEqual(commands(runner), ['init']);
    });

    it('refuses a JTAG chain that holds a different FPGA', async (t) => {
        const { programmer, board, artifact, runner } = await prepared(t, { init: ok(await fx('init-other-fpga.synthetic.txt')) });
        const r = await programmer.program({ artifact, target: TARGET, board, destination: 'volatile' });
        assert.equal(r.diagnostics[0]!.code, 'DIGILENT_DEVICE_MISMATCH');
        assert.ok(!commands(runner).includes('prog'));
    });

    it('reports programming failures from djtgcfg', async (t) => {
        const cases: Array<[Partial<ToolRunResult>, string]> = [
            [err(await fx('prog-bad-header.txt')), 'DIGILENT_FILE_REJECTED'],
            [err(await fx('open-device-failed.txt')), 'DIGILENT_DEVICE_OPEN_FAILED'],
            [err(await fx('init-scan-chain-failed.txt')), 'DIGILENT_JTAG_UNAVAILABLE'],
            [{ outcome: 'timed-out', exitCode: null }, 'DIGILENT_TIMEOUT'],
            [err('garbage'), 'DIGILENT_PROGRAM_FAILED'],
        ];
        for (const [answer, code] of cases) {
            const { programmer, board, artifact } = await prepared(t, { prog: answer });
            const r = await programmer.program({ artifact, target: TARGET, board, destination: 'volatile' });
            assert.equal(r.status, 'failed', code);
            assert.equal(r.diagnostics[0]!.code, code);
            assert.match(await readFile(r.logs[0]!.path, 'utf8'), /\[stdout\]/);
        }
    });

    it('warns when exit code 0 comes without the success line', async (t) => {
        const { programmer, board, artifact } = await prepared(t, { prog: ok('') });
        const r = await programmer.program({ artifact, target: TARGET, board, destination: 'volatile' });
        assert.equal(r.status, 'succeeded');
        assert.ok(r.diagnostics.some((d) => d.code === 'DIGILENT_SUCCESS_UNCONFIRMED' && d.severity === 'warning'));
    });

    it('never passes an unprepared (openXC7-header) bitstream to djtgcfg', async (t) => {
        const { canonical } = await workspace(t);
        const runner = await djtgcfg();
        const r = await new DigilentProgrammer(found, runner, NO_FILES).program({
            artifact: { path: canonical.path, source: canonical, transformation: 'none' },
            target: TARGET,
            board: await nexys(),
            destination: 'volatile',
        });
        assert.equal(r.diagnostics[0]!.code, 'DIGILENT_ARTIFACT_NOT_PREPARED');
        assert.equal(runner.calls.length, 0);
    });

    it('passes cancellation through to djtgcfg', async (t) => {
        const { programmer, board, artifact, runner } = await prepared(t);
        const controller = new AbortController();
        await programmer.program({ artifact, target: TARGET, board, destination: 'volatile', signal: controller.signal });
        assert.ok(runner.calls.every((c) => c.signal === controller.signal));
    });
});
