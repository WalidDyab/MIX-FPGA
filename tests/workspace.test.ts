import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { BuildWorkspace, checkIsolation, WORKSPACE_DIR_NAME, WorkspaceManager } from '../core';
import { makeProject, writeFiles } from './helpers';

async function listRecursive(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (e.isFile()) out.push(relative(dir, join(e.parentPath, e.name)).split('\\').join('/'));
    }
    return out.sort();
}

describe('build workspace isolation (ADR-001)', () => {
    it('opens under <project>/.nexysvhdl with separate check/sim/synth/impl/program/logs folders', async (t) => {
        const project = await makeProject(t);
        const { workspace, diagnostics } = await new WorkspaceManager().open(project);
        assert.deepEqual(diagnostics, []);
        assert.equal(workspace!.paths.root, join(project.root, WORKSPACE_DIR_NAME));
        const dirs = new Set(Object.values(workspace!.paths));
        assert.equal(dirs.size, 7, 'all workspace folders are distinct');
    });

    it('refuses a workspace equal to the project root', async (t) => {
        const project = await makeProject(t);
        const result = await new WorkspaceManager((p) => p.root).open(project);
        assert.equal(result.workspace, undefined);
        assert.ok(result.diagnostics.some((d) => d.code === 'WORKSPACE_IS_PROJECT_ROOT'));
    });

    it('refuses a workspace that contains student sources', async (t) => {
        const project = await makeProject(t);
        const problems = checkIsolation(project, join(project.root, 'src'));
        assert.deepEqual(problems.map((d) => d.code), ['WORKSPACE_CONTAINS_SOURCE']);
    });

    it('stages exactly the given files; stray .v/.xdc in the student tree never reach it', async (t) => {
        const project = await makeProject(t);
        // The Phase 2 failure: a stray Verilog copy with a duplicate module, plus an extra constraint file.
        await writeFiles(project.root, { 'src/stray_copy.v': 'module top; endmodule\n', 'old.xdc': '# stale\n' });
        const { workspace } = await new WorkspaceManager().open(project);
        const staged = await workspace!.stageImplementation([
            { name: 'generated.v', content: 'module top(); endmodule\n' },
            { name: 'generated.xdc', content: '# xdc\n' },
            { name: 'apio.ini', content: '[env:default]\n' },
        ]);
        assert.deepEqual(await listRecursive(staged.dir), ['apio.ini', 'generated.v', 'generated.xdc']);
        assert.ok(!staged.files.some((f) => f.includes('stray_copy')));
    });

    it('writes generated files into the workspace, never into src/', async (t) => {
        const project = await makeProject(t);
        const before = await listRecursive(join(project.root, 'src'));
        const { workspace } = await new WorkspaceManager().open(project);
        await workspace!.stageImplementation([{ name: 'generated.v', content: 'x' }]);
        assert.deepEqual(await listRecursive(join(project.root, 'src')), before);
        assert.ok(relative(project.root, workspace!.paths.impl).startsWith(WORKSPACE_DIR_NAME));
    });

    it('removes stale files from a previous staging', async (t) => {
        const project = await makeProject(t);
        const { workspace } = await new WorkspaceManager().open(project);
        await workspace!.stageImplementation([{ name: 'old.v', content: 'old' }]);
        await writeFile(join(workspace!.paths.impl, 'leftover.v'), 'junk');
        await workspace!.stageImplementation([{ name: 'generated.v', content: 'new' }]);
        assert.deepEqual(await listRecursive(workspace!.paths.impl), ['generated.v']);
    });

    it('copies a staged file from a source path byte-for-byte', async (t) => {
        const project = await makeProject(t);
        const { workspace } = await new WorkspaceManager().open(project);
        const src = join(workspace!.paths.synth, 'generated.v');
        await writeFile(src, 'module top; endmodule\n');
        const staged = await workspace!.stageImplementation([{ name: 'generated.v', sourcePath: src }]);
        assert.equal(await readFile(staged.files[0]!, 'utf8'), 'module top; endmodule\n');
    });

    it('rejects staged names containing folders or duplicates', async (t) => {
        const ws = new BuildWorkspace(BuildWorkspace.pathsFor(join((await makeProject(t)).root, WORKSPACE_DIR_NAME)));
        await assert.rejects(ws.stageImplementation([{ name: '../escape.v', content: '' }]));
        await assert.rejects(ws.stageImplementation([{ name: 'sub/x.v', content: '' }]));
        await assert.rejects(ws.stageImplementation([{ name: 'a.v', content: '' }, { name: 'a.v', content: '' }]));
    });
});
