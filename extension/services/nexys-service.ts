import { readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
    type BuildResult,
    type Diagnostic,
    errorDiag,
    type LogRef,
    type Project,
    PROJECT_FILE_NAME,
    type ProgrammingResult,
    type RtlAnalysisResult,
    type SimulationResult,
    updateProjectFile,
    type VhdlCheckResult,
} from '../../core';
import type { ProblemCategory } from '../diagnostics/problems';
import { DesignIndex, type FileRole, type IndexedFile } from '../hierarchy/design-index';
import { buildHierarchy, type HierarchyModel } from '../hierarchy/hierarchy';
import { parseVhdl } from '../hierarchy/vhdl-parser';
import { buildProjectFilesModel, classifyProjectPath, type ProjectFilesModel, scanProjectFiles, type ScannedFiles } from '../project/project-layout';
import { computeSourceSync } from '../project/project-sync';
import { buildRtlModel, parseYosysJson, type RtlModel } from '../rtl/rtl-model';
import type { NexysBackend } from './backend';
import { type EnvironmentSummary, summarizeEnvironment } from './environment-summary';
import { Emitter, type Logger, silentLogger } from './events';
import { applyDetection, detectionStarted, type HardwareState, initialHardware, resolveProgramTarget, selectBoard } from './hardware-state';
import {
    actionCancelled,
    actionStarted,
    buildFinished,
    buildProgressed,
    checkFinished,
    initialWorkflow,
    programBlocked,
    programFinished,
    simulateFinished,
    type WorkflowAction,
    type WorkflowState,
} from './workflow-state';

export type ChangeKind = 'project' | 'workflow' | 'hardware' | 'environment' | 'results' | 'problems' | 'rtl';

/**
 * RTL schematic state. Generated lazily (only when the student opens the
 * RTL schematic) and only after a passed Check. `revision` is the design
 * revision it was generated from; a different current revision means stale.
 */
export type RtlState =
    | { readonly status: 'idle' }
    | { readonly status: 'running' }
    | { readonly status: 'ready'; readonly result: RtlAnalysisResult; readonly model: RtlModel; readonly generatedAt: Date; readonly revision: number }
    | { readonly status: 'failed' | 'unavailable'; readonly result: RtlAnalysisResult; readonly message: string };

/** Everything the views show about the open project, rebuilt on each refresh. */
export interface ProjectSnapshot {
    readonly root: string;
    /** Absolute path of nexysvhdl.json. */
    readonly file: string;
    /** Absent when nexysvhdl.json is missing or malformed (see loadDiagnostics). */
    readonly project?: Project;
    readonly loadDiagnostics: readonly Diagnostic[];
    readonly validation: readonly Diagnostic[];
    readonly scanned: ScannedFiles;
    readonly files: ProjectFilesModel;
    readonly index: DesignIndex;
    readonly hierarchy: HierarchyModel;
    /** Display name of the project's board, when supported. */
    readonly boardName?: string;
}

/** A problem the student must act on; its message is shown as is. */
export class NexysError extends Error {
    override readonly name = 'NexysError';
}

export type SimulateOutcome = { readonly kind: 'done'; readonly result: SimulationResult } | { readonly kind: 'needs-testbench'; readonly candidates: readonly string[] };

export type ProgramOutcome =
    | { readonly kind: 'done'; readonly result: ProgrammingResult }
    | { readonly kind: 'needs-board'; readonly boards: readonly { readonly serial: string; readonly label: string }[] }
    | { readonly kind: 'stale'; readonly builtAt: Date }
    | { readonly kind: 'blocked'; readonly message: string };

export interface ServiceOptions {
    readonly backend: NexysBackend;
    readonly logger?: Logger;
    /** Delay that coalesces file events before re-indexing (ms). */
    readonly debounceMs?: number;
    /** Whether saving a VHDL file runs Check automatically. */
    readonly checkOnSave?: () => boolean;
}

const posixRel = (root: string, abs: string) => relative(root, abs).split(sep).join('/');

function formatDiag(d: Diagnostic): string {
    const where = d.location ? `${d.location.file}${d.location.line ? `:${d.location.line}` : ''}${d.location.column ? `:${d.location.column}` : ''}: ` : '';
    return `  ${where}${d.severity}: ${d.message} [${d.code}]`;
}

/**
 * Owns the extension's state for one project: project model, design index
 * and hierarchy, workflow/build-stage state, board detection, latest
 * results and diagnostics. Views subscribe to onDidChange and render the
 * snapshot; they never construct backend contexts. Free of the VS Code API.
 */
export class NexysVhdlService {
    private readonly changes = new Emitter<ChangeKind>();
    readonly onDidChange = this.changes.event;

    snapshot: ProjectSnapshot | undefined;
    workflow: WorkflowState = initialWorkflow();
    hardware: HardwareState = initialHardware;
    environment: EnvironmentSummary | undefined;
    lastCheck: VhdlCheckResult | undefined;
    lastSimulation: SimulationResult | undefined;
    lastBuild: BuildResult | undefined;
    lastProgram: ProgrammingResult | undefined;
    rtl: RtlState = { status: 'idle' };
    /** Increments whenever the indexed design (files, contents, top) changes. */
    designRevision = 0;
    /** Increments with every completed simulation (waveform identity). */
    simulationRun = 0;
    /** When the latest simulation finished. */
    lastSimulationAt: Date | undefined;
    private designSignature = '';
    private rtlRunning: Promise<RtlState> | undefined;
    /** Diagnostics per producing operation (see ProblemCategory). */
    readonly problems = new Map<ProblemCategory, readonly Diagnostic[]>();

    private root?: string;
    private readonly backend: NexysBackend;
    private readonly log: Logger;
    private readonly debounceMs: number;
    private readonly checkOnSave: () => boolean;
    private readonly parseCache = new Map<string, { mtimeMs: number; size: number; file: IndexedFile }>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private waiters: Array<() => void> = [];
    private chain: Promise<void> = Promise.resolve();
    private abort: AbortController | undefined;
    private autoCheckQueued = false;
    private runningCheck: { auto: boolean; promise: Promise<VhdlCheckResult> } | undefined;

    constructor(options: ServiceOptions) {
        this.backend = options.backend;
        this.log = options.logger ?? silentLogger;
        this.debounceMs = options.debounceMs ?? 300;
        this.checkOnSave = options.checkOnSave ?? (() => false);
    }

    get project(): Project | undefined {
        return this.snapshot?.project;
    }

    get projectRoot(): string | undefined {
        return this.root;
    }

    get busy(): WorkflowAction | undefined {
        return this.workflow.running;
    }

    private emit(...kinds: ChangeKind[]): void {
        for (const k of kinds) this.changes.fire(k);
    }

    private setWorkflow(next: WorkflowState): void {
        this.workflow = next;
        this.emit('workflow');
    }

    // ------------------------------------------------------------------ project

    /** Opens the project in `root` (the folder holding nexysvhdl.json). */
    async open(root: string): Promise<void> {
        this.root = root;
        this.parseCache.clear();
        this.snapshot = undefined;
        this.workflow = initialWorkflow();
        this.hardware = initialHardware;
        this.lastCheck = this.lastSimulation = this.lastBuild = this.lastProgram = undefined;
        this.rtl = { status: 'idle' };
        this.problems.clear();
        this.log.info(`Opened project folder ${root}`);
        await this.refreshNow();
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
        this.abort?.abort();
        this.changes.dispose();
    }

    /** Debounced refresh: coalesces bursts of file events into one re-index. */
    scheduleRefresh(): Promise<void> {
        if (this.timer) clearTimeout(this.timer);
        return new Promise((resolve) => {
            this.waiters.push(resolve);
            this.timer = setTimeout(() => {
                this.timer = undefined;
                const waiting = this.waiters.splice(0);
                void this.refreshNow().finally(() => waiting.forEach((w) => w()));
            }, this.debounceMs);
        });
    }

    /** Immediate refresh (manual Refresh, before running a workflow action). Serialized. */
    refreshNow(): Promise<void> {
        const run = this.chain.then(() => this.doRefresh()).catch((err: unknown) => this.log.error(`Project refresh failed: ${(err as Error).message}`));
        this.chain = run;
        return run;
    }

    /** Resolves once no refresh is scheduled or running. */
    async whenIdle(): Promise<void> {
        for (;;) {
            if (this.timer || this.waiters.length > 0) {
                await new Promise<void>((r) => this.waiters.push(r));
                continue;
            }
            const current = this.chain;
            await current;
            if (current === this.chain && !this.timer) return;
        }
    }

    /** A file was saved in the editor. Re-indexes; may run Check (setting). */
    notifyFileSaved(absPath: string): void {
        const kind = this.classify(absPath);
        if (!kind) return;
        void this.scheduleRefresh().then(() => {
            if ((kind === 'source' || kind === 'simulation') && this.checkOnSave()) this.autoCheck();
        });
    }

    /** A project file was created, deleted, renamed or changed on disk. */
    notifyFileEvent(absPath: string): void {
        if (this.classify(absPath)) void this.scheduleRefresh();
    }

    private classify(absPath: string) {
        if (!this.root) return undefined;
        const rel = posixRel(this.root, absPath);
        if (rel.startsWith('..')) return undefined;
        return classifyProjectPath(rel);
    }

    private autoCheck(): void {
        if (!this.project) return;
        if (this.busy) {
            this.autoCheckQueued = this.busy === 'check';
            return;
        }
        void this.check({ auto: true }).catch(() => undefined);
    }

    private async parseFile(path: string, role: FileRole): Promise<IndexedFile> {
        const abs = join(this.root!, ...path.split('/'));
        try {
            const s = await stat(abs);
            const cached = this.parseCache.get(path);
            if (cached && cached.mtimeMs === s.mtimeMs && cached.size === s.size && cached.file.role === role) return cached.file;
            const file: IndexedFile = { path, role, parsed: parseVhdl(await readFile(abs, 'utf8')) };
            this.parseCache.set(path, { mtimeMs: s.mtimeMs, size: s.size, file });
            return file;
        } catch {
            this.parseCache.delete(path);
            return { path, role, parsed: { entities: [], architectures: [], packages: [], configurations: [], uses: [] } };
        }
    }

    private async exists(path: string): Promise<boolean> {
        try {
            return (await stat(join(this.root!, ...path.split('/')))).isFile();
        } catch {
            return false;
        }
    }

    private async doRefresh(): Promise<void> {
        const root = this.root;
        if (!root) return;
        const file = join(root, PROJECT_FILE_NAME);
        const scanned = await scanProjectFiles(root);
        let loaded = await this.backend.loadProject(root);
        if (!loaded.ok) {
            const loadDiagnostics = loaded.diagnostics.map((d) => (d.location ? d : { ...d, location: { file: PROJECT_FILE_NAME } }));
            const index = new DesignIndex([]);
            this.snapshot = {
                root, file, loadDiagnostics, validation: [], scanned,
                files: buildProjectFilesModel(scanned, { sources: [] }),
                index, hierarchy: buildHierarchy(index, ''),
            };
            this.problems.set('project', loadDiagnostics);
            this.emit('project', 'problems');
            return;
        }

        let project = loaded.project;
        const listed = (p: Project) => [
            ...(Array.isArray(p.config.sources) ? p.config.sources : []),
            ...(Array.isArray(p.config.simulation?.sources) ? p.config.simulation!.sources : []),
        ].filter((x): x is string => typeof x === 'string');
        const simListed = new Set(Array.isArray(project.config.simulation?.sources) ? project.config.simulation!.sources : []);
        const roleOf = (p: string): FileRole => (classifyProjectPath(p) === 'simulation' || simListed.has(p) ? 'simulation' : 'source');

        // Parse every VHDL file the project has or lists (cached by mtime/size).
        const outside = new Set<string>();
        for (const p of listed(project)) {
            if (!scanned.sources.includes(p) && !scanned.simulation.includes(p) && (await this.exists(p))) outside.add(p);
        }
        const paths = [...new Set([...scanned.sources, ...scanned.simulation, ...outside])];
        const parsed = new Map<string, IndexedFile>();
        for (const p of paths) parsed.set(p, await this.parseFile(p, roleOf(p)));

        // Folder contract -> source lists in nexysvhdl.json (dependency order).
        const patch = computeSourceSync(project.config, scanned, parsed, outside);
        if (patch) {
            try {
                await updateProjectFile(project.file, patch);
                this.log.info(`Updated the source lists in ${PROJECT_FILE_NAME} to match src/ and sim/.`);
                loaded = await this.backend.loadProject(root);
                if (loaded.ok) project = loaded.project;
            } catch (err) {
                this.log.warn(`Could not update ${PROJECT_FILE_NAME}: ${(err as Error).message}`);
            }
        }

        // Index in compile order (so "last analysed" matches GHDL), then any unlisted file.
        const order = [...new Set([...listed(project), ...paths])].filter((p) => parsed.has(p));
        const index = new DesignIndex(order.map((p) => parsed.get(p)!));
        const top = typeof project.config.top === 'string' ? project.config.top : '';
        const hierarchy = buildHierarchy(index, top);
        const topEntity = index.entity(top);
        const tbName = project.config.simulation?.testbench;
        const tbEntity = tbName ? index.entity(tbName) : undefined;
        const files = buildProjectFilesModel(
            scanned,
            project.config,
            new Set(topEntity && topEntity.role === 'source' ? [topEntity.file] : []),
            new Set(tbEntity ? [tbEntity.file] : []),
        );
        const validation = (await this.backend.validate(project)).diagnostics.map((d) => (d.location ? d : { ...d, location: { file: PROJECT_FILE_NAME } }));
        const boardName = (await this.backend.boards()).get(project.config.board)?.name;
        const signature = JSON.stringify([top, order.map((p) => [p, this.parseCache.get(p)?.mtimeMs, this.parseCache.get(p)?.size])]);
        if (signature !== this.designSignature) {
            this.designSignature = signature;
            this.designRevision++;
        }
        this.snapshot = { root, file, project, loadDiagnostics: [], validation, scanned, files, index, hierarchy, ...(boardName ? { boardName } : {}) };
        this.problems.set('project', validation);
        this.emit('project', 'problems');
    }

    /** Sets the top entity in nexysvhdl.json (through the shared project model) and refreshes. */
    async setTop(entity: string): Promise<void> {
        const snap = this.requireProject();
        const decl = snap.index.entity(entity);
        if (!decl) throw new NexysError(`No entity named "${entity}" was found in the project.`);
        if (decl.role !== 'source') throw new NexysError(`"${decl.decl.name}" is in the simulation folder; the top entity must be an RTL source in src/.`);
        await updateProjectFile(snap.file, { top: decl.decl.name });
        this.log.info(`Top entity set to ${decl.decl.name}.`);
        this.lastBuild = undefined;
        await this.refreshNow();
    }

    async setTestbench(entity: string): Promise<void> {
        const snap = this.requireProject();
        const sim = snap.project!.config.simulation;
        await updateProjectFile(snap.file, { simulation: { sources: sim?.sources ?? [], ...sim, testbench: entity } });
        this.log.info(`Testbench set to ${entity}.`);
        await this.refreshNow();
    }

    /** Uses an XDC file for constraints. `replacePins` must be true to drop an existing pin mapping. */
    async useConstraints(path: string, replacePins = false): Promise<void> {
        const snap = this.requireProject();
        if (snap.project!.config.pins && !replacePins) throw new NexysError('This project generates its constraints from "pins"; confirm replacing them with the XDC file.');
        await updateProjectFile(snap.file, { constraints: path, ...(replacePins ? { pins: undefined } : {}) });
        this.log.info(`Constraints file set to ${path}.`);
        this.lastBuild = undefined;
        await this.refreshNow();
    }

    /** Testbench candidates: simulation entities without ports. */
    testbenchCandidates(): string[] {
        return this.snapshot?.index.entitiesIn('simulation').filter((e) => e.decl.ports.length === 0).map((e) => e.decl.name) ?? [];
    }

    private requireProject(): ProjectSnapshot & { project: Project } {
        const snap = this.snapshot;
        if (!snap) throw new NexysError('No NexysVHDL project is open.');
        if (!snap.project) throw new NexysError(`The project file has a problem: ${snap.loadDiagnostics[0]?.message ?? 'unknown error'}`);
        return snap as ProjectSnapshot & { project: Project };
    }

    // ----------------------------------------------------------------- workflow

    /** Common start of an action: one at a time, freshly synced and validated project. */
    /** An automatic check (check on save) never blocks a student's action: wait for it to finish. */
    private async settleAutoCheck(): Promise<void> {
        if (this.runningCheck?.auto) await this.runningCheck.promise.catch(() => undefined);
    }

    private async begin(action: WorkflowAction): Promise<{ project: Project; signal: AbortSignal }> {
        if (action !== 'check') await this.settleAutoCheck();
        if (this.busy) throw new NexysError(`${this.busy[0]!.toUpperCase()}${this.busy.slice(1)} is still running.`);
        await this.whenIdle();
        await this.refreshNow();
        const snap = this.requireProject();
        const errors = snap.validation.filter((d) => d.severity === 'error');
        if (errors.length > 0 && action !== 'program') {
            // The core validates too and would refuse; say why up front.
            this.log.warn(`Project settings have ${errors.length} problem(s):`);
            errors.forEach((d) => this.log.warn(formatDiag(d)));
        }
        this.abort = new AbortController();
        this.setWorkflow(actionStarted(this.workflow, action));
        this.log.info(`▶ ${action[0]!.toUpperCase()}${action.slice(1)} — ${snap.project.config.name}`);
        return { project: snap.project, signal: this.abort.signal };
    }

    private end(): boolean {
        const cancelled = this.abort?.signal.aborted === true;
        this.abort = undefined;
        return cancelled;
    }

    /** Stops the running action (its tool process is killed through the core's AbortSignal). */
    cancel(): void {
        this.abort?.abort();
    }

    private logResult(status: string, diagnostics: readonly Diagnostic[], logs: readonly LogRef[], durationMs: number): void {
        this.log.info(`  ${status} (${(durationMs / 1000).toFixed(1)} s)`);
        for (const d of diagnostics) if (d.code !== 'GHDL_REPORT_NOTE') this.log.info(formatDiag(d));
        for (const l of logs) this.log.info(`  log ${l.label}: ${l.path}`);
    }

    private async run<T>(action: WorkflowAction, op: (project: Project, signal: AbortSignal) => Promise<T>): Promise<T> {
        const { project, signal } = await this.begin(action);
        try {
            return await op(project, signal);
        } catch (err) {
            this.end();
            this.setWorkflow(actionCancelled(this.workflow, action));
            this.log.error(`${action} failed unexpectedly: ${(err as Error).message}`);
            throw err;
        }
    }

    /**
     * Runs Check. A Check requested while one is running joins it instead of
     * failing; `auto` marks a check started by saving a file.
     */
    check(options: { auto?: boolean } = {}): Promise<VhdlCheckResult> {
        if (this.runningCheck) return this.runningCheck.promise;
        const promise = this.runCheck();
        const entry = { auto: options.auto === true, promise };
        this.runningCheck = entry;
        const clear = () => {
            if (this.runningCheck === entry) this.runningCheck = undefined;
        };
        promise.then(clear, clear);
        return promise;
    }

    private async runCheck(): Promise<VhdlCheckResult> {
        const result = await this.run('check', (p, s) => this.backend.check(p, s));
        if (this.end()) {
            this.setWorkflow(actionCancelled(this.workflow, 'check'));
            return result;
        }
        this.lastCheck = result;
        this.problems.set('vhdl', result.diagnostics);
        this.setWorkflow(checkFinished(this.workflow, result));
        this.logResult(`Check ${result.status}`, result.diagnostics, result.logs, result.durationMs);
        this.emit('results', 'problems');
        if (this.autoCheckQueued) {
            this.autoCheckQueued = false;
            this.autoCheck();
        }
        return result;
    }

    async simulate(testbench?: string): Promise<SimulateOutcome> {
        const snap = this.requireProject();
        const tb = testbench ?? snap.project.config.simulation?.testbench;
        if (!tb) return { kind: 'needs-testbench', candidates: this.testbenchCandidates() };
        const result = await this.run('simulate', (p, s) => this.backend.simulate(p, tb, s));
        if (this.end()) {
            this.setWorkflow(actionCancelled(this.workflow, 'simulate'));
            return { kind: 'done', result };
        }
        this.lastSimulation = result;
        this.simulationRun++;
        this.lastSimulationAt = new Date();
        this.problems.set('vhdl', result.diagnostics);
        this.setWorkflow(simulateFinished(this.workflow, result));
        this.logResult(`Simulation ${result.testbench}: ${result.status === 'succeeded' ? (result.passed ? 'PASSED' : 'FAILED') : result.status}`, result.diagnostics, result.logs, result.durationMs);
        for (const m of result.messages) this.log.info(`  ${m}`);
        this.emit('results', 'problems');
        return { kind: 'done', result };
    }

    async build(): Promise<BuildResult> {
        const result = await this.run('build', (p, s) => this.backend.build(p, (progress) => this.setWorkflow(buildProgressed(this.workflow, progress)), s));
        if (this.end()) {
            this.setWorkflow(actionCancelled(this.workflow, 'build'));
            return result;
        }
        this.lastBuild = result;
        this.problems.set('vhdl', result.diagnostics.filter((d) => d.source === 'vhdl'));
        this.problems.set('build', result.diagnostics.filter((d) => d.source !== 'vhdl' && d.source !== 'project'));
        this.setWorkflow(buildFinished(this.workflow, result));
        this.log.info(`  steps: ${result.steps.map((st) => `${st.step}=${st.status}`).join(', ')}`);
        this.logResult(`Build ${result.success ? 'SUCCEEDED' : 'FAILED'}`, result.diagnostics, result.logs, result.durationMs);
        this.emit('results', 'problems');
        return result;
    }

    /** Newest modification time among the files that determine the bitstream. */
    private async newestDesignInput(project: Project): Promise<number> {
        const files = [PROJECT_FILE_NAME, ...project.config.sources, ...(project.config.constraints ? [project.config.constraints] : [])];
        let newest = 0;
        for (const f of files) {
            try {
                newest = Math.max(newest, (await stat(join(project.root, ...f.split('/')))).mtimeMs);
            } catch {
                /* missing files are reported by validation */
            }
        }
        return newest;
    }

    /**
     * Programs the FPGA (SRAM) with the canonical bitstream through the
     * shared ProgrammingService. Asks (via the outcome) instead of guessing
     * when the bitstream is older than the sources or several boards are connected.
     */
    async program(options: { serial?: string; allowStale?: boolean } = {}): Promise<ProgramOutcome> {
        const snap = this.requireProject();
        const project = snap.project;
        await this.settleAutoCheck();
        if (this.busy) throw new NexysError(`${this.busy[0]!.toUpperCase()}${this.busy.slice(1)} is still running.`);
        if (this.lastBuild && !this.lastBuild.success) {
            const message = 'The last build failed. Fix the problems and run Build again before programming.';
            this.setWorkflow(programBlocked(this.workflow, 'Last build failed'));
            return { kind: 'blocked', message };
        }
        const bit = await this.backend.bitstream(project);
        if (!bit) {
            this.setWorkflow(programBlocked(this.workflow, 'No bitstream yet'));
            return { kind: 'blocked', message: 'There is no bitstream yet. Run Build first.' };
        }
        if (!options.allowStale && (await this.newestDesignInput(project)) > bit.modifiedMs) return { kind: 'stale', builtAt: new Date(bit.modifiedMs) };

        let serial = options.serial;
        if (serial === undefined) {
            if (this.hardware.status === 'unknown' || this.hardware.boards.length === 0) await this.detectBoards();
            const target = resolveProgramTarget(this.hardware);
            if (target.kind === 'choose') {
                return { kind: 'needs-board', boards: target.boards.map((b) => ({ serial: b.serialNumber ?? b.selector, label: b.productName ?? 'Board' })) };
            }
            if (target.kind === 'selected') serial = target.serial;
            // 'single' and 'none': the shared service selects the only board or reports none.
        }

        const result = await this.run('program', (p, s) => this.backend.program(p, serial, s));
        if (this.end()) {
            this.setWorkflow(actionCancelled(this.workflow, 'program'));
            return { kind: 'done', result };
        }
        this.lastProgram = result;
        this.setWorkflow(programFinished(this.workflow, result));
        this.logResult(`Program ${result.status}${result.target ? ` (serial ${result.target.serialNumber ?? '?'})` : ''}`, result.diagnostics, result.logs, result.durationMs);
        this.emit('results');
        return { kind: 'done', result };
    }

    // --------------------------------------------------------------------- RTL

    /** True when the RTL schematic was generated from an older design revision. */
    get rtlStale(): boolean {
        return this.rtl.status === 'ready' && this.rtl.revision !== this.designRevision;
    }

    /**
     * Generates the RTL schematic model through the shared core (GHDL synthesis
     * + generic RTL netlist; never placement/routing/bitstream). Requires a
     * passed Check. Concurrent requests share one run.
     */
    generateRtl(): Promise<RtlState> {
        if (this.rtlRunning) return this.rtlRunning;
        const run = this.runRtl().finally(() => (this.rtlRunning = undefined));
        this.rtlRunning = run;
        return run;
    }

    private async runRtl(): Promise<RtlState> {
        await this.settleAutoCheck();
        await this.whenIdle();
        const snap = this.requireProject();
        if (this.workflow.check.state !== 'passed') {
            throw new NexysError('Run Check first: the RTL schematic is generated from VHDL that checks without errors.');
        }
        const revision = this.designRevision;
        this.rtl = { status: 'running' };
        this.emit('rtl');
        this.log.info(`▶ RTL schematic — ${snap.project.config.name}`);
        let result: RtlAnalysisResult;
        try {
            result = await this.backend.rtl(snap.project);
        } catch (err) {
            this.rtl = { status: 'idle' };
            this.emit('rtl');
            throw err;
        }
        this.logResult(`RTL analysis ${result.status}`, result.diagnostics, result.logs, result.durationMs);
        if (result.status === 'succeeded' && result.netlist) {
            try {
                const model = buildRtlModel(parseYosysJson(await readFile(result.netlist.path, 'utf8')), {
                    top: snap.project.config.top,
                    projectRoot: snap.root,
                    entities: [...snap.index.entities.values()].map((e) => e[e.length - 1]!.decl.name),
                    ...(result.verilog ? { verilog: await readFile(result.verilog.path, 'utf8').catch(() => '') } : {}),
                });
                this.rtl = { status: 'ready', result, model, generatedAt: new Date(), revision };
            } catch (err) {
                this.rtl = { status: 'failed', result, message: `The RTL netlist could not be read: ${(err as Error).message}` };
            }
        } else {
            const message = result.diagnostics.find((d) => d.severity === 'error')?.message ?? 'RTL analysis failed.';
            this.rtl = { status: result.status === 'not-configured' ? 'unavailable' : 'failed', result, message };
        }
        this.emit('rtl');
        return this.rtl;
    }

    // ----------------------------------------------------------------- hardware

    async detectBoards(): Promise<HardwareState> {
        const project = this.project;
        if (!project) return this.hardware;
        this.hardware = detectionStarted(this.hardware);
        this.emit('hardware');
        try {
            this.hardware = applyDetection(this.hardware, await this.backend.detectBoards(project));
        } catch (err) {
            this.hardware = applyDetection(this.hardware, { configured: true, boards: [], diagnostics: [errorDiag('programming', 'PROGRAM_DETECT_FAILED', (err as Error).message)] });
        }
        const found = this.hardware.boards.map((b) => b.serialNumber ?? b.selector).join(', ');
        this.log.info(`Board detection: ${this.hardware.status}${found ? ` (${found})` : ''}`);
        for (const d of this.hardware.diagnostics) this.log.info(formatDiag(d));
        this.emit('hardware');
        return this.hardware;
    }

    selectBoard(serial: string): void {
        this.hardware = selectBoard(this.hardware, serial);
        this.emit('hardware');
    }

    // -------------------------------------------------------------- environment

    async refreshEnvironment(): Promise<EnvironmentSummary | undefined> {
        try {
            const report = await this.backend.environment(this.project);
            this.environment = summarizeEnvironment(report);
            this.log.info(`Environment: ${this.environment.headline} (${report.adapter.displayName})`);
            for (const p of this.environment.problems) this.log.info(`  ${p}`);
        } catch (err) {
            this.log.error(`Environment inspection failed: ${(err as Error).message}`);
        }
        this.emit('environment');
        return this.environment;
    }
}
