import { win32 } from 'node:path';
import { type LocatedTool, succeeded, type ToolLocator, type ToolRunner } from '../../../core';
import { decodeWindowsText, getEnv, type WindowsHostEnvironment } from '../host-environment';
import { parseAdeptRuntimeVersion, parseDjtgcfgVersion } from './djtgcfg-output';

/**
 * Adept Utilities package version by the djtgcfg.exe version it installs.
 * The package version is not recorded on disk; only djtgcfg's own version is.
 * Observed in Phase 1B: Adept Utilities 2.7.1 installs djtgcfg 2.6.1.
 */
export const ADEPT_UTILITIES_BY_DJTGCFG: Readonly<Record<string, string>> = { '2.6.1': '2.7.1' };

/** Oldest Adept Runtime that provides the dmgr entry points djtgcfg 2.6.1 imports (Phase 1B). */
export const MIN_ADEPT_RUNTIME = '2.30';

/** NTSTATUS STATUS_ENTRY_POINT_NOT_FOUND: djtgcfg started against a too-old Adept Runtime DLL. */
const ENTRY_POINT_NOT_FOUND = [0xc0000139, 0xc0000139 - 0x1_0000_0000];

export interface AdeptEnvironment {
    /** djtgcfg.exe location, if found. */
    readonly djtgcfg?: LocatedTool;
    /** djtgcfg's own version (`-version`), e.g. `2.6.1`. */
    readonly djtgcfgVersion?: string;
    /** Adept Utilities package version derived from djtgcfgVersion, e.g. `2.7.1`. */
    readonly utilitiesVersion?: string;
    /** Adept Runtime version from the Digilent install log, e.g. `2.30.4`. */
    readonly runtimeVersion?: string;
    /** djtgcfg exists and runs. */
    readonly usable: boolean;
    /** Why not usable, or a caveat when usable. */
    readonly problem?: string;
    readonly rawVersion?: string;
}

export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

/** Reads the Adept Runtime version from the Digilent installer logs (never runs an installer). */
export async function readAdeptRuntimeVersion(host: WindowsHostEnvironment): Promise<string | undefined> {
    const roots = [getEnv(host.env, 'ProgramFiles'), getEnv(host.env, 'ProgramFiles(x86)')].filter((r): r is string => !!r);
    for (const root of [...new Set(roots)]) {
        const buf = await host.fs.readFile(win32.join(root, 'Digilent', 'install.log'));
        const version = buf ? parseAdeptRuntimeVersion(decodeWindowsText(buf)) : undefined;
        if (version) return version;
    }
    return undefined;
}

const VERSION_TIMEOUT_MS = 15_000;

/** Locates djtgcfg, runs `djtgcfg -version`, and reads the Adept Runtime version. Read-only. */
export async function inspectAdept(locator: ToolLocator, runner: ToolRunner, host: WindowsHostEnvironment): Promise<AdeptEnvironment> {
    const runtimeVersion = await readAdeptRuntimeVersion(host);
    const withRuntime = runtimeVersion ? { runtimeVersion } : {};
    const djtgcfg = await locator.locate('programmer');
    if (!djtgcfg) {
        return {
            ...withRuntime,
            usable: false,
            problem: 'djtgcfg.exe not found. Install Digilent Adept Runtime (2.30 or newer) and Adept Utilities 2.7.1; Vivado is not required.',
        };
    }

    const run = await runner.run({ executable: djtgcfg.path, args: ['-version'], timeoutMs: VERSION_TIMEOUT_MS });
    const raw = `${run.stdout}\n${run.stderr}`.trim();
    if (run.outcome === 'spawn-failed') {
        return { djtgcfg, ...withRuntime, usable: false, problem: `djtgcfg could not be started (${run.errorMessage ?? 'unknown error'}).` };
    }
    if (run.outcome === 'exited' && run.exitCode !== null && ENTRY_POINT_NOT_FOUND.includes(run.exitCode)) {
        return {
            djtgcfg,
            ...withRuntime,
            usable: false,
            problem: `djtgcfg cannot load the Adept Runtime (entry point not found). The installed runtime is too old; install Digilent Adept Runtime ${MIN_ADEPT_RUNTIME} or newer.`,
        };
    }
    const djtgcfgVersion = succeeded(run) ? parseDjtgcfgVersion(raw) : undefined;
    if (!djtgcfgVersion) {
        return { djtgcfg, ...withRuntime, usable: false, rawVersion: raw, problem: `djtgcfg -version did not report a version (${run.outcome}, exit ${String(run.exitCode)}).` };
    }
    const utilitiesVersion = ADEPT_UTILITIES_BY_DJTGCFG[djtgcfgVersion];
    const caveat =
        runtimeVersion && compareVersions(runtimeVersion, MIN_ADEPT_RUNTIME) < 0
            ? { problem: `Adept Runtime ${runtimeVersion} is older than the tested ${MIN_ADEPT_RUNTIME}.x.` }
            : {};
    return {
        djtgcfg,
        djtgcfgVersion,
        ...(utilitiesVersion ? { utilitiesVersion } : {}),
        ...withRuntime,
        usable: true,
        rawVersion: raw,
        ...caveat,
    };
}

/** One-line description for doctor / availability. */
export function describeAdept(a: AdeptEnvironment): string {
    if (!a.usable) return a.problem ?? 'unavailable';
    const parts = [
        `djtgcfg ${a.djtgcfgVersion}${a.utilitiesVersion ? ` (Adept Utilities ${a.utilitiesVersion})` : ''}`,
        a.runtimeVersion ? `Adept Runtime ${a.runtimeVersion}` : 'Adept Runtime version unknown',
        `at ${a.djtgcfg!.path} [${a.djtgcfg!.method}]`,
    ];
    return parts.join(', ') + (a.problem ? ` — ${a.problem}` : '');
}
