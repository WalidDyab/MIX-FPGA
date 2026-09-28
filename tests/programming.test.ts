import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
    type BoardDefinition,
    type DetectedBoard,
    type PrepareRequest,
    type ProgrammerProvider,
    type ProgrammingArtifact,
    type ProgramRequest,
    type ProgrammingResult,
    ProgrammingService,
    selectTarget,
    sha256File,
} from '../core';
import { repoBoards, tempDir, writeBitstream } from './helpers';

const BOARD_A: DetectedBoard = { selector: 'target-A', serialNumber: 'SN-A', productName: 'Test board', boardId: 'nexys-a7-100t' };
const BOARD_B: DetectedBoard = { selector: 'target-B', serialNumber: 'SN-B', productName: 'Test board', boardId: 'nexys-a7-100t' };

type PrepareMode = 'copy-transform' | 'unchanged' | 'modify-canonical' | 'transform-in-place';

/** Mock ProgrammerProvider; records calls and never touches hardware. */
class MockProgrammer implements ProgrammerProvider {
    readonly id = 'mock';
    readonly displayName = 'Mock programmer';
    readonly programmed: ProgramRequest[] = [];
    constructor(
        private readonly boards: DetectedBoard[],
        private readonly mode: PrepareMode = 'copy-transform',
        private readonly available = true,
    ) {}
    async availability() {
        return { available: this.available, detail: this.available ? 'mock ready' : 'mock backend missing' };
    }
    async detectBoards(_board: BoardDefinition) {
        return { boards: this.boards, diagnostics: [] };
    }
    async prepareArtifact(req: PrepareRequest): Promise<ProgrammingArtifact> {
        switch (this.mode) {
            case 'unchanged': // e.g. a backend that accepts the canonical file as-is
                return { path: req.canonical.path, source: req.canonical, transformation: 'none' };
            case 'copy-transform': {
                // e.g. a backend that needs a header-adjusted copy
                const path = join(req.outputDir, 'hardware-prepared.bit');
                await copyFile(req.canonical.path, path);
                await writeFile(path, Buffer.concat([Buffer.from('HDR:'), await readFile(path)]));
                return { path, source: req.canonical, transformation: 'header-adjusted' };
            }
            case 'modify-canonical':
                await writeFile(req.canonical.path, 'tampered');
                return { path: req.canonical.path, source: req.canonical, transformation: 'none' };
            case 'transform-in-place':
                return { path: req.canonical.path, source: req.canonical, transformation: 'header-adjusted' };
        }
    }
    async program(req: ProgramRequest): Promise<ProgrammingResult> {
        this.programmed.push(req);
        return { status: 'succeeded', destination: req.destination, target: req.target, artifact: req.artifact, diagnostics: [], logs: [], durationMs: 1 };
    }
}

async function setup(t: Parameters<typeof tempDir>[0]) {
    const dir = await tempDir(t);
    const canonical = await writeBitstream(join(dir, 'impl'));
    const outputDir = join(dir, 'program');
    await mkdir(outputDir, { recursive: true });
    const board = (await repoBoards()).get('nexys-a7-100t')!;
    return { canonical, outputDir, board };
}

describe('ProgrammingService with a mocked ProgrammerProvider', () => {
    it('reports "not configured" (never success) when no provider exists', async (t) => {
        const { canonical, outputDir, board } = await setup(t);
        const result = await new ProgrammingService(undefined).program(canonical, board, outputDir);
        assert.equal(result.status, 'not-configured');
        assert.equal(result.diagnostics[0]!.code, 'PROGRAMMER_NOT_CONFIGURED');
    });

    it('programs a transformed copy while the canonical bitstream stays unchanged', async (t) => {
        const { canonical, outputDir, board } = await setup(t);
        const before = await sha256File(canonical.path);
        const mock = new MockProgrammer([BOARD_A]);
        const result = await new ProgrammingService(mock).program(canonical, board, outputDir);
        assert.equal(result.status, 'succeeded');
        const artifact = mock.programmed[0]!.artifact;
        assert.notEqual(artifact, canonical as unknown, 'distinct objects');
        assert.notEqual(artifact.path, canonical.path, 'distinct paths');
        assert.equal(artifact.source, canonical);
        assert.equal(await sha256File(canonical.path), before);
        assert.equal(mock.programmed[0]!.destination, 'volatile');
    });

    it('allows the canonical file to be used unchanged (transformation "none")', async (t) => {
        const { canonical, outputDir, board } = await setup(t);
        const mock = new MockProgrammer([BOARD_A], 'unchanged');
        const result = await new ProgrammingService(mock).program(canonical, board, outputDir);
        assert.equal(result.status, 'succeeded');
        const artifact = mock.programmed[0]!.artifact;
        assert.equal(artifact.transformation, 'none');
        assert.notEqual(artifact, canonical as unknown, 'still a separate ProgrammingArtifact object');
    });

    it('fails if the provider modifies the canonical bitstream', async (t) => {
        const { canonical, outputDir, board } = await setup(t);
        const mock = new MockProgrammer([BOARD_A], 'modify-canonical');
        const result = await new ProgrammingService(mock).program(canonical, board, outputDir);
        assert.equal(result.status, 'failed');
        assert.ok(result.diagnostics.some((d) => d.code === 'PROGRAM_CANONICAL_MODIFIED'));
        assert.equal(mock.programmed.length, 0, 'board is not programmed');
    });

    it('fails if a transformed artifact claims the canonical path', async (t) => {
        const { canonical, outputDir, board } = await setup(t);
        const mock = new MockProgrammer([BOARD_A], 'transform-in-place');
        const result = await new ProgrammingService(mock).program(canonical, board, outputDir);
        assert.ok(result.diagnostics.some((d) => d.code === 'PROGRAM_ARTIFACT_OVERWRITES_CANONICAL'));
        assert.equal(mock.programmed.length, 0);
    });

    it('selects a board by serial number when several are connected', async (t) => {
        const { canonical, outputDir, board } = await setup(t);
        const mock = new MockProgrammer([BOARD_A, BOARD_B]);
        const result = await new ProgrammingService(mock).program(canonical, board, outputDir, { serialNumber: 'SN-B' });
        assert.equal(result.status, 'succeeded');
        assert.equal(mock.programmed[0]!.target.selector, 'target-B');
    });

    it('refuses to guess between several boards, and reports missing boards/serials', async (t) => {
        const { canonical, outputDir, board } = await setup(t);
        const codeFor = async (boards: DetectedBoard[], serialNumber?: string) =>
            (await new ProgrammingService(new MockProgrammer(boards)).program(canonical, board, outputDir, serialNumber ? { serialNumber } : {}))
                .diagnostics.map((d) => d.code);
        assert.deepEqual(await codeFor([BOARD_A, BOARD_B]), ['PROGRAM_MULTIPLE_BOARDS']);
        assert.deepEqual(await codeFor([]), ['PROGRAM_NO_BOARD']);
        assert.deepEqual(await codeFor([BOARD_A], 'SN-X'), ['PROGRAM_SERIAL_NOT_FOUND']);
    });

    it('reports an unavailable backend without programming', async (t) => {
        const { canonical, outputDir, board } = await setup(t);
        const mock = new MockProgrammer([BOARD_A], 'copy-transform', false);
        const result = await new ProgrammingService(mock).program(canonical, board, outputDir);
        assert.equal(result.status, 'failed');
        assert.equal(result.diagnostics[0]!.code, 'PROGRAMMER_UNAVAILABLE');
    });

    it('ignores detected boards recognised as a different board type', async () => {
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        const other: DetectedBoard = { selector: 'o', serialNumber: 'SN-O', boardId: 'some-other-board' };
        assert.equal(selectTarget([other, BOARD_A], board).target, BOARD_A);
    });
});
