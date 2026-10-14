import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { QsfSdcConstraintProvider } from '../../../core/backend/qsf-sdc';
import type { BoardProfile, BuildProgressEvent, BuildRequest, BuildStage, ConstraintProvider, ImplementationProvider, NormalizedBuildResult, ProgrammingArtifactInfo, ProgrammingArtifactRef, RawReport } from '../../../core/backend/types';
import { combineClocks, parseFmax, parseQuartusMessages, parseSdcClocks, parseStaSummary, parseStageSummary, stageSucceeded, timingStatus } from '../../../core/implementation/quartus/parsers';
import { errorDiag, hasErrors, type Diagnostic, type LogRef } from '../../../core/results/diagnostic';
import type { De10Paths } from './config';
import type { LimaEngine } from './engine';

const E = (code: string, msg: string): Diagnostic => errorDiag('implementation', code, msg);

async function sha256File(path: string): Promise<string> {
    return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

/** Hashes of every student file the backend reads, to prove none was modified. */
async function fingerprint(files: readonly string[]): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    for (const f of files) m.set(f, (await exists(f)) ? await sha256File(f) : 'missing');
    return m;
}

export function jobId(projectDir: string): string {
    const safe = basename(projectDir).replace(/[^A-Za-z0-9._-]/g, '_') || 'project';
    return `${safe}-${createHash('sha1').update(projectDir).digest('hex').slice(0, 8)}`;
}

/** The only entity in the sources, else `top`. */
export function inferTop(vhdl: readonly string[]): string {
    const names = new Set<string>();
    for (const t of vhdl) for (const m of t.matchAll(/^\s*entity\s+(\w+)\s+is\b/gim)) names.add(m[1]!);
    return names.size === 1 ? [...names][0]! : 'top';
}

/** Written next to the artifact by a successful build. */
export const BUILD_INFO = 'build-info.json';

export interface QuartusStep {
    readonly stage: BuildStage;
    readonly name: string;
    readonly command: (top: string) => string;
}

/** The proven command chain (Phase 1), ordered as the Build row shows it: synthesis, implementation (fit, timing), programming file. `quartus_cpf -n p` writes the SVF the native programmer plays into SRAM. */
export const QUARTUS_STEPS: readonly QuartusStep[] = [
    { stage: 'synthesis', name: '1-map', command: (t) => `quartus_map ${t} --read_settings_files=on` },
    { stage: 'fit', name: '2-fit', command: (t) => `quartus_fit ${t}` },
    { stage: 'timing', name: '3-sta', command: (t) => `quartus_sta ${t}` },
    { stage: 'assemble', name: '4-asm', command: (t) => `quartus_asm ${t}` },
    { stage: 'package', name: '5-svf', command: (t) => `cd output_files && mixfpga-q quartus_cpf -c -q 10MHz -g 3.3 -n p ${t}.sof ${t}.svf` },
];

export class QuartusLimaImplementationProvider implements ImplementationProvider {
    readonly id = 'quartus-lima';
    private active: AbortController | undefined;

    constructor(
        private readonly paths: De10Paths,
        private readonly engine: LimaEngine,
        private readonly constraints: ConstraintProvider = new QsfSdcConstraintProvider(),
    ) {}

    supports(board: BoardProfile): boolean {
        return board.implementationProviderId === this.id;
    }

    /** The artifact of the last good build, with the board and input hashes recorded when it was built. */
    async artifactFor(projectDir: string, top: string): Promise<ProgrammingArtifactInfo | undefined> {
        const dir = join(projectDir, '.mix-fpga', 'build', 'de10-lite');
        const path = join(dir, `${top}.svf`);
        try {
            const st = await stat(path);
            const info = JSON.parse(await readFile(join(dir, BUILD_INFO), 'utf8')) as { board?: string; artifact?: { sha256?: string }; inputs?: Record<string, string> };
            if (!info.artifact?.sha256 || !st.isFile()) return undefined;
            return { path, format: 'svf', sizeBytes: st.size, sha256: info.artifact.sha256, modifiedMs: st.mtimeMs, ...(info.board ? { boardId: info.board } : {}), ...(info.inputs ? { inputs: info.inputs } : {}) };
        } catch {
            return undefined;
        }
    }

    /** Hashes of the files a build would read now (same keys as `build-info.json`). */
    async currentInputs(projectDir: string, sources: readonly string[], exclude?: readonly string[]): Promise<Readonly<Record<string, string>>> {
        const set = await this.constraints.collect(projectDir, exclude);
        const out: Record<string, string> = {};
        const files = [...sources.map((rel) => join(projectDir, ...rel.split('/'))), ...set.files.map((f) => f.path)];
        for (const abs of files) out[relative(projectDir, abs).split(sep).join('/')] = (await exists(abs)) ? await sha256File(abs) : 'missing';
        return out;
    }

    /** Aborts the running build (host side) and stops Quartus inside the VM. Safe to call when idle. */
    async cancel(): Promise<void> {
        this.active?.abort();
        await this.engine.killQuartus().catch(() => undefined);
    }

    async build(req: BuildRequest): Promise<NormalizedBuildResult> {
        const started = performance.now();
        const durations: Partial<Record<BuildStage, number>> = {};
        const diagnostics: Diagnostic[] = [];
        const logs: LogRef[] = [];
        const rawReports: RawReport[] = [];
        const board = req.board;
        const ctl = new AbortController();
        this.active = ctl;
        const onAbort = () => ctl.abort();
        req.signal?.addEventListener('abort', onAbort, { once: true });
        if (req.signal?.aborted) ctl.abort();
        const signal = ctl.signal;

        const emit = (e: BuildProgressEvent) => {
            try {
                req.onProgress?.(e);
            } catch {
                /* observers must not break a build */
            }
        };
        const finish = (status: NormalizedBuildResult['implementationStatus'], failedStage: BuildStage | undefined, extra: Partial<NormalizedBuildResult> = {}): NormalizedBuildResult => {
            req.signal?.removeEventListener('abort', onAbort);
            if (this.active === ctl) this.active = undefined;
            return {
                boardId: board.id,
                device: board.fpga.device,
                implementationStatus: status,
                ...(failedStage ? { failedStage } : {}),
                timingStatus: 'not-run',
                clocks: [],
                labels: board.metricLabels,
                resources: {},
                warnings: diagnostics.filter((d) => d.severity === 'warning'),
                diagnostics,
                rawReports,
                logs,
                stageDurationsMs: durations,
                durationMs: Math.round(performance.now() - started),
                ...extra,
            };
        };
        const stage = async <T>(s: BuildStage, fn: () => Promise<T>): Promise<T> => {
            emit({ kind: 'stage-started', stage: s });
            const t0 = performance.now();
            try {
                return await fn();
            } finally {
                durations[s] = Math.round(performance.now() - t0);
            }
        };
        const done = (s: BuildStage, ok: boolean) => emit({ kind: 'stage-finished', stage: s, ok });

        // ---- prepare: project, constraints, engine ------------------------------------------------
        const prep = await stage('prepare', async () => {
            // The project's own source list (compile order) when the caller has one; else the `src/` folder convention.
            const srcDir = join(req.projectDir, 'src');
            const vhdl =
                req.sources !== undefined
                    ? [...req.sources]
                    : (await readdir(srcDir).catch(() => [] as string[])).filter((n) => n.toLowerCase().endsWith('.vhd') || n.toLowerCase().endsWith('.vhdl')).sort().map((n) => `src/${n}`);
            if (vhdl.length === 0) diagnostics.push(E('PROJECT_NO_VHDL', `No .vhd files in ${srcDir}.`));
            const outside = vhdl.find((rel) => rel.startsWith('/') || rel.split('/').includes('..') || rel.includes('\\'));
            if (outside) diagnostics.push(E('PROJECT_SOURCE_OUTSIDE', `Source ${outside} is not inside the project.`));
            const set = await this.constraints.collect(req.projectDir, req.project?.config.exclude);
            diagnostics.push(...(await this.constraints.validate(set, board)));
            if (hasErrors(diagnostics)) return undefined;
            const texts = await Promise.all(vhdl.map((rel) => readFile(join(req.projectDir, ...rel.split('/')), 'utf8').catch(() => '')));
            const top = req.top ?? inferTop(texts);
            const studentFiles = [...vhdl.map((rel) => join(req.projectDir, ...rel.split('/'))), ...set.files.map((f) => f.path)];
            const before = await fingerprint(studentFiles);
            const eng = await this.engine.ensureReady(signal);
            diagnostics.push(...eng.problems);
            if (signal.aborted) return 'cancelled' as const;
            if (eng.state !== 'running' || hasErrors(eng.problems)) return undefined;
            return { vhdl, set, top, studentFiles, before };
        });
        if (prep === 'cancelled') return (done('prepare', false), finish('cancelled', 'prepare'));
        if (!prep) return (done('prepare', false), finish('failed', 'prepare'));
        done('prepare', true);
        const { vhdl, set, top, studentFiles, before } = prep;

        // ---- stage: private job directory, generated Quartus project --------------------------------
        // A fresh directory name per build: re-using one name made the VM see stale or partial files
        // (observed as an intermittent "device family Cyclone V" error from a half-read QSF).
        const id = jobId(req.projectDir);
        const unique = `${id}-${randomBytes(3).toString('hex')}`;
        const job = join(this.paths.shareDir, 'jobs', unique);
        const gJob = `${this.paths.guestShareDir}/jobs/${unique}`;
        const work = `"$HOME/.mixfpga-work/${id}"`;
        const out = join(req.projectDir, '.mix-fpga', 'build', 'de10-lite');
        await stage('stage', async () => {
            const jobsDir = join(this.paths.shareDir, 'jobs');
            for (const old of (await readdir(jobsDir).catch(() => [] as string[])).filter((n) => n.startsWith(`${id}-`))) await rm(join(jobsDir, old), { recursive: true, force: true });
            await mkdir(join(job, 'src'), { recursive: true });
            await mkdir(join(job, 'constraints'), { recursive: true });
            for (const rel of vhdl) {
                await mkdir(dirname(join(job, ...rel.split('/'))), { recursive: true });
                await cp(join(req.projectDir, ...rel.split('/')), join(job, ...rel.split('/')));
            }
            for (const f of set.files) await cp(f.path, join(job, 'constraints', basename(f.path)));
            const qsf = [
                '# generated by MIX-FPGA — do not edit',
                `set_global_assignment -name TOP_LEVEL_ENTITY ${top}`,
                'set_global_assignment -name PROJECT_OUTPUT_DIRECTORY output_files',
                ...vhdl.map((rel) => `set_global_assignment -name VHDL_FILE ${rel}`),
                ...set.files.filter((f) => f.kind === 'sdc').map((f) => `set_global_assignment -name SDC_FILE constraints/${basename(f.path)}`),
                ...(await Promise.all(set.files.filter((f) => f.kind === 'qsf').map((f) => readFile(f.path, 'utf8')))),
            ].join('\n');
            await writeFile(join(job, `${top}.qsf`), qsf + '\n');
            await writeFile(join(job, `${top}.qpf`), `PROJECT_REVISION = "${top}"\n`);
            await rm(out, { recursive: true, force: true });
            await mkdir(join(out, 'logs'), { recursive: true });
            const staged = [...vhdl, ...set.files.map((f) => `constraints/${basename(f.path)}`), `${top}.qsf`, `${top}.qpf`];
            const manifest = (await Promise.all(staged.map(async (rel) => `${await sha256File(join(job, rel))}  ${rel}`))).join('\n');
            await writeFile(join(job, 'MANIFEST.sha256'), manifest + '\n');
            // Copy into the VM's own disk and prove, inside the VM, that every byte arrived.
            const copy = `for i in 1 2 3 4 5; do rm -rf ${work}; mkdir -p ${work}; cp -a '${gJob}/.' ${work}/; if (cd ${work} && sha256sum -c --quiet MANIFEST.sha256 >/dev/null 2>&1); then echo STAGE_OK_$i; exit 0; fi; sleep 1; done; echo STAGE_VERIFY_FAILED; exit 1`;
            const cpIn = await this.engine.guest(copy, { signal, timeoutMs: 90_000 });
            if (cpIn.outcome === 'cancelled') return;
            const tries = /STAGE_OK_(\d)/.exec(cpIn.stdout)?.[1];
            if (cpIn.exitCode !== 0 || !tries) diagnostics.push(E('STAGE_COPY_FAILED', `The project could not be copied intact into the engine: ${(cpIn.stdout + cpIn.stderr).trim().slice(-160)}`));
            else if (tries !== '1') diagnostics.push({ severity: 'warning', source: 'implementation', code: 'STAGE_COPY_RETRIED', message: `Staging needed ${tries} attempts before the engine saw the files intact.` });
        });
        if (signal.aborted) return (done('stage', false), finish('cancelled', 'stage'));
        if (hasErrors(diagnostics)) return (done('stage', false), finish('failed', 'stage'));
        done('stage', true);

        // ---- Quartus chain ---------------------------------------------------------------------------
        const logText = new Map<string, string>();
        for (const step of QUARTUS_STEPS) {
            const cmd = step.command(top);
            const script = cmd.startsWith('cd ') ? `cd ${work}/${cmd.slice(3)}` : `cd ${work} && mixfpga-q ${cmd}`;
            const ok = await stage(step.stage, async () => {
                const r = await this.engine.guest(script, { signal, ...(req.onOutput ? { onOutput: req.onOutput } : {}) });
                const text = `${r.stdout}${r.stderr}`;
                const logPath = join(out, 'logs', `${step.name}.log`);
                await writeFile(logPath, text);
                logs.push({ label: step.name, path: logPath });
                logText.set(step.name, text);
                const msgs = parseQuartusMessages(text);
                for (const d of [...msgs.warnings, ...msgs.errors]) if (!diagnostics.some((x) => x.code === d.code && x.message === d.message)) diagnostics.push(d);
                // A cancel request wins even if the tool finished in the same instant.
                if (r.outcome === 'cancelled' || signal.aborted) return 'cancelled' as const;
                if (r.outcome !== 'exited') {
                    diagnostics.push(E('QUARTUS_NOT_RUN', `${cmd.split(' ')[0]} ${r.outcome === 'timed-out' ? 'timed out' : 'could not run'}${r.errorMessage ? `: ${r.errorMessage}` : ''}.`));
                    return false;
                }
                if (r.exitCode !== 0) {
                    diagnostics.push(E('QUARTUS_FAILED', `${step.stage} failed (exit ${r.exitCode}).`));
                    return false;
                }
                // Exit code alone is not accepted: Quartus must say it was successful.
                if (!stageSucceeded(text)) {
                    diagnostics.push(E('QUARTUS_NO_SUCCESS_LINE', `${step.stage} exited 0 but Quartus did not report success.`));
                    return false;
                }
                return true;
            });
            if (ok === 'cancelled') {
                await this.engine.killQuartus().catch(() => undefined);
                return (done(step.stage, false), finish('cancelled', step.stage));
            }
            done(step.stage, ok);
            if (!ok) return finish('failed', step.stage);
        }

        // ---- collect: bring results home and prove they exist ---------------------------------------
        const collected = await stage('collect', async () => {
            const back = await this.engine.guest(`rm -rf '${gJob}/output_files' && cp -a ${work}/output_files '${gJob}/output_files'`, { timeoutMs: 60_000 });
            if (back.exitCode !== 0) {
                diagnostics.push(E('COLLECT_FAILED', `Copying results out of the engine failed: ${back.stderr.trim().slice(0, 160)}`));
                return false;
            }
            await cp(join(job, 'output_files'), join(out, 'reports'), { recursive: true });
            for (const ext of ['sof', 'svf']) {
                const p = join(out, 'reports', `${top}.${ext}`);
                if (!(await exists(p)) || (await stat(p)).size === 0) {
                    diagnostics.push(E('ARTIFACT_MISSING', `Expected ${top}.${ext} was not produced.`));
                    return false;
                }
                await cp(p, join(out, `${top}.${ext}`));
            }
            return true;
        });
        done('collect', collected);
        if (signal.aborted) return finish('cancelled', 'collect');
        if (!collected) return finish('failed', 'collect');

        // ---- parse and verify -----------------------------------------------------------------------
        const rep = (n: string) => join(out, 'reports', `${top}.${n}`);
        const read = async (n: string) => ((await exists(rep(n))) ? readFile(rep(n), 'utf8') : '');
        for (const n of ['map.rpt', 'fit.rpt', 'sta.rpt', 'asm.rpt', 'flow.rpt']) if (await exists(rep(n))) rawReports.push({ label: n, path: rep(n) });
        const fit = parseStageSummary(await read('fit.summary'), board);
        const sta = parseStaSummary(await read('sta.summary'));
        const targets = new Map<string, number>();
        for (const f of set.files.filter((x) => x.kind === 'sdc')) for (const [k, v] of parseSdcClocks(await readFile(f.path, 'utf8'))) targets.set(k, v);
        if (fit.device && fit.device.toUpperCase() !== board.fpga.device.toUpperCase()) diagnostics.push(E('DEVICE_MISMATCH', `Fitter targeted ${fit.device}, expected ${board.fpga.device}.`));
        if (fit.topEntity && fit.topEntity !== top) diagnostics.push(E('TOP_MISMATCH', `Quartus built ${fit.topEntity}, expected ${top}.`));

        const after = await fingerprint(studentFiles);
        for (const [f, h] of before) if (after.get(f) !== h) diagnostics.push(E('SOURCE_MODIFIED', `Student file changed during the build: ${f}`));

        const svfPath = join(out, `${top}.svf`);
        const artifact: ProgrammingArtifactRef = { path: svfPath, format: 'svf', sizeBytes: (await stat(svfPath)).size, sha256: await sha256File(svfPath) };
        const ok = !hasErrors(diagnostics);
        if (ok) {
            // What this artifact was built from and for: Program refuses an artifact of another board or of changed sources.
            const inputs: Record<string, string> = {};
            for (const [abs, hash] of before) inputs[relative(req.projectDir, abs).split(sep).join('/')] = hash;
            await writeFile(join(out, BUILD_INFO), JSON.stringify({ schema: 1, board: board.id, device: board.fpga.device, top, builtAt: new Date().toISOString(), artifact: { sha256: artifact.sha256, sizeBytes: artifact.sizeBytes }, inputs }, null, 2) + '\n');
        }
        return finish(ok ? 'passed' : 'failed', ok ? undefined : 'collect', {
            timingStatus: timingStatus(sta, targets),
            clocks: combineClocks(sta, parseFmax(await read('sta.rpt')), targets),
            resources: fit.resources,
            ...(ok ? { programmingArtifact: artifact } : {}),
        });
    }
}
