import { homedir } from 'node:os';
import { join } from 'node:path';
import { DE10_LITE_PROFILE } from '../../../core/backend/profiles';
import type { BoardProfile, BuildRequest, EngineStatus, HardwareDetection, NormalizedBuildResult, ProgramOutcome, ProgrammingArtifactRef } from '../../../core/backend/types';
import { describeEnvironment, type EnvironmentSummary } from '../../../core/backend/environment';
import { NodeToolRunner, type ToolRunner } from '../../../core/process/tool-runner';
import type { De10Paths } from './config';
import { resolveRuntimeLayout } from '../install/layout';
import { installedDe10Paths } from '../install/paths';
import { LimaEngine } from './engine';
import { NativeJtagProgrammer } from './ofl-programmer';
import { QuartusLimaImplementationProvider } from './quartus-lima-provider';

export interface De10BackendOptions {
    readonly repoRoot: string;
    readonly home?: string;
    readonly runner?: ToolRunner;
    readonly paths?: De10Paths;
    readonly board?: BoardProfile;
}

/** The surface the VS Code extension will call for a DE10-Lite on macOS. No UI, no infrastructure leakage. */
export class De10LiteBackend {
    readonly paths: De10Paths;
    readonly board: BoardProfile;
    readonly engine: LimaEngine;
    readonly implementation: QuartusLimaImplementationProvider;
    readonly programmer: NativeJtagProgrammer;

    constructor(opts: De10BackendOptions) {
        const runner = opts.runner ?? new NodeToolRunner();
        this.paths = opts.paths ?? installedDe10Paths(resolveRuntimeLayout({ ...(opts.home ? { home: opts.home } : {}) }));
        this.board = opts.board ?? DE10_LITE_PROFILE;
        this.engine = new LimaEngine(this.paths, runner);
        this.implementation = new QuartusLimaImplementationProvider(this.paths, this.engine);
        this.programmer = new NativeJtagProgrammer(this.paths, runner);
    }

    status(): Promise<EngineStatus> {
        return this.engine.status();
    }

    ensureReady(signal?: AbortSignal): Promise<EngineStatus> {
        return this.engine.ensureReady(signal);
    }

    build(projectDir: string, opts: Omit<BuildRequest, 'projectDir' | 'board'> = {}): Promise<NormalizedBuildResult> {
        return this.implementation.build({ ...opts, projectDir, board: this.board });
    }

    cancelBuild(): Promise<void> {
        return this.implementation.cancel();
    }

    detectHardware(signal?: AbortSignal): Promise<HardwareDetection> {
        return this.programmer.detect(this.board, signal);
    }

    program(artifact: ProgrammingArtifactRef, opts: { signal?: AbortSignal; onOutput?: (t: string) => void } = {}): Promise<ProgramOutcome> {
        return this.programmer.program({ artifact, board: this.board, ...opts });
    }

    restartImplementationEngine(signal?: AbortSignal): Promise<EngineStatus> {
        return this.engine.restart(signal);
    }

    shutdownImplementationEngine(): Promise<void> {
        return this.engine.shutdown();
    }

    /** Student-facing environment table (Details lists the real tools). */
    async environment(vhdlReady: boolean): Promise<EnvironmentSummary> {
        const [engine, prog] = await Promise.all([this.engine.status(), this.programmer.availability()]);
        return describeEnvironment({
            board: this.board,
            vhdlReady,
            engine,
            programmerAvailable: prog.available,
            details: [
                { label: 'Implementation tool', value: engine.toolVersion ? `Quartus Prime Lite ${engine.toolVersion}` : 'Quartus Prime Lite (not answering)' },
                { label: 'Engine', value: `Lima VM ${this.paths.instance} (Linux, Rosetta)` },
                { label: 'Programmer', value: prog.detail },
            ],
        });
    }
}

export const defaultStagingDir = (home = homedir()): string => join(home, 'Library', 'MIX-FPGA', 'staging');
