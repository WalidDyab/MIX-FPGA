import * as vscode from 'vscode';
import { AppearanceManager, KEEP_MINE, type ThemeSettings, USE_CLASSROOM } from './appearance/appearance-manager';
import { registerCommands } from './commands/commands';
import { hardwareViewOf } from './setup/hardware-view';
import { SetupService } from './setup/setup-service';
import { routeUri } from './commands/uri-routes';
import { ProblemsPublisher } from './diagnostics/vscode-diagnostics';
import { findNvprojFiles } from '../core';
import { findProjectRoot } from './project/detect';
import { RtlPanel } from './rtl/rtl-panel';
import { AppearanceStore } from './schematic/schematic-chrome';
import { SchematicPanel } from './schematic/schematic-panel';
import { LAYOUT_STATE_KEY, RADIX_STATE_KEY, WaveformPanel } from './waveform/waveform-panel';
import { loadRequirement } from '../runtime/classroom';
import { CoreBackend } from './services/backend';
import { MixFpgaBackend } from './services/multiboard-backend';
import { type ConsoleVerbosity, NexysConsole } from './services/console';
import type { Logger } from './services/events';
import { NexysVhdlService } from './services/nexys-service';
import { ProjectState } from './services/project-state';
import { StatusBar } from './status/status-bar';
import { DESIGN_MODE_KEY, DESIGN_MODE_STATE_KEY, DesignView } from './views/design-view';
import { HardwareView } from './views/hardware-view';
import { ProjectView } from './views/project-view';
import { ResultsView } from './views/results-view';
import { WorkflowView } from './views/workflow-view';

/**
 * Composition root of the VS Code extension: a thin UI over the shared
 * Phase 3 core. VS Code API -> extension services (NexysVhdlService) ->
 * shared core (via runtime/) -> platform adapters. No tool or platform
 * logic lives here.
 */
/** What activate() returns: the service, for integration tests in an Extension Development Host. */
export interface NexysVhdlApi {
    readonly service: NexysVhdlService;
    readonly rtl: RtlPanel;
    readonly waveform: WaveformPanel;
    readonly schematic: SchematicPanel;
    /** NexysVHDL's own per-project workspace state (`.nexysvhdl/state.json`). */
    readonly state: ProjectState;
}

/** Completes pending NexysVHDL project writes; set by activate(), awaited by deactivate(). */
let shutdown: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<NexysVhdlApi> {
    // Two surfaces, one purpose each: the NexysVHDL Console is what a student reads (workflow progress, results, errors);
    // the NexysVHDL Log keeps the engineering detail (timestamps, diagnostic codes, log-file paths).
    const output = vscode.window.createOutputChannel('MIX-FPGA Log', { log: true });
    const consoleChannel = vscode.window.createOutputChannel('MIX-FPGA Console');
    const nexysConsole = new NexysConsole(
        { appendLine: (l) => consoleChannel.appendLine(l), reveal: () => consoleChannel.show(true) },
        () => (vscode.workspace.getConfiguration('nexysvhdl').get<string>('console.detail', 'normal') === 'detailed' ? 'detailed' : 'normal') satisfies ConsoleVerbosity,
    );
    const logger: Logger = { info: (m) => output.info(m), warn: (m) => output.warn(m), error: (m) => output.error(m) };
    const config = () => vscode.workspace.getConfiguration('nexysvhdl');

    // Classroom mode: FPGA tools come only from the separately versioned NexysVHDL toolchain
    // this release requires (installed once per user, shared by extension updates).
    const required = loadRequirement(context.extensionPath);
    for (const d of required.diagnostics) output.error(d.message);
    // MIX-FPGA: one backend that routes Check / Simulate / Build / Detect / Program to the open project's board.
    const backend = new MixFpgaBackend(new CoreBackend({ ...(required.requirement ? { classroom: { requirement: required.requirement } } : {}), onToolOutput: (text) => nexysConsole.raw(text) }));
    const service = new NexysVhdlService({ backend, logger, console: nexysConsole, checkOnSave: () => config().get<boolean>('checkOnSave', true) });
    const state = new ProjectState();
    // One Dark/Light choice for both schematics, kept with the project.
    const schematicAppearance = new AppearanceStore(state);
    const schematic = new SchematicPanel(service, context.extensionUri, state, schematicAppearance);
    const rtl = new RtlPanel(service, context.extensionUri, state, schematicAppearance);
    const waveform = new WaveformPanel(service, context.extensionUri, state);
    context.subscriptions.push(rtl, waveform);
    context.subscriptions.push(output, consoleChannel, { dispose: () => service.dispose() }, schematic, new ProblemsPublisher(service), new StatusBar(service));

    const design = new DesignView(service, state);
    context.subscriptions.push(state.onDidAttach(() => design.reload()));
    const views: Array<[string, vscode.TreeDataProvider<unknown> & vscode.Disposable]> = [
        ['nexysvhdl.project', new ProjectView(service)],
        ['nexysvhdl.design', design],
        ['nexysvhdl.workflow', new WorkflowView(service)],
        ['nexysvhdl.hardware', new HardwareView(service)],
        ['nexysvhdl.results', new ResultsView(service)],
    ];
    const setContext = (key: string, value: unknown) => void vscode.commands.executeCommand('setContext', key, value);
    const trees = new Map<string, vscode.TreeView<unknown>>();
    for (const [id, provider] of views) {
        const tree = vscode.window.createTreeView(id, { treeDataProvider: provider, showCollapseAll: id === 'nexysvhdl.design' });
        trees.set(id, tree);
        context.subscriptions.push(provider, tree);
        if (provider === design) {
            const showMode = (mode: string) => {
                tree.description = mode === 'hierarchy' ? 'Hierarchy' : 'Files';
                setContext(DESIGN_MODE_KEY, mode);
            };
            showMode(design.mode);
            context.subscriptions.push(design.onDidChangeMode(showMode));
        }
    }

    // A short status beside each section title (a supported header decoration), so the sections read as separate things at a glance.
    const describeSections = () => {
        const set = (id: string, text: string) => {
            const t = trees.get(id);
            if (t) t.description = text;
        };
        set('nexysvhdl.project', service.snapshot?.emptyProject ? 'empty project' : (service.project?.config.name ?? ''));
        const busy = service.busyAction;
        set('nexysvhdl.workflow', busy ? `${busy} running…` : '');
        const boards = service.hardware.boards.length;
        set('nexysvhdl.hardware', service.hardware.status === 'unknown' ? '' : service.hardware.status === 'detecting' ? 'looking…' : boards === 0 ? 'no board' : `${boards} board${boards === 1 ? '' : 's'}`);
    };
    context.subscriptions.push(service.onDidChange(describeSections));
    describeSections();

    // Optional classroom appearance: workspace scope only, the user's own theme is never written.
    const themeSettings: ThemeSettings = {
        workspaceTheme: () => vscode.workspace.getConfiguration('workbench').inspect<string>('colorTheme')?.workspaceValue,
        setWorkspaceTheme: (theme) => Promise.resolve(vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Workspace)),
    };
    const appearance = new AppearanceManager(themeSettings, context.workspaceState, context.globalState);

    // The NexysVHDL launcher asks for existing commands through vscode://emxplore.nexysvhdl/<route>.
    context.subscriptions.push(
        vscode.window.registerUriHandler({
            handleUri: (uri) => {
                const command = routeUri(uri.path);
                if (command) void vscode.commands.executeCommand(command);
                else output.appendLine(`Ignored an unknown link: ${uri.path}`);
            },
        }),
    );

    const setup = new SetupService({ extensionPath: context.extensionPath, hardware: () => hardwareViewOf(service.hardware) });
    registerCommands(context, { setup, service, backend, schematic, rtl, waveform, design, appearance, output, console: nexysConsole, extensionVersion: String((context.extension.packageJSON as { version?: string }).version ?? ''), flush: () => (shutdown ? shutdown() : Promise.resolve()) });

    let toolchainPrompted = false;
    context.subscriptions.push(
        service.onDidChange((k) => {
            if (k === 'workflow' || k === 'busy') setContext('nexysvhdl.busy', service.busyAction !== undefined);
            if (k === 'environment') {
                const state = service.environment?.toolchain?.state ?? 'unknown';
                setContext('nexysvhdl.toolchainState', state);
                if (state === 'not-installed' && !toolchainPrompted) {
                    toolchainPrompted = true;
                    // With board support (Apple-silicon Macs) a missing Nexys toolchain is not a problem by itself: only a computer with
                    // no board support at all is "new" and gets the welcome. Anything else is reachable from Show Environment.
                    void setup.controller().then(async (controller) => {
                        if (!controller) {
                            const c = await vscode.window.showInformationMessage(`MIX-FPGA needs its FPGA toolchain ${service.environment!.toolchain!.requiredVersion} before it can check, simulate or build designs.`, 'Install FPGA Toolchain…', 'Getting Started');
                            if (c) void vscode.commands.executeCommand(c === 'Getting Started' ? 'nexysvhdl.gettingStarted' : 'nexysvhdl.installToolchain');
                            return;
                        }
                        const { view } = await controller.status();
                        if (!view.fresh) return;
                        const c = await vscode.window.showInformationMessage('Welcome to MIX-FPGA. Choose the FPGA boards you will use to finish setting up.', 'Choose Boards…', 'Getting Started');
                        if (c) void vscode.commands.executeCommand(c === 'Getting Started' ? 'nexysvhdl.gettingStarted' : 'nexysvhdl.showEnvironment');
                    });
                }
            }
        }),
    );

    // Watch only the project's own files; generated output in .nexysvhdl/ is never watched.
    let watchers: vscode.Disposable[] = [];
    const watch = (root: string) => {
        watchers.forEach((w) => w.dispose());
        watchers = ['nexysvhdl.json', 'src/**/*.{vhd,vhdl}', 'sim/**/*.{vhd,vhdl}', 'constraints/**/*.{xdc,qsf,sdc}'].map((glob) => {
            const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, glob));
            const changed = (uri: vscode.Uri) => service.notifyFileEvent(uri.fsPath);
            w.onDidCreate(changed);
            w.onDidDelete(changed);
            w.onDidChange(changed);
            return w;
        });
    };
    context.subscriptions.push(
        { dispose: () => watchers.forEach((w) => w.dispose()) },
        vscode.workspace.onDidSaveTextDocument((doc) => doc.uri.scheme === 'file' && service.notifyFileSaved(doc.uri.fsPath)),
    );

    const detect = async () => {
        const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
        const root = await findProjectRoot(folders);
        setContext('nexysvhdl.hasProject', root !== undefined);
        if (!root || root === service.projectRoot) return;
        await service.open(root);
        // The remembered interface choices travel with the project; earlier versions kept them in VS Code's workspace storage.
        setContext('nexysvhdl.hasProjectFile', (await findNvprojFiles(root)).length > 0);
        await state.attach(root, { store: context.workspaceState, keys: [DESIGN_MODE_STATE_KEY, RADIX_STATE_KEY, LAYOUT_STATE_KEY] });
        watch(root);
        if (appearance.shouldAsk(config().get<boolean>('promptForClassroomAppearance', true))) {
            void vscode.window
                .showInformationMessage('MIX-FPGA has an optional Classroom appearance (navy and orange). It applies to this project folder only; your VS Code theme stays as it is everywhere else.', USE_CLASSROOM, KEEP_MINE)
                .then((choice) => appearance.answer(choice));
        }
        void service.refreshEnvironment();
        if (config().get<boolean>('detectBoardsOnOpen', true)) void service.detectBoards();
    };
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void detect()));

    // Save-before-exit. Changes are written as they happen (debounced); this makes sure nothing pending is lost.
    // Modified .vhd / .xdc editor buffers are NOT saved here: VS Code's own Save / Auto Save / prompt handles them.
    const flushAll = async () => {
        const results = await Promise.allSettled([service.flush(), state.flush()]);
        for (const r of results) if (r.status === 'rejected') output.appendLine(`[warn] Could not save project state: ${String((r.reason as Error)?.message ?? r.reason)}`);
    };
    shutdown = flushAll;
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((w) => {
            if (!w.focused) void flushAll(); // leaving the window is the last safe moment before a forced close
        }),
        { dispose: () => state.dispose() },
    );
    await detect();
    // The setup state matters with or without a project (welcome views, Getting Started).
    if (!service.projectRoot) void service.refreshEnvironment();
    return { service, rtl, waveform, schematic, state };
}

/** VS Code awaits this on shutdown, window close and reload: pending NexysVHDL project writes are completed first. */
export async function deactivate(): Promise<void> {
    const flush = shutdown;
    shutdown = undefined;
    await flush?.();
    /* everything else is disposed through context.subscriptions */
}
