import { BoardRegistry, dataPaths, loadProject, type ToolInvocation, type ToolRunResult, type ToolRunner } from '../../core';
import { createBoardFlows } from '../../runtime/multiboard';
import { createContext } from '../../runtime/context';
import { MixFpgaBackend, type ReferenceBackend } from '../../extension/services/multiboard-backend';
import type { CoreBackend } from '../../extension/services/backend';
import { WindowsDe10Runtime } from '../../platform/windows/de10/runtime';
import { isolatedCli, REPO, writeFiles } from '../helpers';
import { makeDe10Project } from '../mixfpga/fake-vm';
import { WIN } from '../multiboard/harness';
import { FakeQuartusRunner, windowsEnv, type WindowsTestEnv } from './fake-quartus';

/** Routes each executable to its fake: Quartus tools, GHDL, Yosys, the programmer. Never starts a process. */
export class WindowsRouter implements ToolRunner {
    readonly calls: ToolInvocation[] = [];
    constructor(private readonly env: WindowsTestEnv, readonly quartus: FakeQuartusRunner) {}
    async run(inv: ToolInvocation): Promise<ToolRunResult> {
        this.calls.push(inv);
        const ok = (o: Partial<ToolRunResult> = {}): ToolRunResult => ({ invocation: inv, outcome: 'exited', exitCode: 0, stdout: '', stderr: '', durationMs: 1, ...o });
        if (/(quartus_\w+|jtagconfig)\.exe$/.test(inv.executable)) return this.quartus.run(inv);
        if (inv.executable === this.env.paths.ghdl) return inv.args[0] === '--version' ? ok({ stdout: 'GHDL 6.0.0 (6.0.0.r0.ge589c698c) [Dunoon edition]\r\n' }) : ok();
        if (inv.executable === this.env.paths.yosys) return ok({ stdout: 'Yosys 0.63+173 (git sha1 66306a8ca)\r\n' });
        return ok({ outcome: 'spawn-failed', exitCode: null, errorMessage: `unexpected executable ${inv.executable}` });
    }
}

export async function harness(t: import('node:test').TestContext, quartus: import('./fake-quartus').QuartusOptions = {}) {
    const env = await windowsEnv(t, quartus);
    const router = new WindowsRouter(env, new FakeQuartusRunner(env, quartus));
    const ctx = await createContext(isolatedCli({ host: WIN }));
    const boards = (await BoardRegistry.loadDirectory(dataPaths(REPO).boards)).registry;
    const de10 = new WindowsDe10Runtime({ repoRoot: REPO, boards, runner: router, paths: env.paths });
    const flows = createBoardFlows({ ctx, de10 });
    const reference = {
        flows: async () => flows,
        boards: async () => boards,
        loadProject: (root: string) => loadProject(root),
        validate: async () => ({ valid: true, diagnostics: [] }),
        environment: async () => ({ adapter: { id: 'fake', displayName: 'Test platform', status: '' }, toolchain: { overall: 'compatible', tools: [] }, diagnostics: [], providers: {} }),
        bitstream: async () => undefined,
    } as unknown as ReferenceBackend & CoreBackend;
    const backend = new MixFpgaBackend(reference);
    const project = async () => {
        const root = await makeDe10Project(t);
        await writeFiles(root, { 'nexysvhdl.json': JSON.stringify({ name: 'blink', board: 'de10-lite', language: 'vhdl', standard: '2008', top: 'blink', sources: ['src/blink.vhd'] }) });
        const loaded = await loadProject(root);
        if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
        return loaded.project;
    };
    return { env, router, backend, flows, project, boards };
}
