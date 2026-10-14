import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DE10_LITE_PROFILE, type BuildProgressEvent } from '../../core/backend';
import { LimaEngine } from '../../platform/macos/de10/engine';
import { QUARTUS_STEPS, QuartusLimaImplementationProvider, inferTop, jobId } from '../../platform/macos/de10/quartus-lima-provider';
import { tempDir } from '../helpers';
import { FakeVm, makeDe10Project, testPaths, type VmOptions } from './fake-vm';

async function setup(t: import('node:test').TestContext, o: VmOptions = {}) {
    const { home, paths } = await testPaths(t);
    const vm = new FakeVm(paths, o);
    const engine = new LimaEngine(paths, vm);
    const provider = new QuartusLimaImplementationProvider(paths, engine);
    const project = await makeDe10Project(t);
    return { home, paths, vm, provider, project, req: (extra = {}) => ({ projectDir: project, board: DE10_LITE_PROFILE, ...extra }) };
}

const tree = async (dir: string): Promise<string[]> => (await readdir(dir, { recursive: true })).sort();
const quartusTools = (vm: FakeVm) => vm.guestScripts.map((s) => /mixfpga-q (quartus_\w+)/.exec(s)?.[1]).filter((x): x is string => !!x && x !== 'quartus_sh');

describe('DE10-Lite build: success path', () => {
    it('runs the proven Quartus chain in order and returns a normalized result', async (t) => {
        const { provider, req, vm, project } = await setup(t);
        const events: string[] = [];
        const r = await provider.build(req({ onProgress: (e: BuildProgressEvent) => events.push(`${e.kind === 'stage-started' ? '+' : e.ok ? '✓' : '✗'}${e.stage}`) }));
        assert.equal(r.implementationStatus, 'passed', JSON.stringify(r.diagnostics));
        assert.deepEqual(quartusTools(vm), ['quartus_map', 'quartus_fit', 'quartus_sta', 'quartus_asm', 'quartus_cpf']);
        assert.deepEqual(events.filter((e) => e[0] !== '+'), ['✓prepare', '✓stage', '✓synthesis', '✓fit', '✓timing', '✓assemble', '✓package', '✓collect']);
        assert.equal(r.timingStatus, 'met');
        assert.equal(r.boardId, 'de10-lite');
        assert.equal(r.device, '10M50DAF484C7G');
        assert.equal(r.resources.logic?.used, 27);
        assert.equal(r.resources.logic?.label, 'Logic Elements');
        assert.equal(r.clocks[0]?.name, 'clk_50');
        assert.equal(r.clocks[0]?.targetMHz, 50);
        const art = r.programmingArtifact!;
        assert.equal(art.format, 'svf');
        assert.equal(art.path, join(project, '.mix-fpga', 'build', 'de10-lite', 'blink.svf'));
        assert.equal(art.sha256, createHash('sha256').update('SVF-BYTES-1234').digest('hex'));
        assert.equal(art.sizeBytes, 14);
        assert.ok(r.rawReports.some((x) => x.label === 'fit.rpt') === false, 'fixture has no fit.rpt; only existing reports are listed');
        assert.equal(r.logs.length, QUARTUS_STEPS.length);
        assert.ok(Object.keys(r.stageDurationsMs).includes('synthesis'));
        assert.equal(r.warnings.filter((w) => w.code === 'QUARTUS_W18236').length, 1, 'repeated warnings are reported once');
    });

    it('never modifies the student sources and writes only under .mix-fpga', async (t) => {
        const { provider, req, project } = await setup(t);
        const before = new Map<string, string>();
        for (const f of await tree(project)) before.set(f, f.endsWith('src') || f.endsWith('constraints') ? '' : await readFile(join(project, f), 'utf8').catch(() => ''));
        const r = await provider.build(req());
        assert.equal(r.implementationStatus, 'passed');
        for (const [f, text] of before) if (text) assert.equal(await readFile(join(project, f), 'utf8'), text, f);
        const added = (await tree(project)).filter((f) => !before.has(f));
        assert.ok(added.length > 0 && added.every((f) => f === '.mix-fpga' || f.startsWith('.mix-fpga')), `unexpected writes: ${added.join(', ')}`);
    });

    it('stages into a private job directory (copy + generated Quartus project), not in the project', async (t) => {
        const { provider, req, paths, project } = await setup(t);
        await provider.build(req());
        const jobs = await readdir(join(paths.shareDir, 'jobs'));
        assert.equal(jobs.length, 1);
        assert.ok(jobs[0]!.startsWith(jobId(project)));
        const job = join(paths.shareDir, 'jobs', jobs[0]!);
        const qsf = await readFile(join(job, 'blink.qsf'), 'utf8');
        assert.match(qsf, /TOP_LEVEL_ENTITY blink/);
        assert.match(qsf, /VHDL_FILE src\/blink\.vhd/);
        assert.match(qsf, /SDC_FILE constraints\/de10-lite\.sdc/);
        assert.match(qsf, /DEVICE 10M50DAF484C7G/);
        assert.match(await readFile(join(job, 'blink.qpf'), 'utf8'), /PROJECT_REVISION = "blink"/);
        assert.match(await readFile(join(job, 'MANIFEST.sha256'), 'utf8'), /src\/blink\.vhd/);
        assert.equal(await readFile(join(job, 'src', 'blink.vhd'), 'utf8'), await readFile(join(project, 'src', 'blink.vhd'), 'utf8'));
    });

    it('uses a fresh job directory per build and removes the old one', async (t) => {
        const { provider, req, paths } = await setup(t);
        await provider.build(req());
        const first = await readdir(join(paths.shareDir, 'jobs'));
        await provider.build(req());
        const second = await readdir(join(paths.shareDir, 'jobs'));
        assert.equal(second.length, 1);
        assert.notEqual(first[0], second[0]);
    });

    it('handles a project path with spaces and passes no host path to the guest shell', async (t) => {
        const { provider, req, vm, project } = await setup(t);
        assert.match(project, / /);
        assert.equal((await provider.build(req())).implementationStatus, 'passed');
        assert.ok(vm.guestScripts.every((s) => !s.includes(project)));
        assert.ok(vm.calls.every((c) => c.args.every((a) => typeof a === 'string')));
    });

    it('starts a stopped VM automatically before building', async (t) => {
        const { provider, req, vm } = await setup(t, { vm: 'Stopped' });
        assert.equal((await provider.build(req())).implementationStatus, 'passed');
        assert.ok(vm.limaArgs.some((a) => a[0] === 'start'));
    });

    it('leaves the VM running afterwards', async (t) => {
        const { provider, req, vm } = await setup(t);
        await provider.build(req());
        assert.equal(vm.state, 'Running');
        assert.ok(!vm.limaArgs.some((a) => a[0] === 'stop'));
    });

    it('infers the top entity only when it is unambiguous', () => {
        assert.equal(inferTop(['entity blink is\nend;']), 'blink');
        assert.equal(inferTop(['entity a is\nend;', 'entity b is\nend;']), 'top');
        assert.equal(inferTop([]), 'top');
    });
});

describe('DE10-Lite build: files removed from the project', () => {
    it('are never staged or hashed, even though they stay on disk', async (t) => {
        const { provider, paths, req, project } = await setup(t);
        await writeFile(join(project, 'constraints', 'old.sdc'), 'create_clock -name stale -period 5 [get_ports clk_50]\n');
        const exclude = ['constraints/old.sdc'];
        const fakeProject = { root: project, file: join(project, 'nexysvhdl.json'), config: { exclude } } as unknown as import('../../core').Project;
        const r = await provider.build(req({ project: fakeProject }));
        assert.equal(r.implementationStatus, 'passed', JSON.stringify(r.diagnostics));
        const job = join(paths.shareDir, 'jobs', (await readdir(join(paths.shareDir, 'jobs')))[0]!);
        assert.deepEqual((await readdir(join(job, 'constraints'))).sort(), ['de10-lite.qsf', 'de10-lite.sdc']);
        assert.doesNotMatch(await readFile(join(job, 'blink.qsf'), 'utf8'), /old\.sdc/);
        const inputs = await provider.currentInputs(project, ['src/blink.vhd'], exclude);
        assert.deepEqual(Object.keys(inputs).sort(), ['constraints/de10-lite.qsf', 'constraints/de10-lite.sdc', 'src/blink.vhd']);
        assert.ok('constraints/old.sdc' in (await provider.currentInputs(project, ['src/blink.vhd'])), 'without the exclusion it would count');
    });
});

describe('DE10-Lite build: failures are reported accurately', () => {
    it('propagates a nonzero Quartus exit code, stops the chain and names the stage', async (t) => {
        const { provider, req, vm } = await setup(t, { failStep: { tool: 'quartus_fit', exitCode: 3 } });
        const r = await provider.build(req());
        assert.equal(r.implementationStatus, 'failed');
        assert.equal(r.failedStage, 'fit');
        assert.deepEqual(quartusTools(vm), ['quartus_map', 'quartus_fit'], 'asm/sta/cpf must not run after a failed fitter');
        assert.ok(r.diagnostics.some((d) => d.code === 'QUARTUS_FAILED' && /exit 3/.test(d.message)));
        assert.ok(r.diagnostics.some((d) => d.code === 'QUARTUS_E12345'), 'the tool\'s own error message is surfaced');
        assert.equal(r.programmingArtifact, undefined);
    });

    it('does not trust exit code 0 without Quartus\'s own success line', async (t) => {
        const { provider, req } = await setup(t, { failStep: { tool: 'quartus_map', exitCode: 0, withoutSuccessLine: true } });
        const r = await provider.build(req());
        assert.equal(r.implementationStatus, 'failed');
        assert.equal(r.failedStage, 'synthesis');
        assert.ok(r.diagnostics.some((d) => d.code === 'QUARTUS_NO_SUCCESS_LINE'));
    });

    it('detects a missing programming artifact even though every tool said success', async (t) => {
        const { provider, req } = await setup(t, { noSvf: true });
        const r = await provider.build(req());
        assert.equal(r.implementationStatus, 'failed');
        assert.equal(r.failedStage, 'collect');
        assert.ok(r.diagnostics.some((d) => d.code === 'ARTIFACT_MISSING' && /blink\.svf/.test(d.message)));
        assert.equal(r.programmingArtifact, undefined);
    });

    it('stops at prepare when the VM cannot start, running no Quartus step', async (t) => {
        const { provider, req, vm } = await setup(t, { vm: 'Stopped', startFails: true });
        const r = await provider.build(req());
        assert.equal(r.implementationStatus, 'failed');
        assert.equal(r.failedStage, 'prepare');
        assert.ok(r.diagnostics.some((d) => d.code === 'ENGINE_START_FAILED'));
        assert.deepEqual(quartusTools(vm), []);
    });

    it('stops at prepare when Quartus crashes and cannot be repaired (Rosetta SIGBUS)', async (t) => {
        const { provider, req } = await setup(t, { probes: ['sigbus'] });
        const r = await provider.build(req());
        assert.equal(r.failedStage, 'prepare');
        assert.ok(r.diagnostics.some((d) => d.code === 'QUARTUS_SIGBUS'));
    });

    it('rejects constraints for the wrong device before touching the VM', async (t) => {
        const { provider, vm } = await setup(t);
        const bad = await makeDe10Project(t, '10M08SAE144C8G');
        const r = await provider.build({ projectDir: bad, board: DE10_LITE_PROFILE });
        assert.equal(r.failedStage, 'prepare');
        assert.ok(r.diagnostics.some((d) => d.code === 'CONSTRAINTS_WRONG_DEVICE'));
        assert.equal(vm.calls.length, 0);
    });

    it('reports a project without VHDL', async (t) => {
        const { provider, vm } = await setup(t);
        const empty = await tempDir(t);
        const r = await provider.build({ projectDir: empty, board: DE10_LITE_PROFILE });
        assert.equal(r.implementationStatus, 'failed');
        assert.ok(r.diagnostics.some((d) => d.code === 'PROJECT_NO_VHDL'));
        assert.equal(vm.calls.length, 0);
    });

    it('fails the build if a student file changes while it runs', async (t) => {
        const { project } = { project: await makeDe10Project(t) };
        const { home: _h, paths } = await testPaths(t);
        void _h;
        const vm = new FakeVm(paths, { onGuest: async (s) => { if (s.includes('quartus_fit')) await writeFile(join(project, 'src', 'blink.vhd'), '-- tampered\n'); } });
        const provider = new QuartusLimaImplementationProvider(paths, new LimaEngine(paths, vm));
        const r = await provider.build({ projectDir: project, board: DE10_LITE_PROFILE });
        assert.equal(r.implementationStatus, 'failed');
        assert.ok(r.diagnostics.some((d) => d.code === 'SOURCE_MODIFIED'));
    });
});

describe('DE10-Lite build: cancellation', () => {
    it('reports cancelled (not failed), stops the chain and kills Quartus inside the VM', async (t) => {
        const { provider, req, vm } = await setup(t, { cancelOn: 'quartus_fit' });
        const r = await provider.build(req());
        assert.equal(r.implementationStatus, 'cancelled');
        assert.equal(r.failedStage, 'fit');
        assert.deepEqual(quartusTools(vm), ['quartus_map', 'quartus_fit']);
        assert.ok(vm.guestScripts.some((s) => s.includes('pkill')), 'guest cleanup ran');
        assert.equal(r.programmingArtifact, undefined);
    });

    it('cancelBuild() aborts the signal that reaches the running process', async (t) => {
        const { paths } = await testPaths(t);
        const project = await makeDe10Project(t);
        let seen: AbortSignal | undefined;
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const vm = new FakeVm(paths, { onGuest: async (s) => { if (s.includes('quartus_map')) await gate; } });
        const origRun = vm.run.bind(vm);
        vm.run = async (inv) => { if (inv.args.at(-1)?.includes('quartus_map')) seen = inv.signal; return origRun(inv); };
        const provider = new QuartusLimaImplementationProvider(paths, new LimaEngine(paths, vm));
        const pending = provider.build({ projectDir: project, board: DE10_LITE_PROFILE });
        while (!seen) await new Promise((r) => setTimeout(r, 5));
        const cancel = provider.cancel();
        assert.equal(seen.aborted, true);
        release();
        await cancel;
        const r = await pending;
        assert.equal(r.implementationStatus, 'cancelled', 'cancel wins even if the tool finished in the same instant');
        assert.equal(r.programmingArtifact, undefined);
        assert.ok(vm.guestScripts.some((s) => s.includes('pkill')));
    });

    it('an already-aborted request never runs Quartus', async (t) => {
        const { provider, req, vm } = await setup(t);
        const ac = new AbortController();
        ac.abort();
        const r = await provider.build(req({ signal: ac.signal }));
        assert.equal(r.implementationStatus, 'cancelled');
        assert.deepEqual(quartusTools(vm), []);
    });
});
