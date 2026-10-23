import { randomBytes } from 'node:crypto';
import type { SetupStepResult, ComponentDefinition, ComponentId, ComponentState, ComponentStatus, InstallMode, InstallProgress, UserInputKind } from './model';
import { type InstallStateStore, operationAlive, type PersistedComponent } from './state-store';

export interface PlanStep {
    readonly id: ComponentId;
    readonly mode: InstallMode;
    readonly userInput: UserInputKind;
    readonly covers: readonly ComponentId[];
    /** Why the step is needed, for Details. */
    readonly reason: string;
}

export type StepOutcome = 'done' | 'failed' | 'awaiting-input' | 'blocked' | 'cancelled';

export interface StepReport {
    readonly id: ComponentId;
    readonly outcome: StepOutcome;
    readonly message?: string;
    readonly code?: string;
    /** For `awaiting-input`: what the student must supply. */
    readonly needs?: UserInputKind;
}

export type RunOutcome = 'complete' | 'incomplete' | 'cancelled' | 'busy';

export interface RunResult {
    readonly outcome: RunOutcome;
    readonly steps: readonly StepReport[];
    readonly statuses: readonly ComponentStatus[];
}

export interface RunOptions {
    /** Per step id: what the student supplied (a consent, chosen files). A step that needs input and has none waits. */
    readonly inputs?: Readonly<Record<ComponentId, unknown>>;
    /** Limit the run to these steps (and what they require). Default: everything that is not ready. */
    readonly only?: readonly ComponentId[];
    /**
     * Repair: parts the user modified (present and usable) are restored too. Off by default: an install or any other
     * run never touches a modified part, it is only restored when the user explicitly asks for Repair.
     */
    readonly repairModified?: boolean;
    readonly signal?: AbortSignal;
    readonly onProgress?: (p: InstallProgress) => void;
}

/** Combine what the machine shows with what was recorded about operations and failures. */
export function combine(inspected: ComponentStatus, recorded: PersistedComponent | undefined, isAlive: (op: { id: string; pid: number }) => boolean): ComponentStatus {
    if (recorded?.operation && isAlive(recorded.operation)) return { ...inspected, state: 'installing', detail: 'installation in progress' };
    if (inspected.state === 'ready' || inspected.state === 'modified' || inspected.state === 'incompatible') return inspected;
    if (recorded?.failure) return { ...inspected, state: 'failed', code: recorded.failure.code, detail: recorded.failure.message };
    if (recorded?.interrupted || recorded?.operation) {
        const state: ComponentState = inspected.state === 'not-installed' ? 'not-installed' : 'repairable';
        return { ...inspected, state, code: 'INTERRUPTED', detail: 'a previous installation was interrupted; it will continue where it stopped' };
    }
    return inspected;
}

/**
 * Inspects every component independently, plans only what is missing, and runs it. Safe to
 * stop at any point: the next run inspects the machine again and continues from what is there.
 */
export class SetupEngine {
    private readonly byId = new Map<ComponentId, ComponentDefinition>();

    constructor(
        components: readonly ComponentDefinition[],
        private readonly store: InstallStateStore,
        private readonly isAlive: (op: { id: string; pid: number }) => boolean = operationAlive,
    ) {
        for (const c of components) this.byId.set(c.id, c);
    }

    get definitions(): readonly ComponentDefinition[] {
        return [...this.byId.values()];
    }

    /** Inspection order: every component after the ones it inspects through. */
    private inspectionOrder(): ComponentDefinition[] {
        const out: ComponentDefinition[] = [];
        const seen = new Set<ComponentId>();
        const visit = (c: ComponentDefinition, trail: ComponentId[]): void => {
            if (seen.has(c.id)) return;
            if (trail.includes(c.id)) throw new Error(`install components form a cycle: ${[...trail, c.id].join(' -> ')}`);
            for (const dep of c.inspectAfter ?? []) {
                const d = this.byId.get(dep);
                if (!d) throw new Error(`component ${c.id} inspects unknown component ${dep}`);
                visit(d, [...trail, c.id]);
            }
            seen.add(c.id);
            out.push(c);
        };
        for (const c of this.byId.values()) visit(c, []);
        return out;
    }

    /** Independent per-component status. Starts and changes nothing. */
    async inspectAll(signal?: AbortSignal): Promise<ComponentStatus[]> {
        const recorded = (await this.store.read()).components;
        const done = new Map<ComponentId, ComponentStatus>();
        for (const def of this.inspectionOrder()) {
            let status: ComponentStatus;
            try {
                const i = await def.inspect(done, signal);
                status = { id: def.id, ...i };
            } catch (err) {
                status = { id: def.id, state: 'repairable', ownership: 'managed', code: 'INSPECTION_FAILED', detail: err instanceof Error ? err.message : String(err) };
            }
            done.set(def.id, combine(status, recorded[def.id], this.isAlive));
        }
        // Report in definition order, not inspection order.
        return [...this.byId.keys()].map((id) => done.get(id)!);
    }

    /** What would run now, in dependency order. Pure: no side effects. */
    plan(statuses: readonly ComponentStatus[], only?: readonly ComponentId[], opts: { readonly repairModified?: boolean } = {}): PlanStep[] {
        const status = new Map(statuses.map((s) => [s.id, s]));
        const steps = [...this.byId.values()].filter((d) => d.install);
        const wanted = new Set<ComponentId>();
        const want = (id: ComponentId): void => {
            if (wanted.has(id)) return;
            wanted.add(id);
            for (const r of this.byId.get(id)?.install?.requires ?? []) want(r);
        };
        for (const id of only ?? steps.map((d) => d.id)) want(id);
        const out: PlanStep[] = [];
        const order: ComponentId[] = [];
        const visit = (id: ComponentId, trail: ComponentId[]): void => {
            if (order.includes(id)) return;
            if (trail.includes(id)) throw new Error(`install steps form a cycle: ${[...trail, id].join(' -> ')}`);
            for (const r of this.byId.get(id)?.install?.requires ?? []) visit(r, [...trail, id]);
            order.push(id);
        };
        for (const d of steps) visit(d.id, []);
        for (const id of order) {
            const def = this.byId.get(id)!;
            if (!def.install || !wanted.has(id)) continue;
            const covers = def.install.covers ?? [];
            const members = [id, ...covers].map((m) => status.get(m)).filter((s): s is ComponentStatus => !!s);
            // A modified part is usable: it is left alone unless the user asked for Repair.
            const pending = members.filter((s) => s.state !== 'ready' && s.state !== 'installing' && (s.state !== 'modified' || opts.repairModified === true));
            if (pending.length === 0) continue;
            // Never "fix" something MIX-FPGA cannot use: an incompatible component needs the student's attention.
            if (pending.every((s) => s.state === 'incompatible')) continue;
            const repair = members.some((s) => s.state === 'repairable' || s.state === 'failed' || (s.state === 'modified' && opts.repairModified === true)) && !members.every((s) => s.state === 'not-installed' || s.state === 'failed');
            out.push({
                id,
                mode: repair ? 'repair' : 'install',
                userInput: def.install.userInput,
                covers,
                reason: pending.map((s) => `${s.id}: ${s.state}`).join(', '),
            });
        }
        return out;
    }

    async run(options: RunOptions = {}): Promise<RunResult> {
        const opId = randomBytes(6).toString('hex');
        const release = await this.store.acquireLock(opId);
        if (!release) return { outcome: 'busy', steps: [], statuses: await this.inspectAll() };
        const reports: StepReport[] = [];
        try {
            await this.store.markDeadOperationsInterrupted();
            const unmet = new Set<ComponentId>();
            const plan = this.plan(await this.inspectAll(options.signal), options.only, { repairModified: options.repairModified === true });
            for (const step of plan) {
                const def = this.byId.get(step.id)!.install!;
                if (options.signal?.aborted) {
                    reports.push({ id: step.id, outcome: 'cancelled' });
                    break;
                }
                // A step waits for everything it requires; if one of those did not get done, it is blocked, not failed.
                const blockers = def.requires.filter((r) => unmet.has(r));
                const mine = [step.id, ...step.covers];
                if (blockers.length > 0) {
                    mine.forEach((m) => unmet.add(m));
                    reports.push({ id: step.id, outcome: 'blocked', message: `waiting for ${blockers.join(', ')}` });
                    continue;
                }
                const input = options.inputs?.[step.id];
                if (def.userInput !== 'none' && input === undefined) {
                    mine.forEach((m) => unmet.add(m));
                    reports.push({ id: step.id, outcome: 'awaiting-input', needs: def.userInput });
                    continue;
                }
                await this.store.begin(mine, opId);
                const label = this.byId.get(step.id)!.label;
                let result: SetupStepResult;
                try {
                    result = await def.run({
                        mode: step.mode,
                        ...(options.repairModified === true ? { repairModified: true } : {}),
                        ...(input !== undefined ? { input } : {}),
                        ...(options.signal ? { signal: options.signal } : {}),
                        progress: (p) => options.onProgress?.({ component: step.id, ...p }),
                    });
                } catch (err) {
                    result = { ok: false, code: 'UNEXPECTED_ERROR', message: err instanceof Error ? err.message : String(err) };
                }
                if (options.signal?.aborted) {
                    await this.store.release(mine, opId);
                    reports.push({ id: step.id, outcome: 'cancelled' });
                    break;
                }
                if (result.ok) {
                    await this.store.succeed(mine, opId);
                    reports.push({ id: step.id, outcome: 'done', ...(result.detail ? { message: result.detail } : {}) });
                    // Truth check: a step only counts when the machine now shows its parts ready.
                    // A part the user modified and that Repair was not asked to restore is allowed to stay modified.
                    const after = (await this.inspectAll(options.signal)).filter((s) => mine.includes(s.id) && s.state !== 'ready' && !(s.state === 'modified' && options.repairModified !== true));
                    if (after.length > 0) {
                        mine.forEach((m) => unmet.add(m));
                        reports[reports.length - 1] = { id: step.id, outcome: 'failed', code: 'VERIFY_FAILED', message: `${label} was installed but is not ready: ${after.map((s) => `${s.id} ${s.state}`).join(', ')}` };
                        await this.store.fail(mine, opId, { code: 'VERIFY_FAILED', message: reports[reports.length - 1]!.message! });
                    }
                } else {
                    await this.store.fail(mine, opId, { code: result.code, message: result.message });
                    mine.forEach((m) => unmet.add(m));
                    reports.push({ id: step.id, outcome: 'failed', code: result.code, message: result.message });
                }
            }
        } finally {
            await release();
        }
        const statuses = await this.inspectAll();
        const cancelled = reports.some((r) => r.outcome === 'cancelled');
        const incomplete = reports.some((r) => r.outcome !== 'done');
        return { outcome: cancelled ? 'cancelled' : incomplete ? 'incomplete' : 'complete', steps: reports, statuses };
    }
}
