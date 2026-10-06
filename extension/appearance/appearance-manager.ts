/**
 * Optional "NexysVHDL Classroom" appearance. Pure logic over two small ports
 * (workspace settings, remembered answers) so it is testable without VS Code.
 *
 * Rules:
 *  - never touches the student's global (user) theme: only the workspace
 *    value of `workbench.colorTheme` is ever written;
 *  - switching back removes our workspace value (or restores the workspace
 *    value the folder had before), so the user's normal theme shows again;
 *  - the first-use question is asked once per workspace and never again
 *    after "Keep My VS Code Appearance".
 */

/** The label of the contributed theme (`contributes.themes[].label`). */
export const CLASSROOM_THEME = 'NexysVHDL Classroom';

export const USE_CLASSROOM = 'Use NexysVHDL Classroom Appearance';
export const KEEP_MINE = 'Keep My VS Code Appearance';

/** The workspace-scoped theme setting. */
export interface ThemeSettings {
    /** The `workbench.colorTheme` value stored at workspace scope (undefined = none). */
    workspaceTheme(): string | undefined;
    /** Writes (or, with undefined, removes) the workspace-scope value. Never the user scope. */
    setWorkspaceTheme(theme: string | undefined): Promise<void>;
}

/** Small key/value store (a workspaceState or globalState memento). */
export interface Remembered {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void> | Promise<void>;
}

export type Decision = 'classroom' | 'keep';

const DECISION = 'nexysvhdl.appearance.decision';
const PREVIOUS = 'nexysvhdl.appearance.previousWorkspaceTheme';
/** Set when the student said "Keep" anywhere: do not ask again in other workspaces. */
const KEEP_EVERYWHERE = 'nexysvhdl.appearance.keepEverywhere';

export class AppearanceManager {
    constructor(
        private readonly settings: ThemeSettings,
        /** Per-workspace answers. */
        private readonly workspaceState: Remembered,
        /** Per-user answers (only "keep" is stored here). */
        private readonly globalState: Remembered,
    ) {}

    /** Whether the Classroom appearance is the workspace's theme right now. */
    get active(): boolean {
        return this.settings.workspaceTheme() === CLASSROOM_THEME;
    }

    /** True when the one-time question should be shown. */
    shouldAsk(promptEnabled = true): boolean {
        if (!promptEnabled) return false;
        if (this.workspaceState.get<Decision>(DECISION) !== undefined) return false;
        if (this.globalState.get<boolean>(KEEP_EVERYWHERE) === true) return false;
        return !this.active;
    }

    /** Applies the Classroom theme at workspace scope, remembering what the workspace had. */
    async useClassroom(): Promise<void> {
        const current = this.settings.workspaceTheme();
        if (current !== CLASSROOM_THEME) await this.workspaceState.update(PREVIOUS, current ?? null);
        await this.settings.setWorkspaceTheme(CLASSROOM_THEME);
        await this.workspaceState.update(DECISION, 'classroom' satisfies Decision);
    }

    /**
     * Back to the student's normal appearance: removes our workspace override
     * (restoring a different workspace theme the folder itself had chosen).
     * A user-level theme is never read or written.
     */
    async useMine(): Promise<void> {
        if (this.active) {
            const previous = this.workspaceState.get<string | null>(PREVIOUS);
            await this.settings.setWorkspaceTheme(typeof previous === 'string' && previous !== CLASSROOM_THEME ? previous : undefined);
        }
        await this.workspaceState.update(PREVIOUS, undefined);
        await this.workspaceState.update(DECISION, 'keep' satisfies Decision);
    }

    /** The answer to the first-use question. */
    async answer(choice: string | undefined): Promise<Decision | undefined> {
        if (choice === USE_CLASSROOM) {
            await this.useClassroom();
            return 'classroom';
        }
        if (choice === KEEP_MINE) {
            await this.workspaceState.update(DECISION, 'keep' satisfies Decision);
            await this.globalState.update(KEEP_EVERYWHERE, true);
            return 'keep';
        }
        return undefined; // dismissed: ask again next time
    }
}
