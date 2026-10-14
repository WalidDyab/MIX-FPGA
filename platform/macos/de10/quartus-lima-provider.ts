import { join } from 'node:path';
import { QuartusImplementationProvider, type QuartusExecutor, type QuartusJob, type QuartusStep } from '../../../core/implementation/quartus/provider';
import type { ConstraintProvider } from '../../../core/backend/types';
import type { ToolRunResult } from '../../../core/process/tool-runner';
import { errorDiag, type Diagnostic } from '../../../core/results/diagnostic';
import type { De10Paths } from './config';
import type { LimaEngine } from './engine';

// The platform-neutral engine moved to core/implementation/quartus/provider.ts; these names stay importable from here.
export { BUILD_INFO, QUARTUS_STEPS, inferTop, jobId } from '../../../core/implementation/quartus/provider';
export type { QuartusStep } from '../../../core/implementation/quartus/provider';

const E = (code: string, msg: string): Diagnostic => errorDiag('implementation', code, msg);

/**
 * Runs Quartus inside the hidden Lima VM (x86-64 Quartus under Rosetta). The host stages each job in the
 * shared folder; the executor copies it onto the VM's own disk, proves every byte arrived, runs the chain there
 * and copies `output_files` back.
 */
export class LimaQuartusExecutor implements QuartusExecutor {
    constructor(
        private readonly paths: De10Paths,
        readonly engine: LimaEngine,
    ) {}

    readonly programmingFormat = 'svf' as const;

    get jobsRoot(): string {
        return join(this.paths.shareDir, 'jobs');
    }

    private guestJob(job: QuartusJob): string {
        return `${this.paths.guestShareDir}/jobs/${job.unique}`;
    }

    private work(job: QuartusJob): string {
        return `"$HOME/.mixfpga-work/${job.id}"`;
    }

    async install(job: QuartusJob, signal: AbortSignal): Promise<readonly Diagnostic[]> {
        const work = this.work(job);
        // Copy into the VM's own disk and prove, inside the VM, that every byte arrived.
        const copy = `for i in 1 2 3 4 5; do rm -rf ${work}; mkdir -p ${work}; cp -a '${this.guestJob(job)}/.' ${work}/; if (cd ${work} && sha256sum -c --quiet MANIFEST.sha256 >/dev/null 2>&1); then echo STAGE_OK_$i; exit 0; fi; sleep 1; done; echo STAGE_VERIFY_FAILED; exit 1`;
        const cpIn = await this.engine.guest(copy, { signal, timeoutMs: 90_000 });
        if (cpIn.outcome === 'cancelled') return [];
        const tries = /STAGE_OK_(\d)/.exec(cpIn.stdout)?.[1];
        if (cpIn.exitCode !== 0 || !tries) return [E('STAGE_COPY_FAILED', `The project could not be copied intact into the engine: ${(cpIn.stdout + cpIn.stderr).trim().slice(-160)}`)];
        if (tries !== '1') return [{ severity: 'warning', source: 'implementation', code: 'STAGE_COPY_RETRIED', message: `Staging needed ${tries} attempts before the engine saw the files intact.` }];
        return [];
    }

    run(job: QuartusJob, step: QuartusStep, top: string, io: { signal: AbortSignal; onOutput?: (text: string) => void }): Promise<ToolRunResult> {
        const work = this.work(job);
        const command = `mixfpga-q ${step.tool} ${step.args(top).join(' ')}`;
        const script = step.inOutputDir ? `cd ${work}/output_files && ${command}` : `cd ${work} && ${command}`;
        return this.engine.guest(script, { signal: io.signal, ...(io.onOutput ? { onOutput: io.onOutput } : {}) });
    }

    async collect(job: QuartusJob): Promise<Diagnostic | undefined> {
        const g = this.guestJob(job);
        const back = await this.engine.guest(`rm -rf '${g}/output_files' && cp -a ${this.work(job)}/output_files '${g}/output_files'`, { timeoutMs: 60_000 });
        return back.exitCode !== 0 ? E('COLLECT_FAILED', `Copying results out of the engine failed: ${back.stderr.trim().slice(0, 160)}`) : undefined;
    }

    killTools(): Promise<void> {
        return this.engine.killQuartus();
    }
}

export class QuartusLimaImplementationProvider extends QuartusImplementationProvider {
    constructor(paths: De10Paths, engine: LimaEngine, constraints?: ConstraintProvider) {
        super(new LimaQuartusExecutor(paths, engine), constraints);
    }
}
