import '../extension/install-vscode-fake';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { addFileKindsFor, targetPath, writeNewFile } from '../../extension/project/add-file';
import { de10StarterQsf } from '../../extension/project/de10-templates';
import { createProject } from '../../extension/project/scaffold';
import { NexysVhdlService } from '../../extension/services/nexys-service';
import { buildResultsModel } from '../../extension/services/results-model';
import type { Node } from '../../extension/views/base';
import { FilesView } from '../../extension/views/files-view';
import { ProjectView } from '../../extension/views/project-view';
import { repoBoards, tempDir } from '../helpers';
import { FakeBackend } from '../extension/fake-backend';

async function make(t: TestContext, board: 'nexys-a7-100t' | 'de10-lite', name: string) {
    const parent = await tempDir(t);
    const r = await createProject({ parentDir: parent, name, board: (await repoBoards()).get(board)!, template: 'starter' });
    assert.ok(r.ok);
    return r.root;
}
const labels = (nodes: readonly Node[]): string[] => nodes.map((n) => String(n.label));
const flat = (view: FilesView, nodes: readonly Node[] = view.getChildren()): string[] => nodes.flatMap((n) => [String(n.label), ...flat(view, view.getChildren(n))]);

describe('project switching between boards in one window', () => {
    it('Nexys -> DE10 -> Nexys: board, constraint files and Project view follow the open project', async (t) => {
        const nexys = await make(t, 'nexys-a7-100t', 'NexysDemo');
        const de10 = await make(t, 'de10-lite', 'De10Demo');
        const service = new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 5 });
        t.after(() => service.dispose());
        const project = new ProjectView(service);
        const files = new FilesView(service);
        t.after(() => { project.dispose(); files.dispose(); });

        await service.open(nexys);
        assert.deepEqual(labels(project.getChildren()), ['NexysDemo', 'Nexys A7-100T', 'Environment']);
        assert.equal(service.snapshot?.constraintFormat, 'xdc');
        assert.deepEqual(service.snapshot?.scanned.constraints, ['constraints/nexys-a7-100t.xdc']);

        await service.open(de10);
        assert.deepEqual(labels(project.getChildren()), ['De10Demo', 'DE10-Lite', 'Environment']);
        assert.equal(service.snapshot?.constraintFormat, 'qsf-sdc');
        assert.deepEqual(service.snapshot?.scanned.constraints, ['constraints/de10-lite.qsf', 'constraints/de10-lite.sdc']);
        const names = flat(files);
        assert.ok(names.includes('de10-lite.qsf') && names.includes('de10-lite.sdc'));
        assert.ok(!names.some((n) => n.endsWith('.xdc')), 'no XDC file in a DE10 project');
        assert.equal(service.snapshot?.validation.filter((d) => d.severity === 'error').length, 0);

        await service.open(nexys);
        assert.deepEqual(labels(project.getChildren()), ['NexysDemo', 'Nexys A7-100T', 'Environment']);
        assert.equal(service.snapshot?.constraintFormat, 'xdc');
        const back = flat(files);
        assert.ok(back.includes('nexys-a7-100t.xdc'));
        assert.ok(!back.some((n) => n.endsWith('.qsf') || n.endsWith('.sdc')), 'no QSF/SDC in a Nexys project');
    });

    it('a DE10 build result does not appear on a Nexys project after switching (results are per open project)', async (t) => {
        const de10 = await make(t, 'de10-lite', 'De10Demo');
        const nexys = await make(t, 'nexys-a7-100t', 'NexysDemo');
        const backend = new FakeBackend();
        const service = new NexysVhdlService({ backend, debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(de10);
        backend.buildResult = {
            success: true, steps: [{ step: 'check', status: 'succeeded', durationMs: 1, diagnostics: [] }, { step: 'implement', status: 'succeeded', durationMs: 1, diagnostics: [] }],
            diagnostics: [], logs: [], durationMs: 5,
            normalized: { boardId: 'de10-lite', device: '10M50DAF484C7G', implementationStatus: 'passed', timingStatus: 'met', clocks: [], labels: { logic: 'Logic Elements', registers: 'Registers', memory: 'Memory Bits', dsp: 'DSP Blocks' }, resources: { logic: { used: 27, label: 'Logic Elements', vendorName: 'Total logic elements' } }, warnings: [], diagnostics: [], rawReports: [], logs: [], stageDurationsMs: {}, durationMs: 5 },
        };
        const built = await service.build();
        assert.equal(built.success, true);
        assert.ok(service.lastBuild);
        await service.open(nexys);
        // A different project root clears what the previous project produced.
        assert.equal(service.lastBuild, undefined);
        assert.equal(service.workflow.build.state, 'idle');
        assert.equal(service.hardware.status, 'unknown');
        assert.deepEqual(buildResultsModel(undefined, undefined, service.lastBuild).build, undefined);
    });
});

describe('DE10-Lite projects through the service', () => {
    it('Add File offers only QSF and SDC; a new QSF keeps the exact device; nothing asks about activating constraints', async (t) => {
        const de10 = await make(t, 'de10-lite', 'De10Demo');
        const service = new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(de10);
        assert.deepEqual(addFileKindsFor(service.snapshot!.constraintFormat).map((k) => k.kind), ['source', 'simulation', 'qsf', 'sdc']);
        const board = (await repoBoards()).get('de10-lite')!;
        await writeNewFile(de10, targetPath('qsf', 'extra'), de10StarterQsf('De10Demo', board, { starterPorts: false }));
        const outcome = await service.filesAdded('qsf', ['constraints/extra.qsf']);
        assert.equal(outcome.constraints, 'already-active', 'every QSF/SDC in constraints/ is used: no "make it active?" question');
        assert.ok(service.snapshot!.scanned.constraints.includes('constraints/extra.qsf'));
        const text = await readFile(join(de10, 'constraints', 'extra.qsf'), 'utf8');
        assert.match(text, /^set_global_assignment -name DEVICE 10M50DAF484C7G$/m);
    });

    it('removing a QSF from a DE10 project works like any other file and clears nothing else', async (t) => {
        const de10 = await make(t, 'de10-lite', 'De10Demo');
        const service = new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(de10);
        const impact = service.removalImpact('constraints/de10-lite.sdc');
        assert.deepEqual(impact, {});
        const removed = await service.removeFromProject('constraints/de10-lite.sdc');
        assert.equal(removed.constraints, undefined);
        assert.ok(!service.snapshot!.scanned.constraints.includes('constraints/de10-lite.sdc'));
        assert.ok(service.snapshot!.validation.some((d) => d.code === 'PROJECT_NO_SDC'), 'the project now says it needs an SDC');
    });
});
