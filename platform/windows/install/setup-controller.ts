import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { InstallStateStore } from '../../../core/install/state-store';
import { SetupEngine, type PlanStep, type RunResult } from '../../../core/install/engine';
import type { ComponentDefinition, ComponentStatus, Inspection } from '../../../core/install/model';
import type { ToolRunner } from '../../../core/process/tool-runner';
import type { ToolchainRequirement } from '../../../core/toolchain/store';
import { ArchivePayload } from '../../shared/install/archive-payload';
import type { LoadedExpected } from '../../shared/install/expected';
import type { PayloadSource } from '../../shared/install/payload';
import { acceptanceFor } from '../../shared/install/quartus-vendor';
import { BoardSelectionStore, type BoardSupportId } from '../../macos/install/boards';
import type { InstallSummary, SetupInteraction, SetupResult, VerifyResult, VerifyStep } from '../../macos/install/setup-controller';
import { buildSetupView, type HardwareView, type SetupView } from '../../macos/install/setup-view';
import type { InstallHooks, HostFacts } from '../../macos/install/toolchain-installer';
import { NativeQuartusEngine } from '../de10/native-quartus-engine';
import { WINDOWS_BOARD_SUPPORT, WINDOWS_CATALOG, WINDOWS_VIEW_PROFILE, windowsBoardState, windowsStudentFailure } from './boards';
import type { ElevatedHelper } from './elevation';
import { checkPathLength, DE10_LONGEST_RELATIVE_PATH, NEXYS_LONGEST_RELATIVE_PATH, TOOLCHAIN_TARGET, TOOLCHAIN_VERSION, type WindowsRuntimeLayout } from './layout';
import { type NexysAdoptionPlan, type NexysArchive, adoptNexys, nexysDefinition, planNexysAdoption } from './nexys-support';
import { alteraDriverPresent, installedWindowsDe10Paths, readLongPathsEnabled } from './paths';
import { WINDOWS_QUARTUS_SPEC, WindowsQuartusSetup, type WindowsQuartusSpec, verifyQuartus } from './quartus-install';
import { windowsToolchainDefinitions } from './toolchain';

export interface WindowsSetupDeps {
    readonly layout: WindowsRuntimeLayout;
    readonly expected: LoadedExpected;
    /** Folder source of the DE10-Lite tools (installer development). Used when no payload archive is available. */
    readonly payload: PayloadSource | undefined;
    /** Folder holding the support archives (see toolchains/mixfpga/payloads-1.0-windows-x64.json); each is checked against its pinned sha256. */
    readonly payloadDir?: string;
    readonly payloadPins?: Readonly<Record<string, { readonly file: string; readonly sha256: string }>>;
    /** Nexys A7 support: the validated toolchain requirement, its MIX-FPGA store, and NexysVHDL stores it may reuse or take over. */
    readonly nexys?: { readonly requirement: ToolchainRequirement; readonly dataRoot: string; readonly legacyRoots: readonly string[] };
    readonly runner: ToolRunner;
    readonly freeBytes: (path: string) => Promise<number>;
    readonly hardware: () => Promise<HardwareView>;
    readonly host?: HostFacts;
    readonly quartusSpec?: WindowsQuartusSpec;
    readonly toolchainHooks?: InstallHooks;
    /** Test seam: the elevated helper. */
    readonly helper?: ElevatedHelper;
    /** Test seam: `LongPathsEnabled`. Default: read from the registry (read only). */
    readonly longPaths?: () => Promise<boolean | undefined>;
    /** Test seam: the Quartus engine (default: built from the installed layout). */
    readonly engine?: NativeQuartusEngine;
    /** Test seam: where the driver store is asked about Altera's driver. */
    readonly driverPresent?: () => Promise<boolean | undefined>;
    /** Test seam: Digilent's utilities. */
    readonly digilent?: () => Promise<boolean>;
}

const STUDENT_ITEM: Record<string, string> = { 'nexys-toolchain': 'the Nexys A7 tools', toolchain: 'the VHDL tools', quartus: 'Quartus Prime Lite and MAX 10 support (from Altera)' };

const DIGILENT_UTILITIES = 'C:\\Program Files (x86)\\Digilent\\AdeptUtilities\\djtgcfg.exe';

/**
 * The one place the Windows Setup page talks to. It owns the component states, drives the install/repair/verify flows, asks the
 * student only what it must (Altera's files and licence), and never touches Quartus except to ask it questions. Windows' one
 * permission prompt appears only when Quartus itself has to be installed. Same shape as the macOS controller.
 */
export class WindowsSetupController {
    private readonly spec: WindowsQuartusSpec;
    private readonly store: InstallStateStore;
    private readonly selection: BoardSelectionStore;
    private readonly engine: NativeQuartusEngine;
    private readonly quartus: WindowsQuartusSetup;
    private askNexys: (() => Promise<string | undefined>) | undefined;
    private de10Archive: ArchivePayload | undefined;

    constructor(private readonly deps: WindowsSetupDeps) {
        this.spec = deps.quartusSpec ?? WINDOWS_QUARTUS_SPEC;
        this.selection = new BoardSelectionStore(join(deps.layout.stateDir, 'board-support.json'));
        this.store = new InstallStateStore(deps.layout.installStateFile, deps.layout.lockFile);
        this.engine = deps.engine ?? new NativeQuartusEngine(installedWindowsDe10Paths(deps.layout, deps.runner), deps.runner);
        this.quartus = new WindowsQuartusSetup({ layout: deps.layout, runner: deps.runner, engine: this.engine, freeBytes: deps.freeBytes, spec: this.spec, ...(deps.helper ? { helper: deps.helper } : {}) });
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
            freeBytes: this.deps.freeBytes,
            archive: async (): Promise<NexysArchive | undefined> => {
                const pinned = await this.pinnedArchive('nexys-a7-100t');
                if (pinned) return pinned;
                const chosen = await this.askNexys?.();
                return chosen ? { path: chosen } : undefined;
            },
        };
    }

    private payload(): PayloadSource | undefined {
        return this.de10Archive ?? this.deps.payload;
    }

    private definitions(depth: 'quick' | 'full'): ComponentDefinition[] {
        const none: PayloadSource = { kind: 'directory', describe: () => 'none', has: async () => false, materialize: async () => undefined };
        const ctx = { layout: this.deps.layout, expected: this.deps.expected, payload: this.payload() ?? none, freeBytes: this.deps.freeBytes, ...(this.deps.host ? { host: this.deps.host } : {}), ...(this.deps.toolchainHooks ? { hooks: this.deps.toolchainHooks } : {}) };
        const derived = (label: string, id: string, from: string): ComponentDefinition => ({
            id,
            label,
            inspectAfter: [from],
            inspect: async (deps): Promise<Inspection> => {
                const o = deps.get(from)!;
                return { state: o.state === 'installing' ? 'repairable' : (o.state as 'ready'), ownership: 'external', ...(o.version ? { version: o.version } : {}), ...(o.code ? { code: o.code } : {}), ...(o.detail ? { detail: o.detail } : {}) };
            },
        });
        return [
            ...(this.deps.nexys ? [nexysDefinition(this.nexysDeps(), depth)] : []),
            {
                // Digilent's USB/JTAG support is theirs: looked at, never installed here (the existing Environment page explains where to get it).
                id: 'digilent-adept',
                label: 'Digilent USB/JTAG support',
                inspect: async (): Promise<Inspection> => {
                    const present = this.deps.digilent ? await this.deps.digilent() : await stat(DIGILENT_UTILITIES).then((s) => s.isFile(), () => false);
                    return present ? { state: 'ready', ownership: 'external' } : { state: 'not-installed', ownership: 'external', detail: "Digilent's free USB/JTAG support is needed only to program the Nexys A7." };
                },
            },
            ...windowsToolchainDefinitions(ctx, depth),
            ...this.quartus.definitions(),
            derived('Quartus Programmer', 'programmer', 'quartus'),
            {
                // Altera's driver is the system's and the vendor's: shown for information, never installed or changed by MIX-FPGA.
                id: 'usb-driver',
                label: 'Altera USB-Blaster driver',
                inspect: async (): Promise<Inspection> => {
                    const present = this.deps.driverPresent ? await this.deps.driverPresent() : await alteraDriverPresent(this.deps.runner);
                    if (present === undefined) return { state: 'ready', ownership: 'system', detail: 'could not be checked' };
                    return present ? { state: 'ready', ownership: 'system' } : { state: 'not-installed', ownership: 'system', detail: "Altera's USB-Blaster driver is not in the driver store; it comes with Quartus' programmer support." };
                },
            },
        ];
    }

    private sengine(depth: 'quick' | 'full' = 'quick'): SetupEngine {
        return new SetupEngine(this.definitions(depth), this.store);
    }

    /** What the Setup page shows. Runs Quartus only to ask its version and its device list, and never a build. */
    async status(): Promise<{ statuses: ComponentStatus[]; view: SetupView }> {
        const statuses = await this.sengine().inspectAll();
        return { statuses, view: buildSetupView(statuses, await this.deps.hardware(), await this.selection.read(), WINDOWS_VIEW_PROFILE) };
    }

    /** Is this board's support completely installed? (New Project asks before creating a project for it.) */
    async isBoardReady(board: string): Promise<boolean> {
        const entry = WINDOWS_BOARD_SUPPORT.find((b) => b.id === board);
        if (!entry) return true;
        if (entry.id === 'nexys-a7-100t' && !this.deps.nexys) return true;
        return windowsBoardState(await this.sengine().inspectAll(), entry) === 'installed';
    }

    /**
     * Upgrade from NexysVHDL: the Nexys A7 tools already on this computer, verified file by file and taken over into the MIX-FPGA
     * store as a real copy (no links to the original). `dryRun` only reports.
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
        const quartus = need.has('quartus') && !ready('quartus');
        const nexys = need.has('nexys-toolchain');
        return {
            items: plan.map((p) => STUDENT_ITEM[p.id]).filter((x): x is string => !!x),
            needsInternet: false,
            storageGB: (nexys ? 3 : 0) + (need.has('toolchain') ? 0.2 : 0) + (quartus ? 9 : 0),
            requiredFreeGB: (nexys ? 4 : 0) + (need.has('toolchain') ? 1 : 0) + (quartus ? this.spec.requiredFreeGB : 0),
            askedForAltera: quartus,
            needsAdministrator: quartus,
        };
    }

    /** Detection only: would the longest file of each chosen board's tools fit under this computer's path limit? Changes nothing. */
    async pathPreflight(boards: readonly BoardSupportId[]): Promise<{ ok: boolean; problems: string[] }> {
        const longPaths = await (this.deps.longPaths ?? (() => readLongPathsEnabled(this.deps.runner)))();
        const problems: string[] = [];
        const check = (folder: string, longest: number, what: string) => {
            const c = checkPathLength(folder, longest, longPaths === true);
            if (!c.ok) problems.push(`${what}: its longest file would need ${c.worstLength} characters; Windows allows ${c.limit} (long paths are ${longPaths === false ? 'off' : 'unknown'}). The folder is ${folder}`);
        };
        if (boards.includes('nexys-a7-100t') && this.deps.nexys) check(join(this.deps.nexys.dataRoot, 'toolchains', 'win32-x64', '1.0'), NEXYS_LONGEST_RELATIVE_PATH, 'Nexys A7 tools');
        if (boards.includes('de10-lite')) check(this.deps.layout.toolchainDir, DE10_LONGEST_RELATIVE_PATH, 'DE10-Lite tools');
        return { ok: problems.length === 0, problems };
    }

    async install(ui: SetupInteraction, signal?: AbortSignal, boards?: readonly BoardSupportId[]): Promise<SetupResult> {
        const chosen = await this.resolveBoards(ui, boards);
        if (!chosen) return { outcome: 'stopped', message: 'No board was chosen. Nothing was changed.', view: await this.view() };
        return this.drive(ui, signal, false, chosen);
    }

    async repair(ui: SetupInteraction, signal?: AbortSignal, boards?: readonly BoardSupportId[]): Promise<SetupResult> {
        const present = await this.presentBoards();
        return this.drive(ui, signal, true, boards ?? present);
    }

    private async presentBoards(): Promise<BoardSupportId[]> {
        const statuses = await this.sengine().inspectAll();
        const selected = await this.selection.read();
        return WINDOWS_BOARD_SUPPORT.filter((b) => this.managed(b.id) && (selected.includes(b.id) || windowsBoardState(statuses, b) !== 'not-installed')).map((b) => b.id);
    }

    private managed(id: BoardSupportId): boolean {
        return id !== 'nexys-a7-100t' || this.deps.nexys !== undefined;
    }

    private async resolveBoards(ui: SetupInteraction, boards: readonly BoardSupportId[] | undefined): Promise<BoardSupportId[] | undefined> {
        if (boards && boards.length > 0) return boards.filter((b) => this.managed(b));
        const present = await this.presentBoards();
        if (present.length > 0) return present;
        const statuses = await this.sengine().inspectAll();
        const offered = WINDOWS_BOARD_SUPPORT.filter((b) => this.managed(b.id)).map((b) => ({ id: b.id, name: b.name, installed: windowsBoardState(statuses, b) === 'installed' }));
        const picked = await ui.chooseBoards(offered);
        return picked && picked.length > 0 ? picked : undefined;
    }

    private async drive(ui: SetupInteraction, signal: AbortSignal | undefined, repairOnly: boolean, boards: readonly BoardSupportId[]): Promise<SetupResult> {
        const steps = [...new Set(boards.flatMap((b) => WINDOWS_BOARD_SUPPORT.find((x) => x.id === b)?.steps ?? []))];
        if (steps.length === 0) return { outcome: 'complete', message: 'Everything is already set up.', view: await this.view() };
        this.askNexys = () => ui.askNexysArchive();
        try {
            const pinned = boards.includes('de10-lite') ? await this.pinnedArchive('de10-lite') : undefined;
            if (pinned) this.de10Archive = new ArchivePayload(pinned.path, pinned.sha256, join(this.deps.layout.root, '.payload'));
            return await this.driveSteps(ui, signal, repairOnly, boards, steps);
        } finally {
            this.askNexys = undefined;
            await this.de10Archive?.dispose().catch(() => undefined);
            this.de10Archive = undefined;
            // Whatever happened, administrator rights and the temporary Altera copies do not outlive Setup.
            await this.quartus.abandon();
        }
    }

    private async driveSteps(ui: SetupInteraction, signal: AbortSignal | undefined, repairOnly: boolean, boards: readonly BoardSupportId[], steps: readonly string[]): Promise<SetupResult> {
        // Repair looks at every byte (a changed file is invisible to the quick check); Install only needs the quick one.
        const depth = repairOnly ? 'full' : 'quick';
        const first = await this.sengine(depth).inspectAll(signal);
        const plan = this.sengine(depth).plan(first, steps).filter((p) => !repairOnly || p.mode === 'repair' || first.find((s) => s.id === p.id)?.state === 'failed');
        if (plan.length === 0) {
            if (!repairOnly) await this.selection.add(boards);
            return { outcome: 'complete', message: 'Everything is already set up.', view: await this.view() };
        }
        const pre = await this.pathPreflight(boards.filter((b) => plan.some((p) => (b === 'nexys-a7-100t' ? p.id === 'nexys-toolchain' : p.id === 'toolchain'))));
        if (!pre.ok) {
            for (const p of pre.problems) ui.log(`path: PATH_TOO_LONG — ${p}`);
            return { outcome: 'failed', message: windowsStudentFailure('PATH_TOO_LONG'), view: await this.view() };
        }
        if (!(await ui.confirmInstall(this.summary(first, plan)))) return { outcome: 'stopped', message: 'Nothing was changed.', view: await this.view() };
        if (!repairOnly) await this.selection.add(boards);

        const inputs: Record<string, unknown> = {};
        const only = repairOnly ? plan.map((p) => p.id) : steps;
        for (let round = 0; round < 10; round++) {
            const run: RunResult = await this.sengine(depth).run({ inputs, ...(only ? { only } : {}), ...(signal ? { signal } : {}), onProgress: (p) => ui.progress(p.message) });
            for (const s of run.steps) ui.log(`${s.id}: ${s.outcome}${s.code ? ` ${s.code}` : ''}${s.message ? ` — ${s.message}` : ''}`);
            if (run.outcome === 'busy') return { outcome: 'busy', message: 'Setup is already running.', view: await this.view() };
            if (run.outcome === 'cancelled') return { outcome: 'cancelled', message: windowsStudentFailure('CANCELLED'), view: await this.view() };
            if (run.outcome === 'complete') return { outcome: 'complete', message: 'Setup finished.', view: await this.view() };

            const failed = run.steps.find((s) => s.outcome === 'failed');
            if (failed) return { outcome: 'failed', message: windowsStudentFailure(failed.code ?? ''), view: await this.view() };
            const awaiting = run.steps.find((s) => s.outcome === 'awaiting-input');
            if (!awaiting) return { outcome: 'failed', message: windowsStudentFailure(''), view: await this.view() };

            const stop = async (message: string): Promise<SetupResult> => ({ outcome: 'stopped', message, view: await this.view() });
            if (awaiting.id === 'quartus') {
                const files = await ui.askQuartusFiles();
                if (!files) return stop("Quartus was not installed. Choose Install DE10-Lite Support when you have Altera's two files.");
                const prepared = await this.quartus.prepareLicense(files, signal, (m) => ui.progress(m));
                if (!prepared.ok) {
                    ui.log(`quartus: ${prepared.code} — ${prepared.message}`);
                    return { outcome: 'failed', message: windowsStudentFailure(prepared.code), view: await this.view() };
                }
                if (!(await ui.showLicense(prepared.offer))) return stop('Quartus was not installed because the licence was not accepted.');
                inputs['quartus'] = { ...files, eula: acceptanceFor(prepared.offer) };
            } else return { outcome: 'failed', message: windowsStudentFailure(''), view: await this.view() };
        }
        return { outcome: 'failed', message: windowsStudentFailure(''), view: await this.view() };
    }

    /** Verify Environment: a full check of every installed file, then Quartus is asked and a test design really goes through it. */
    async verify(signal?: AbortSignal): Promise<VerifyResult> {
        const steps: VerifyStep[] = [];
        const boards = await this.presentBoards();
        const wanted = new Set(boards.flatMap((b) => WINDOWS_BOARD_SUPPORT.find((x) => x.id === b)?.components ?? []));
        const statuses = (await this.sengine('full').inspectAll(signal)).filter((s) => wanted.has(s.id));
        for (const s of statuses) steps.push({ label: WINDOWS_CATALOG.find((c) => c.id === s.id)?.label ?? s.id, ok: s.state === 'ready', detail: s.state === 'ready' ? (s.version ?? '') : (s.detail ?? s.state) });
        if (boards.includes('de10-lite') && statuses.find((s) => s.id === 'quartus')?.state === 'ready') {
            const v = await verifyQuartus(this.engine, this.deps.layout.stagingDir, this.spec, signal);
            steps.push({ label: 'Quartus and a test design', ok: v.ok, detail: v.ok ? (v.version ?? '') : (v.message ?? v.code ?? '') });
            if (v.ok) await this.quartus.record.merge({ verifiedAt: new Date().toISOString(), ...(v.version ? { version: v.version } : {}), device: this.spec.device });
        }
        return { ok: steps.length > 0 && steps.every((s) => s.ok), steps, view: await this.view() };
    }
}

export { TOOLCHAIN_TARGET, TOOLCHAIN_VERSION };
