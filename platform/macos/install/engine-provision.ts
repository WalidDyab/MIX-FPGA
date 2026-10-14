import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComponentDefinition, SetupStepResult } from '../../../core/install/model';
import type { ToolInvocation, ToolRunResult, ToolRunner } from '../../../core/process/tool-runner';
import { writeFileAtomic } from '../../../core/util/atomic-write';
import { LimaEngine } from '../de10/engine';
import { compareInstanceConfig, ENGINE_SPEC, EXPECTED_STORAGE, type LimaInstanceJson, renderEngineTemplate } from './engine-config';
import type { Downloader } from './download';
import { checkLimaSocketLength, LIMA_INSTANCE, type RuntimeLayout } from './layout';
import { installedDe10Paths } from './paths';

export const VM_TEMPLATE = 'mix-fpga-de10.yaml';
const GUEST_SCRIPTS = ['provision-guest.sh', 'provision-quartus-env.sh'] as const;

/** What survives between runs, so creation can resume. Facts only: readiness is always re-derived from Lima. */
export interface LinuxVmRecord {
    readonly schemaVersion: 1;
    readonly createdAt?: string;
    readonly guestPackagesAt?: string;
    readonly wrapperAt?: string;
    readonly verifiedAt?: string;
    /** Quartus was installed into this VM: it is never deleted automatically. */
    readonly quartusInstalledAt?: string;
    /** Adopted from an existing, verified engine that already held Quartus: never deleted automatically either. */
    readonly quartusPresent?: boolean;
    readonly adoptedAt?: string;
}

export interface EngineDeps {
    readonly layout: RuntimeLayout;
    readonly runner: ToolRunner;
    readonly downloader: Downloader;
    readonly freeBytes: (path: string) => Promise<number>;
}

const OK = (r: ToolRunResult): boolean => r.outcome === 'exited' && r.exitCode === 0;
const fail = (code: string, message: string): SetupStepResult => ({ ok: false, code, message });
const tail = (r: ToolRunResult): string => `${r.stderr || r.stdout}`.trim().split('\n').slice(-2).join(' ').slice(0, 200);
const gb = (n: number): string => `${(n / 1e9).toFixed(1)} GB`;

/** Reads and writes `state/linux-vm.json` beside the rest of the install state. */
export class LinuxVmRecordStore {
    constructor(private readonly file: string) {}
    async read(): Promise<LinuxVmRecord> {
        try {
            const r = JSON.parse(await readFile(this.file, 'utf8')) as LinuxVmRecord;
            return r.schemaVersion === 1 ? r : { schemaVersion: 1 };
        } catch {
            return { schemaVersion: 1 };
        }
    }
    async merge(patch: Partial<LinuxVmRecord>): Promise<void> {
        await mkdir(join(this.file, '..'), { recursive: true });
        await writeFileAtomic(this.file, `${JSON.stringify({ ...(await this.read()), ...patch }, null, 2)}\n`);
    }
}

/**
 * Creates, repairs and checks the hidden Linux engine. `inspect` only reads (`limactl list`); it never starts the
 * VM or runs anything inside it. `provision` starts it only while setting it up and stops it again.
 */
export class EngineProvisioner {
    private readonly paths;
    private readonly engine;
    readonly record;

    constructor(private readonly deps: EngineDeps) {
        this.paths = installedDe10Paths(deps.layout);
        this.engine = new LimaEngine(this.paths, deps.runner);
        this.record = new LinuxVmRecordStore(join(deps.layout.stateDir, 'linux-vm.json'));
    }

    private lima(args: string[], signal?: AbortSignal, timeoutMs = 60_000): Promise<ToolRunResult> {
        const inv: ToolInvocation = { executable: this.paths.limactl, args, env: { LIMA_HOME: this.paths.limaHome }, timeoutMs, ...(signal ? { signal } : {}) };
        return this.deps.runner.run(inv);
    }

    private async list(): Promise<{ kind: 'missing' } | { kind: 'found'; json: LimaInstanceJson } | { kind: 'unreadable'; detail: string }> {
        const r = await this.lima(['list', '--json', LIMA_INSTANCE], undefined, 30_000);
        if (r.outcome === 'spawn-failed') return { kind: 'unreadable', detail: 'Lima is not installed' };
        const line = r.stdout.split('\n').find((l) => l.trim().startsWith('{'));
        if (!line) return { kind: 'missing' };
        try {
            return { kind: 'found', json: JSON.parse(line) as LimaInstanceJson };
        } catch {
            return { kind: 'unreadable', detail: 'Lima answered something unreadable' };
        }
    }

    // ------------------------------------------------------------------ inspect (read-only)

    definition(): ComponentDefinition {
        return {
            id: 'linux-vm',
            label: 'Linux VM',
            inspect: async () => {
                if (!(await stat(this.paths.limactl).then((s) => s.isFile(), () => false))) return { state: 'not-installed', ownership: 'managed', code: 'LIMA_MISSING', detail: 'Lima is not installed yet' };
                const l = await this.list();
                if (l.kind === 'unreadable') return { state: 'repairable', ownership: 'managed', code: 'LIMA_UNREADABLE', detail: l.detail };
                if (l.kind === 'missing') {
                    const leftover = await stat(this.deps.layout.instanceDir).then((s) => s.isDirectory(), () => false);
                    return leftover ? { state: 'repairable', ownership: 'managed', code: 'INCOMPLETE_INSTANCE', detail: 'a previous creation did not finish' } : { state: 'not-installed', ownership: 'managed' };
                }
                if (l.json.status === 'Broken' || (l.json.errors?.length ?? 0) > 0) return { state: 'repairable', ownership: 'managed', code: 'BROKEN_INSTANCE', detail: `Lima reports the engine as ${l.json.status ?? 'broken'}` };
                const diffs = compareInstanceConfig(l.json, this.deps.layout.shareDir);
                const critical = diffs.filter((d) => d.severity === 'critical');
                if (critical.length > 0) return { state: 'incompatible', ownership: 'managed', code: 'ENGINE_CONFIG_DIFFERS', detail: `an engine named ${LIMA_INSTANCE} exists with a different configuration (${critical.map((d) => d.field).join(', ')}); MIX-FPGA will not modify it` };
                if (diffs.length > 0) return { state: 'repairable', ownership: 'managed', code: 'CONFIG_DRIFT', detail: `engine settings differ (${diffs.map((d) => d.field).join(', ')})` };
                const rec = await this.record.read();
                if (!rec.verifiedAt) return { state: 'repairable', ownership: 'managed', code: rec.createdAt ? 'GUEST_NOT_PROVISIONED' : 'GUEST_UNVERIFIED', detail: 'the engine exists but its Linux setup has not been verified' };
                return { state: 'ready', ownership: 'managed', version: `Lima ${ENGINE_SPEC.lima}` };
            },
            install: { requires: ['toolchain', 'rosetta'], userInput: 'none', run: (request) => this.provision(request) },
        };
    }

    // ------------------------------------------------------------------ provision (may start the VM, stops it again)

    private async provision(request: { signal?: AbortSignal; progress: (p: { message: string; fraction?: number }) => void }): Promise<SetupStepResult> {
        const { layout } = this.deps;
        const signal = request.signal;
        const say = (message: string, fraction?: number) => request.progress({ message, ...(fraction !== undefined ? { fraction } : {}) });

        const socket = checkLimaSocketLength(layout);
        if (!socket.ok) return fail('LIMA_SOCKET_PATH_TOO_LONG', `The folder name of this Mac's user account makes the engine's connection paths ${socket.over} characters too long for macOS. MIX-FPGA cannot set up the engine under this account yet.`);

        let l = await this.list();
        if (l.kind === 'unreadable') return fail('LIMA_UNREADABLE', l.detail);
        const rec0 = await this.record.read();

        if (l.kind === 'missing' || (l.kind === 'found' && (l.json.status === 'Broken' || (l.json.errors?.length ?? 0) > 0))) {
            const free = await this.deps.freeBytes(layout.root);
            const need = EXPECTED_STORAGE.requiredFreeGB * 1e9;
            if (free < need) return fail('INSUFFICIENT_DISK', `Setting up the FPGA engine needs about ${gb(need)} free (it uses about ${EXPECTED_STORAGE.vmAfterQuartusGB} GB once Quartus is installed); only ${gb(free)} is available.`);
        }

        // 1. The Ubuntu image: a verified download, cached, resumable.
        if (l.kind === 'missing' || l.kind === 'found' && l.json.status === 'Broken') {
            say('Downloading the engine image…', 0);
            const image = join(layout.downloadsDir, ENGINE_SPEC.image.fileName);
            const d = await this.deps.downloader({ url: ENGINE_SPEC.image.url, dest: image, sha256: ENGINE_SPEC.image.sha256, bytes: ENGINE_SPEC.image.bytes, ...(signal ? { signal } : {}), onProgress: (done, total) => say('Downloading the engine image…', total ? done / total : undefined) });
            if (!d.ok) return fail(d.code === 'NETWORK' ? 'IMAGE_DOWNLOAD_FAILED' : d.code === 'CANCELLED' ? 'CANCELLED' : `IMAGE_${d.code}`, d.message);

            // 2. Create (a broken, empty engine of ours is replaced; one that ever held Quartus is never deleted automatically).
            if (l.kind === 'found') {
                if (rec0.quartusInstalledAt || rec0.quartusPresent) return fail('RECREATE_NEEDS_CONFIRMATION', 'The FPGA engine is damaged and contains Quartus. MIX-FPGA will not delete it without the student\'s confirmation.');
                say('Removing the unfinished FPGA engine…');
                const del = await this.lima(['delete', '--force', LIMA_INSTANCE], signal, 120_000);
                if (!OK(del)) return fail('ENGINE_DELETE_FAILED', `The unfinished engine could not be removed: ${tail(del)}`);
            }
            say('Creating the FPGA engine…');
            const template = await readFile(join(layout.unit('engine'), VM_TEMPLATE), 'utf8');
            const yaml = renderEngineTemplate(template, { imageLocation: image, shareDir: layout.shareDir });
            await mkdir(layout.stateDir, { recursive: true });
            await mkdir(layout.shareDir, { recursive: true });
            const yamlFile = join(layout.stateDir, 'engine.yaml');
            await writeFile(yamlFile, yaml);
            const created = await this.lima(['create', '--name', LIMA_INSTANCE, '--tty=false', yamlFile], signal, 600_000);
            if (signal?.aborted) return fail('CANCELLED', 'Installation was cancelled.');
            if (!OK(created)) return fail('ENGINE_CREATE_FAILED', `The FPGA engine could not be created: ${tail(created)}`);
            await this.record.merge({ createdAt: new Date().toISOString() });
            l = await this.list();
            if (l.kind !== 'found') return fail('ENGINE_CREATE_FAILED', 'The FPGA engine was created but Lima does not list it.');
        } else if (l.kind === 'found') {
            const diffs = compareInstanceConfig(l.json, layout.shareDir);
            if (diffs.some((x) => x.severity === 'critical')) return fail('ENGINE_CONFIG_DIFFERS', `An engine named ${LIMA_INSTANCE} exists with a different configuration; MIX-FPGA will not modify it.`);
            if (diffs.length > 0) {
                say('Adjusting the FPGA engine settings…');
                if (l.json.status === 'Running') await this.lima(['stop', LIMA_INSTANCE], signal, 120_000);
                const edit = await this.lima(['edit', LIMA_INSTANCE, '--tty=false', '--cpus', String(ENGINE_SPEC.cpus), '--memory', '8', '--disk', '60'], signal, 120_000);
                if (!OK(edit)) return fail('ENGINE_EDIT_FAILED', `The engine settings could not be adjusted: ${tail(edit)}`);
            }
        }

        // 3. Start (only for setup), 4. Linux packages and the Quartus wrapper, 5. verify.
        const wasRunning = l.kind === 'found' && l.json.status === 'Running';
        if (!wasRunning) {
            say('Starting the FPGA engine…');
            const start = await this.lima(['start', LIMA_INSTANCE, '--tty=false'], signal, 300_000);
            if (signal?.aborted) return fail('CANCELLED', 'Installation was cancelled.');
            if (!OK(start)) return fail('ENGINE_START_FAILED', `The FPGA engine did not start: ${tail(start)}`);
        }
        const done = await this.setUpGuest(signal, say);
        if (!wasRunning) await this.lima(['stop', LIMA_INSTANCE], undefined, 120_000);
        return done;
    }

    private async setUpGuest(signal: AbortSignal | undefined, say: (m: string, f?: number) => void): Promise<SetupStepResult> {
        const { layout } = this.deps;
        const dir = join(layout.shareDir, 'provision');
        await mkdir(dir, { recursive: true });
        for (const f of GUEST_SCRIPTS) await copyFile(join(layout.unit('engine'), f), join(dir, f));
        const guest = (script: string, timeoutMs: number) => this.engine.guest(script, { ...(signal ? { signal } : {}), timeoutMs });

        say('Preparing the FPGA engine…');
        const pk = await guest(`sudo -n bash ${this.paths.guestShareDir}/provision/provision-guest.sh`, 1_500_000);
        if (signal?.aborted) return fail('CANCELLED', 'Installation was cancelled.');
        if (!OK(pk)) {
            const text = `${pk.stdout}\n${pk.stderr}`;
            return /Could not resolve|Temporary failure|Failed to fetch|Unable to locate|Connection (?:timed out|failed)/i.test(text)
                ? fail('GUEST_NETWORK', 'The FPGA engine needs an internet connection once, to fetch its Linux libraries. Connect and try again; setup continues where it stopped.')
                : fail('GUEST_PROVISION_FAILED', `The Linux libraries could not be installed: ${tail(pk)}`);
        }
        await this.record.merge({ guestPackagesAt: new Date().toISOString() });

        const w = await guest(`sudo -n bash ${this.paths.guestShareDir}/provision/provision-quartus-env.sh`, 180_000);
        if (!OK(w)) return fail('GUEST_WRAPPER_FAILED', `The Quartus compatibility layer could not be installed: ${tail(w)}`);
        await this.record.merge({ wrapperAt: new Date().toISOString() });

        say('Verifying the FPGA engine…');
        const v = await guest('test -x /usr/local/bin/mixfpga-q && ! test -S /run/rosettad/rosetta.sock && test -e /proc/sys/fs/binfmt_misc/rosetta && echo MIXFPGA_GUEST_OK', 60_000);
        if (!OK(v) || !v.stdout.includes('MIXFPGA_GUEST_OK')) return fail('GUEST_VERIFY_FAILED', 'The FPGA engine was set up but did not pass its check (Rosetta translation or the Quartus layer is missing).');
        await this.record.merge({ verifiedAt: new Date().toISOString() });
        return { ok: true };
    }
}
