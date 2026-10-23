import { InstallStateStore } from '../../../core/install/state-store';
import { SetupEngine, type PlanStep, type RunResult } from '../../../core/install/engine';
import type { ComponentDefinition, ComponentStatus } from '../../../core/install/model';
import type { ToolRunner } from '../../../core/process/tool-runner';
import { LimaEngine } from '../de10/engine';
import { MACOS_CATALOG } from './catalog';
import type { Downloader } from './download';
import { EngineProvisioner } from './engine-provision';
import { EXPECTED_STORAGE } from './engine-config';
import { installedDe10Paths } from './paths';
import { LIMA_INSTANCE, type RuntimeLayout } from './layout';
import type { LoadedExpected } from './expected';
import type { PayloadSource } from './payload';
import { type LicenseOffer, QUARTUS_SPEC, QuartusInstaller, type QuartusFiles, type QuartusSpec, verifyQuartus, acceptanceFor } from './quartus-install';
import { type RosettaCommandRunner, type RosettaConsent, type RosettaHost, rosettaDefinition } from './rosetta';
import { buildSetupView, type HardwareView, MODIFIED_HINT, type SetupView, studentFailure } from './setup-view';
import { ArchivePayload } from './archive-payload';
import { type PayloadPin, PickedArchivePayload, supportFileMessage } from './de10-support-file';
import { BOARD_SUPPORT, BoardSelectionStore, type BoardSupportId, boardEntry, boardState } from './boards';
import { adoptNexys, type NexysArchive, nexysDefinition, planNexysAdoption, type NexysAdoptionPlan } from './nexys-support';
import type { ToolchainRequirement } from '../../../core/toolchain/store';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { toolchainDefinitions } from './toolchain-components';
import type { HostFacts, InstallHooks } from './toolchain-installer';

/** Every question the student can be asked during setup. The VS Code side answers them with dialogs; tests answer them directly. */
export interface SetupInteraction {
    /** First run: which boards will the student use? Undefined: they declined. */
    chooseBoards(boards: readonly { readonly id: BoardSupportId; readonly name: string; readonly installed: boolean }[]): Promise<BoardSupportId[] | undefined>;
    /** Nexys A7 support on a computer with nothing to adopt and no packaged source: the student's support file, or undefined. */
    askNexysArchive(): Promise<string | undefined>;
    /** DE10-Lite support on a computer with no pinned source: the support file the course provides, or undefined if the student cancels. */
    askDe10Archive(): Promise<string | undefined>;
    /** Before anything starts: what will happen and what it needs. Return false to stop. */
    confirmInstall(summary: InstallSummary): Promise<boolean>;
    askRosettaConsent(): Promise<RosettaConsent | undefined>;
    /** The two files the student downloaded from Altera, or undefined if they decline. */
    askQuartusFiles(): Promise<QuartusFiles | undefined>;
    /** Shows the vendor's licence; true only if the student ticked the box and chose to continue. */
    showLicense(offer: LicenseOffer): Promise<boolean>;
    progress(message: string): void;
    /** Engineering detail for the Console. */
    log(line: string): void;
}

export interface InstallSummary {
    /** Student words for what will be installed, e.g. `VHDL tools`. */
    readonly items: readonly string[];
    readonly needsInternet: boolean;
    readonly storageGB: number;
    readonly requiredFreeGB: number;
    readonly askedForAltera: boolean;
    /** Repair will replace files the student changed with the supported release copy. */
    readonly replacesChanges?: boolean;
    /** Windows: the installation will ask Windows for permission once. */
    readonly needsAdministrator?: boolean;
}

export type SetupOutcome = 'complete' | 'stopped' | 'failed' | 'cancelled' | 'busy';

export interface SetupResult {
    readonly outcome: SetupOutcome;
    /** One student-facing sentence. */
    readonly message: string;
    readonly view: SetupView;
}

export interface VerifyStep {
    readonly label: string;
    readonly ok: boolean;
    readonly detail?: string;
}

export interface VerifyResult {
    readonly ok: boolean;
    readonly steps: readonly VerifyStep[];
    /** Some installed files differ from the supported release (the student changed them). Usable, but not the verified configuration. */
    readonly modified?: boolean;
    readonly view: SetupView;
}

export interface SetupDeps {
    readonly layout: RuntimeLayout;
    readonly expected: LoadedExpected;
    /** Folder source of the DE10-Lite tools (installer development). Used when no payload archive is available. */
    readonly payload: PayloadSource | undefined;
    /** Folder holding the support archives (see toolchains/mixfpga/payloads-1.0.json); each is checked against its pinned sha256. */
    readonly payloadDir?: string;
    readonly payloadPins?: Readonly<Record<string, PayloadPin>>;
    /** Nexys A7 support: the validated toolchain requirement, its MIX-FPGA store, and NexysVHDL stores it may adopt. */
    readonly nexys?: { readonly requirement: ToolchainRequirement; readonly dataRoot: string; readonly legacyRoots: readonly string[] };
    readonly runner: ToolRunner;
    readonly downloader: Downloader;
    readonly freeBytes: (path: string) => Promise<number>;
    readonly rosettaHost: RosettaHost;
    readonly runRosettaCommand: RosettaCommandRunner;
    readonly hardware: () => Promise<HardwareView>;
    readonly host?: HostFacts;
    readonly quartusSpec?: QuartusSpec;
    readonly toolchainHooks?: InstallHooks;
}

const NO_PAYLOAD: PayloadSource = { kind: 'directory', describe: () => 'none', has: async () => false, materialize: async () => undefined };

const STUDENT_ITEM: Record<string, string> = { 'nexys-toolchain': 'the Nexys A7 tools', toolchain: 'VHDL tools and the programmer', rosetta: 'Rosetta (from Apple)', 'linux-vm': 'the FPGA engine', quartus: 'Quartus Prime Lite and MAX 10 support (from Altera)' };

/**
 * The one place the Setup page talks to. It owns the component states, drives the install/repair/verify flows,
 * asks the student only what it must (Apple consent, Altera files, Altera licence), and never starts the engine
 * just to show the page.
 */
export class SetupController {
    private readonly spec: QuartusSpec;
    private readonly store: InstallStateStore;
    private readonly provisioner: EngineProvisioner;
    private readonly quartus: QuartusInstaller;
    private readonly selection: BoardSelectionStore;
    /** Set for the duration of a run: where the Nexys archive comes from when the student must choose it. */
    private askNexys: (() => Promise<string | undefined>) | undefined;
    private de10Archive: ArchivePayload | PickedArchivePayload | undefined;
    /** Set when the DE10-Lite support file is chosen by the student (not pinned beside the extension) and has not been accepted. */
    private de10Picked: PickedArchivePayload | undefined;

    constructor(private readonly deps: SetupDeps) {
        this.selection = new BoardSelectionStore(join(deps.layout.stateDir, 'board-support.json'));
        this.spec = deps.quartusSpec ?? QUARTUS_SPEC;
        this.store = new InstallStateStore(deps.layout.installStateFile, deps.layout.lockFile);
        this.provisioner = new EngineProvisioner({ layout: deps.layout, runner: deps.runner, downloader: deps.downloader, freeBytes: deps.freeBytes });
        this.quartus = new QuartusInstaller({ layout: deps.layout, runner: deps.runner, freeBytes: deps.freeBytes, spec: this.spec });
    }

    private async pinnedArchive(id: string): Promise<{ path: string; sha256: string } | undefined> {
        const pin = this.deps.payloadPins?.[id];
        if (!pin || !this.deps.payloadDir) return undefined;
        const path = join(this.deps.payloadDir, pin.file);
        return (await stat(path).then((x) => x.isFile(), () => false)) ? { path, sha256: pin.sha256 } : undefined;
    }

    private nexysDeps() {
        const n = this.deps.nexys!;
        return {
            requirement: n.requirement,
            dataRoot: n.dataRoot,
            legacyRoots: n.legacyRoots,
            runner: this.deps.runner,
            freeBytes: this.deps.freeBytes,
            archive: async (): Promise<NexysArchive | undefined> => {
                const pinned = await this.pinnedArchive('nexys-a7-100t');
                if (pinned) return pinned;
                const chosen = await this.askNexys?.();
                return chosen ? { path: chosen } : undefined;
            },
        };
    }

    private payload(): PayloadSource {
        return this.de10Archive ?? this.deps.payload ?? NO_PAYLOAD;
    }

    private definitions(depth: 'quick' | 'full'): ComponentDefinition[] {
        const ctx = { layout: this.deps.layout, expected: this.deps.expected, payload: this.payload(), freeBytes: this.deps.freeBytes, ...(this.deps.host ? { host: this.deps.host } : {}), ...(this.deps.toolchainHooks ? { hooks: this.deps.toolchainHooks } : {}) };
        return [
            ...(this.deps.nexys ? [nexysDefinition(this.nexysDeps(), depth)] : []),
            ...toolchainDefinitions(ctx, depth),
            rosettaDefinition({ host: this.deps.rosettaHost, runCommand: this.deps.runRosettaCommand }),
            this.provisioner.definition(),
            ...this.quartus.definitions(),
            {
                id: 'programmer',
                label: 'Programmer',
                inspectAfter: ['openfpgaloader'],
                inspect: async (deps) => {
                    const o = deps.get('openfpgaloader')!;
                    return { state: o.state === 'installing' ? 'repairable' : (o.state as 'ready'), ownership: 'managed', ...(o.version ? { version: o.version } : {}), ...(o.code ? { code: o.code } : {}), ...(o.detail ? { detail: o.detail } : {}) };
                },
            },
        ];
    }

    private engine(depth: 'quick' | 'full' = 'quick'): SetupEngine {
        return new SetupEngine(this.definitions(depth), this.store);
    }

    /** What the Setup page shows. Reads files and Lima's list only: never starts the engine. */
    async status(): Promise<{ statuses: ComponentStatus[]; view: SetupView }> {
        const statuses = await this.engine().inspectAll();
        return { statuses, view: buildSetupView(statuses, await this.deps.hardware(), await this.selection.read()) };
    }

    /** Is this board's support completely installed? (New Project asks before creating a project for it.) */
    async isBoardReady(board: string): Promise<boolean> {
        const entry = boardEntry(board);
        if (!entry) return true; // a board without managed support (none today) needs nothing here
        if (entry.id === 'nexys-a7-100t' && !this.deps.nexys) return true; // this computer's Nexys flow is not managed by this Setup
        // A board whose files the student changed is still usable: only a missing or damaged one asks for installation.
        const state = boardState(await this.engine().inspectAll(), entry);
        return state === 'installed' || state === 'modified';
    }

    /** Is this board's support complete and usable, but no longer the verified MIX-FPGA configuration? */
    async isBoardModified(board: string): Promise<boolean> {
        const entry = boardEntry(board);
        if (!entry) return false;
        if (entry.id === 'nexys-a7-100t' && !this.deps.nexys) return false;
        return boardState(await this.engine().inspectAll(), entry) === 'modified';
    }

    /**
     * Upgrade from NexysVHDL: the Nexys A7 tools already on this computer, verified file by file and taken over into the
     * MIX-FPGA store as an APFS clone. `dryRun` only reports.
     */
    async adoptNexysVhdl(opts: { dryRun: boolean; progress?: (m: string) => void; signal?: AbortSignal }): Promise<{ plan: NexysAdoptionPlan; result?: { ok: boolean; message: string } }> {
        if (!this.deps.nexys) throw new Error('Nexys A7 support is not managed on this computer.');
        const d = this.nexysDeps();
        const plan = await planNexysAdoption(d, { verify: true });
        if (opts.dryRun || plan.status !== 'adoptable') return { plan };
        const release = await this.store.acquireLock('adopt-nexys');
        if (!release) return { plan, result: { ok: false, message: 'Setup is already running.' } };
        try {
            const r = await adoptNexys(d, opts.progress, opts.signal);
            if (r.ok) await this.selection.add(['nexys-a7-100t']);
            return { plan, result: r.ok ? { ok: true, message: r.detail ?? 'adopted' } : { ok: false, message: r.message } };
        } finally {
            await release();
        }
    }

    private async view(): Promise<SetupView> {
        return (await this.status()).view;
    }

    private summary(statuses: readonly ComponentStatus[], plan: readonly PlanStep[]): InstallSummary {
        const need = new Set(plan.map((p) => p.id));
        const ready = (id: string) => statuses.find((s) => s.id === id)?.state === 'ready';
        return {
            items: plan.map((p) => STUDENT_ITEM[p.id]).filter((x): x is string => !!x),
            needsInternet: need.has('linux-vm'),
            storageGB: need.has('linux-vm') || need.has('quartus') ? EXPECTED_STORAGE.vmAfterQuartusGB + EXPECTED_STORAGE.imageDownloadGB : 0.3,
            requiredFreeGB: need.has('linux-vm') || need.has('quartus') ? EXPECTED_STORAGE.requiredFreeGB : 1,
            askedForAltera: need.has('quartus') && !ready('quartus'),
            replacesChanges: plan.some((p) => statuses.find((s) => s.id === p.id)?.state === 'modified'),
        };
    }

    /**
     * Install support for `boards` (default: the boards already chosen or present; on a fresh computer the student is asked).
     * Only what those boards need is installed; whatever was already done is resumed, never redone.
     */
    async install(ui: SetupInteraction, signal?: AbortSignal, boards?: readonly BoardSupportId[]): Promise<SetupResult> {
        const chosen = await this.resolveBoards(ui, boards);
        if (!chosen) return { outcome: 'stopped', message: 'No board was chosen. Nothing was changed.', view: await this.view() };
        return this.drive(ui, signal, false, chosen);
    }

    /** Repair: only what is already there but interrupted, damaged or changed (for `boards`, default every board present). */
    async repair(ui: SetupInteraction, signal?: AbortSignal, boards?: readonly BoardSupportId[]): Promise<SetupResult> {
        const present = await this.presentBoards();
        return this.drive(ui, signal, true, boards ?? present);
    }

    private async presentBoards(): Promise<BoardSupportId[]> {
        const statuses = await this.engine().inspectAll();
        const selected = await this.selection.read();
        return BOARD_SUPPORT.filter((b) => this.managed(b.id) && (selected.includes(b.id) || boardState(statuses, b) !== 'not-installed')).map((b) => b.id);
    }

    private managed(id: BoardSupportId): boolean {
        return id !== 'nexys-a7-100t' || this.deps.nexys !== undefined;
    }

    private async resolveBoards(ui: SetupInteraction, boards: readonly BoardSupportId[] | undefined): Promise<BoardSupportId[] | undefined> {
        if (boards && boards.length > 0) return boards.filter((b) => this.managed(b));
        const present = await this.presentBoards();
        if (present.length > 0) return present;
        const statuses = await this.engine().inspectAll();
        const offered = BOARD_SUPPORT.filter((b) => this.managed(b.id)).map((b) => ({ id: b.id, name: b.name, installed: boardState(statuses, b) === 'installed' }));
        const picked = await ui.chooseBoards(offered);
        return picked && picked.length > 0 ? picked : undefined;
    }

    private async drive(ui: SetupInteraction, signal: AbortSignal | undefined, repairOnly: boolean, boards: readonly BoardSupportId[]): Promise<SetupResult> {
        const steps = [...new Set(boards.flatMap((b) => boardEntry(b)?.steps ?? []))];
        if (steps.length === 0) return { outcome: 'complete', message: 'Everything is already set up.', view: await this.view() };
        this.askNexys = () => ui.askNexysArchive();
        try {
            const pinned = boards.includes('de10-lite') ? await this.pinnedArchive('de10-lite') : undefined;
            const work = join(this.deps.layout.root, '.payload');
            if (pinned) this.de10Archive = new ArchivePayload(pinned.path, pinned.sha256, work);
            else if (boards.includes('de10-lite') && !this.deps.payload && this.deps.payloadPins?.['de10-lite']) {
                // Production: the student supplies the support file (like Nexys); only asked if a tool from it is actually needed.
                this.de10Picked = new PickedArchivePayload(this.deps.payloadPins['de10-lite'], () => ui.askDe10Archive(), work);
                this.de10Archive = this.de10Picked;
            }
            return await this.driveSteps(ui, signal, repairOnly, boards, steps);
        } finally {
            this.askNexys = undefined;
            await this.de10Archive?.dispose().catch(() => undefined);
            this.de10Archive = undefined;
            this.de10Picked = undefined;
        }
    }

    private async driveSteps(ui: SetupInteraction, signal: AbortSignal | undefined, repairOnly: boolean, boards: readonly BoardSupportId[], steps: readonly string[]): Promise<SetupResult> {
        // Repair looks at every byte (a changed file is invisible to the quick check); Install only needs the quick one.
        const depth = repairOnly ? 'full' : 'quick';
        const first = await this.engine(depth).inspectAll(signal);
        const plan = this.engine(depth).plan(first, steps, { repairModified: repairOnly }).filter((p) => !repairOnly || p.mode === 'repair' || first.find((s) => s.id === p.id)?.state === 'failed');
        if (plan.length === 0) {
            if (!repairOnly) await this.selection.add(boards);
            return { outcome: 'complete', message: 'Everything is already set up.', view: await this.view() };
        }
        if (!(await ui.confirmInstall(this.summary(first, plan)))) return { outcome: 'stopped', message: 'Nothing was changed.', view: await this.view() };
        if (!repairOnly) await this.selection.add(boards);

        const inputs: Record<string, unknown> = {};
        const only = repairOnly ? plan.map((p) => p.id) : steps;
        for (let round = 0; round < 10; round++) {
            const run: RunResult = await this.engine(depth).run({ inputs, repairModified: repairOnly, ...(only ? { only } : {}), ...(signal ? { signal } : {}), onProgress: (p) => ui.progress(p.message) });
            for (const s of run.steps) ui.log(`${s.id}: ${s.outcome}${s.code ? ` ${s.code}` : ''}${s.message ? ` — ${s.message}` : ''}`);
            if (run.outcome === 'busy') return { outcome: 'busy', message: 'Setup is already running.', view: await this.view() };
            if (run.outcome === 'cancelled') return { outcome: 'cancelled', message: studentFailure('CANCELLED'), view: await this.view() };
            if (run.outcome === 'complete') return { outcome: 'complete', message: 'Setup finished.', view: await this.view() };

            const failed = run.steps.find((s) => s.outcome === 'failed');
            const problem = this.de10Picked?.problem;
            if (failed && problem && failed.code === 'PAYLOAD_INCOMPLETE') {
                ui.log(`toolchain: DE10-Lite support file ${problem}`);
                const message = supportFileMessage(problem, this.deps.payloadPins!['de10-lite']!, 'DE10-Lite');
                return { outcome: problem === 'cancelled' ? 'stopped' : 'failed', message, view: await this.view() };
            }
            if (failed) return { outcome: 'failed', message: studentFailure(failed.code ?? ''), view: await this.view() };
            const awaiting = run.steps.find((s) => s.outcome === 'awaiting-input');
            if (!awaiting) return { outcome: 'failed', message: studentFailure(''), view: await this.view() };

            const stop = async (message: string): Promise<SetupResult> => ({ outcome: 'stopped', message, view: await this.view() });
            if (awaiting.id === 'rosetta') {
                const consent = await ui.askRosettaConsent();
                if (!consent) return stop('Rosetta was not installed. The DE10-Lite\'s FPGA engine needs it. Choose Install DE10-Lite Support to continue.');
                inputs['rosetta'] = consent;
            } else if (awaiting.id === 'quartus') {
                const files = await ui.askQuartusFiles();
                if (!files) return stop('Quartus was not installed. Choose Install DE10-Lite Support when you have Altera\'s two files.');
                const prepared = await this.quartus.prepareLicense(files, signal, (m) => ui.progress(m));
                if (!prepared.ok) {
                    ui.log(`quartus: ${prepared.code} — ${prepared.message}`);
                    return { outcome: 'failed', message: studentFailure(prepared.code), view: await this.view() };
                }
                if (!(await ui.showLicense(prepared.offer))) return stop('Quartus was not installed because the licence was not accepted.');
                inputs['quartus'] = { ...files, eula: acceptanceFor(prepared.offer) };
            } else return { outcome: 'failed', message: studentFailure(''), view: await this.view() };
        }
        return { outcome: 'failed', message: studentFailure(''), view: await this.view() };
    }

    /** Verify Environment: a full check of every installed file, then a real run of the FPGA engine (it may start, and is stopped again). */
    async verify(signal?: AbortSignal): Promise<VerifyResult> {
        const steps: VerifyStep[] = [];
        // Only the boards this computer has (or the student chose): a board nobody installed is not a failure.
        const boards = await this.presentBoards();
        const wanted = new Set(boards.flatMap((b) => boardEntry(b)?.components ?? []));
        const statuses = (await this.engine('full').inspectAll(signal)).filter((s) => wanted.has(s.id));
        // A modified part is usable: it is reported (not hidden) but does not fail the check.
        for (const s of statuses) steps.push({ label: MACOS_CATALOG.find((c) => c.id === s.id)?.label ?? s.id, ok: s.state === 'ready' || s.state === 'modified', detail: s.state === 'ready' ? (s.version ?? '') : s.state === 'modified' ? `modified: ${MODIFIED_HINT}` : (s.detail ?? s.state) });
        const modified = statuses.some((s) => s.state === 'modified');
        const vm = statuses.find((s) => s.id === 'linux-vm')?.state;
        const quartus = statuses.find((s) => s.id === 'quartus');
        if (vm === 'ready' || (vm === 'repairable' && quartus?.state !== 'not-installed')) {
            const paths = installedDe10Paths(this.deps.layout);
            const engine = new LimaEngine(paths, this.deps.runner, { lima: '2.2.1', programmer: '1.1.1', ghdl: '6.0.0', yosys: '0.63', quartusBanner: this.spec.banner });
            const wasRunning = (await engine.vmState()) === 'running';
            const ready = await engine.ensureReady(signal);
            if (ready.state !== 'running') steps.push({ label: 'FPGA engine', ok: false, detail: ready.problems[0]?.message ?? ready.state });
            else {
                const v = await verifyQuartus(engine, this.deps.layout.shareDir, this.spec, signal);
                steps.push({ label: 'FPGA engine and Quartus', ok: v.ok, detail: v.ok ? (v.version ?? '') : (v.message ?? v.code ?? '') });
                if (v.ok) await this.quartus.record.merge({ verifiedAt: new Date().toISOString(), ...(v.version ? { version: v.version } : {}), device: this.spec.device });
            }
            if (!wasRunning) await this.deps.runner.run({ executable: paths.limactl, args: ['stop', LIMA_INSTANCE], env: { LIMA_HOME: paths.limaHome }, timeoutMs: 120_000 });
        }
        return { ok: steps.length > 0 && steps.every((s) => s.ok), steps, ...(modified ? { modified } : {}), view: await this.view() };
    }
}
