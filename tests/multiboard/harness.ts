import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createContext } from '../../runtime/context';
import { createBoardFlows } from '../../runtime/multiboard';
import { De10Runtime } from '../../platform/macos/de10/runtime';
import type { De10Paths } from '../../platform/macos/de10/config';
import { MixFpgaBackend, type ReferenceBackend } from '../../extension/services/multiboard-backend';
import type { CoreBackend } from '../../extension/services/backend';
import { BoardRegistry, dataPaths, loadProject, type HostInfo, type Project, type ToolInvocation, type ToolRunResult, type ToolRunner } from '../../core';
import { isolatedCli, REPO, writeFiles } from '../helpers';
import { FakeVm, makeDe10Project, testPaths, type VmOptions } from '../mixfpga/fake-vm';
import { FakeProgrammerBinary, type Script } from '../mixfpga/fake-programmer';

export const MAC: HostInfo = { platform: 'darwin', arch: 'arm64', nodeVersion: 'v24.0.0-test' };
export const WIN: HostInfo = { platform: 'win32', arch: 'x64', nodeVersion: 'v24.0.0-test' };

/** Routes each executable to its fake: limactl -> the VM, ghdl -> a GHDL that succeeds, the programmer -> its script. Never starts a process. */
export class RoutingRunner implements ToolRunner {
    readonly ghdlCalls: ToolInvocation[] = [];
    readonly yosysCalls: ToolInvocation[] = [];
    constructor(private readonly paths: De10Paths, readonly vm: FakeVm, readonly programmer: FakeProgrammerBinary) {}
    async run(inv: ToolInvocation): Promise<ToolRunResult> {
        const ok = (o: Partial<ToolRunResult> = {}): ToolRunResult => ({ invocation: inv, outcome: 'exited', exitCode: 0, stdout: '', stderr: '', durationMs: 1, ...o });
        if (inv.executable === this.paths.limactl) return this.vm.run(inv);
        if (inv.executable === this.paths.programmer) return this.programmer.run(inv);
        if (inv.executable === this.paths.ghdl) {
            this.ghdlCalls.push(inv);
            return inv.args[0] === '--version' ? ok({ stdout: 'GHDL 6.0.0 (6.0.0.r0.ge589c698c) [Dunoon edition]\n' }) : ok();
        }
        if (inv.executable === this.paths.yosys) {
            this.yosysCalls.push(inv);
            return ok({ stdout: 'Yosys 0.63+173 (git sha1 66306a8ca)\n' });
        }
        return ok({ outcome: 'spawn-failed', exitCode: null, errorMessage: `unexpected executable ${inv.executable}` });
    }
}

export interface Harness {
    readonly backend: MixFpgaBackend;
    readonly vm: FakeVm;
    readonly runner: RoutingRunner;
    readonly paths: De10Paths;
    readonly home: string;
    readonly boards: BoardRegistry;
    /** Provider calls seen by the original (Nexys) flow's controller. */
    readonly nexysBuilds: Project[];
    readonly de10Project: () => Promise<Project>;
}

/**
 * The real router over the real composition root (`createBoardFlows`), with every tool faked:
 * the original flow's controller records its calls, the DE10 side runs against a scripted VM.
 */
export async function makeHarness(t: TestContext, o: { vm?: VmOptions; programmer?: Script; host?: HostInfo; withDe10?: boolean } = {}): Promise<Harness> {
    const { home, paths } = await testPaths(t);
    for (const p of [paths.ghdl, paths.yosys]) {
        await mkdir(join(p, '..'), { recursive: true });
        await writeFile(p, '#!/bin/sh\n');
    }
    const vm = new FakeVm(paths, o.vm ?? {});
    const runner = new RoutingRunner(paths, vm, new FakeProgrammerBinary(o.programmer ?? {}));
    // The original flow gets the repo's standard isolation (fake platform, refusing runner): no host tool is ever found.
    const ctx = await createContext(isolatedCli({ host: o.host ?? MAC }));
    const boards = (await BoardRegistry.loadDirectory(dataPaths(REPO).boards)).registry;
    const de10 = new De10Runtime({ repoRoot: REPO, boards, runner, paths });
    const flows = createBoardFlows({ ctx, ...(o.withDe10 === false ? {} : { de10 }) });
    const nexysBuilds: Project[] = [];
    const reference = {
        flows: async () => flows,
        boards: async () => boards,
        loadProject: (root: string) => loadProject(root),
        validate: async () => ({ valid: true, diagnostics: [] }),
        environment: async () => ({ adapter: { id: 'fake', displayName: 'Test platform', status: '' }, toolchain: { overall: 'compatible', tools: [] }, diagnostics: [], providers: {} }),
        bitstream: async () => undefined, // no Nexys build ever produced one in these tests
        build: async (project: Project) => {
            nexysBuilds.push(project);
            return { success: true, steps: [], diagnostics: [], logs: [], durationMs: 0 };
        },
    } as unknown as ReferenceBackend & CoreBackend;
    return {
        backend: new MixFpgaBackend(reference),
        vm,
        runner,
        paths,
        home,
        boards,
        nexysBuilds,
        de10Project: async () => {
            const root = await makeDe10Project(t);
            await writeFiles(root, { 'nexysvhdl.json': JSON.stringify({ name: 'blink', board: 'de10-lite', language: 'vhdl', standard: '2008', top: 'blink', sources: ['src/blink.vhd'] }) });
            const loaded = await loadProject(root);
            if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
            return loaded.project;
        },
    };
}
