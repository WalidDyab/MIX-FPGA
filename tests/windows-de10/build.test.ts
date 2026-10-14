import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DE10_LITE_PROFILE, QUARTUS_STEPS, QuartusImplementationProvider, type BuildProgressEvent } from '../../core/backend';
import { NativeQuartusEngine } from '../../platform/windows/de10/native-quartus-engine';
import { NativeQuartusExecutor } from '../../platform/windows/de10/quartus-native-executor';
import { tempDir } from '../helpers';
import { makeDe10Project } from '../mixfpga/fake-vm';
import { FakeQuartusRunner, windowsEnv, type QuartusOptions } from './fake-quartus';

async function setup(t: import('node:test').TestContext, o: QuartusOptions = {}) {
    const env = await windowsEnv(t, o);
    const runner = new FakeQuartusRunner(env, o);
    const engine = new NativeQuartusEngine(env.paths, runner);
    const provider = new QuartusImplementationProvider(new NativeQuartusExecutor(env.paths, engine));
    const project = await makeDe10Project(t);
    return { env, runner, engine, provider, project, req: (extra = {}) => ({ projectDir: project, board: DE10_LITE_PROFILE, ...extra }) };
}

const tree = async (dir: string): Promise<string[]> => (await readdir(dir, { recursive: true })).sort();

describe('DE10-Lite on Windows: native Quartus build', () => {
    it('runs the same proven chain as macOS, natively, and returns the same normalized result', async (t) => {
        const { provider, req, runner, project } = await setup(t);
        const events: string[] = [];
        const r = await provider.build(req({ onProgress: (e: BuildProgressEvent) => events.push(`${e.kind === 'stage-started' ? '+' : e.ok ? 'ok:' : 'FAIL:'}${e.stage}`) }));
        assert.equal(r.implementationStatus, 'passed', JSON.stringify(r.diagnostics));
        assert.deepEqual(runner.chain, ['quartus_map', 'quartus_fit', 'quartus_sta', 'quartus_asm', 'quartus_cpf']);
        assert.deepEqual(events.filter((e) => !e.startsWith('+')), ['ok:prepare', 'ok:stage', 'ok:synthesis', 'ok:fit', 'ok:timing', 'ok:assemble', 'ok:package', 'ok:collect']);
        assert.equal(r.timingStatus, 'met');
        assert.equal(r.boardId, 'de10-lite');
        assert.equal(r.device, '10M50DAF484C7G');
        assert.equal(r.resources.logic?.used, 27);
        assert.equal(r.resources.logic?.label, 'Logic Elements');
        assert.equal(r.resources.registers?.label, 'Registers');
        assert.equal(r.clocks[0]?.name, 'clk_50');
        assert.equal(r.clocks[0]?.targetMHz, 50);
        const art = r.programmingArtifact!;
        assert.equal(art.format, 'sof', 'Windows programs the .sof');
        assert.equal(art.path, join(project, '.mix-fpga', 'build', 'de10-lite', 'blink.sof'));
        assert.equal(art.sha256, createHash('sha256').update('SOF-BYTES').digest('hex'));
        assert.deepEqual(r.programmingArtifacts?.map((a) => a.format).sort(), ['sof', 'svf'], 'the .svf is built too');
        assert.equal(r.logs.length, QUARTUS_STEPS.length);
        assert.equal(r.warnings.filter((w) => w.code === 'QUARTUS_W18236').length, 1, 'repeated warnings are reported once');
    });

    it('parses reports written with Windows (CRLF) line endings exactly as LF ones', async (t) => {
        const lf = await setup(t);
        const a = await lf.provider.build(lf.req());
        const win = await setup(t, { crlf: true });
        const b = await win.provider.build(win.req());
        assert.equal(b.implementationStatus, 'passed', JSON.stringify(b.diagnostics));
        assert.deepEqual(b.resources, a.resources);
        assert.deepEqual(b.clocks, a.clocks);
        assert.equal(b.timingStatus, a.timingStatus);
    });

    it('runs every tool by full path in the staged job folder, the conversion in output_files, with the install on PATH', async (t) => {
        const { provider, req, runner, env } = await setup(t);
        assert.equal((await provider.build(req())).implementationStatus, 'passed');
        const tools = runner.calls.filter((c) => c.args[0] !== '--version' && c.args[0] !== '-t');
        assert.equal(tools.length, 5);
        for (const c of tools) {
            assert.ok(c.executable.startsWith(join(env.quartusRoot, 'quartus', 'bin64')), c.executable);
            assert.equal(c.env?.['QUARTUS_ROOTDIR'], join(env.quartusRoot, 'quartus'));
            assert.ok(c.env?.['PATH']?.startsWith(join(env.quartusRoot, 'quartus', 'bin64') + ';'));
            assert.ok(c.cwd!.startsWith(env.paths.jobsRoot), 'tools run in the private job folder, never in the student project');
        }
        assert.ok(tools[4]!.cwd!.endsWith('output_files') && tools[4]!.args.includes('blink.sof'));
        assert.deepEqual(tools[0]!.args, ['blink', '--read_settings_files=on']);
    });

    it('never modifies the student sources, writes only under .mix-fpga, and uses no VM', async (t) => {
        const { provider, req, project, runner } = await setup(t);
        const before = new Map<string, string>();
        for (const f of await tree(project)) before.set(f, await readFile(join(project, f), 'utf8').catch(() => ''));
        assert.equal((await provider.build(req())).implementationStatus, 'passed');
        for (const [f, text] of before) if (text) assert.equal(await readFile(join(project, f), 'utf8'), text, f);
        const added = (await tree(project)).filter((f) => !before.has(f));
        assert.ok(added.length > 0 && added.every((f) => f.startsWith('.mix-fpga')), `unexpected writes: ${added.join(', ')}`);
        assert.ok(runner.calls.every((c) => /quartus_\w+\.exe$/.test(c.executable)), 'only Quartus tools were started');
    });

    it('stages a private job folder per build and removes the previous one', async (t) => {
        const { provider, req, env } = await setup(t);
        await provider.build(req());
        const first = await readdir(env.paths.jobsRoot);
        await provider.build(req());
        const second = await readdir(env.paths.jobsRoot);
        assert.equal(second.length, 1);
        assert.notEqual(first[0], second[0]);
        const qsf = await readFile(join(env.paths.jobsRoot, second[0]!, 'blink.qsf'), 'utf8');
        assert.match(qsf, /TOP_LEVEL_ENTITY blink/);
        assert.match(qsf, /SDC_FILE constraints\/de10-lite\.sdc/);
        assert.match(qsf, /DEVICE 10M50DAF484C7G/);
    });

    it('handles a project path with spaces', async (t) => {
        const { provider, req, project, runner } = await setup(t);
        assert.match(project, / /);
        assert.equal((await provider.build(req())).implementationStatus, 'passed');
        assert.ok(runner.calls.every((c) => !c.args.some((a) => a.includes(project))), 'no student path is passed to Quartus');
    });

    it('fails clearly, running nothing, when Quartus is not installed', async (t) => {
        const { provider, req, runner } = await setup(t, { install: 'none' });
        const r = await provider.build(req());
        assert.equal(r.implementationStatus, 'failed');
        assert.equal(r.failedStage, 'prepare');
        assert.ok(r.diagnostics.some((d) => d.code === 'ENGINE_NOT_INSTALLED' && /Quartus Prime Lite 25\.1 Build 1129 is not installed/.test(d.message)));
        assert.equal(runner.calls.length, 0);
    });

    it('rejects a different Quartus version instead of building with it', async (t) => {
        const { provider, req, runner } = await setup(t, { install: 'other-version' });
        // the fake install lives in a 23.1std folder, which the engine does not look at: it is reported as not installed
        const r = await provider.build(req());
        assert.equal(r.implementationStatus, 'failed');
        assert.ok(r.diagnostics.some((d) => d.code === 'ENGINE_NOT_INSTALLED' && /23\.1std/.test(d.message)), 'names the other install it found');
        assert.deepEqual(runner.chain, []);
    });

    it('rejects an install in the right place that is the wrong version', async (t) => {
        const env = await windowsEnv(t);
        const wrong = new FakeQuartusRunner({ ...env, quartusRoot: join(env.root, 'x', '23.1std') }, {});
        const engine = new NativeQuartusEngine(env.paths, wrong);
        const s = await engine.status();
        assert.equal(s.state, 'unhealthy');
        assert.equal(s.problems[0]?.code, 'QUARTUS_WRONG_VERSION');
        assert.match(s.problems[0]!.message, /23\.1std\.0 Build 991.*needs Quartus Prime Lite 25\.1 Build 1129/);
    });

    it('reports a missing MAX 10 package before running anything', async (t) => {
        const { provider, req, runner } = await setup(t, { parts: 'no-max10' });
        const r = await provider.build(req());
        assert.equal(r.implementationStatus, 'failed');
        assert.ok(r.diagnostics.some((d) => d.code === 'MAX10_MISSING'));
        assert.deepEqual(runner.chain, []);
    });

    it('stops at the failing stage and reports it', async (t) => {
        const { provider, req, runner } = await setup(t, { failStep: { tool: 'quartus_fit', exitCode: 2 } });
        const r = await provider.build(req());
        assert.equal(r.implementationStatus, 'failed');
        assert.equal(r.failedStage, 'fit');
        assert.deepEqual(runner.chain, ['quartus_map', 'quartus_fit']);
        assert.ok(r.diagnostics.some((d) => d.code === 'QUARTUS_FAILED'));
    });

    it('does not accept exit code 0 without a Quartus success line', async (t) => {
        const { provider, req } = await setup(t, { failStep: { tool: 'quartus_map', exitCode: 0, withoutSuccessLine: true } });
        const r = await provider.build(req());
        assert.equal(r.implementationStatus, 'failed');
        assert.ok(r.diagnostics.some((d) => d.code === 'QUARTUS_NO_SUCCESS_LINE'));
    });

    it('fails when the programming file was not produced', async (t) => {
        const { provider, req } = await setup(t, { noSvf: true });
        const r = await provider.build(req());
        assert.equal(r.implementationStatus, 'failed');
        assert.ok(r.diagnostics.some((d) => d.code === 'ARTIFACT_MISSING'));
        assert.equal(r.programmingArtifact, undefined);
    });

    it('cancellation ends the build as cancelled without running later stages', async (t) => {
        const { provider, req, runner } = await setup(t, { cancelOn: 'quartus_fit' });
        const r = await provider.build(req());
        assert.equal(r.implementationStatus, 'cancelled');
        assert.deepEqual(runner.chain, ['quartus_map', 'quartus_fit']);
        await provider.cancel(); // safe when idle
    });

    it('aborting from outside cancels a running build', async (t) => {
        const ac = new AbortController();
        const { provider, req, runner } = await setup(t, { onTool: (tool) => { if (tool === 'quartus_map') ac.abort(); } });
        const r = await provider.build(req({ signal: ac.signal }));
        assert.equal(r.implementationStatus, 'cancelled');
        assert.ok(!runner.chain.includes('quartus_fit'));
    });

    it('records the board and input hashes so a changed design makes the artifact stale', async (t) => {
        const { provider, req, project } = await setup(t);
        const r = await provider.build(req());
        const info = await provider.artifactFor(project, 'blink');
        assert.equal(info?.boardId, 'de10-lite');
        assert.equal(info?.sha256, r.programmingArtifact?.sha256);
        const now = await provider.currentInputs(project, ['src/blink.vhd']);
        assert.deepEqual(now, info?.inputs);
        await writeFile(join(project, 'src', 'blink.vhd'), 'entity blink is\nend entity blink; -- changed\n');
        const changed = await provider.currentInputs(project, ['src/blink.vhd']);
        assert.notDeepEqual(changed, info?.inputs);
    });

    it('the engine is just Quartus: ready when present, restart re-checks it, nothing is started or stopped', async (t) => {
        const { engine, runner } = await setup(t);
        const s = await engine.status();
        assert.equal(s.state, 'running');
        assert.equal(s.toolVersion, 'Version 25.1std.0 Build 1129');
        const r = await engine.restart();
        assert.equal(r.state, 'running');
        await engine.shutdown();
        assert.ok(runner.calls.every((c) => c.args[0] === '--version' || c.args[0] === '-t'), 'only readiness probes ran');
    });

    it('creates the job folder under the per-user MIX-FPGA folder, not under the project or the repo', async (t) => {
        const { env } = await setup(t);
        assert.equal(env.paths.jobsRoot, join(env.root, 'AppData Local', 'MIX-FPGA', 'staging', 'jobs'));
        await mkdir(env.paths.jobsRoot, { recursive: true });
        assert.ok((await stat(env.paths.jobsRoot)).isDirectory());
        void tempDir;
    });
});

describe('Windows MAX 10 readiness comes from Quartus, not from folder layout', () => {
    const status = async (t: import('node:test').TestContext, parts: NonNullable<QuartusOptions['parts']>) => {
        const { engine, runner } = await setup(t, { parts });
        return { s: await engine.status(), runner };
    };

    it('package present and the exact part listed: running, via load_package device / get_part_list', async (t) => {
        const { s, runner } = await status(t, 'ok');
        assert.equal(s.state, 'running');
        const q = runner.calls.find((c) => c.args[0] === '-t')!;
        const tcl = await readFile(q.args[1]!, 'utf8');
        assert.match(tcl, /load_package device/);
        assert.match(tcl, /get_part_list -family \{MAX 10\}/);
        assert.match(tcl, /10M50DAF484C7G/);
    });

    it('does not look at the install folder layout (no devinfo\max10 needed)', async (t) => {
        const env = await windowsEnv(t);
        const { stat } = await import('node:fs/promises');
        assert.equal(await stat(join(env.quartusRoot, 'quartus', 'common', 'devinfo', 'max10')).then(() => true, () => false), false);
        const engine = new NativeQuartusEngine(env.paths, new FakeQuartusRunner(env));
        assert.equal((await engine.status()).state, 'running');
    });

    it('package missing (no MAX 10 parts): MAX10_MISSING', async (t) => {
        const { s } = await status(t, 'no-max10');
        assert.equal(s.state, 'unhealthy');
        assert.equal(s.problems[0]?.code, 'MAX10_MISSING');
    });

    it('Quartus installed but the exact part missing: TARGET_PART_MISSING naming the part', async (t) => {
        const { s } = await status(t, 'part-missing');
        assert.equal(s.state, 'unhealthy');
        assert.equal(s.problems[0]?.code, 'TARGET_PART_MISSING');
        assert.match(s.problems[0]!.message, /10M50DAF484C7G/);
    });

    it('Quartus command failure: PART_CHECK_FAILED, never reported as ready', async (t) => {
        const { s } = await status(t, 'command-fails');
        assert.equal(s.state, 'unhealthy');
        assert.equal(s.problems[0]?.code, 'PART_CHECK_FAILED');
    });

    it('empty or unexpected part-list response: PART_CHECK_UNEXPECTED, never reported as ready', async (t) => {
        for (const parts of ['empty-output', 'garbage'] as const) {
            const { s } = await status(t, parts);
            assert.equal(s.state, 'unhealthy', parts);
            assert.equal(s.problems[0]?.code, 'PART_CHECK_UNEXPECTED', parts);
        }
    });

    it('a build refuses to start on any of these, running no Quartus stage', async (t) => {
        for (const parts of ['no-max10', 'part-missing', 'command-fails', 'empty-output'] as const) {
            const { provider, req, runner } = await setup(t, { parts });
            const r = await provider.build(req());
            assert.equal(r.implementationStatus, 'failed', parts);
            assert.equal(r.failedStage, 'prepare', parts);
            assert.deepEqual(runner.chain, [], parts);
        }
    });
});
