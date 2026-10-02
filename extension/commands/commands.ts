import { stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { type Diagnostic, PROJECT_FILE_NAME } from '../../core';
import { classifyProjectPath } from '../project/project-layout';
import { createProject, validateProjectName } from '../project/scaffold';
import type { RtlPanel } from '../rtl/rtl-panel';
import type { SchematicPanel } from '../schematic/schematic-panel';
import type { WaveformPanel } from '../waveform/waveform-panel';
import type { NexysBackend } from '../services/backend';
import { boardRow, type SetupRow } from '../services/environment-summary';
import { NexysError, type NexysVhdlService } from '../services/nexys-service';
import { BUILD_STAGES } from '../services/workflow-state';
import type { Node } from '../views/base';
import type { HierarchyPayload } from '../views/hierarchy-view';

export interface CommandDeps {
    readonly service: NexysVhdlService;
    readonly backend: NexysBackend;
    readonly schematic: SchematicPanel;
    readonly rtl: RtlPanel;
    readonly waveform: WaveformPanel;
    readonly output: vscode.OutputChannel;
    readonly extensionVersion: string;
}

const SETUP_ICON: Record<SetupRow['state'], string> = {
    ready: '$(pass)',
    'setup-required': '$(warning)',
    problem: '$(error)',
    'not-connected': '$(circle-outline)',
    'not-checked': '$(circle-outline)',
};

const STAGE_LABEL = { synthesis: 'Synthesis', implementation: 'Implementation', bitstream: 'Bitstream' } as const;

function firstError(diagnostics: readonly Diagnostic[]): string | undefined {
    return diagnostics.find((d) => d.severity === 'error')?.message;
}

/** Saves dirty editors that belong to the project (VHDL, XDC, nexysvhdl.json) before an action. */
async function saveProjectFiles(root: string): Promise<void> {
    for (const doc of vscode.workspace.textDocuments) {
        if (!doc.isDirty || doc.uri.scheme !== 'file') continue;
        const rel = relative(root, doc.uri.fsPath).split(sep).join('/');
        if (!rel.startsWith('..') && classifyProjectPath(rel)) await doc.save();
    }
}

async function openFolder(root: string): Promise<void> {
    const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    let forceNewWindow = false;
    if (hasWorkspace) {
        const choice = await vscode.window.showInformationMessage(`Open project ${root.split(/[\\/]/).pop()}?`, 'Open in This Window', 'Open in New Window');
        if (!choice) return;
        forceNewWindow = choice === 'Open in New Window';
    }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow });
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
    const { service, backend, schematic, rtl, waveform, output, extensionVersion } = deps;

    /** Wraps a handler: NexysErrors become friendly messages, anything else is logged too. The handler's result is returned. */
    const register = (id: string, handler: (...args: never[]) => unknown) => {
        context.subscriptions.push(
            vscode.commands.registerCommand(id, async (...args: never[]) => {
                try {
                    return await handler(...args);
                } catch (err) {
                    if (err instanceof NexysError) void vscode.window.showWarningMessage(err.message);
                    else {
                        output.appendLine(`[error] ${id}: ${(err as Error).stack ?? String(err)}`);
                        void vscode.window.showErrorMessage(`NexysVHDL: ${(err as Error).message}`, 'Show Log').then((c) => c && output.show());
                    }
                }
            }),
        );
    };

    const requireRoot = (): string => {
        const root = service.projectRoot;
        if (!root) throw new NexysError('Open a NexysVHDL project first (NexysVHDL: Open Project or Create Project).');
        return root;
    };

    // ------------------------------------------------------------- projects

    /**
     * Interactive (dialogs) by default. Scripted use (lab setup, validation) may pass
     * { parentDir, name, board? }: the same project is created without dialogs and not opened.
     */
    register('nexysvhdl.createProject', async (scripted?: { parentDir: string; name: string; board?: string }) => {
        const boards = await backend.boards();
        let parentDir = scripted?.parentDir;
        let name = scripted?.name;
        let boardId = scripted?.board ?? (scripted ? boards.all()[0]?.id : undefined);
        if (!scripted) {
            const parent = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Create Project Here', title: 'NexysVHDL: choose the folder that will contain the new project folder' });
            if (!parent?.[0]) return undefined;
            parentDir = parent[0].fsPath;
            name = await vscode.window.showInputBox({
                title: 'NexysVHDL: project name',
                prompt: `A new folder with this name is created in ${parentDir}`,
                placeHolder: 'CounterDemo',
                validateInput: (v) => validateProjectName(v),
            });
            if (!name) return undefined;
            const pick = await vscode.window.showQuickPick(
                boards.all().map((b) => ({ label: b.name, description: `${b.fpga.device}`, id: b.id })),
                { title: 'NexysVHDL: board', placeHolder: 'Choose the FPGA board' },
            );
            if (!pick) return undefined;
            boardId = pick.id;
        }
        const board = boardId ? boards.get(boardId) : undefined;
        if (!parentDir || !name || !board) throw new NexysError('Create Project needs a folder, a project name and a supported board.');
        const result = await createProject({ parentDir, name, board });
        if (!result.ok) {
            void vscode.window.showErrorMessage(result.message);
            return result;
        }
        output.appendLine(`Created project ${result.root}: ${result.files.join(', ')}`);
        if (!scripted) await openFolder(result.root);
        return result;
    });

    register('nexysvhdl.openProject', async () => {
        const folder = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Open Project', title: 'NexysVHDL: choose a project folder (containing nexysvhdl.json)' });
        if (!folder?.[0]) return;
        try {
            await stat(join(folder[0].fsPath, PROJECT_FILE_NAME));
        } catch {
            throw new NexysError(`${folder[0].fsPath} has no ${PROJECT_FILE_NAME}. Choose a NexysVHDL project folder, or use Create Project.`);
        }
        await openFolder(folder[0].fsPath);
    });

    register('nexysvhdl.refreshProject', async () => {
        requireRoot();
        await service.refreshNow();
        void service.refreshEnvironment();
    });

    register('nexysvhdl.refreshHierarchy', async () => {
        requireRoot();
        await service.refreshNow();
        vscode.window.setStatusBarMessage('$(check) Design hierarchy refreshed', 2500);
    });

    register('nexysvhdl.openProjectSettings', async () => {
        await vscode.window.showTextDocument(vscode.Uri.file(join(requireRoot(), PROJECT_FILE_NAME)));
    });

    register('nexysvhdl.openLocation', async (root: string, file: string, line?: number, col?: number) => {
        const uri = vscode.Uri.file(join(root, ...file.split('/')));
        const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (col ?? 1) - 1));
        await vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos), preview: true });
    });

    const pickEntity = async (title: string, names: string[], current?: string): Promise<string | undefined> => {
        if (names.length === 0) throw new NexysError('No entities were found.');
        const pick = await vscode.window.showQuickPick(
            names.map((n) => ({ label: n, ...(current && n.toLowerCase() === current.toLowerCase() ? { description: 'current' } : {}) })),
            { title },
        );
        return pick?.label;
    };

    register('nexysvhdl.setTopEntity', async () => {
        requireRoot();
        const snap = service.snapshot!;
        const names = snap.index.entitiesIn('source').map((e) => e.decl.name);
        const name = await pickEntity('NexysVHDL: top entity (from src/)', names, snap.project?.config.top);
        if (name) await service.setTop(name);
    });

    register('nexysvhdl.setTopEntityFromItem', async (node?: Node) => {
        requireRoot();
        const payload = node?.payload;
        if (payload && typeof payload === 'object' && 'entity' in payload) {
            await service.setTop((payload as HierarchyPayload).entity);
            return;
        }
        if (typeof payload === 'string') {
            // A file in Project Files: its entity, or a choice if it has several.
            const entities = service.snapshot!.index.entitiesInFile(payload).map((e) => e.name);
            if (entities.length === 0) throw new NexysError(`${payload} declares no entity.`);
            const name = entities.length === 1 ? entities[0] : await pickEntity(`Top entity from ${payload}`, entities);
            if (name) await service.setTop(name);
        }
    });

    register('nexysvhdl.setTestbench', async (node?: Node) => {
        requireRoot();
        let candidates = service.testbenchCandidates();
        if (typeof node?.payload === 'string') {
            const inFile = new Set(service.snapshot!.index.entitiesInFile(node.payload).map((e) => e.name));
            candidates = candidates.filter((c) => inFile.has(c));
        }
        if (candidates.length === 0) throw new NexysError('No testbench was found: a testbench is an entity without ports in sim/.');
        const name = candidates.length === 1 && node ? candidates[0] : await pickEntity('NexysVHDL: testbench', candidates, service.project?.config.simulation?.testbench);
        if (name) await service.setTestbench(name);
    });

    register('nexysvhdl.useConstraintsFile', async (node?: Node) => {
        requireRoot();
        const path = typeof node?.payload === 'string' ? node.payload : undefined;
        if (!path) return;
        let replacePins = false;
        if (service.project?.config.pins) {
            const ok = await vscode.window.showWarningMessage(
                `This project generates its constraints from "pins" in ${PROJECT_FILE_NAME}. Use ${path} instead? The "pins" setting will be removed.`,
                { modal: true },
                'Use XDC File',
            );
            if (!ok) return;
            replacePins = true;
        }
        await service.useConstraints(path, replacePins);
    });

    // ------------------------------------------------------------- workflow

    register('nexysvhdl.check', async () => {
        await saveProjectFiles(requireRoot());
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'NexysVHDL: Checking VHDL' }, () => service.check());
        if (result.status === 'succeeded') {
            vscode.window.setStatusBarMessage('$(check) NexysVHDL: No VHDL errors', 4000);
        } else if (result.status === 'not-configured') {
            void vscode.window.showWarningMessage('The VHDL tools are not set up on this computer.', 'Show Environment').then((c) => c && vscode.commands.executeCommand('nexysvhdl.showEnvironment'));
        } else {
            const n = result.diagnostics.filter((d) => d.severity === 'error').length;
            void vscode.window.showErrorMessage(`Check found ${n || 'some'} error${n === 1 ? '' : 's'}.`, 'Show Problems').then((c) => c && vscode.commands.executeCommand('workbench.actions.view.problems'));
        }
    });

    register('nexysvhdl.simulate', async () => {
        await saveProjectFiles(requireRoot());
        let outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'NexysVHDL: Simulating' }, () => service.simulate());
        if (outcome.kind === 'needs-testbench') {
            if (outcome.candidates.length === 0) throw new NexysError('No testbench was found: add a testbench (an entity without ports) to sim/.');
            const tb = outcome.candidates.length === 1 ? outcome.candidates[0] : await pickEntity('NexysVHDL: which testbench?', [...outcome.candidates]);
            if (!tb) return;
            await service.setTestbench(tb);
            outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'NexysVHDL: Simulating' }, () => service.simulate(tb));
        }
        if (outcome.kind !== 'done') return;
        const r = outcome.result;
        const after = (c: string | undefined) => {
            if (c === 'Open Waveform') void vscode.commands.executeCommand('nexysvhdl.openWaveform');
            else if (c === 'View Log') output.show();
            else if (c) void vscode.commands.executeCommand('workbench.actions.view.problems');
        };
        if (r.status === 'not-configured') {
            void vscode.window.showWarningMessage('The simulator is not set up on this computer.', 'Show Environment').then((c) => c && vscode.commands.executeCommand('nexysvhdl.showEnvironment'));
        } else if (r.status === 'succeeded' && r.passed) {
            void vscode.window.showInformationMessage(`Simulation passed: ${service.workflow.simulate.summary ?? ''}`, ...(r.vcd ? ['Open Waveform'] : []), 'View Log').then(after);
        } else {
            void vscode.window.showErrorMessage(`Simulation failed: ${firstError(r.diagnostics) ?? r.messages[r.messages.length - 1] ?? 'see the log'}`, ...(r.vcd ? ['Open Waveform'] : []), 'View Log', 'Show Problems').then(after);
        }
    });

    register('nexysvhdl.build', async () => {
        await saveProjectFiles(requireRoot());
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'NexysVHDL Build', cancellable: true },
            async (progress, token) => {
                token.onCancellationRequested(() => service.cancel());
                let last: string | undefined;
                const sub = service.onDidChange((k) => {
                    if (k !== 'workflow') return;
                    const stage = BUILD_STAGES.find((id) => service.workflow.stages[id].state === 'running');
                    if (stage && stage !== last) {
                        last = stage;
                        progress.report({ message: `${STAGE_LABEL[stage]}…` });
                    }
                });
                try {
                    return await service.build();
                } finally {
                    sub.dispose();
                }
            },
        );
        const w = service.workflow;
        if (result.success) {
            const clock = result.timing?.clocks[0];
            const timing = result.timing?.passed !== undefined ? ` Timing ${result.timing.passed ? 'PASS' : 'FAIL'}${clock?.achievedMHz ? ` (${Math.round(clock.achievedMHz * 100) / 100} MHz)` : ''}.` : '';
            void vscode.window.showInformationMessage(`Build complete.${timing}`, 'Program FPGA', 'Show Results').then((c) => {
                if (c === 'Program FPGA') void vscode.commands.executeCommand('nexysvhdl.program');
                else if (c) void vscode.commands.executeCommand('nexysvhdl.results.focus');
            });
        } else if (w.build.state === 'unavailable') {
            void vscode.window.showWarningMessage('The FPGA build tools are not set up on this computer.', 'Show Environment').then((c) => c && vscode.commands.executeCommand('nexysvhdl.showEnvironment'));
        } else if (w.build.summary !== 'Cancelled') {
            const stage = BUILD_STAGES.find((id) => w.stages[id].state === 'failed');
            const reason = (stage && w.stages[stage].summary) ?? firstError(result.diagnostics) ?? (result.timing?.passed === false ? 'timing not met' : 'see the log');
            void vscode.window.showErrorMessage(`Build failed${stage ? ` in ${STAGE_LABEL[stage]}` : ''}: ${reason}`, 'Show Problems', 'View Log').then((c) => {
                if (c === 'View Log') output.show();
                else if (c) void vscode.commands.executeCommand('workbench.actions.view.problems');
            });
        }
    });

    register('nexysvhdl.program', async (opts?: { serial?: string; allowStale?: boolean }) => {
        requireRoot();
        let options = { ...(opts ?? {}) };
        for (;;) {
            const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'NexysVHDL: Programming FPGA…' }, () => service.program(options));
            if (outcome.kind === 'blocked') {
                void vscode.window.showWarningMessage(outcome.message, 'Build').then((c) => c && vscode.commands.executeCommand('nexysvhdl.build'));
                return;
            }
            if (outcome.kind === 'stale') {
                const c = await vscode.window.showWarningMessage(
                    `The bitstream was built at ${outcome.builtAt.toLocaleTimeString()}, before your latest changes. Program it anyway?`,
                    { modal: true },
                    'Program Anyway',
                    'Build First',
                );
                if (c === 'Build First') void vscode.commands.executeCommand('nexysvhdl.build');
                if (c !== 'Program Anyway') return;
                options = { ...options, allowStale: true };
                continue;
            }
            if (outcome.kind === 'needs-board') {
                const pick = await vscode.window.showQuickPick(
                    outcome.boards.map((b) => ({ label: b.serial, description: b.label })),
                    { title: 'Several boards are connected: which one should be programmed?' },
                );
                if (!pick) return;
                service.selectBoard(pick.label);
                options = { ...options, serial: pick.label };
                continue;
            }
            const r = outcome.result;
            if (r.status === 'succeeded') {
                void vscode.window.showInformationMessage(`FPGA programmed${r.target?.serialNumber ? ` (${r.target.serialNumber})` : ''}. The design stays loaded until the board is switched off.`);
            } else if (r.status === 'not-configured') {
                void vscode.window.showWarningMessage('The board programmer is not set up on this computer.', 'Show Environment').then((c) => c && vscode.commands.executeCommand('nexysvhdl.showEnvironment'));
            } else {
                void vscode.window.showErrorMessage(`Programming failed: ${firstError(r.diagnostics) ?? 'see the log'}`, 'Detect Boards', 'View Log').then((c) => {
                    if (c === 'View Log') output.show();
                    else if (c) void vscode.commands.executeCommand('nexysvhdl.detectBoards');
                });
            }
            void service.detectBoards();
            return;
        }
    });

    register('nexysvhdl.cancel', () => service.cancel());

    // ------------------------------------------------------------- hardware

    register('nexysvhdl.detectBoards', async () => {
        requireRoot();
        await service.detectBoards();
    });

    register('nexysvhdl.selectBoard', (serial?: string | Node) => {
        const s = typeof serial === 'string' ? serial : undefined;
        if (s) service.selectBoard(s);
    });

    // ------------------------------------------------------------- schematic & navigation

    register('nexysvhdl.openSchematic', () => {
        requireRoot();
        schematic.show();
    });

    register('nexysvhdl.openSchematicFromItem', (node?: Node) => {
        requireRoot();
        const p = node?.payload as HierarchyPayload | undefined;
        schematic.show(p?.id);
    });

    register('nexysvhdl.openRtlSchematic', async () => {
        const root = requireRoot();
        const check = service.workflow.check.state;
        if (check === 'failed') {
            const c = await vscode.window.showWarningMessage('Check found errors. Fix them first: the RTL schematic is generated from VHDL that checks without errors.', 'Show Problems');
            if (c) void vscode.commands.executeCommand('workbench.actions.view.problems');
            return;
        }
        if (check !== 'passed') {
            // Not checked yet in this session: check first, then show the RTL.
            await saveProjectFiles(root);
            const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'NexysVHDL: Checking VHDL' }, () => service.check());
            if (r.status !== 'succeeded') {
                void vscode.window.showWarningMessage('Check did not pass, so the RTL schematic cannot be generated.', 'Show Problems').then((c) => c && vscode.commands.executeCommand('workbench.actions.view.problems'));
                return;
            }
        }
        await rtl.show();
    });

    register('nexysvhdl.openWaveform', async () => {
        requireRoot();
        if (!service.lastSimulation) {
            const c = await vscode.window.showInformationMessage('There is no waveform yet: run Simulate first.', 'Simulate');
            if (c) await vscode.commands.executeCommand('nexysvhdl.simulate');
            if (!service.lastSimulation) return;
        }
        waveform.show();
    });

    register('nexysvhdl.goToEntity', async (node?: Node) => {
        const root = requireRoot();
        const p = node?.payload as HierarchyPayload | undefined;
        if (p?.entityFile) await vscode.commands.executeCommand('nexysvhdl.openLocation', root, p.entityFile, p.entityLine, 1);
    });

    // ------------------------------------------------------------- environment & log

    register('nexysvhdl.showEnvironment', async () => {
        const summary = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'NexysVHDL: Inspecting tools' }, () => service.refreshEnvironment());
        if (!summary) throw new NexysError('The environment could not be inspected; see the log.');
        const rows = [...summary.setup, boardRow(service.hardware)];
        const tc = summary.toolchain;
        type Item = vscode.QuickPickItem & { action?: () => unknown };
        const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
        const items: Item[] = [
            sep(`NexysVHDL ${extensionVersion} — Classroom Preview`),
            { label: '$(pass) Extension', description: `Ready — ${extensionVersion}` },
            ...rows.map((r) => ({ label: `${SETUP_ICON[r.state]} ${r.label}`, description: r.status, ...(r.detail ? { detail: r.detail } : {}) })),
            sep(`Status: ${summary.status}`),
        ];
        if (tc?.state === 'ready' || tc?.state === 'problem') items.push(sep(`NexysVHDL Toolchain ${tc.installedVersion ?? tc.requiredVersion}${tc.platform ? ` — ${tc.platform}` : ''}`));
        else if (!tc) items.push(sep('Tools'));
        if (tc?.state !== 'not-installed') {
            for (const i of summary.items.slice(0, -1)) items.push({ label: `${i.ok ? (i.warn ? '$(warning)' : '$(pass)') : '$(error)'} ${i.label}`, description: `${i.detail}${i.ok && !i.warn ? '   Ready' : ''}` });
        }
        if (summary.problems.length && summary.level !== 'ready') items.push(sep('Notes'), ...summary.problems.map((p) => ({ label: `$(info) ${p}` })));
        items.push(sep('Actions'));
        if (tc && tc.state !== 'ready') items.push({ label: '$(desktop-download) Install FPGA Toolchain…', ...(tc.archiveName ? { description: tc.archiveName } : {}), action: () => vscode.commands.executeCommand('nexysvhdl.installToolchain') });
        const guide = summary.programmerGuide;
        if (guide && rows.some((r) => r.id === 'programmer' && r.state !== 'ready')) {
            items.push({ label: `$(link-external) How to install ${guide.name}`, ...(guide.instructions ? { detail: guide.instructions } : {}), action: () => guide.url && vscode.env.openExternal(vscode.Uri.parse(guide.url)) });
        }
        if (tc?.state === 'ready') items.push({ label: '$(verified) Verify Toolchain', description: 'checks every installed file', action: () => vscode.commands.executeCommand('nexysvhdl.verifyToolchain') });
        items.push(
            { label: '$(book) Getting Started', action: () => vscode.commands.executeCommand('nexysvhdl.gettingStarted') },
            { label: '$(law) Third-Party Notices', action: () => vscode.commands.executeCommand('nexysvhdl.openThirdPartyNotices') },
            { label: '$(output) Engineering details (paths, versions) in the log', action: () => showEngineeringDetails() },
        );
        const pick = await vscode.window.showQuickPick(items, { title: 'NexysVHDL Environment', placeHolder: summary.status, matchOnDescription: true });
        await pick?.action?.();
    });

    const showEngineeringDetails = () => {
        const report = service.environmentReport;
        output.appendLine(`NexysVHDL ${extensionVersion} environment details:`);
        const c = report?.classroom;
        if (c) {
            output.appendLine('  Mode: classroom (bundled toolchain only; no PATH or system FPGA tools)');
            output.appendLine(`  Required toolchain: ${c.requirement.bundleVersion} for ${c.target} (content ${c.requirement.targets[c.target]?.treeSha256 ?? 'n/a'})`);
            output.appendLine(`  Data root: ${c.dataRoot ?? 'unknown'}`);
            if (c.installed) output.appendLine(`  Toolchain folder: ${c.installed.paths.versionDir} (${c.installed.status})`);
            if (c.installed) output.appendLine(`  Tool state folder: ${c.installed.paths.stateDir}`);
            if (c.installed?.status === 'installed') output.appendLine(`  Installed: ${c.installed.marker.installedAt} from ${c.installed.marker.source}, ${c.installed.marker.files} files`);
            for (const comp of c.resolution?.manifest?.components ?? []) output.appendLine(`  Component ${comp.id} ${comp.version} (${comp.license}) ${comp.content.files} files, tree ${comp.content.treeSha256}`);
        }
        for (const t of report?.toolchain.tools ?? []) output.appendLine(`  ${t.tool}: ${t.status} — ${t.reason}${t.detected?.path ? ` — ${t.detected.path}` : ''}${t.detected?.method ? ` (${t.detected.method})` : ''}`);
        if (report?.programmer) output.appendLine(`  Programmer: ${report.programmer.displayName} — ${report.programmer.availability.detail}`);
        for (const d of report?.diagnostics ?? []) output.appendLine(`  [${d.code}] ${d.message}`);
        output.show();
    };

    /** Interactive by default; scripted use (lab setup, validation) may pass the archive path. Returns the outcome. */
    register('nexysvhdl.installToolchain', async (scriptedArchive?: string) => {
        const name = await backend.toolchainArchiveName();
        const picked = typeof scriptedArchive === 'string' ? [vscode.Uri.file(scriptedArchive)] : await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'NexysVHDL toolchain': ['gz'] },
            openLabel: 'Install Toolchain',
            title: `NexysVHDL: choose the toolchain file${name ? ` (${name})` : ''}`,
        });
        if (!picked?.[0]) return undefined;
        const archive = picked[0].fsPath;
        const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing the NexysVHDL FPGA toolchain', cancellable: true }, async (progress, token) => {
            const abort = new AbortController();
            token.onCancellationRequested(() => abort.abort());
            let shown = 0;
            return backend.installToolchain(
                archive,
                (fraction, message) => {
                    if (fraction === undefined) return progress.report({ message });
                    const pct = Math.round(fraction * 100);
                    progress.report({ increment: pct - shown, message: `${pct}% (${message})` });
                    shown = pct;
                },
                abort.signal,
            );
        });
        for (const d of outcome.diagnostics) output.appendLine(`[toolchain] ${d.message}`);
        if (outcome.status === 'failed') {
            void vscode.window.showErrorMessage(outcome.diagnostics[0]?.message ?? 'The toolchain could not be installed.', 'Show Log').then((c) => c && output.show());
            return outcome;
        }
        output.appendLine(`Toolchain ${outcome.version} ${outcome.status === 'installed' ? 'installed' : 'was already installed'} at ${outcome.location}`);
        await service.refreshEnvironment();
        const done = outcome.status === 'installed' ? `NexysVHDL FPGA toolchain ${outcome.version} installed.` : `NexysVHDL FPGA toolchain ${outcome.version} is already installed.`;
        void vscode.window.showInformationMessage(done, 'Show Environment').then((c) => c && vscode.commands.executeCommand('nexysvhdl.showEnvironment'));
        return outcome;
    });

    register('nexysvhdl.verifyToolchain', async () => {
        const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'NexysVHDL: verifying the toolchain' }, async (progress) => {
            let n = 0;
            return backend.verifyToolchain(() => {
                if (++n % 500 === 0) progress.report({ message: `${n.toLocaleString('en-US')} files checked` });
            });
        });
        if (r.ok) void vscode.window.showInformationMessage(`NexysVHDL toolchain verified: all ${r.files?.toLocaleString('en-US') ?? ''} files are unchanged.`);
        else void vscode.window.showErrorMessage(r.diagnostics[0]?.message ?? 'The toolchain could not be verified.');
        return r;
    });

    register('nexysvhdl.gettingStarted', async () => {
        await vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#nexysvhdl.gettingStarted`, false);
    });

    register('nexysvhdl.openThirdPartyNotices', async () => {
        const files = [join(context.extensionPath, 'THIRD_PARTY_NOTICES.md')];
        const location = service.environment?.toolchain?.location;
        if (location) files.push(join(location, 'THIRD_PARTY_NOTICES.md'));
        for (const f of files) {
            try {
                await stat(f);
                await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(f));
            } catch {
                /* a notices file that is not there (toolchain not installed) is skipped */
            }
        }
    });

    register('nexysvhdl.showLog', () => output.show());
}
