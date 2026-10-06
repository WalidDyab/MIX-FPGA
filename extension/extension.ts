import * as vscode from 'vscode';
import { AppearanceManager, KEEP_MINE, type ThemeSettings, USE_CLASSROOM } from './appearance/appearance-manager';
import { registerCommands } from './commands/commands';
import { routeUri } from './commands/uri-routes';
import { ProblemsPublisher } from './diagnostics/vscode-diagnostics';
import { findProjectRoot } from './project/detect';
import { RtlPanel } from './rtl/rtl-panel';
import { SchematicPanel } from './schematic/schematic-panel';
import { WaveformPanel } from './waveform/waveform-panel';
import { loadRequirement } from '../runtime/classroom';
import { CoreBackend } from './services/backend';
import type { Logger } from './services/events';
import { NexysVhdlService } from './services/nexys-service';
import { StatusBar } from './status/status-bar';
import { DESIGN_MODE_KEY, DesignView } from './views/design-view';
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
}

export async function activate(context: vscode.ExtensionContext): Promise<NexysVhdlApi> {
    const output = vscode.window.createOutputChannel('NexysVHDL', { log: true });
    const logger: Logger = { info: (m) => output.info(m), warn: (m) => output.warn(m), error: (m) => output.error(m) };
    const config = () => vscode.workspace.getConfiguration('nexysvhdl');

    // Classroom mode: FPGA tools come only from the separately versioned NexysVHDL toolchain
    // this release requires (installed once per user, shared by extension updates).
    const required = loadRequirement(context.extensionPath);
    for (const d of required.diagnostics) output.error(d.message);
    const backend = new CoreBackend(required.requirement ? { classroom: { requirement: required.requirement } } : {});
    const service = new NexysVhdlService({ backend, logger, checkOnSave: () => config().get<boolean>('checkOnSave', true) });
    const schematic = new SchematicPanel(service);
    const rtl = new RtlPanel(service);
    const waveform = new WaveformPanel(service, context.extensionUri, context.workspaceState);
    context.subscriptions.push(rtl, waveform);
    context.subscriptions.push(output, { dispose: () => service.dispose() }, schematic, new ProblemsPublisher(service), new StatusBar(service));

    const design = new DesignView(service, context.workspaceState);
    const views: Array<[string, vscode.TreeDataProvider<unknown> & vscode.Disposable]> = [
        ['nexysvhdl.project', new ProjectView(service)],
        ['nexysvhdl.design', design],
        ['nexysvhdl.workflow', new WorkflowView(service)],
        ['nexysvhdl.hardware', new HardwareView(service)],
        ['nexysvhdl.results', new ResultsView(service)],
    ];
    const setContext = (key: string, value: unknown) => void vscode.commands.executeCommand('setContext', key, value);
    for (const [id, provider] of views) {
        const tree = vscode.window.createTreeView(id, { treeDataProvider: provider, showCollapseAll: id === 'nexysvhdl.design' });
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

    registerCommands(context, { service, backend, schematic, rtl, waveform, design, appearance, output, extensionVersion: String((context.extension.packageJSON as { version?: string }).version ?? '') });

    let toolchainPrompted = false;
    context.subscriptions.push(
        service.onDidChange((k) => {
            if (k === 'workflow' || k === 'busy') setContext('nexysvhdl.busy', service.busyAction !== undefined);
            if (k === 'environment') {
                const state = service.environment?.toolchain?.state ?? 'unknown';
                setContext('nexysvhdl.toolchainState', state);
                if (state === 'not-installed' && !toolchainPrompted) {
                    toolchainPrompted = true;
                    void vscode.window
                        .showInformationMessage(`NexysVHDL needs its FPGA toolchain ${service.environment!.toolchain!.requiredVersion} before it can check, simulate or build designs.`, 'Install FPGA Toolchain…', 'Getting Started')
                        .then((c) => c && vscode.commands.executeCommand(c === 'Getting Started' ? 'nexysvhdl.gettingStarted' : 'nexysvhdl.installToolchain'));
                }
            }
        }),
    );

    // Watch only the project's own files; generated output in .nexysvhdl/ is never watched.
    let watchers: vscode.Disposable[] = [];
    const watch = (root: string) => {
        watchers.forEach((w) => w.dispose());
        watchers = ['nexysvhdl.json', 'src/**/*.{vhd,vhdl}', 'sim/**/*.{vhd,vhdl}', 'constraints/**/*.xdc'].map((glob) => {
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
        watch(root);
        if (appearance.shouldAsk(config().get<boolean>('promptForClassroomAppearance', true))) {
            void vscode.window
                .showInformationMessage('NexysVHDL has an optional Classroom appearance (navy and orange). It applies to this project folder only; your VS Code theme stays as it is everywhere else.', USE_CLASSROOM, KEEP_MINE)
                .then((choice) => appearance.answer(choice));
        }
        void service.refreshEnvironment();
        if (config().get<boolean>('detectBoardsOnOpen', true)) void service.detectBoards();
    };
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void detect()));
    await detect();
    // The setup state matters with or without a project (welcome views, Getting Started).
    if (!service.projectRoot) void service.refreshEnvironment();
    return { service, rtl, waveform, schematic };
}

export function deactivate(): void {
    /* everything is disposed through context.subscriptions */
}
