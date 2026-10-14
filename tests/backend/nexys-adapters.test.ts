import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LegacyProgrammingProvider, OpenXC7ImplementationProvider, XdcConstraintProvider, nexysA7BoardProfile, normalizeLegacyBuild } from '../../core/backend';
import {
    type BoardDefinition,
    type BuildProgress,
    type BuildResult,
    type DetectedBoard,
    type PrepareRequest,
    type ProgrammerProvider,
    type ProgrammingResult,
    ProgrammingService,
    type Project,
    type WorkflowController,
} from '../../core';
import { VALID_CONFIG, makeProject, repoBoards, tempDir, writeBitstream, writeFiles } from '../helpers';

const okStep = (step: BuildResult['steps'][number]['step']) => ({ step, status: 'succeeded' as const, durationMs: 10, diagnostics: [] });

const LEGACY_OK: BuildResult = {
    success: true,
    steps: [okStep('validate'), okStep('workspace'), okStep('check'), okStep('synthesize'), okStep('constraints'), okStep('implement')],
    utilization: { luts: { used: 120, available: 63400 }, flipFlops: { used: 80, available: 126800 }, bram: { used: 1, available: 135 }, dsp: { used: 0, available: 240 }, io: { used: 2 } },
    timing: { clocks: [{ clock: 'CLK100MHZ', targetMHz: 100, achievedMHz: 187.5, passed: true }], worstSlackNs: 4.67, passed: true },
    implementationStage: 'bitstream',
    diagnostics: [{ severity: 'warning', source: 'implementation', code: 'W', message: 'careful' }],
    logs: [{ label: 'apio-build', path: '/tmp/apio.log' }],
    durationMs: 5000,
};

class FakeController {
    readonly calls: { project: Project; options: Parameters<WorkflowController['build']>[1] }[] = [];
    constructor(private readonly result: BuildResult, private readonly events: BuildProgress[] = []) {}
    async build(project: Project, options: Parameters<WorkflowController['build']>[1]): Promise<BuildResult> {
        this.calls.push({ project, options });
        for (const e of this.events) options?.onProgress?.(e);
        return this.result;
    }
}
const asController = (c: FakeController) => c as unknown as WorkflowController;

describe('OpenXC7ImplementationProvider adapter', () => {
    it('delegates to the existing WorkflowController and keeps its result as `native`', async (t) => {
        const profile = nexysA7BoardProfile(await repoBoards());
        const project = await makeProject(t);
        const bit = await writeBitstream(join(project.root, '.nexysvhdl', 'out'));
        const legacy: BuildResult = { ...LEGACY_OK, bitstream: bit };
        const ctl = new FakeController(legacy);
        const provider = new OpenXC7ImplementationProvider({ controllerFor: async () => asController(ctl) });
        assert.ok(provider.supports(profile));
        const r = await provider.build({ projectDir: project.root, board: profile });
        assert.equal(ctl.calls.length, 1, 'one call into the original flow, no second implementation');
        assert.equal(ctl.calls[0]!.project.root, project.root);
        assert.equal(r.native, legacy, 'the original result object is preserved untouched');
        assert.equal(r.implementationStatus, 'passed');
        assert.equal(r.timingStatus, 'met');
        assert.equal(r.device, 'XC7A100T-1CSG324C');
    });

    it('keeps vendor words: LUTs / Flip-Flops / BRAM / DSP, with the original counts', async () => {
        const profile = nexysA7BoardProfile(await repoBoards());
        const n = await normalizeLegacyBuild(LEGACY_OK, profile);
        assert.deepEqual(n.resources.logic, { used: 120, available: 63400, label: 'LUTs', vendorName: 'LUTs' });
        assert.equal(n.resources.registers?.label, 'Flip-Flops');
        assert.equal(n.resources.memoryBlocks?.label, 'BRAM (36 Kb)');
        assert.equal(n.resources.memoryBlocks?.used, 1);
        assert.equal(n.resources.dsp?.label, 'DSP');
        assert.equal(n.resources.pins?.used, 2);
        assert.deepEqual(n.clocks[0], { name: 'CLK100MHZ', targetMHz: 100, fmaxMHz: 187.5, worstSetupSlackNs: 4.67 });
        assert.equal(n.warnings.length, 1);
        assert.equal(n.rawReports[0]?.label, 'apio-build');
    });

    it('names the failing stage in vendor-neutral terms', async () => {
        const profile = nexysA7BoardProfile(await repoBoards());
        const failedImpl: BuildResult = { ...LEGACY_OK, success: false, implementationStage: 'implementation', steps: [okStep('validate'), { step: 'implement', status: 'failed', durationMs: 1, diagnostics: [] }] };
        const n = await normalizeLegacyBuild(failedImpl, profile);
        assert.equal(n.implementationStatus, 'failed');
        assert.equal(n.failedStage, 'fit');
        const failedCheck: BuildResult = { success: false, steps: [{ step: 'check', status: 'failed', durationMs: 1, diagnostics: [] }], diagnostics: [], logs: [], durationMs: 1 };
        assert.equal((await normalizeLegacyBuild(failedCheck, profile)).failedStage, 'prepare');
        const empty: BuildResult = { success: false, steps: [], diagnostics: [], logs: [], durationMs: 0 };
        assert.equal((await normalizeLegacyBuild(empty, profile)).implementationStatus, 'not-run');
    });

    it('reports cancelled when the request was aborted', async () => {
        const profile = nexysA7BoardProfile(await repoBoards());
        const n = await normalizeLegacyBuild({ ...LEGACY_OK, success: false }, profile, true);
        assert.equal(n.implementationStatus, 'cancelled');
    });

    it('forwards the original progress stream unchanged and also emits provider events', async (t) => {
        const profile = nexysA7BoardProfile(await repoBoards());
        const project = await makeProject(t);
        const events: BuildProgress[] = [{ kind: 'step-started', step: 'synthesize' }, { kind: 'implementation-stage', stage: 'implementation' }, { kind: 'step-finished', step: 'implement', status: 'succeeded' }];
        const provider = new OpenXC7ImplementationProvider({ controllerFor: async () => asController(new FakeController(LEGACY_OK, events)) });
        const legacy: BuildProgress[] = [];
        const neutral: string[] = [];
        await provider.buildProject(project, { projectDir: project.root, board: profile, onProgress: (e) => neutral.push(`${e.kind}:${e.stage}`) }, (p) => legacy.push(p));
        assert.deepEqual(legacy, events);
        assert.deepEqual(neutral, ['stage-started:synthesis', 'stage-started:fit', 'stage-finished:fit']);
    });

    it('turns an unreadable project into a failed result without calling the flow', async (t) => {
        const profile = nexysA7BoardProfile(await repoBoards());
        const dir = await tempDir(t);
        let called = false;
        const provider = new OpenXC7ImplementationProvider({ controllerFor: async () => { called = true; return asController(new FakeController(LEGACY_OK)); } });
        const r = await provider.build({ projectDir: dir, board: profile });
        assert.equal(r.implementationStatus, 'failed');
        assert.equal(r.diagnostics[0]?.code, 'PROJECT_FILE_NOT_FOUND');
        assert.equal(called, false);
    });
});

describe('XdcConstraintProvider adapter', () => {
    it('uses the project\'s XDC file, or the generated pin constraints', async (t) => {
        const boards = await repoBoards();
        const profile = nexysA7BoardProfile(boards);
        const p = new XdcConstraintProvider(boards);
        const withFile = await tempDir(t);
        await writeFiles(withFile, { 'nexysvhdl.json': JSON.stringify({ ...VALID_CONFIG, pins: undefined, constraints: 'constraints/n.xdc' }), 'constraints/n.xdc': '# xdc\n' });
        const set = await p.collect(withFile);
        assert.equal(set.origin, 'files');
        assert.deepEqual(set.files.map((f) => f.kind), ['xdc']);
        assert.deepEqual(await p.validate(set, profile), []);

        const generated = await tempDir(t);
        await writeFile(join(generated, 'nexysvhdl.json'), JSON.stringify(VALID_CONFIG));
        const gset = await p.collect(generated);
        assert.equal(gset.origin, 'generated');
        assert.deepEqual(await p.validate(gset, profile, generated), []);
    });

    it('rejects a non-XDC file and a project with neither file nor pins', async (t) => {
        const boards = await repoBoards();
        const profile = nexysA7BoardProfile(boards);
        const p = new XdcConstraintProvider(boards);
        const bad = await p.validate({ format: 'xdc', origin: 'files', files: [{ kind: 'qsf', path: '/x/a.qsf' }] }, profile);
        assert.equal(bad[0]?.code, 'CONSTRAINTS_WRONG_KIND');
        assert.equal((await p.validate({ format: 'xdc', origin: 'files', files: [] }, profile))[0]?.code, 'CONSTRAINTS_NO_XDC');
        const dir = await tempDir(t);
        await writeFile(join(dir, 'nexysvhdl.json'), JSON.stringify({ ...VALID_CONFIG, pins: undefined }));
        assert.equal((await p.validate({ format: 'xdc', origin: 'generated', files: [] }, profile, dir))[0]?.code, 'CONSTRAINTS_NO_PINS');
    });
});

describe('LegacyProgrammingProvider adapter', () => {
    const BOARD: DetectedBoard = { selector: 't', serialNumber: 'SN1', productName: 'Nexys A7', boardId: 'nexys-a7-100t' };
    const mk = (boards: DetectedBoard[], programmed: ProgrammingResult['status'] = 'succeeded') => {
        const calls: string[] = [];
        const programmer: ProgrammerProvider = {
            id: 'mock', displayName: 'Mock',
            availability: async () => ({ available: true, detail: 'ok' }),
            detectBoards: async (_b: BoardDefinition) => ({ boards, diagnostics: [] }),
            prepareArtifact: async (r: PrepareRequest) => ({ path: r.canonical.path, source: r.canonical, transformation: 'none' }),
            program: async (r) => { calls.push(r.artifact.path); return { status: programmed, destination: 'volatile', diagnostics: [], logs: [], durationMs: 1 }; },
        };
        return { calls, service: new ProgrammingService(programmer) };
    };

    it('detects through the existing service and maps the result', async () => {
        const boards = await repoBoards();
        const profile = nexysA7BoardProfile(boards);
        const found = new LegacyProgrammingProvider({ boards, service: mk([BOARD]).service, programDirFor: () => '/tmp', describe: async () => ({ available: true, detail: 'x' }) });
        const d = await found.detect(profile);
        assert.equal(d.status, 'detected');
        assert.equal(d.probes[0]?.serial, 'SN1');
        const none = new LegacyProgrammingProvider({ boards, service: mk([]).service, programDirFor: () => '/tmp', describe: async () => ({ available: true, detail: 'x' }) });
        assert.equal((await none.detect(profile)).status, 'board-absent');
        const unset = new LegacyProgrammingProvider({ boards, service: new ProgrammingService(undefined), programDirFor: () => '/tmp', describe: async () => ({ available: false, detail: 'none' }) });
        assert.equal((await unset.detect(profile)).status, 'programmer-missing');
    });

    it('programs the canonical bitstream through the existing service', async (t) => {
        const boards = await repoBoards();
        const profile = nexysA7BoardProfile(boards);
        const dir = await tempDir(t);
        const bit = await writeBitstream(dir);
        const m = mk([BOARD]);
        const prov = new LegacyProgrammingProvider({ boards, service: m.service, programDirFor: () => dir, describe: async () => ({ available: true, detail: 'x' }) });
        const o = await prov.program({ artifact: { path: bit.path, format: 'bit', sizeBytes: 1, sha256: 'x' }, board: profile });
        assert.equal(o.status, 'programmed');
        assert.equal(o.softwareVerified, true);
        assert.deepEqual(m.calls, [bit.path]);
        const failed = mk([BOARD], 'failed');
        const prov2 = new LegacyProgrammingProvider({ boards, service: failed.service, programDirFor: () => dir, describe: async () => ({ available: true, detail: 'x' }) });
        assert.equal((await prov2.program({ artifact: { path: bit.path, format: 'bit', sizeBytes: 1, sha256: 'x' }, board: profile })).status, 'failed');
    });
});
