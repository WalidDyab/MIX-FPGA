import * as vscode from 'vscode';
import { registerCommands } from './commands/commands';
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
import { FilesView } from './views/files-view';
import { HardwareView } from './views/hardware-view';
import { HierarchyView } from './views/hierarchy-view';
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
    const waveform = new WaveformPanel(service, context.extensionUri);
    context.subscriptions.push(rtl, waveform);
    context.subscriptions.push(output, { dispose: () => service.dispose() }, schematic, new ProblemsPublisher(service), new StatusBar(service));

    const views: Array<[string, vscode.TreeDataProvider<unknown> & vscode.Disposable]> = [
        ['nexysvhdl.project', new ProjectView(service)],
        ['nexysvhdl.files', new FilesView(service)],
        ['nexysvhdl.hierarchy', new HierarchyView(service)],
        ['nexysvhdl.workflow', new WorkflowView(service)],
        ['nexysvhdl.hardware', new HardwareView(service)],
        ['nexysvhdl.results', new ResultsView(service)],
    ];
    for (const [id, provider] of views) {
        context.subscriptions.push(provider, vscode.window.createTreeView(id, { treeDataProvider: provider, showCollapseAll: id === 'nexysvhdl.hierarchy' }));
    }

    registerCommands(context, { service, backend, schematic, rtl, waveform, output, extensionVersion: String((context.extension.packageJSON as { version?: string }).version ?? '') });

    const setContext = (key: string, value: unknown) => void vscode.commands.executeCommand('setContext', key, value);
    let toolchainPrompted = false;
    context.subscriptions.push(
        service.onDidChange((k) => {
            if (k === 'workflow') setContext('nexysvhdl.busy', service.busy !== undefined);
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
