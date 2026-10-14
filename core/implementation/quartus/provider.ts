import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { QsfSdcConstraintProvider } from '../../backend/qsf-sdc';
import type { BoardProfile, BuildProgressEvent, BuildRequest, BuildStage, ConstraintProvider, EngineProvider, ImplementationProvider, NormalizedBuildResult, ProgrammingArtifactInfo, ProgrammingArtifactRef, ProgrammingFormat, RawReport } from '../../backend/types';
import type { ToolRunResult } from '../../process/tool-runner';
import { errorDiag, hasErrors, type Diagnostic, type LogRef } from '../../results/diagnostic';
import { combineClocks, parseFmax, parseQuartusMessages, parseSdcClocks, parseStaSummary, parseStageSummary, stageSucceeded, timingStatus } from './parsers';

/**
 * The Quartus implementation engine, shared by every host. Everything here is platform-neutral:
 * project staging, QSF/SDC generation and validation, source hashing, the command chain, report
 * parsing, normalized results, stale-artifact detection and cancellation. What differs between
 * hosts is only WHERE the tools run, which sits behind `QuartusExecutor`:
 *
 *   macOS   -> Quartus inside the hidden Lima/Rosetta VM (platform/macos/de10)
 *   Windows -> the native Quartus command-line tools   (platform/windows/de10)
 */

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
    /** Quartus executable, without extension (`quartus_map`). */
    readonly tool: string;
    readonly args: (top: string) => string[];
    /** Run inside `output_files` instead of the project root (the programming-file conversion reads the .sof there). */
    readonly inOutputDir?: boolean;
}

/** The proven command chain (Phase 1), ordered as the Build row shows it: synthesis, implementation (fit, timing), programming file. `quartus_cpf -n p` writes the SVF the native programmer plays into SRAM. */
export const QUARTUS_STEPS: readonly QuartusStep[] = [
    { stage: 'synthesis', name: '1-map', tool: 'quartus_map', args: (t) => [t, '--read_settings_files=on'] },
    { stage: 'fit', name: '2-fit', tool: 'quartus_fit', args: (t) => [t] },
    { stage: 'timing', name: '3-sta', tool: 'quartus_sta', args: (t) => [t] },
    { stage: 'assemble', name: '4-asm', tool: 'quartus_asm', args: (t) => [t] },
    { stage: 'package', name: '5-svf', tool: 'quartus_cpf', args: (t) => ['-c', '-q', '10MHz', '-g', '3.3', '-n', 'p', `${t}.sof`, `${t}.svf`], inOutputDir: true },
];

/** One build's private working tree on the host. */
export interface QuartusJob {
    /** Stable per project (name + path hash). */
    readonly id: string;
    /** Unique per build: a re-used directory name made a VM see stale or half-copied files. */
    readonly unique: string;
    /** The staged project on the host: `src/`, `constraints/`, `<top>.qsf`, `<top>.qpf`, `MANIFEST.sha256`. After `collect`, also `output_files/`. */
    readonly hostDir: string;
}

/** Where Quartus runs. The only platform-specific part of the Quartus implementation. */
export interface QuartusExecutor {
    /** The machinery behind it: a VM on macOS, the native install on Windows. */
    readonly engine: EngineProvider;
    /** The programming file this host's programmer loads (macOS openFPGALoader: `svf`; Windows quartus_pgm: `sof`). Both are always built. */
    readonly programmingFormat: 'svf' | 'sof';
    /** Host folder under which every build gets a private job folder. */
    readonly jobsRoot: string;
    /** Makes the staged tree (already written to `job.hostDir`) runnable and proves it arrived intact. Errors fail the build. */
    install(job: QuartusJob, signal: AbortSignal): Promise<readonly Diagnostic[]>;
    /** Runs one Quartus tool of the chain inside the job. */
    run(job: QuartusJob, step: QuartusStep, top: string, io: { signal: AbortSignal; onOutput?: (text: string) => void }): Promise<ToolRunResult>;
    /** Makes `job.hostDir/output_files` available on the host. Returns an error diagnostic on failure. */
    collect(job: QuartusJob): Promise<Diagnostic | undefined>;
    /** Best-effort: stop Quartus processes left running after the host-side client was killed. Safe when idle. */
    killTools(): Promise<void>;
}

export class QuartusImplementationProvider implements ImplementationProvider {
    readonly id = 'quartus';
    private active: AbortController | undefined;

    constructor(
        protected readonly executor: QuartusExecutor,
        private readonly constraints: ConstraintProvider = new QsfSdcConstraintProvider(),
    ) {}

    supports(board: BoardProfile): boolean {
        return board.implementationProviderId === this.id;
    }

    /**
     * One programming file of the last good build, with the board and input hashes recorded when it was built. The hash is the
     * MANIFEST's, not the file's: a file changed after the build no longer matches it, and Program rejects it.
     */
    async artifactFor(projectDir: string, top: string, format: ProgrammingFormat = this.executor.programmingFormat): Promise<ProgrammingArtifactInfo | undefined> {
        if (format !== 'svf' && format !== 'sof') return undefined;
        const dir = join(projectDir, '.mix-fpga', 'build', 'de10-lite');
        const path = join(dir, `${top}.${format}`);
        try {
            const st = await stat(path);
            const info = JSON.parse(await readFile(join(dir, BUILD_INFO), 'utf8')) as { board?: string; artifact?: { sha256?: string }; artifacts?: Partial<Record<string, { sha256?: string }>>; inputs?: Record<string, string> };
            // Schema 1 recorded only the .svf as `artifact`.
            const sha = info.artifacts?.[format]?.sha256 ?? (format === 'svf' ? info.artifact?.sha256 : undefined);
            if (!sha || !st.isFile()) return undefined;
            return { path, format, sizeBytes: st.size, sha256: sha, modifiedMs: st.mtimeMs, ...(info.board ? { boardId: info.board } : {}), ...(info.inputs ? { inputs: info.inputs } : {}) };
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

    /** Aborts the running build (host side) and stops Quartus. Safe to call when idle. */
    async cancel(): Promise<void> {
        this.active?.abort();
        await this.executor.killTools().catch(() => undefined);
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
            const eng = await this.executor.engine.ensureReady(signal);
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
        const id = jobId(req.projectDir);
        const unique = `${id}-${randomBytes(3).toString('hex')}`;
        const job: QuartusJob = { id, unique, hostDir: join(this.executor.jobsRoot, unique) };
        const out = join(req.projectDir, '.mix-fpga', 'build', 'de10-lite');
        await stage('stage', async () => {
            for (const old of (await readdir(this.executor.jobsRoot).catch(() => [] as string[])).filter((n) => n.startsWith(`${id}-`))) await rm(join(this.executor.jobsRoot, old), { recursive: true, force: true });
            await mkdir(join(job.hostDir, 'src'), { recursive: true });
            await mkdir(join(job.hostDir, 'constraints'), { recursive: true });
            for (const rel of vhdl) {
                await mkdir(dirname(join(job.hostDir, ...rel.split('/'))), { recursive: true });
                await cp(join(req.projectDir, ...rel.split('/')), join(job.hostDir, ...rel.split('/')));
            }
            for (const f of set.files) await cp(f.path, join(job.hostDir, 'constraints', basename(f.path)));
            const qsf = [
                '# generated by MIX-FPGA — do not edit',
                `set_global_assignment -name TOP_LEVEL_ENTITY ${top}`,
                'set_global_assignment -name PROJECT_OUTPUT_DIRECTORY output_files',
                ...vhdl.map((rel) => `set_global_assignment -name VHDL_FILE ${rel}`),
                ...set.files.filter((f) => f.kind === 'sdc').map((f) => `set_global_assignment -name SDC_FILE constraints/${basename(f.path)}`),
                ...(await Promise.all(set.files.filter((f) => f.kind === 'qsf').map((f) => readFile(f.path, 'utf8')))),
            ].join('\n');
            await writeFile(join(job.hostDir, `${top}.qsf`), qsf + '\n');
            await writeFile(join(job.hostDir, `${top}.qpf`), `PROJECT_REVISION = "${top}"\n`);
            await rm(out, { recursive: true, force: true });
            await mkdir(join(out, 'logs'), { recursive: true });
            const staged = [...vhdl, ...set.files.map((f) => `constraints/${basename(f.path)}`), `${top}.qsf`, `${top}.qpf`];
            const manifest = (await Promise.all(staged.map(async (rel) => `${await sha256File(join(job.hostDir, ...rel.split('/')))}  ${rel}`))).join('\n');
            await writeFile(join(job.hostDir, 'MANIFEST.sha256'), manifest + '\n');
            diagnostics.push(...(await this.executor.install(job, signal)));
        });
        if (signal.aborted) return (done('stage', false), finish('cancelled', 'stage'));
        if (hasErrors(diagnostics)) return (done('stage', false), finish('failed', 'stage'));
        done('stage', true);

        // ---- Quartus chain ---------------------------------------------------------------------------
        for (const step of QUARTUS_STEPS) {
            const ok = await stage(step.stage, async () => {
                const r = await this.executor.run(job, step, top, { signal, ...(req.onOutput ? { onOutput: req.onOutput } : {}) });
                const text = `${r.stdout}${r.stderr}`;
                const logPath = join(out, 'logs', `${step.name}.log`);
                await writeFile(logPath, text);
                logs.push({ label: step.name, path: logPath });
                const msgs = parseQuartusMessages(text);
                for (const d of [...msgs.warnings, ...msgs.errors]) if (!diagnostics.some((x) => x.code === d.code && x.message === d.message)) diagnostics.push(d);
                // A cancel request wins even if the tool finished in the same instant.
                if (r.outcome === 'cancelled' || signal.aborted) return 'cancelled' as const;
                if (r.outcome !== 'exited') {
                    diagnostics.push(E('QUARTUS_NOT_RUN', `${step.tool} ${r.outcome === 'timed-out' ? 'timed out' : 'could not run'}${r.errorMessage ? `: ${r.errorMessage}` : ''}.`));
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
                await this.executor.killTools().catch(() => undefined);
                return (done(step.stage, false), finish('cancelled', step.stage));
            }
            done(step.stage, ok);
            if (!ok) return finish('failed', step.stage);
        }

        // ---- collect: bring results home and prove they exist ---------------------------------------
        const collected = await stage('collect', async () => {
            const problem = await this.executor.collect(job);
            if (problem) {
                diagnostics.push(problem);
                return false;
            }
            await cp(join(job.hostDir, 'output_files'), join(out, 'reports'), { recursive: true });
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

        // Every programming file of this build, typed and hashed; the host's programmer loads one of them.
        const artifacts: ProgrammingArtifactRef[] = [];
        for (const format of ['sof', 'svf'] as const) {
            const p = join(out, `${top}.${format}`);
            artifacts.push({ path: p, format, sizeBytes: (await stat(p)).size, sha256: await sha256File(p) });
        }
        const artifact = artifacts.find((a) => a.format === this.executor.programmingFormat)!;
        const svf = artifacts.find((a) => a.format === 'svf')!;
        const ok = !hasErrors(diagnostics);
        if (ok) {
            // What this artifact was built from and for: Program refuses an artifact of another board or of changed sources.
            const inputs: Record<string, string> = {};
            for (const [abs, hash] of before) inputs[relative(req.projectDir, abs).split(sep).join('/')] = hash;
            await writeFile(join(out, BUILD_INFO), JSON.stringify({ schema: 2, board: board.id, device: board.fpga.device, top, builtAt: new Date().toISOString(), artifact: { sha256: svf.sha256, sizeBytes: svf.sizeBytes }, artifacts: Object.fromEntries(artifacts.map((a) => [a.format, { sha256: a.sha256, sizeBytes: a.sizeBytes }])), inputs }, null, 2) + '\n');
        }
        return finish(ok ? 'passed' : 'failed', ok ? undefined : 'collect', {
            timingStatus: timingStatus(sta, targets),
            clocks: combineClocks(sta, parseFmax(await read('sta.rpt')), targets),
            resources: fit.resources,
            ...(ok ? { programmingArtifact: artifact, programmingArtifacts: artifacts } : {}),
        });
    }
}
