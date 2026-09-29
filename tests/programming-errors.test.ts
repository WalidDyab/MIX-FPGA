import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import {
    type BoardDefinition,
    diagnosticsFromError,
    type ProgrammerProvider,
    ProgrammingError,
    ProgrammingService,
    sha256File,
    type ToolInvocation,
} from '../core';
import { DigilentProgrammer } from '../platform/windows';
import { FakeRunner, REPO, repoBoards, tempDir, writeBitstream } from './helpers';

type Stage = 'availability' | 'detectBoards' | 'prepareArtifact' | 'program';

/** A provider that throws from one stage. */
function throwing(stage: Stage, error: unknown): ProgrammerProvider & { reached: Stage[] } {
    const reached: Stage[] = [];
    const maybeThrow = (s: Stage) => {
        reached.push(s);
        if (s === stage) throw error;
    };
    return {
        id: 'throwing',
        displayName: 'Throwing programmer',
        reached,
        async availability() {
            maybeThrow('availability');
            return { available: true, detail: 'ok' };
        },
        async detectBoards() {
            maybeThrow('detectBoards');
            return { boards: [{ selector: 'SN:1', serialNumber: '1', boardId: 'nexys-a7-100t' }], diagnostics: [] };
        },
        async prepareArtifact(req) {
            maybeThrow('prepareArtifact');
            return { path: req.canonical.path, source: req.canonical, transformation: 'none' };
        },
        async program(req) {
            maybeThrow('program');
            return { status: 'succeeded', destination: req.destination, diagnostics: [], logs: [], durationMs: 1 };
        },
    };
}

async function setup(t: TestContext, content?: string) {
    const dir = await tempDir(t);
    const canonical = await writeBitstream(join(dir, 'impl'), 'hardware.bit', content);
    const board: BoardDefinition = (await repoBoards()).get('nexys-a7-100t')!;
    return { dir, canonical, board, outputDir: join(dir, 'program') };
}

describe('ProgrammingService turns provider exceptions into results', () => {
    it('a prepareArtifact exception becomes a failed ProgrammingResult; program() is never reached', async (t) => {
        const { canonical, board, outputDir } = await setup(t);
        const provider = throwing('prepareArtifact', new Error('header is garbage'));
        const r = await new ProgrammingService(provider).program(canonical, board, outputDir);
        assert.equal(r.status, 'failed');
        assert.equal(r.destination, 'volatile');
        assert.equal(r.diagnostics[0]!.code, 'PROGRAM_PREPARE_FAILED');
        assert.match(r.diagnostics[0]!.message, /Throwing programmer could not prepare .*hardware\.bit: header is garbage/);
        assert.equal(r.target?.serialNumber, '1');
        assert.ok(!provider.reached.includes('program'));
    });

    it('keeps structured diagnostics carried by a ProgrammingError', async (t) => {
        const { canonical, board, outputDir } = await setup(t);
        const carried = [{ severity: 'error' as const, source: 'programming' as const, code: 'VENDOR_CODE', message: 'vendor explanation' }];
        const r = await new ProgrammingService(throwing('prepareArtifact', new ProgrammingError(carried))).program(canonical, board, outputDir);
        assert.deepEqual(r.diagnostics, carried);
    });

    it('covers exceptions from every provider stage, including non-Error values', async (t) => {
        const { canonical, board, outputDir } = await setup(t);
        const expected: Record<Stage, string> = {
            availability: 'PROGRAMMER_UNAVAILABLE',
            detectBoards: 'PROGRAM_DETECT_FAILED',
            prepareArtifact: 'PROGRAM_PREPARE_FAILED',
            program: 'PROGRAM_FAILED',
        };
        for (const [stage, code] of Object.entries(expected) as Array<[Stage, string]>) {
            const r = await new ProgrammingService(throwing(stage, 'a string, not an Error')).program(canonical, board, outputDir);
            assert.equal(r.status, 'failed', stage);
            assert.equal(r.diagnostics[0]!.code, code, stage);
            assert.doesNotMatch(r.diagnostics[0]!.message, /\n\s+at /, 'no stack trace');
        }
        const detection = await new ProgrammingService(throwing('detectBoards', new Error('usb gone'))).detectBoards(board);
        assert.deepEqual(detection.boards, []);
        assert.equal(detection.diagnostics[0]!.code, 'PROGRAM_DETECT_FAILED');
    });

    it('reports an unreadable canonical bitstream instead of throwing', async (t) => {
        const { canonical, board, outputDir } = await setup(t);
        const r = await new ProgrammingService(throwing('program', new Error('unused'))).program({ ...canonical, path: join(canonical.path, '..', 'missing.bit') }, board, outputDir);
        assert.equal(r.diagnostics[0]!.code, 'PROGRAM_CANONICAL_UNREADABLE');
    });

    it('ignores malformed "diagnostics" on a thrown value', () => {
        const d = diagnosticsFromError({ diagnostics: [{ nope: true }], message: 'x' }, 'CODE', 'ctx');
        assert.equal(d[0]!.code, 'CODE');
    });
});

describe('ProgrammingService with the Windows provider and a malformed bitstream', () => {
    it('reports DIGILENT_BIT_MALFORMED, leaves the canonical file untouched and never runs djtgcfg prog', async (t) => {
        const { canonical, board, outputDir } = await setup(t, 'this is not a Xilinx bitstream');
        const enumOut = await readFile(join(REPO, 'tests', 'fixtures', 'windows', 'djtgcfg', 'enum-one-board.txt'), 'utf8');
        const runner = new FakeRunner((inv: ToolInvocation) =>
            inv.args[0] === '-version'
                ? { stdout: 'Digilent JTAG Config Utility v2.6.1\n' }
                : inv.args[0] === 'enum'
                  ? { stdout: enumOut }
                  : { stdout: 'Initializing scan chain...\nFound Device ID: 13631093\n\nFound 1 device(s):\n    Device 0: XC7A100T\n' },
        );
        const provider = new DigilentProgrammer({ locate: async () => ({ path: 'C:\\Digilent\\djtgcfg.exe', method: 'test' }) }, runner, {
            env: {},
            fs: { isFile: async () => false, listDirectories: async () => [], readFile: async () => undefined },
        });
        const before = await sha256File(canonical.path);
        const r = await new ProgrammingService(provider).program(canonical, board, outputDir);
        assert.equal(r.status, 'failed');
        assert.equal(r.diagnostics[0]!.code, 'DIGILENT_BIT_MALFORMED');
        assert.equal(r.diagnostics[0]!.source, 'programming');
        assert.equal(await sha256File(canonical.path), before);
        assert.ok(!runner.calls.some((c) => c.args[0] === 'prog'));
    });
});
