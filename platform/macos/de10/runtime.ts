import { GhdlVhdlProvider } from '../../../core/vhdl/ghdl/ghdl-provider';
import { OutputTeeRunner } from '../../../core/process/output-tee-runner';
import { NodeToolRunner, type ToolInvocation, type ToolRunner } from '../../../core/process/tool-runner';
import { DirectYosysRtlProvider } from '../../../core/rtl/yosys-rtl-provider';
import { WorkflowController } from '../../../core/workflow/workflow-controller';
import { WorkspaceManager } from '../../../core/workspace/build-workspace';
import type { BoardRegistry } from '../../../core/board/board-registry';
import type { BoardEnvironment, EnvironmentVerification, ToolReport } from '../../../core/backend/environment';
import { stat } from 'node:fs/promises';
import type { De10Paths } from './config';
import { loadExpectedToolchain } from '../install/expected';
import { type RuntimeLayout, resolveRuntimeLayout } from '../install/layout';
import { installedDe10Paths } from '../install/paths';
import { checkUnit, readMarker, unitProblem } from '../install/toolchain-installer';
import { LimaEngine } from './engine';
import { NativeJtagProgrammer } from './ofl-programmer';
import { QuartusLimaImplementationProvider } from './quartus-lima-provider';
import { loadManifest, verifyOwnedComponents } from './toolchain';

export interface De10RuntimeOptions {
    readonly repoRoot: string;
    readonly boards: BoardRegistry;
    readonly home?: string;
    readonly runner?: ToolRunner;
    /** Receives everything every tool prints, as it prints it (the console). */
    readonly onToolOutput?: (text: string, invocation: ToolInvocation) => void;
    /** Tool locations. Absent: the installed MIX-FPGA Toolchain (~/Library/MIX-FPGA, or $MIXFPGA_HOME). There is no repository fallback. */
    readonly paths?: De10Paths;
    /** Verify Environment checks the installed toolchain against this recorded manifest (full-tree). Absent: the older per-executable check. */
    readonly installed?: { readonly layout: RuntimeLayout; readonly manifestFile: string };
}

/**
 * Everything the DE10-Lite on macOS needs, built from MIX-FPGA-owned tools only:
 * its own GHDL and Yosys (check, simulate, RTL schematic), the Quartus-in-Lima implementation,
 * and the native programmer. Nothing here starts a process until the student asks for it:
 * the Linux VM is touched only by `implementation.build()` and the engine methods.
 */
export class De10Runtime {
    readonly paths: De10Paths;
    readonly runner: ToolRunner;
    readonly engine: LimaEngine;
    readonly implementation: QuartusLimaImplementationProvider;
    readonly programmer: NativeJtagProgrammer;
    private readonly controller: WorkflowController;
    /** Version probes and health checks: never echoed to the student's console. */
    private readonly quiet: ToolRunner;
    private readonly repoRoot: string;
    private readonly installed: De10RuntimeOptions['installed'];

    constructor(opts: De10RuntimeOptions) {
        this.paths = opts.paths ?? installedDe10Paths(resolveRuntimeLayout({ ...(opts.home ? { home: opts.home } : {}) }));
        this.installed = opts.installed;
        const base = opts.runner ?? new NodeToolRunner();
        this.quiet = base;
        this.repoRoot = opts.repoRoot;
        this.runner = opts.onToolOutput ? new OutputTeeRunner(base, opts.onToolOutput) : base;
        this.engine = new LimaEngine(this.paths, this.runner);
        this.implementation = new QuartusLimaImplementationProvider(this.paths, this.engine);
        this.programmer = new NativeJtagProgrammer(this.paths, this.runner);
        // No implementation provider here on purpose: Build goes through `implementation` (normalized), not through the Verilog/XDC controller.
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

    /** Versions of every tool behind the DE10-Lite. Runs only small `--version` commands; the Linux VM is not touched. */
    async inspectTools(engineVersion?: string): Promise<ToolReport[]> {
        const [ghdl, yosys, lima, prog] = await Promise.all([
            this.firstLine(this.paths.ghdl, ['--version'], /GHDL (\S+)/),
            this.firstLine(this.paths.yosys, ['-V'], /Yosys (\S+)/),
            this.firstLine(this.paths.limactl, ['--version'], /version (\S+)/),
            this.programmer.availability(),
        ]);
        const rosetta = await stat('/Library/Apple/usr/share/rosetta/rosetta').then((s) => s.isFile(), () => false);
        const row = (id: string, label: string, ownership: ToolReport['ownership'], r: { found: boolean; version?: string; detail?: string }): ToolReport => ({ id, label, ownership, found: r.found, ...(r.version ? { version: r.version } : {}), ...(r.detail ? { detail: r.detail } : {}) });
        return [
            row('ghdl', 'GHDL', 'owned', ghdl),
            row('yosys', 'Yosys', 'owned', yosys),
            row('quartus', 'Quartus Prime Lite', 'external', engineVersion ? { found: true, version: engineVersion } : { found: false, detail: 'checked when the FPGA engine starts' }),
            row('max10', 'MAX 10 device support', 'external', engineVersion ? { found: true, version: '25.1' } : { found: false, detail: 'checked when the FPGA engine starts' }),
            row('lima', 'Lima', 'owned', lima),
            row('rosetta', 'Rosetta 2', 'external', { found: rosetta, ...(rosetta ? {} : { detail: 'not installed' }) }),
            row('openfpgaloader', 'openFPGALoader', 'owned', { found: prog.available, ...(prog.available ? { version: /v(\S+)/.exec(prog.detail)?.[1] ?? prog.detail } : { detail: prog.detail }) }),
        ];
    }

    /** The environment page's data. Starts nothing: a stopped engine is reported as stopped. */
    async environment(displayName: string, boardId: string): Promise<BoardEnvironment> {
        const engine = await this.engine.status();
        const [tools, present, prog] = await Promise.all([this.inspectTools(engine.toolVersion), this.vhdlToolsPresent(), this.programmer.availability()]);
        return { boardId, displayName, engine, tools, vhdlReady: present.ghdl && present.yosys && tools.find((t) => t.id === 'ghdl')?.found === true, programmer: prog };
    }

    /** Hash-checks the owned tools, then proves the engine really runs Quartus (this may start the VM). */
    async verify(signal?: AbortSignal): Promise<EnvironmentVerification> {
        const steps: { label: string; ok: boolean; detail?: string }[] = [];
        if (this.installed) {
            const expected = await loadExpectedToolchain(this.installed.manifestFile).catch(() => undefined);
            if (!expected) steps.push({ label: 'Toolchain manifest', ok: false, detail: 'the recorded manifest is missing or unreadable' });
            else {
                for (const u of expected.toolchain.units) {
                    const c = await checkUnit(this.installed.layout, u, 'full');
                    steps.push({ label: `${u.name}${u.version ? ` ${u.version}` : ''}`, ok: c.state === 'ok', ...(c.state === 'ok' ? {} : { detail: unitProblem(c) }) });
                }
                const marker = await readMarker(this.installed.layout);
                steps.push({ label: 'Installation record', ok: marker?.manifestSha256 === expected.sha256, ...(marker?.manifestSha256 === expected.sha256 ? {} : { detail: 'the installation was not completed or is for another toolchain' }) });
            }
        } else {
            const manifest = await loadManifest(this.repoRoot);
            if (!manifest) steps.push({ label: 'Toolchain manifest', ok: false, detail: 'toolchains/mixfpga/macos-arm64.json is missing or unreadable' });
            else {
                for (const r of await verifyOwnedComponents(manifest, this.paths.toolchainRoot)) {
                    steps.push({ label: `${r.component.name} ${r.component.version}`, ok: r.state === 'ok', ...(r.state === 'ok' ? {} : { detail: r.state === 'missing' ? 'not installed' : r.state === 'modified' ? 'files differ from the recorded version' : 'no recorded checksum' }) });
                }
            }
        }
        const rosetta = await stat('/Library/Apple/usr/share/rosetta/rosetta').then((s) => s.isFile(), () => false);
        steps.push({ label: 'Rosetta 2', ok: rosetta, ...(rosetta ? {} : { detail: 'not installed' }) });
        const engine = await this.engine.ensureReady(signal);
        const detail = engine.state === 'running' ? engine.toolVersion : engine.problems[0]?.message;
        steps.push({ label: 'FPGA engine and Quartus', ok: engine.state === 'running', ...(detail ? { detail } : {}) });
        return { ok: steps.every((s) => s.ok), steps, engine };
    }
}

