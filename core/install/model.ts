/**
 * Platform-neutral installation model. A "component" is anything the student's setup needs
 * (MIX-FPGA's own tools, Rosetta, the Linux engine, Quartus, ...). Each one has its own
 * state and its own ownership, so there is never a single "installed" Boolean.
 *
 *   state      what is true now (derived from the machine, never trusted from a file alone)
 *   ownership  who owns the thing: MIX-FPGA installs and maintains it (`managed`), the
 *              student/vendor supplies it under their own licence (`external`), or the
 *              operating system provides it (`system`)
 */

export type ComponentId = string;

export type ComponentState =
    /** Nothing usable is there. */
    | 'not-installed'
    /** An installation is running right now (this or another live process). */
    | 'installing'
    /** Present, verified and usable. */
    | 'ready'
    /**
     * Present and usable, but one or more files differ from the supported release because the user changed them
     * (nothing is missing, nothing is unreadable). It is not the verified MIX-FPGA configuration and is never
     * restored automatically; the user may keep using it or choose Repair.
     */
    | 'modified'
    /** Present but damaged, partial or interrupted: running the installer again fixes it without starting over. */
    | 'repairable'
    /** Present but not something MIX-FPGA can use or fix (wrong version, unknown binaries, wrong architecture). */
    | 'incompatible'
    /** The last attempt to install or repair it failed; the reason is recorded. */
    | 'failed';

export type Ownership = 'managed' | 'external' | 'system';

export interface ComponentStatus {
    readonly id: ComponentId;
    readonly state: ComponentState;
    readonly ownership: Ownership;
    readonly version?: string;
    /** One plain sentence for Details; never shown as the student-facing word. */
    readonly detail?: string;
    /** Stable machine-readable reason (`INTERRUPTED`, `HASH_MISMATCH`, ...). */
    readonly code?: string;
}

/** What an inspector reports; `installing` is decided by the engine from recorded operations, not by inspectors. */
export interface Inspection {
    readonly state: Exclude<ComponentState, 'installing'>;
    readonly ownership: Ownership;
    readonly version?: string;
    readonly detail?: string;
    readonly code?: string;
}

export type UserInputKind = 'none' | 'consent' | 'files';
export type InstallMode = 'install' | 'repair';

export interface InstallProgress {
    readonly component: ComponentId;
    /** Short student-facing phrase, e.g. "Installing VHDL tools…". */
    readonly message: string;
    /** 0..1 when known. */
    readonly fraction?: number;
}

export type SetupStepResult =
    | { readonly ok: true; readonly detail?: string }
    | { readonly ok: false; readonly code: string; readonly message: string };

export interface InstallRequest {
    readonly mode: InstallMode;
    /** The student chose Repair: files they changed (present and usable) may be replaced by the supported copy. Never set by Install or at start-up. */
    readonly repairModified?: boolean;
    /** Whatever the student provided for this step (consent, chosen files); undefined for `userInput: 'none'`. */
    readonly input?: unknown;
    readonly signal?: AbortSignal;
    readonly progress: (p: Omit<InstallProgress, 'component'>) => void;
}

export interface InstallStep {
    /** Components that must be `ready` before this step runs. */
    readonly requires: readonly ComponentId[];
    /** What the student must supply before this step may run (consent to a licence, files). Never assumed. */
    readonly userInput: UserInputKind;
    /** Other components this step creates or repairs together with its own (e.g. the four tools of the toolchain). */
    readonly covers?: readonly ComponentId[];
    run(request: InstallRequest): Promise<SetupStepResult>;
}

export interface ComponentDefinition {
    readonly id: ComponentId;
    readonly label: string;
    /** Components whose statuses this inspection needs (aggregates, dependent checks). Inspected first. */
    readonly inspectAfter?: readonly ComponentId[];
    inspect(deps: ReadonlyMap<ComponentId, ComponentStatus>, signal?: AbortSignal): Promise<Inspection>;
    /** Absent when the component cannot be installed on its own (it is created by another step, or is read-only to us). */
    readonly install?: InstallStep;
}

/** Combine the states of parts into the state of the whole. */
export function aggregate(parts: readonly ComponentStatus[], ownership: Ownership): Inspection {
    if (parts.length === 0) return { state: 'not-installed', ownership };
    const has = (s: ComponentState) => parts.some((p) => p.state === s);
    if (parts.every((p) => p.state === 'ready')) return { state: 'ready', ownership };
    // A modified part does not make the whole unusable: modified but usable is not "not installed" and not "damaged".
    if (parts.every((p) => p.state === 'ready' || p.state === 'modified')) return { state: 'modified', ownership, detail: 'files were changed after installation', code: 'MODIFIED' };
    if (has('incompatible')) return { state: 'incompatible', ownership, detail: 'a part is not usable by MIX-FPGA', code: 'PART_INCOMPATIBLE' };
    if (parts.every((p) => p.state === 'not-installed')) return { state: 'not-installed', ownership };
    return { state: 'repairable', ownership, detail: 'some parts are missing or damaged', code: 'PARTIAL' };
}
