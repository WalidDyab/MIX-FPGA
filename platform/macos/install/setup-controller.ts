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
import { buildSetupView, type HardwareView, type SetupView, studentFailure } from './setup-view';
import { toolchainDefinitions } from './toolchain-components';
import type { HostFacts, InstallHooks } from './toolchain-installer';

/** Every question the student can be asked during setup. The VS Code side answers them with dialogs; tests answer them directly. */
export interface SetupInteraction {
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
    readonly view: SetupView;
}

export interface SetupDeps {
    readonly layout: RuntimeLayout;
    readonly expected: LoadedExpected;
    /** Where the tools are copied from. Absent: nothing can be installed (a release provides it). */
    readonly payload: PayloadSource | undefined;
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

const STUDENT_ITEM: Record<string, string> = { toolchain: 'VHDL tools and the programmer', rosetta: 'Rosetta (from Apple)', 'linux-vm': 'the FPGA engine', quartus: 'Quartus Prime Lite and MAX 10 support (from Altera)' };

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

    constructor(private readonly deps: SetupDeps) {
        this.spec = deps.quartusSpec ?? QUARTUS_SPEC;
        this.store = new InstallStateStore(deps.layout.installStateFile, deps.layout.lockFile);
        this.provisioner = new EngineProvisioner({ layout: deps.layout, runner: deps.runner, downloader: deps.downloader, freeBytes: deps.freeBytes });
        this.quartus = new QuartusInstaller({ layout: deps.layout, runner: deps.runner, freeBytes: deps.freeBytes, spec: this.spec });
    }

    private definitions(depth: 'quick' | 'full'): ComponentDefinition[] {
        const ctx = { layout: this.deps.layout, expected: this.deps.expected, payload: this.deps.payload ?? NO_PAYLOAD, freeBytes: this.deps.freeBytes, ...(this.deps.host ? { host: this.deps.host } : {}), ...(this.deps.toolchainHooks ? { hooks: this.deps.toolchainHooks } : {}) };
        return [
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
        return { statuses, view: buildSetupView(statuses, await this.deps.hardware()) };
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
        };
    }

    /** Install FPGA Toolchain: everything that is missing, resuming whatever was already done. */
    install(ui: SetupInteraction, signal?: AbortSignal): Promise<SetupResult> {
        return this.drive(ui, signal, false);
    }

    /** Repair: only what is already there but interrupted, damaged or changed. */
    repair(ui: SetupInteraction, signal?: AbortSignal): Promise<SetupResult> {
        return this.drive(ui, signal, true);
    }

    private async drive(ui: SetupInteraction, signal: AbortSignal | undefined, repairOnly: boolean): Promise<SetupResult> {
        const first = await this.engine().inspectAll(signal);
        const plan = this.engine().plan(first).filter((p) => !repairOnly || p.mode === 'repair' || first.find((s) => s.id === p.id)?.state === 'failed');
        if (plan.length === 0) return { outcome: 'complete', message: 'Everything is already set up.', view: await this.view() };
        if (!(await ui.confirmInstall(this.summary(first, plan)))) return { outcome: 'stopped', message: 'Nothing was changed.', view: await this.view() };

        const inputs: Record<string, unknown> = {};
        const only = repairOnly ? plan.map((p) => p.id) : undefined;
        for (let round = 0; round < 10; round++) {
            const run: RunResult = await this.engine().run({ inputs, ...(only ? { only } : {}), ...(signal ? { signal } : {}), onProgress: (p) => ui.progress(p.message) });
            for (const s of run.steps) ui.log(`${s.id}: ${s.outcome}${s.code ? ` ${s.code}` : ''}${s.message ? ` — ${s.message}` : ''}`);
            if (run.outcome === 'busy') return { outcome: 'busy', message: 'Setup is already running.', view: await this.view() };
            if (run.outcome === 'cancelled') return { outcome: 'cancelled', message: studentFailure('CANCELLED'), view: await this.view() };
            if (run.outcome === 'complete') return { outcome: 'complete', message: 'Setup finished.', view: await this.view() };

            const failed = run.steps.find((s) => s.outcome === 'failed');
            if (failed) return { outcome: 'failed', message: studentFailure(failed.code ?? ''), view: await this.view() };
            const awaiting = run.steps.find((s) => s.outcome === 'awaiting-input');
            if (!awaiting) return { outcome: 'failed', message: studentFailure(''), view: await this.view() };

            const stop = async (message: string): Promise<SetupResult> => ({ outcome: 'stopped', message, view: await this.view() });
            if (awaiting.id === 'rosetta') {
                const consent = await ui.askRosettaConsent();
                if (!consent) return stop('Rosetta was not installed. The FPGA engine needs it. Choose Install FPGA Toolchain to continue.');
                inputs['rosetta'] = consent;
            } else if (awaiting.id === 'quartus') {
                const files = await ui.askQuartusFiles();
                if (!files) return stop('Quartus was not installed. Choose Install FPGA Toolchain when you have Altera\'s two files.');
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
        const statuses = await this.engine('full').inspectAll(signal);
        for (const s of statuses) steps.push({ label: MACOS_CATALOG.find((c) => c.id === s.id)?.label ?? s.id, ok: s.state === 'ready', detail: s.state === 'ready' ? (s.version ?? '') : (s.detail ?? s.state) });
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
        return { ok: steps.length > 0 && steps.every((s) => s.ok), steps, view: await this.view() };
    }
}
