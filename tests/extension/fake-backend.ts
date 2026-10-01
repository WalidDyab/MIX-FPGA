import {
    type BoardDetectionResult,
    type BoardRegistry,
    type BuildProgress,
    type BuildResult,
    loadProject,
    type Project,
    type ProgrammingResult,
    type ProjectLoadResult,
    type ProjectValidation,
    type RtlAnalysisResult,
    type SimulationResult,
    validateProject,
    type VhdlCheckResult,
} from '../../core';
import type { EnvironmentReport } from '../../runtime/environment';
import type { BitstreamInfo, NexysBackend } from '../../extension/services/backend';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoBoards } from '../helpers';
import { SYNTHETIC_NETLIST, syntheticVerilog } from './rtl-fixtures';

export const OK = { status: 'succeeded' as const, diagnostics: [], logs: [], durationMs: 5 };

/**
 * Scripted NexysBackend for service tests. Project loading/validation use
 * the real Phase 3 model; tool-backed operations return canned results and
 * record each call. Nothing here can start a process.
 */
export class FakeBackend implements NexysBackend {
    readonly calls: string[] = [];
    checkResult: VhdlCheckResult = { ...OK, elaborated: ['top'] };
    simResult: SimulationResult = { ...OK, testbench: 'top_tb', passed: true, stoppedAt: '280ns', messages: ['@280ns report note: ALL TESTS PASSED'] };
    buildProgress: BuildProgress[] = [];
    buildResult?: BuildResult;
    detection: BoardDetectionResult & { configured: boolean } = { configured: true, boards: [], diagnostics: [] };
    bit: BitstreamInfo | undefined;
    programResult: ProgrammingResult = { ...OK, destination: 'volatile' };
    /** Resolves when the current tool operation may finish (for observing running states). */
    gate?: Promise<void>;

    async boards(): Promise<BoardRegistry> {
        return repoBoards();
    }
    loadProject(root: string): Promise<ProjectLoadResult> {
        return loadProject(root);
    }
    async validate(project: Project): Promise<ProjectValidation> {
        return validateProject(project, await repoBoards());
    }
    async check(project: Project): Promise<VhdlCheckResult> {
        this.calls.push(`check:${project.config.top}`);
        await this.gate;
        return this.checkResult;
    }
    async simulate(_project: Project, testbench: string | undefined): Promise<SimulationResult> {
        this.calls.push(`simulate:${testbench}`);
        await this.gate;
        return { ...this.simResult, testbench: testbench ?? '' };
    }
    async build(_project: Project, onProgress: (p: BuildProgress) => void): Promise<BuildResult> {
        this.calls.push('build');
        for (const p of this.buildProgress) onProgress(p);
        await this.gate;
        return this.buildResult!;
    }
    /** When set, rtl() returns this instead of writing the synthetic netlist. */
    rtlResult: RtlAnalysisResult | undefined;
    /** Writes the synthetic netlist into <project>/.nexysvhdl/rtl, like the real provider would. */
    async rtl(project: Project): Promise<RtlAnalysisResult> {
        this.calls.push('rtl');
        await this.gate;
        if (this.rtlResult) return this.rtlResult;
        const dir = join(project.root, '.nexysvhdl', 'rtl');
        await mkdir(dir, { recursive: true });
        const netlist = join(dir, 'rtl.json');
        const verilog = join(dir, 'generated.v');
        await writeFile(netlist, JSON.stringify(SYNTHETIC_NETLIST));
        await writeFile(verilog, syntheticVerilog(project.root));
        return { ...OK, top: project.config.top, netlist: { kind: 'rtl-netlist', path: netlist, canonical: false }, verilog: { kind: 'generated-verilog', path: verilog, canonical: false } };
    }
    async detectBoards(): Promise<BoardDetectionResult & { configured: boolean }> {
        this.calls.push('detect');
        return this.detection;
    }
    async bitstream(): Promise<BitstreamInfo | undefined> {
        return this.bit;
    }
    async program(_project: Project, serial: string | undefined): Promise<ProgrammingResult> {
        this.calls.push(`program:${serial ?? '(auto)'}`);
        return this.programResult;
    }
    async environment(): Promise<EnvironmentReport> {
        return {
            adapter: { id: 'fake', displayName: 'Fake', status: 'fake' },
            toolchain: { overall: 'compatible', tools: [] },
            diagnostics: [],
            providers: {},
        };
    }
}

/** A successful BuildResult shaped like Phase 3 output (values are test data, not measurements). */
export function successfulBuild(bitPath: string): BuildResult {
    return {
        success: true,
        steps: (['validate', 'workspace', 'check', 'synthesize', 'constraints', 'implement'] as const).map((step) => ({ step, status: 'succeeded' as const, durationMs: 1, diagnostics: [] })),
        board: { id: 'nexys-a7-100t', name: 'Digilent Nexys A7-100T', device: 'XC7A100T-1CSG324C', part: 'xc7a100tcsg324-1' },
        bitstream: { kind: 'bitstream', path: bitPath, canonical: true, sizeBytes: 3_825_888 },
        utilization: { luts: { used: 56, available: 63400 }, flipFlops: { used: 27, available: 126800 }, bram: { used: 0 }, dsp: { used: 0, available: 240 } },
        timing: { clocks: [{ clock: 'clk', targetMHz: 100, achievedMHz: 372.58, passed: true }], passed: true, worstSlackNs: 7.3 },
        implementationStage: 'bitstream',
        diagnostics: [],
        logs: [{ label: 'apio-build', path: 'apio-build.log' }],
        durationMs: 30_000,
    };
}
