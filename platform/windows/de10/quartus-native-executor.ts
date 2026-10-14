import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { QuartusExecutor, QuartusJob, QuartusStep } from '../../../core/implementation/quartus/provider';
import type { ToolRunResult } from '../../../core/process/tool-runner';
import { errorDiag, type Diagnostic } from '../../../core/results/diagnostic';
import type { WindowsDe10Paths } from './config';
import type { NativeQuartusEngine } from './native-quartus-engine';

/** A ceiling per tool, so a hung Quartus cannot hold a build forever. */
const STEP_TIMEOUT_MS = 30 * 60_000;

/**
 * Runs the Quartus command-line tools natively. The host's staged job folder IS the working tree (there is no
 * VM to copy into), so `install` has nothing to move and `collect` only checks that `output_files` exists.
 */
export class NativeQuartusExecutor implements QuartusExecutor {
    constructor(
        private readonly paths: WindowsDe10Paths,
        readonly engine: NativeQuartusEngine,
    ) {}

    readonly programmingFormat = 'sof' as const;

    get jobsRoot(): string {
        return this.paths.jobsRoot;
    }

    async install(): Promise<readonly Diagnostic[]> {
        return [];
    }

    async run(job: QuartusJob, step: QuartusStep, top: string, io: { signal: AbortSignal; onOutput?: (text: string) => void }): Promise<ToolRunResult> {
        const i = await this.engine.install();
        if (!i) return { invocation: { executable: step.tool, args: [] }, outcome: 'spawn-failed', exitCode: null, stdout: '', stderr: '', durationMs: 0, errorMessage: 'Quartus is not installed' };
        return this.engine.run(i, step.tool, step.args(top), {
            cwd: step.inOutputDir ? join(job.hostDir, 'output_files') : job.hostDir,
            signal: io.signal,
            timeoutMs: STEP_TIMEOUT_MS,
            ...(io.onOutput ? { onOutput: io.onOutput } : {}),
        });
    }

    async collect(job: QuartusJob): Promise<Diagnostic | undefined> {
        const ok = await stat(join(job.hostDir, 'output_files')).then((s) => s.isDirectory(), () => false);
        return ok ? undefined : errorDiag('implementation', 'COLLECT_FAILED', 'Quartus produced no output_files folder.');
    }

    async killTools(): Promise<void> {
        /* the runner terminates the whole process tree of an aborted step; nothing else of ours is left running */
    }
}
