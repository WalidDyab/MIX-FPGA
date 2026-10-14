import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineProvider, EngineState, EngineStatus } from '../../../core/backend/types';
import type { ToolRunResult, ToolRunner } from '../../../core/process/tool-runner';
import { errorDiag, type Diagnostic } from '../../../core/results/diagnostic';
import { WINDOWS_PINNED, type WindowsDe10Paths, type WindowsDe10Versions } from './config';
import { findOtherQuartus, findQuartus, quartusEnv, quartusTool, type QuartusInstall } from './quartus-install';

const diag = (code: string, message: string): Diagnostic => errorDiag('toolchain', code, message);

export type ProbeKind = 'ok' | 'wrong-version' | 'missing' | 'other';

export interface Probe {
    readonly kind: ProbeKind;
    readonly version?: string;
    readonly detail: string;
}

/** Classifies the output of `quartus_sh --version`. Windows prints a `TBBmalloc` notice on stderr; it is ignored. */
export function classifyProbe(run: ToolRunResult, banner: string): Probe {
    const text = `${run.stdout}\n${run.stderr}`;
    if (run.outcome === 'spawn-failed') return { kind: 'missing', detail: run.errorMessage ?? 'quartus_sh could not start' };
    if (run.outcome === 'exited' && run.exitCode === 0) {
        const v = /Version (\S+ Build \d+)/.exec(text)?.[0];
        return text.includes(banner)
            ? { kind: 'ok', ...(v ? { version: v } : {}), detail: 'Quartus answered' }
            : { kind: 'wrong-version', ...(v ? { version: v } : {}), detail: `${v ?? 'An unknown Quartus version'} is installed; MIX-FPGA needs Quartus Prime Lite ${banner.replace('std.0', '')}.` };
    }
    return { kind: 'other', detail: `exit ${run.exitCode ?? run.outcome}: ${text.trim().slice(0, 160)}` };
}

export type PartCheck = 'ok' | 'max10-missing' | 'part-missing' | 'failed' | 'unexpected';

/**
 * The Tcl Quartus runs to answer "is the MAX 10 package installed, and is this exact part available?". It asks
 * Quartus's own device database; the install's folder layout is never the source of truth.
 */
export function partCheckTcl(part: string): string {
    return [
        'load_package device',
        'set l [get_part_list -family {MAX 10}]',
        `puts "MIXFPGA_PARTS count=[llength $l] target=[expr {[lsearch -exact $l ${part}] >= 0}]"`,
        '',
    ].join('\n');
}

/** Classifies the output of the part-list query. Only the marker line counts; Quartus's chatter is ignored. */
export function classifyPartCheck(run: ToolRunResult): { kind: PartCheck; count?: number } {
    if (run.outcome !== 'exited' || run.exitCode !== 0) return { kind: 'failed' };
    const m = /MIXFPGA_PARTS count=(\d+) target=([01])/.exec(`${run.stdout}\n${run.stderr}`);
    if (!m) return { kind: 'unexpected' };
    const count = Number(m[1]);
    if (count === 0) return { kind: 'max10-missing', count };
    return m[2] === '1' ? { kind: 'ok', count } : { kind: 'part-missing', count };
}

const codeOf = (k: ProbeKind): string => (k === 'missing' ? 'QUARTUS_MISSING' : k === 'wrong-version' ? 'QUARTUS_WRONG_VERSION' : 'QUARTUS_PROBE_FAILED');

/**
 * The "engine" behind the DE10-Lite on Windows is simply the native Quartus install: there is nothing to
 * start, so `ensureReady` only proves the right Quartus and the MAX 10 package are present. The student sees
 * the same row as on macOS (FPGA Engine: Ready) without any virtual machine.
 */
export class NativeQuartusEngine implements EngineProvider {
    readonly id = 'native-quartus';

    constructor(
        private readonly paths: WindowsDe10Paths,
        private readonly runner: ToolRunner,
        private readonly versions: WindowsDe10Versions = WINDOWS_PINNED,
    ) {}

    /** The pinned Quartus install, if one is present. */
    install(): Promise<QuartusInstall | undefined> {
        return findQuartus(this.paths.quartusCandidates);
    }

    /** Runs one Quartus tool by full path with the install's own environment. */
    run(i: QuartusInstall, tool: string, args: string[], extra: { cwd?: string; signal?: AbortSignal; onOutput?: (t: string) => void; timeoutMs?: number } = {}): Promise<ToolRunResult> {
        return this.runner.run({
            executable: quartusTool(i, tool),
            args,
            env: quartusEnv(i),
            ...(extra.cwd ? { cwd: extra.cwd } : {}),
            ...(extra.signal ? { signal: extra.signal } : {}),
            ...(extra.onOutput ? { onOutput: extra.onOutput } : {}),
            ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
        });
    }

    async probe(i: QuartusInstall, signal?: AbortSignal): Promise<Probe> {
        return classifyProbe(await this.run(i, 'quartus_sh', ['--version'], { ...(signal ? { signal } : {}), timeoutMs: 120_000 }), this.versions.quartusBanner);
    }

    private async notInstalled(): Promise<EngineStatus> {
        const others = await findOtherQuartus(this.paths.quartusCandidates);
        const note = others.length > 0 ? ` (${others.map((o) => o.root).join(', ')} is a different version, which MIX-FPGA does not use)` : '';
        return { state: 'not-installed', problems: [diag('ENGINE_NOT_INSTALLED', `Quartus Prime Lite ${this.versions.quartusBanner.replace('std.0', '')} is not installed on this computer${note}.`)] };
    }

    /** Asks Quartus whether the MAX 10 package is installed and the exact target part is available. */
    async checkPart(i: QuartusInstall, signal?: AbortSignal): Promise<{ kind: PartCheck; count?: number }> {
        // A script file, not --tcl_eval: --tcl_eval evaluates its arguments one command at a time and cannot carry a multi-statement script.
        const script = join(this.paths.stateDir, 'part-check.tcl');
        try {
            await mkdir(this.paths.stateDir, { recursive: true });
            await writeFile(script, partCheckTcl(this.versions.targetPart));
        } catch {
            return { kind: 'failed' };
        }
        return classifyPartCheck(await this.run(i, 'quartus_sh', ['-t', script], { ...(signal ? { signal } : {}), timeoutMs: 120_000 }));
    }

    /** Problems found by the part check, as student-facing diagnostics (empty when the part is available). */
    private partProblems(k: PartCheck): Diagnostic[] {
        const part = this.versions.targetPart;
        switch (k) {
            case 'ok':
                return [];
            case 'max10-missing':
                return [diag('MAX10_MISSING', 'The MAX 10 device package is not installed in Quartus; the DE10-Lite cannot be built.')];
            case 'part-missing':
                return [diag('TARGET_PART_MISSING', `Quartus does not list the DE10-Lite's FPGA (${part}); its MAX 10 device package is incomplete or the wrong version.`)];
            case 'failed':
                return [diag('PART_CHECK_FAILED', 'Quartus could not be asked which devices it supports (the command failed).')];
            case 'unexpected':
                return [diag('PART_CHECK_UNEXPECTED', 'Quartus answered the device-support check in a way MIX-FPGA does not understand.')];
        }
    }

    /** Proves Quartus answers with the pinned version and the exact MAX 10 part is available. */
    async status(signal?: AbortSignal): Promise<EngineStatus> {
        const i = await this.install();
        if (!i) return this.notInstalled();
        const p = await this.probe(i, signal);
        const tv = p.version ? { toolVersion: p.version } : {};
        if (p.kind !== 'ok') return { state: 'unhealthy', ...tv, problems: [diag(codeOf(p.kind), p.detail)] };
        const part = this.partProblems((await this.checkPart(i, signal)).kind);
        if (part.length > 0) return { state: 'unhealthy', ...tv, problems: part };
        const state: EngineState = 'running';
        return { state, ...tv, problems: [] };
    }

    /** Nothing to start: re-checks Quartus. */
    ensureReady(signal?: AbortSignal): Promise<EngineStatus> {
        return this.status(signal);
    }

    async shutdown(): Promise<void> {
        /* no engine process: Quartus runs only while a build runs, and an aborted build is stopped with its process tree */
    }

    restart(signal?: AbortSignal): Promise<EngineStatus> {
        return this.ensureReady(signal);
    }
}
