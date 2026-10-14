import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic } from '../../../core/results/diagnostic';
import type { ToolRunResult, ToolRunner } from '../../../core/process/tool-runner';
import type { EngineProvider, EngineState, EngineStatus } from '../../../core/backend/types';
import { PINNED, type De10Paths, type De10Versions } from './config';

const diag = (severity: Diagnostic['severity'], code: string, message: string): Diagnostic => ({ severity, source: 'toolchain', code, message });

export type ProbeKind = 'ok' | 'sigbus' | 'missing' | 'other';

export interface Probe {
    readonly kind: ProbeKind;
    readonly version?: string;
    readonly detail: string;
}

/** Classifies the output of `mixfpga-q quartus_sh --version`. */
export function classifyProbe(run: ToolRunResult, banner: string): Probe {
    const text = `${run.stdout}\n${run.stderr}`;
    if (run.outcome === 'exited' && run.exitCode === 0) {
        const v = /Version (\S+ Build \d+)/.exec(text)?.[0];
        return text.includes(banner) ? { kind: 'ok', ...(v ? { version: v } : {}), detail: 'Quartus answered' } : { kind: 'other', detail: `unexpected Quartus version: ${v ?? text.trim().slice(0, 120)}` };
    }
    if (run.exitCode === 135 || /Bus error|SIGBUS/i.test(text)) return { kind: 'sigbus', detail: 'Quartus died with a bus error' };
    if (run.exitCode === 127 || /not found|No such file/i.test(text)) return { kind: 'missing', detail: text.trim().slice(0, 160) };
    return { kind: 'other', detail: `exit ${run.exitCode ?? run.outcome}: ${text.trim().slice(0, 160)}` };
}

/**
 * The hidden Linux VM that runs Quartus under Rosetta (Lima instance `mix-fpga-de10`).
 * All VM interaction goes through the injected ToolRunner, so every branch is unit-testable.
 */
export class LimaEngine implements EngineProvider {
    readonly id = 'lima-quartus';

    constructor(
        private readonly paths: De10Paths,
        private readonly runner: ToolRunner,
        private readonly versions: De10Versions = PINNED,
    ) {}

    /** Run one command inside the VM through `bash -c`. */
    guest(script: string, extra: { signal?: AbortSignal; onOutput?: (t: string) => void; timeoutMs?: number } = {}): Promise<ToolRunResult> {
        return this.runner.run({
            executable: this.paths.limactl,
            args: ['shell', '--workdir', '/tmp', this.paths.instance, 'bash', '-c', script],
            env: { LIMA_HOME: this.paths.limaHome },
            ...(extra.signal ? { signal: extra.signal } : {}),
            ...(extra.onOutput ? { onOutput: extra.onOutput } : {}),
            ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
        });
    }

    private lima(args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<ToolRunResult> {
        return this.runner.run({ executable: this.paths.limactl, args, env: { LIMA_HOME: this.paths.limaHome }, ...(signal ? { signal } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    }

    /** VM lifecycle state as Lima reports it. */
    async vmState(): Promise<'not-installed' | 'stopped' | 'running' | 'starting' | 'error'> {
        const r = await this.lima(['list', '--format', '{{.Status}}', this.paths.instance], undefined, 30_000);
        if (r.outcome === 'spawn-failed') return 'not-installed';
        const out = r.stdout.trim();
        if (r.exitCode !== 0 || out === '') return 'not-installed';
        if (out === 'Running') return 'running';
        if (out === 'Stopped') return 'stopped';
        if (out === 'Starting') return 'starting';
        return 'error';
    }

    async probe(signal?: AbortSignal): Promise<Probe> {
        return classifyProbe(await this.guest('mixfpga-q quartus_sh --version', { ...(signal ? { signal } : {}), timeoutMs: 120_000 }), this.versions.quartusBanner);
    }

    /** True while Lima's `rosettad` AOT daemon serves its socket (the state in which Quartus dies with SIGBUS). */
    async rosettadSocketActive(signal?: AbortSignal): Promise<boolean> {
        const r = await this.guest('test -S /run/rosettad/rosetta.sock && echo ROSETTAD_SOCKET_ACTIVE || echo ROSETTAD_SOCKET_ABSENT', { ...(signal ? { signal } : {}), timeoutMs: 30_000 });
        return r.stdout.includes('ROSETTAD_SOCKET_ACTIVE');
    }

    /** Re-runs the idempotent provisioning script inside the VM (installs the rosettad drop-in and `mixfpga-q`). */
    async remediate(signal?: AbortSignal): Promise<boolean> {
        const dir = join(this.paths.shareDir, 'provision');
        await mkdir(dir, { recursive: true });
        await copyFile(this.paths.provisionScript, join(dir, 'provision-quartus-env.sh'));
        const r = await this.guest(`sudo -n bash ${this.paths.guestShareDir}/provision/provision-quartus-env.sh`, { ...(signal ? { signal } : {}), timeoutMs: 120_000 });
        return r.outcome === 'exited' && r.exitCode === 0;
    }

    async status(): Promise<EngineStatus> {
        const vm = await this.vmState();
        if (vm === 'not-installed') return { state: 'not-installed', problems: [diag('error', 'ENGINE_NOT_INSTALLED', `The implementation engine (Lima instance ${this.paths.instance}) is not installed.`)] };
        if (vm !== 'running') return { state: vm === 'error' ? 'unhealthy' : vm, problems: [] };
        const problems: Diagnostic[] = [];
        if (await this.rosettadSocketActive()) problems.push(diag('error', 'ROSETTAD_AOT_ACTIVE', 'Rosetta AOT caching is active; Quartus will crash until the engine is repaired.'));
        const p = await this.probe();
        if (p.kind !== 'ok') problems.push(diag('error', p.kind === 'sigbus' ? 'QUARTUS_SIGBUS' : p.kind === 'missing' ? 'QUARTUS_MISSING' : 'QUARTUS_PROBE_FAILED', p.detail));
        return { state: problems.some((d) => d.severity === 'error') ? 'unhealthy' : 'running', ...(p.version ? { toolVersion: p.version } : {}), problems };
    }

    /**
     * Start the VM if needed, then prove Quartus runs. Known failure modes are repaired once:
     * the Rosetta AOT daemon socket is removed before Quartus is probed, and a bus error triggers
     * the same repair followed by a second probe.
     */
    async ensureReady(signal?: AbortSignal): Promise<EngineStatus> {
        const fail = (state: EngineState, d: Diagnostic): EngineStatus => ({ state, problems: [d] });
        let vm = await this.vmState();
        if (vm === 'not-installed') return fail('not-installed', diag('error', 'ENGINE_NOT_INSTALLED', `The implementation engine (Lima instance ${this.paths.instance}) is not installed.`));
        if (vm !== 'running') {
            const s = await this.lima(['start', this.paths.instance, '--tty=false'], signal, 300_000);
            if (s.outcome === 'cancelled') return fail('stopped', diag('warning', 'ENGINE_START_CANCELLED', 'Starting the implementation engine was cancelled.'));
            vm = await this.vmState();
            if (s.exitCode !== 0 || vm !== 'running') return fail('stopped', diag('error', 'ENGINE_START_FAILED', `The implementation engine did not start (${s.outcome === 'exited' ? `exit ${s.exitCode}` : s.outcome}): ${(s.stderr || s.stdout).trim().split('\n').slice(-1)[0] ?? ''}`));
        }
        const notes: Diagnostic[] = [];
        if (await this.rosettadSocketActive(signal)) {
            if (!(await this.remediate(signal))) return fail('unhealthy', diag('error', 'ROSETTAD_REPAIR_FAILED', 'Rosetta AOT caching is active and the automatic repair failed.'));
            notes.push(diag('info', 'ROSETTAD_REPAIRED', 'Rosetta AOT caching was switched off (known Quartus crash cause).'));
        }
        let p = await this.probe(signal);
        if (p.kind === 'sigbus' || p.kind === 'missing') {
            if (await this.remediate(signal)) {
                notes.push(diag('info', 'ROSETTAD_REPAIRED', 'Rosetta AOT caching was switched off after a Quartus crash.'));
                p = await this.probe(signal);
            }
        }
        if (p.kind !== 'ok') {
            const code = p.kind === 'sigbus' ? 'QUARTUS_SIGBUS' : p.kind === 'missing' ? 'QUARTUS_MISSING' : 'QUARTUS_PROBE_FAILED';
            return { state: 'unhealthy', problems: [...notes, diag('error', code, p.detail)] };
        }
        return { state: 'running', ...(p.version ? { toolVersion: p.version } : {}), problems: notes };
    }

    async shutdown(): Promise<void> {
        await this.lima(['stop', this.paths.instance], undefined, 120_000);
    }

    async restart(signal?: AbortSignal): Promise<EngineStatus> {
        await this.shutdown();
        return this.ensureReady(signal);
    }

    /** Best-effort: stop Quartus processes left running in the VM after the host-side client was killed. */
    async killQuartus(): Promise<void> {
        await this.guest("pkill -u \"$(id -u)\" -f '/quartus/linux64/' || true", { timeoutMs: 30_000 });
    }
}
