import { stat } from 'node:fs/promises';
import type { BoardRegistry } from '../../../core/board/board-registry';
import type { BoardEnvironment, EnvironmentVerification, ToolReport } from '../../../core/backend/environment';
import { QuartusImplementationProvider } from '../../../core/implementation/quartus/provider';
import { OutputTeeRunner } from '../../../core/process/output-tee-runner';
import { NodeToolRunner, type ToolInvocation, type ToolRunner } from '../../../core/process/tool-runner';
import { DirectYosysRtlProvider } from '../../../core/rtl/yosys-rtl-provider';
import { loadManifest, verifyOwnedComponents } from '../../../core/toolchain/mixfpga-manifest';
import { GhdlVhdlProvider } from '../../../core/vhdl/ghdl/ghdl-provider';
import { WorkflowController } from '../../../core/workflow/workflow-controller';
import { WorkspaceManager } from '../../../core/workspace/build-workspace';
import type { WindowsDe10Paths } from './config';
import { loadExpectedToolchain } from '../../shared/install/expected';
import { resolveWindowsLayout, type WindowsRuntimeLayout } from '../install/layout';
import { installedWindowsDe10Paths } from '../install/paths';
import { checkUnit, readMarker, unitProblem } from '../../macos/install/toolchain-installer';
import { NativeQuartusEngine } from './native-quartus-engine';
import { NativeQuartusExecutor } from './quartus-native-executor';
import { QuartusPgmProgrammer } from './quartus-programmer';

export interface WindowsDe10RuntimeOptions {
    readonly repoRoot: string;
    readonly boards: BoardRegistry;
    readonly runner?: ToolRunner;
    /** Receives everything every tool prints, as it prints it (the console). */
    readonly onToolOutput?: (text: string, invocation: ToolInvocation) => void;
    /** Tool locations. Absent: the installed MIX-FPGA Toolchain (%LOCALAPPDATA%\MIX-FPGA, or $MIXFPGA_HOME). There is no repository fallback. */
    readonly paths?: WindowsDe10Paths;
    /** Verify Environment checks the installed toolchain against this recorded manifest (full tree). Absent: the older per-executable check. */
    readonly installed?: { readonly layout: WindowsRuntimeLayout; readonly manifestFile: string };
}

/**
 * Everything the DE10-Lite on Windows needs, built from MIX-FPGA-owned tools plus the student's own Quartus:
 * MIX-FPGA's GHDL and Yosys (check, simulate, RTL schematic), the shared Quartus implementation running the
 * native command-line tools, and Quartus's own programmer over the standard Altera USB-Blaster driver. Nothing starts a process until the student asks.
 */
export class WindowsDe10Runtime {
    readonly paths: WindowsDe10Paths;
    readonly runner: ToolRunner;
    readonly engine: NativeQuartusEngine;
    readonly implementation: QuartusImplementationProvider;
    readonly programmer: QuartusPgmProgrammer;
    private readonly controller: WorkflowController;
    /** Version probes and health checks: never echoed to the student's console. */
    private readonly quiet: ToolRunner;
    private readonly repoRoot: string;
    private readonly installed: WindowsDe10RuntimeOptions['installed'];

    constructor(opts: WindowsDe10RuntimeOptions) {
        const base = opts.runner ?? new NodeToolRunner();
        this.paths = opts.paths ?? installedWindowsDe10Paths(resolveWindowsLayout(), base);
        this.installed = opts.installed;
        this.quiet = base;
        this.repoRoot = opts.repoRoot;
        this.runner = opts.onToolOutput ? new OutputTeeRunner(base, opts.onToolOutput) : base;
        this.engine = new NativeQuartusEngine(this.paths, this.runner);
        this.implementation = new QuartusImplementationProvider(new NativeQuartusExecutor(this.paths, this.engine));
        this.programmer = new QuartusPgmProgrammer(this.engine);
        this.controller = new WorkflowController({
            boards: opts.boards,
            workspaces: new WorkspaceManager(),
            vhdl: new GhdlVhdlProvider(this.paths.ghdl, this.runner),
            rtl: new DirectYosysRtlProvider(this.paths.yosys, this.runner),
        });
    }

    /** Check / Simulate / RTL controller using MIX-FPGA's own GHDL and Yosys. Starts nothing by itself. */
    workflow(): WorkflowController {
        return this.controller;
    }

    /** Whether MIX-FPGA's own VHDL tools are installed (file check only; runs nothing). */
    async vhdlToolsPresent(): Promise<{ ghdl: boolean; yosys: boolean }> {
        const has = (p: string) => stat(p).then((s) => s.isFile(), () => false);
        return { ghdl: await has(this.paths.ghdl), yosys: await has(this.paths.yosys) };
    }

    private async firstLine(executable: string, args: string[], pattern: RegExp): Promise<{ found: boolean; version?: string; detail?: string }> {
        const r = await this.quiet.run({ executable, args, timeoutMs: 15_000 });
        if (r.outcome !== 'exited' || r.exitCode !== 0) return { found: false, detail: r.outcome === 'spawn-failed' ? 'not installed' : 'did not start' };
        const v = pattern.exec(`${r.stdout}\n${r.stderr}`)?.[1];
        return { found: true, ...(v ? { version: v } : {}) };
    }

    /** Versions of every tool behind the DE10-Lite. Only small `--version` commands run. */
    async inspectTools(engine: { toolVersion?: string; max10: boolean }): Promise<ToolReport[]> {
        const [ghdl, yosys, prog] = await Promise.all([
            this.firstLine(this.paths.ghdl, ['--version'], /GHDL (\S+)/),
            this.firstLine(this.paths.yosys, ['-V'], /Yosys (\S+)/),
            this.programmer.availability(),
        ]);
        const row = (id: string, label: string, ownership: ToolReport['ownership'], r: { found: boolean; version?: string; detail?: string }): ToolReport => ({ id, label, ownership, found: r.found, ...(r.version ? { version: r.version } : {}), ...(r.detail ? { detail: r.detail } : {}) });
        return [
            row('ghdl', 'GHDL', 'owned', ghdl),
            row('yosys', 'Yosys', 'owned', yosys),
            row('quartus', 'Quartus Prime Lite', 'external', engine.toolVersion ? { found: true, version: engine.toolVersion } : { found: false, detail: 'not found' }),
            row('max10', 'MAX 10 device support', 'external', engine.max10 ? { found: true, version: '25.1' } : { found: false, detail: 'not found' }),
            row('quartus_pgm', 'Quartus Programmer', 'external', { found: prog.available, ...(prog.available ? { version: /Version (\S+ Build \d+)/.exec(prog.detail)?.[1] ?? prog.detail } : { detail: prog.detail }) }),
        ];
    }

    /** The environment page's data. Runs only `quartus_sh --version` and the small tool probes. */
    async environment(displayName: string, boardId: string): Promise<BoardEnvironment> {
        const engine = await this.engine.status();
        // Quartus itself said the MAX 10 part is available exactly when the engine is running.
        const max10 = engine.state === 'running';
        const [tools, present, prog] = await Promise.all([this.inspectTools({ ...(engine.toolVersion ? { toolVersion: engine.toolVersion } : {}), max10 }), this.vhdlToolsPresent(), this.programmer.availability()]);
        return { boardId, displayName, engine, tools, vhdlReady: present.ghdl && present.yosys && tools.find((t) => t.id === 'ghdl')?.found === true, programmer: prog };
    }

    /** Hash-checks the owned tools, then proves Quartus runs and knows the exact MAX 10 part. */
    async verify(signal?: AbortSignal): Promise<EnvironmentVerification> {
        const steps: { label: string; ok: boolean; detail?: string }[] = [];
        let modified = false;
        if (this.installed) {
            const expected = await loadExpectedToolchain(this.installed.manifestFile).catch(() => undefined);
            if (!expected) steps.push({ label: 'Toolchain manifest', ok: false, detail: 'the recorded manifest is missing or unreadable' });
            else {
                for (const u of expected.toolchain.units) {
                    const c = await checkUnit(this.installed.layout, u, 'full');
                    // A file the user changed is reported but is not a failure; missing or damaged files still fail.
                    steps.push({ label: `${u.name}${u.version ? ` ${u.version}` : ''}`, ok: c.state === 'ok' || c.state === 'modified', ...(c.state === 'ok' ? {} : { detail: c.state === 'modified' ? `modified: ${unitProblem(c)}. This is no longer the verified MIX-FPGA configuration; choose Repair to restore the supported version.` : unitProblem(c) }) });
                    if (c.state === 'modified') modified = true;
                }
                const marker = await readMarker(this.installed.layout);
                steps.push({ label: 'Installation record', ok: marker?.manifestSha256 === expected.sha256, ...(marker?.manifestSha256 === expected.sha256 ? {} : { detail: 'the installation was not completed or is for another toolchain' }) });
            }
        } else {
            const manifest = await loadManifest(this.repoRoot, 'windows-x64');
            if (!manifest) steps.push({ label: 'Toolchain manifest', ok: false, detail: 'toolchains/mixfpga/windows-x64.json is missing or unreadable' });
            else {
                for (const r of await verifyOwnedComponents(manifest, this.paths.toolchainRoot)) {
                    steps.push({ label: `${r.component.name} ${r.component.version}`, ok: r.state === 'ok', ...(r.state === 'ok' ? {} : { detail: r.state === 'missing' ? 'not installed' : r.state === 'modified' ? 'files differ from the recorded version' : 'no recorded checksum' }) });
                }
            }
        }
        const engine = await this.engine.ensureReady(signal);
        const detail = engine.state === 'running' ? engine.toolVersion : engine.problems[0]?.message;
        steps.push({ label: 'Quartus and MAX 10 support', ok: engine.state === 'running', ...(detail ? { detail } : {}) });
        return { ok: steps.every((s) => s.ok), steps, engine, ...(modified ? { modified } : {}) };
    }
}
