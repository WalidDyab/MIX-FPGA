import './install-vscode-fake';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { registerCommands } from '../../extension/commands/commands';
import { createProject } from '../../extension/project/scaffold';
import { NexysConsole } from '../../extension/services/console';
import { NexysVhdlService } from '../../extension/services/nexys-service';
import type { Node } from '../../extension/views/base';
import { ProjectView } from '../../extension/views/project-view';
import { REPO, repoBoards, tempDir } from '../helpers';
import { FakeBackend } from './fake-backend';
import { commandLog, registered } from './vscode-fake';

async function make(parent: string, name: string, template: 'empty' | 'starter' = 'starter') {
    const r = await createProject({ parentDir: parent, name, board: (await repoBoards()).get('nexys-a7-100t')!, template });
    assert.ok(r.ok);
    return r.root;
}

describe('Project view: one purpose', () => {
    it('with a project open it shows only the project name, the board and Environment', async (t) => {
        const root = await make(await tempDir(t), 'DigitDisplay');
        const service = new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(root);
        const view = new ProjectView(service);
        t.after(() => view.dispose());
        const rows = view.getChildren();
        assert.deepEqual(rows.map((n: Node) => String(n.label)), ['DigitDisplay', 'Nexys A7-100T', 'Environment']);
        const text = rows.map((n: Node) => `${String(n.label)} ${String(n.description ?? '')}`).join(' ');
        for (const gone of ['nexysvhdl.json', 'Top', 'Testbench', 'Constraints', 'Simulation length', 'Standard', '.xdc', 'src/']) assert.ok(!text.includes(gone), `${gone} is not repeated here`);
        assert.equal(rows[2]!.command?.command, 'nexysvhdl.showEnvironment');
    });

    it('shows nothing without a project (the welcome content takes over), and still shows a damaged project file', async (t) => {
        const service = new NexysVhdlService({ backend: new FakeBackend() });
        t.after(() => service.dispose());
        const view = new ProjectView(service);
        t.after(() => view.dispose());
        assert.deepEqual(view.getChildren(), []);
        const root = await make(await tempDir(t), 'Broken');
        await writeFile(join(root, 'nexysvhdl.json'), '{ nope');
        await service.open(root);
        assert.match(String(view.getChildren()[0]!.label), /Project file has a problem/);
    });

    it('the design settings are still reachable through their commands', () => {
        const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string }> } };
        for (const c of ['nexysvhdl.setTopEntity', 'nexysvhdl.setTestbench', 'nexysvhdl.useConstraintsFile', 'nexysvhdl.setSimulationStopTime', 'nexysvhdl.openProjectSettings', 'nexysvhdl.createProjectFile']) {
            assert.ok(pkg.contributes.commands.some((x) => x.command === c), `${c} still exists`);
        }
    });
});

describe('Project header actions', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
        contributes: {
            commands: Array<{ command: string; title: string; icon?: string }>;
            menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
            viewsWelcome: Array<{ view: string; when?: string; contents: string }>;
        };
    };
    const header = pkg.contributes.menus['view/title']!.filter((m) => m.when?.startsWith('view == nexysvhdl.project'));

    it('New, Open and Close Project are native header actions with icons; settings and refresh moved to the overflow menu', () => {
        const nav = header.filter((m) => m.group?.startsWith('navigation')).sort((a, b) => a.group!.localeCompare(b.group!));
        assert.deepEqual(nav.map((m) => m.command), ['nexysvhdl.createProject', 'nexysvhdl.openProject', 'nexysvhdl.closeProject']);
        for (const m of nav) assert.ok(pkg.contributes.commands.find((c) => c.command === m.command)!.icon?.startsWith('$('), `${m.command} has an icon`);
        assert.match(nav[2]!.when!, /nexysvhdl\.hasProject/, 'Close only with a project open');
        assert.ok(!header.some((m) => m.command === 'nexysvhdl.openProjectSettings' && m.group?.startsWith('navigation')));
        assert.ok(header.some((m) => m.command === 'nexysvhdl.refreshProject' && !m.group?.startsWith('navigation')));
        assert.equal(pkg.contributes.commands.find((c) => c.command === 'nexysvhdl.closeProject')!.title, 'Close Project');
    });

    it('no menu targets a Project row that was removed', () => {
        const ctx = pkg.contributes.menus['view/item/context']!.map((m) => m.when ?? '').join('\n');
        for (const gone of ['project.top', 'project.testbench', 'project.stopTime', 'project.fileMissing', 'project.constraints']) assert.ok(!ctx.includes(gone), gone);
    });

    it('the no-project welcome keeps New Project, Open Project, Getting Started and Environment', () => {
        const w = pkg.contributes.viewsWelcome.find((x) => x.view === 'nexysvhdl.project' && x.when === '!nexysvhdl.hasProject')!;
        for (const c of ['nexysvhdl.createProject', 'nexysvhdl.openProject', 'nexysvhdl.gettingStarted', 'nexysvhdl.showEnvironment']) assert.ok(w.contents.includes(`command:${c}`), c);
    });
});

describe('Close Project and same-window switching', () => {
    async function wire(t: TestContext, root?: string) {
        const service = new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 5 });
        t.after(() => service.dispose());
        if (root) await service.open(root);
        const events: string[] = [];
        registered.clear();
        commandLog.length = 0;
        registerCommands({ subscriptions: [], extensionPath: REPO, extension: { id: 'x' } } as never, {
            service,
            backend: new FakeBackend(),
            console: new NexysConsole({ appendLine: () => undefined, reveal: () => undefined }),
            output: { appendLine: () => undefined, show: () => undefined },
            extensionVersion: '0',
            flush: () => {
                events.push('flush');
                return Promise.resolve();
            },
        } as never);
        const run = (id: string, ...args: unknown[]) => (registered.get(id) as (...a: unknown[]) => Promise<unknown>)(...args);
        return { service, events, run };
    }

    it('Close Project flushes NexysVHDL state first, then asks VS Code to close the folder (the window stays open); it saves nothing itself', async (t) => {
        const root = await make(await tempDir(t), 'A');
        const { events, run } = await wire(t, root);
        const order: string[] = [];
        registered.set('workbench.action.closeFolder', () => order.push(`closeFolder after ${events.join(',') || 'nothing'}`));
        await run('nexysvhdl.closeProject');
        assert.deepEqual(order, ['closeFolder after flush']);
        assert.ok(!commandLog.some((c) => /files\.save|saveAll|revert/i.test(c.command)), 'dirty documents are left to VS Code');
    });

    it('Close Project with no project open closes nothing', async (t) => {
        const { run } = await wire(t);
        await run('nexysvhdl.closeProject');
        assert.ok(!commandLog.some((c) => c.command === 'workbench.action.closeFolder'));
    });

    it('Open Project on a .nvproj, a folder and a legacy folder switches THIS window after a flush, with no vscode:// link', async (t) => {
        const parent = await tempDir(t);
        const a = await make(parent, 'A');
        const b = await make(parent, 'B');
        const legacy = await make(parent, 'Legacy');
        await rm(join(legacy, 'Legacy.nvproj'));
        const { events, run } = await wire(t, a);
        for (const [target, expected] of [[join(b, 'B.nvproj'), b], [b, b], [legacy, legacy]] as const) {
            commandLog.length = 0;
            events.length = 0;
            await run('nexysvhdl.openProject', target);
            const open = commandLog.find((c) => c.command === 'vscode.openFolder');
            assert.ok(open, `${target} opens`);
            assert.equal((open.args[0] as { fsPath: string }).fsPath, expected);
            assert.deepEqual(open.args[1], { forceNewWindow: false }, 'the same window');
            assert.deepEqual(events, ['flush']);
            assert.ok(!commandLog.some((c) => /open-url|vscode:\/\//i.test(JSON.stringify(c))), 'no URI route');
        }
    });

    it('a damaged or missing target is explained, and neither flushes nor opens anything', async (t) => {
        const parent = await tempDir(t);
        const a = await make(parent, 'A');
        const { events, run } = await wire(t, a);
        await mkdir(join(parent, 'Plain'));
        await writeFile(join(parent, 'bad.nvproj'), '{ nope');
        for (const target of [join(parent, 'bad.nvproj'), join(parent, 'Plain'), join(parent, 'nothing')]) await run('nexysvhdl.openProject', target);
        assert.ok(!commandLog.some((c) => c.command === 'vscode.openFolder'));
        assert.deepEqual(events, []);
    });

    it('opening the project that is already open does nothing; Open Project from an empty window works too', async (t) => {
        const parent = await tempDir(t);
        const a = await make(parent, 'A');
        const same = await wire(t, a);
        await same.run('nexysvhdl.openProject', join(a, 'A.nvproj'));
        assert.ok(!commandLog.some((c) => c.command === 'vscode.openFolder'));
        const empty = await wire(t);
        await empty.run('nexysvhdl.openProject', a);
        assert.ok(commandLog.some((c) => c.command === 'vscode.openFolder'));
    });

    it('opening a project clears everything of the previous one (results, workflow, problems, design state)', async (t) => {
        const parent = await tempDir(t);
        const a = await make(parent, 'A');
        const b = await make(parent, 'B', 'empty');
        const service = new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 5 });
        t.after(() => service.dispose());
        await service.open(a);
        await service.check();
        service.problems.set('vhdl', [{ severity: 'error', source: 'vhdl', code: 'X', message: 'from A', location: { file: join(a, 'src', 'top.vhd'), line: 1 } }]);
        assert.ok(service.lastCheck);
        await service.open(b);
        assert.equal(service.lastCheck, undefined);
        assert.equal(service.lastSimulation, undefined);
        assert.equal(service.lastBuild, undefined);
        assert.equal(service.project?.config.name, 'B');
        assert.equal(service.workflow.check.state, 'idle');
        assert.equal(service.problems.get('vhdl'), undefined, 'A\'s diagnostics are gone');
        assert.equal(service.snapshot?.emptyProject, true);
    });

    it('extension.ts passes one flush (project writes and state.json) to the commands, and Close Project saves no documents', () => {
        const ext = readFileSync(join(REPO, 'extension', 'extension.ts'), 'utf8');
        assert.match(ext, /flush: \(\) => \(shutdown \? shutdown\(\) : Promise\.resolve\(\)\)/);
        const commands = readFileSync(join(REPO, 'extension', 'commands', 'commands.ts'), 'utf8');
        assert.equal((commands.match(/\.save\(\)/g) ?? []).length, 1, 'still only the documented save-before-run');
        assert.match(commands, /workbench\.action\.closeFolder/);
        assert.doesNotMatch(commands, /showInformationMessage\(`Open project/, 'no Open-in-this-window prompt: the switch is direct');
    });
});
