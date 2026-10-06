import type { PinMapping } from '../board/constraints';
import type { ToolId } from '../toolchain/types';

/** Name of the project file students keep at their project root. */
export const PROJECT_FILE_NAME = 'nexysvhdl.json';

export type HdlLanguage = 'vhdl';
export type VhdlStandard = '2008';

export interface SimulationSettings {
    /** Testbench-only files (project-relative). */
    readonly sources: readonly string[];
    /** Entity name of the testbench to run by default. */
    readonly testbench?: string;
    /**
     * Finite simulation length passed to GHDL as `--stop-time`, e.g. `1us`
     * (an integer and a unit: fs, ps, ns, us, ms, sec). Absent: the
     * testbench runs until it ends itself (`std.env.stop`), as before.
     */
    readonly stopTime?: string;
}

/** Time units GHDL accepts in `--stop-time`. */
export const STOP_TIME_UNITS = ['fs', 'ps', 'ns', 'us', 'ms', 'sec'] as const;

/** Normalizes `1 us` / `1US` to `1us`, or undefined when it is not an integer followed by a GHDL time unit. */
export function normalizeStopTime(text: string): string | undefined {
    const m = /^\s*(\d+)\s*(fs|ps|ns|us|ms|sec)\s*$/i.exec(text);
    if (!m || /^0+$/.test(m[1]!)) return undefined;
    return `${m[1]!.replace(/^0+(?=\d)/, '')}${m[2]!.toLowerCase()}`;
}

export interface ToolchainSettings {
    /** Toolchain manifest id to validate against (see toolchains/*.json). */
    readonly manifest?: string;
    /** Explicit executable paths, overriding discovery. */
    readonly tools?: Partial<Readonly<Record<ToolId, string>>>;
}

/** Contents of nexysvhdl.json as written by the student (all paths project-relative, `/`-separated). */
export interface ProjectFile {
    readonly name: string;
    readonly board: string;
    readonly language: HdlLanguage;
    readonly standard: VhdlStandard;
    /** Top-level entity for synthesis. */
    readonly top: string;
    /** RTL sources in compile order. */
    readonly sources: readonly string[];
    readonly simulation?: SimulationSettings;
    /**
     * The project's own XDC constraints file (project-relative, e.g.
     * `constraints/nexys-a7-100t.xdc`). Students may edit it directly.
     * A project uses either `constraints` or `pins`, never both.
     */
    readonly constraints?: string;
    /** Top-level port -> board resource id; NexysVHDL generates the XDC from it. */
    readonly pins?: PinMapping;
    readonly toolchain?: ToolchainSettings;
}

/** A loaded project: the file contents plus where it lives. */
export interface Project {
    /** Absolute project root directory. */
    readonly root: string;
    /** Absolute path of nexysvhdl.json. */
    readonly file: string;
    readonly config: ProjectFile;
}

/** Standard folders of a NexysVHDL project (Phase 4A folder contract). */
export const PROJECT_FOLDERS = {
    /** RTL sources (`src/**\/*.vhd`). */
    sources: 'src',
    /** Testbenches (`sim/**\/*.vhd`). */
    simulation: 'sim',
    /** XDC constraints (`constraints/**\/*.xdc`). */
    constraints: 'constraints',
} as const;

export const PROJECT_DEFAULTS = {
    language: 'vhdl',
    standard: '2008',
    board: 'nexys-a7-100t',
} as const satisfies Partial<ProjectFile>;
