import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { CoreBackend } from '../../extension/services/backend';
import { NexysVhdlService } from '../../extension/services/nexys-service';
import { createProject } from '../../extension/project/scaffold';
import { FakeRunner, fakePlatform, ForbiddenRunner, isolatedCli, REPO, repoBoards, tempDir, trapProcesses } from '../helpers';

function stripComments(ts: string): string {
    return ts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

async function extensionSources(): Promise<Array<{ file: string; text: string }>> {
    const out: Array<{ file: string; text: string }> = [];
    for (const e of await readdir(join(REPO, 'extension'), { withFileTypes: true, recursive: true })) {
        if (e.isFile() && e.name.endsWith('.ts')) {
            const abs = join(e.parentPath, e.name);
            out.push({ file: relative(REPO, abs).split('\\').join('/'), text: stripComments(await readFile(abs, 'utf8')) });
        }
    }
    return out;
}

/** The extension is a thin UI: tools run only inside the shared core, through the platform adapter. */
describe('architecture rules for extension/', () => {
    it('never starts processes itself', async () => {
        for (const { file, text } of await extensionSources()) {
            assert.doesNotMatch(text, /node:child_process|from 'child_process'|require\('child_process'\)/, file);
            assert.doesNotMatch(text, /\bspawn\(|\bexecFile\(|\bexecSync\(|NodeToolRunner|new\s+\w*ToolRunner/, file);
        }
    });

    it('never names platform programming backends, drivers or tool binaries', async () => {
        const forbidden = /djtgcfg|adept|openfpgaloader|ftdi|winusb|zadig|vivado|digilent|fasm2frames|xc7frames2bit|nextpnr|APIO_REMOTE_CONFIG_URL/i;
        for (const { file, text } of await extensionSources()) {
            // Student-facing strings may say "Digilent" only via board data, never in code.
            assert.doesNotMatch(text.replace(/\/\^Digilent \//g, ''), forbidden, file);
            // The RTL view reads Yosys's JSON netlist *format* and tool ids are data keys,
            // but the extension never builds a tool invocation itself.
            assert.doesNotMatch(text, /\bexecutable\s*:|(yosys|ghdl|apio)\.exe|['"`]raw['"`]\s*,\s*['"`]--['"`]/i, file);
        }
    });

    it('does not branch on the host platform', async () => {
        for (const { file, text } of await extensionSources()) {
            assert.doesNotMatch(text, /process\.platform|os\.platform\(|process\.arch|'win32'|"win32"|'darwin'|"darwin"/, file);
        }
    });

    it('reaches platform code only through the shared composition root (runtime/)', async () => {
        for (const { file, text } of await extensionSources()) {
            assert.doesNotMatch(text, /from '(\.\.\/)+(platform|cli)(\/|')/, file);
        }
        const backend = (await extensionSources()).find((s) => s.file === 'extension/services/backend.ts')!;
        assert.match(backend.text, /from '\.\.\/\.\.\/runtime\/context'/);
    });

    it('keeps the VS Code API out of the service, project, hierarchy and schematic-model layers', async () => {
        const pure = /^extension\/(services|project|hierarchy)\/|^extension\/schematic\/schematic-(model|svg)\.ts$|^extension\/diagnostics\/problems\.ts$/;
        for (const { file, text } of await extensionSources()) {
            if (pure.test(file)) assert.doesNotMatch(text, /from 'vscode'/, file);
        }
    });
});

describe('extension backend uses the shared Phase 3 core', () => {
    it('runs Check through the core WorkflowController and the platform-configured runner', async (t) => {
        const trap = trapProcesses(t);
        const runner = new FakeRunner();
        const platform = fakePlatform({ runner, toolLocator: { locate: async (tool) => (tool === 'ghdl' ? { path: '/fake/ghdl', method: 'fake' } : undefined) } });
        const backend = new CoreBackend(isolatedCli({ platform }));
        const parent = await tempDir(t);
        const created = await createProject({ parentDir: parent, name: 'Shared', board: (await repoBoards()).get('nexys-a7-100t')! });
        assert.ok(created.ok);
        const service = new NexysVhdlService({ backend, debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(created.root);

        const result = await service.check();
        assert.equal(result.status, 'succeeded');
        // GHDL analyse + elaborate(top) + elaborate(testbench), all through the injected platform runner.
        assert.deepEqual(runner.calls.map((c) => `${c.executable} ${c.args[0]}`), ['/fake/ghdl -a', '/fake/ghdl -e', '/fake/ghdl -e']);
        assert.ok(runner.calls.every((c) => c.cwd?.startsWith(join(created.root, '.nexysvhdl'))), 'tools run inside the build workspace');
        assert.deepEqual(trap.attempts, []);
    });

    it('reports missing tools as not configured (never success), with no tools present', async (t) => {
        const trap = trapProcesses(t);
        const overrides = isolatedCli();
        const backend = new CoreBackend(overrides);
        const parent = await tempDir(t);
        const created = await createProject({ parentDir: parent, name: 'NoTools', board: (await repoBoards()).get('nexys-a7-100t')! });
        assert.ok(created.ok);
        const service = new NexysVhdlService({ backend, debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(created.root);

        assert.equal((await service.check()).status, 'not-configured');
        assert.equal(service.workflow.check.state, 'unavailable');
        assert.equal((await service.build()).success, false);
        assert.equal(service.workflow.build.state, 'unavailable');
        await service.detectBoards();
        assert.equal(service.hardware.status, 'unavailable');
        const env = await service.refreshEnvironment();
        assert.equal(env?.level, 'setup-required');
        const program = await service.program();
        assert.equal(program.kind, 'blocked', 'no bitstream exists');
        assert.equal((overrides.runner as ForbiddenRunner).calls.length, 0);
        assert.deepEqual(trap.attempts, []);
    });
});
