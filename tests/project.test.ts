import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadProject, validateProject } from '../core';
import { makeProject, REPO, repoBoards, tempDir } from './helpers';

async function codesFor(project: Parameters<typeof validateProject>[0]): Promise<string[]> {
    const result = await validateProject(project, await repoBoards());
    return result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
}

describe('project validation', () => {
    it('accepts a valid project', async (t) => {
        const result = await validateProject(await makeProject(t), await repoBoards());
        assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    });

    it('accepts the bundled example project', async () => {
        const loaded = await loadProject(join(REPO, 'examples', 'nexys-a7-counter'));
        assert.ok(loaded.ok);
        const result = await validateProject(loaded.project, await repoBoards());
        assert.deepEqual(result.diagnostics, []);
    });

    it('rejects a missing top entity', async (t) => {
        assert.deepEqual(await codesFor(await makeProject(t, { top: '' })), ['PROJECT_MISSING_TOP']);
    });

    it('rejects a missing project name', async (t) => {
        assert.deepEqual(await codesFor(await makeProject(t, { name: ' ' })), ['PROJECT_MISSING_NAME']);
    });

    it('rejects an unsupported board id', async (t) => {
        assert.deepEqual(await codesFor(await makeProject(t, { board: 'basys3' })), ['PROJECT_BOARD_UNSUPPORTED']);
    });

    it('rejects a project with no RTL sources', async (t) => {
        assert.deepEqual(await codesFor(await makeProject(t, { sources: [] })), ['PROJECT_NO_SOURCES']);
    });

    it('rejects source files that do not exist', async (t) => {
        const project = await makeProject(t, {}, false);
        assert.deepEqual((await codesFor(project)).sort(), ['PROJECT_SOURCE_NOT_FOUND', 'PROJECT_SOURCE_NOT_FOUND']);
    });

    it('rejects absolute, backslashed, escaping and non-VHDL paths', async (t) => {
        const cases: Array<[string, string]> = [
            ['/abs/top.vhd', 'PROJECT_PATH_ABSOLUTE'],
            ['C:/abs/top.vhd', 'PROJECT_PATH_ABSOLUTE'],
            ['src\\top.vhd', 'PROJECT_PATH_BACKSLASH'],
            ['../outside.vhd', 'PROJECT_PATH_OUTSIDE'],
            ['src/top.v', 'PROJECT_SOURCE_NOT_VHDL'],
        ];
        for (const [path, code] of cases) {
            const project = await makeProject(t, { sources: [path], simulation: { sources: [] } }, false);
            assert.deepEqual(await codesFor(project), [code], path);
        }
    });

    it('rejects pin mappings to resources the board does not have', async (t) => {
        assert.deepEqual(await codesFor(await makeProject(t, { pins: { led: 'LED15' } })), ['PIN_RESOURCE_UNKNOWN']);
    });

    it('reports every problem at once instead of stopping at the first', async (t) => {
        const codes = await codesFor(await makeProject(t, { top: '', board: 'nope', sources: [] }));
        assert.deepEqual(codes.sort(), ['PROJECT_BOARD_UNSUPPORTED', 'PROJECT_MISSING_TOP', 'PROJECT_NO_SOURCES']);
    });
});

describe('project loading', () => {
    it('reports a missing project file as a structured diagnostic', async (t) => {
        const loaded = await loadProject(await tempDir(t));
        assert.equal(loaded.ok, false);
        assert.equal(!loaded.ok && loaded.diagnostics[0]!.code, 'PROJECT_FILE_NOT_FOUND');
    });

    it('reports invalid JSON as a structured diagnostic', async (t) => {
        const dir = await tempDir(t);
        await writeFile(join(dir, 'nexysvhdl.json'), '{ not json', 'utf8');
        const loaded = await loadProject(dir);
        assert.equal(!loaded.ok && loaded.diagnostics[0]!.code, 'PROJECT_FILE_INVALID_JSON');
    });

    it('applies defaults for language, standard and board', async (t) => {
        const dir = await tempDir(t);
        await writeFile(join(dir, 'nexysvhdl.json'), JSON.stringify({ name: 'n', top: 't', sources: [], pins: {} }), 'utf8');
        const loaded = await loadProject(dir);
        assert.ok(loaded.ok);
        assert.equal(loaded.project.config.language, 'vhdl');
        assert.equal(loaded.project.config.standard, '2008');
        assert.equal(loaded.project.config.board, 'nexys-a7-100t');
    });
});
