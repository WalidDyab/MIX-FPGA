import { stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import type { AppearanceManager } from '../appearance/appearance-manager';
import { createNvprojFile, type Diagnostic, findNvprojFiles, LEGACY_BOARD_ID, normalizeStopTime, PROJECT_FILE_NAME, STOP_TIME_UNITS } from '../../core';
import {
    addFileKindsFor,
    type AddFileKind,
    type AddFileMode,
    checkCopySource,
    copyIntoProject,
    entityNameOf,
    findExisting,
    isConstraintKind,
    isSameFile,
    kindInfo,
    normalizeFileName,
    sourceSkeleton,
    suggestFreeName,
    targetPath,
    testbenchSkeleton,
    validateCopyName,
    validateFileName,
    writeNewFile,
} from '../project/add-file';
import { classifyProjectPath } from '../project/project-layout';
import { findOpenTab } from './open-existing';
import { resolveOpenTarget } from '../project/open-target';
import type { NexysConsole } from '../services/console';
import { de10StarterQsf, de10StarterSdc } from '../project/de10-templates';
import { starterXdc } from '../project/templates';
import { createProject, DEFAULT_TEMPLATE, PROJECT_TEMPLATES, type ProjectTemplate, validateProjectName } from '../project/scaffold';
import type { RtlPanel } from '../rtl/rtl-panel';
import type { SchematicPanel } from '../schematic/schematic-panel';
import type { WaveformPanel } from '../waveform/waveform-panel';
import type { NexysBackend } from '../services/backend';
import { boardRow, type SetupRow } from '../services/environment-summary';
import { NexysError, type NexysVhdlService } from '../services/nexys-service';
import { BUILD_STAGES } from '../services/workflow-state';
import type { Node } from '../views/base';
import type { DesignView } from '../views/design-view';
import type { HierarchyPayload } from '../views/hierarchy-view';
import type { SetupService } from '../setup/setup-service';
import { VsCodeSetupInteraction } from '../setup/setup-ui';
import { type BoardSupportId, isBoardSupportId, type SetupResult } from '../../runtime/setup';

export interface CommandDeps {
    readonly service: NexysVhdlService;
    readonly backend: NexysBackend;
    readonly schematic: SchematicPanel;
    readonly rtl: RtlPanel;
    readonly waveform: WaveformPanel;
    readonly design: DesignView;
    readonly appearance: AppearanceManager;
    readonly output: vscode.OutputChannel;
    /** The NexysVHDL Console (the student-facing record of workflow actions). */
    readonly console: NexysConsole;
    readonly extensionVersion: string;
    /** Completes every pending NexysVHDL write (project file and state.json) before the window leaves the project. */
    readonly flush: () => Promise<void>;
    /** Apple-silicon Macs with the Toolchain 1.0 manifest: the Setup page and its Install / Repair / Verify actions. */
    readonly setup?: SetupService;
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
        if (!rel.startsWith('..') && (classifyProjectPath(rel, 'xdc') || classifyProjectPath(rel, 'qsf-sdc'))) await doc.save();
    }
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
    const { service, backend, schematic, rtl, waveform, design, appearance, output, console: nexysConsole, extensionVersion, flush, setup } = deps;

    const sameFolder = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

    /**
     * Switches THIS window to a project folder. NexysVHDL's own state is flushed first; VS Code then replaces the window's folder
     * (no vscode:// link, no second window) and asks about unsaved source documents itself: NexysVHDL never saves or discards them.
     * The extension host restarts with the new folder, so nothing of the previous project survives into it.
     */
    const switchToProject = async (root: string): Promise<void> => {
        if (service.projectRoot && sameFolder(service.projectRoot, root)) {
            vscode.window.setStatusBarMessage('This project is already open.', 3000);
            return;
        }
        await flush();
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: false });
    };

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
                        void vscode.window.showErrorMessage(`MIX-FPGA: ${(err as Error).message}`, 'Show Log').then((c) => c && output.show());
                    }
                }
            }),
        );
    };

    /**
     * Shows a file in the editor, focusing the tab that already shows it (in whichever
     * editor group) instead of opening a second tab for the same file.
     */
    const showFile = async (uri: vscode.Uri, selection?: vscode.Range, beside = false): Promise<vscode.TextEditor> => {
        const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => ({ fsPath: t.input instanceof vscode.TabInputText ? t.input.uri.fsPath : undefined, viewColumn: g.viewColumn })));
        const open = findOpenTab(tabs, uri.fsPath);
        // `beside`: a file opened from the full-width schematic goes to the side, so the schematic stays in view.
        const column = open ? { viewColumn: open.viewColumn } : beside ? { viewColumn: vscode.ViewColumn.Beside } : {};
        return vscode.window.showTextDocument(uri, { preview: false, ...column, ...(selection ? { selection } : {}) });
    };

    const requireRoot = (): string => {
        const root = service.projectRoot;
        if (!root) throw new NexysError('Open a MIX-FPGA project first (MIX-FPGA: Open Project or Create Project).');
        return root;
    };

    // ------------------------------------------------------------- projects

    /**
     * Interactive (dialogs) by default. Scripted use (lab setup, validation) may pass
     * { parentDir, name, board? }: the same project is created without dialogs and not opened.
     */
    register('nexysvhdl.createProject', async (scripted?: { parentDir: string; name: string; board?: string; template?: ProjectTemplate }) => {
        const boards = await backend.boards();
        let parentDir = scripted?.parentDir;
        let name = scripted?.name;
        // Interactive creation always asks. Scripted creation (lab setup, tests) that names no board keeps the original Nexys A7 behaviour.
        let boardId = scripted?.board ?? (scripted ? LEGACY_BOARD_ID : undefined);
        let template: ProjectTemplate = scripted?.template ?? DEFAULT_TEMPLATE;
        if (!scripted) {
            const parent = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Create Project Here', title: 'MIX-FPGA: choose the folder that will contain the new project folder' });
            if (!parent?.[0]) return undefined;
            parentDir = parent[0].fsPath;
            name = await vscode.window.showInputBox({
                title: 'MIX-FPGA: project name',
                prompt: `A new folder with this name is created in ${parentDir}`,
                placeHolder: 'CounterDemo',
                validateInput: (v) => validateProjectName(v),
            });
            if (!name) return undefined;
            const pick = await vscode.window.showQuickPick(
                boards.all().filter((b) => backend.supportsBoard?.(b) !== false).map((b) => ({ label: b.displayName ?? b.name, description: `${b.fpga.device}`, id: b.id })),
                { title: 'New MIX-FPGA Project: board', placeHolder: 'Choose the FPGA board' },
            );
            if (!pick) return undefined;
            boardId = pick.id;
            // A board whose support is not installed yet: offer to install it, then continue with the project.
            const controller = await setup?.controller();
            if (controller && !(await controller.isBoardReady(boardId))) {
                const choice = await vscode.window.showWarningMessage(`${pick.label} support is not installed.`, { modal: true, detail: 'MIX-FPGA can install it now; the new project is created afterwards.' }, 'Install Support');
                if (choice !== 'Install Support') return undefined;
                const installed = await runSetup('install', isBoardSupportId(boardId) ? [boardId] : undefined);
                if (installed?.outcome !== 'complete' || !(await controller.isBoardReady(boardId))) return undefined;
            }
            const kind = await vscode.window.showQuickPick(
                PROJECT_TEMPLATES.map((t) => ({ label: `${t.recommended ? '$(file-directory)' : '$(lightbulb)'} ${t.label}`, description: t.description, template: t.template })),
                { title: 'MIX-FPGA: what should the new project contain?', placeHolder: 'Empty project or starter example' },
            );
            if (!kind) return undefined;
            template = kind.template;
        }
        const board = boardId ? boards.get(boardId) : undefined;
        if (!parentDir || !name || !board) throw new NexysError('Create Project needs a folder, a project name and a supported board.');
        const result = await createProject({ parentDir, name, board, template });
        if (!result.ok) {
            void vscode.window.showErrorMessage(result.message);
            return result;
        }
        output.appendLine(`Created project ${result.root}: ${result.files.join(', ')}`);
        if (!scripted) await switchToProject(result.root);
        return result;
    });

    /**
     * Open Project accepts a project folder (containing nexysvhdl.json) or a .nvproj project file. Interactive
     * by default; scripted use (lab setup) passes the path.
     */
    register('nexysvhdl.openProject', async (scripted?: string | { path: string }) => {
        let target: string | undefined = typeof scripted === 'string' ? scripted : scripted?.path;
        if (!target) {
            const kind = await vscode.window.showQuickPick(
                [
                    { label: '$(file) Project file (.nvproj)', description: 'recommended: the file named after your project', mode: 'file' as const },
                    { label: '$(folder) Project folder', description: 'a folder that contains nexysvhdl.json', mode: 'folder' as const },
                ],
                { title: 'MIX-FPGA: open a project', placeHolder: 'What do you want to open?' },
            );
            if (!kind) return undefined;
            const picked = await vscode.window.showOpenDialog(
                kind.mode === 'file'
                    ? { canSelectFolders: false, canSelectFiles: true, canSelectMany: false, openLabel: 'Open Project', title: 'MIX-FPGA: choose a project file', filters: { 'MIX-FPGA project': ['nvproj'] } }
                    : { canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Open Project', title: 'MIX-FPGA: choose a project folder (containing nexysvhdl.json)' },
            );
            target = picked?.[0]?.fsPath;
            if (!target) return undefined;
        }
        const resolved = await resolveOpenTarget(target);
        if (!resolved.ok) throw new NexysError(resolved.message);
        await switchToProject(resolved.root);
        return resolved;
    });

    /**
     * Adds <folder>.nvproj to a project that was made before project files existed. Never overwrites
     * anything and never changes the rest of the project.
     */
    register('nexysvhdl.createProjectFile', async () => {
        const root = requireRoot();
        const existing = await findNvprojFiles(root);
        if (existing.length > 0) {
            void vscode.window.showInformationMessage(`This project already has a project file: ${basename(existing[0]!)}.`);
            return { file: existing[0]!, created: false };
        }
        const r = await createNvprojFile(root);
        void vscode.commands.executeCommand('setContext', 'nexysvhdl.hasProjectFile', true);
        await service.refreshNow();
        nexysConsole.say('Project', `Created the project file ${basename(r.file)}. Double-click it to open this project.`);
        void vscode.window.showInformationMessage(`Created ${basename(r.file)}. Double-click it in your file manager to open this project with MIX-FPGA.`);
        return r;
    });

    /**
     * Close Project: NexysVHDL's state is flushed, then VS Code's own Close Folder runs: the window stays open and empty, the extension
     * restarts without a project, and VS Code handles any unsaved source documents (save / don't save / cancel) itself.
     */
    register('nexysvhdl.closeProject', async () => {
        requireRoot();
        await flush();
        await vscode.commands.executeCommand('workbench.action.closeFolder');
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
        await showFile(vscode.Uri.file(join(requireRoot(), PROJECT_FILE_NAME)));
    });

    register('nexysvhdl.openLocation', async (root: string, file: string, line?: number, col?: number, opts?: { beside?: boolean }) => {
        const uri = vscode.Uri.file(join(root, ...file.split('/')));
        const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (col ?? 1) - 1));
        await showFile(uri, new vscode.Range(pos, pos), opts?.beside === true);
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
        const name = await pickEntity('MIX-FPGA: top entity (from src/)', names, snap.project?.config.top);
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
        const name = candidates.length === 1 && node ? candidates[0] : await pickEntity('MIX-FPGA: testbench', candidates, service.project?.config.simulation?.testbench);
        if (name) await service.setTestbench(name);
    });

    /** Makes `path` the active XDC, first confirming the removal of a `pins` mapping. Returns whether it was applied. */
    const activateConstraints = async (path: string): Promise<boolean> => {
        let replacePins = false;
        if (service.project?.config.pins) {
            const ok = await vscode.window.showWarningMessage(
                `This project generates its constraints from "pins" in ${PROJECT_FILE_NAME}. Use ${path} instead? The "pins" setting will be removed.`,
                { modal: true },
                'Use XDC File',
            );
            if (!ok) return false;
            replacePins = true;
        }
        await service.useConstraints(path, replacePins);
        return true;
    };

    register('nexysvhdl.useConstraintsFile', async (node?: Node) => {
        requireRoot();
        const path = typeof node?.payload === 'string' ? node.payload : undefined;
        if (path) await activateConstraints(path);
    });

    // ------------------------------------------------------------- remove from project

    /**
     * Removes a file from the project (never from the disk). If the file is the top
     * entity, the selected testbench or the active XDC, that is said and handled
     * explicitly. Scripted: pass the project-relative path (and { confirm: true }).
     */
    register('nexysvhdl.removeFromProject', async (arg?: Node | string | { path: string; confirm?: boolean; constraints?: string | null }) => {
        requireRoot();
        const scripted = typeof arg === 'object' && arg !== null && 'path' in arg ? arg : undefined;
        const path = typeof arg === 'string' ? arg : scripted ? scripted.path : typeof (arg as Node | undefined)?.payload === 'string' ? ((arg as Node).payload as string) : undefined;
        if (!path) return undefined;
        const impact = service.removalImpact(path);
        const notes: string[] = [];
        if (impact.topEntity) notes.push(`It declares the top entity ${impact.topEntity}. The project will have no top entity until you choose another.`);
        if (impact.testbench) notes.push(`It declares the selected testbench ${impact.testbench}. No testbench will be selected.`);
        if (impact.constraints) notes.push('It is the constraints file in use. The project will have no constraints file, and Build needs one.');
        if (notes.length > 0 && !scripted?.confirm) {
            const go = await vscode.window.showWarningMessage(`Remove ${basename(path)} from the project?\n\n${notes.join('\n')}\n\nThe file stays on your computer.`, { modal: true }, 'Remove from Project');
            if (!go) return undefined;
        }
        const removed = await service.removeFromProject(path);
        if (removed.constraints) {
            const others = (service.snapshot?.files.constraints ?? []).filter((f) => f.path !== path);
            if (scripted) {
                if (scripted.constraints) await service.useConstraints(scripted.constraints);
            } else if (others.length > 0) {
                const pick = await vscode.window.showQuickPick(
                    [...others.map((f) => ({ label: f.name, description: f.path, path: f.path as string | undefined })), { label: 'Choose later', description: 'build stays unavailable until a constraints file is chosen', path: undefined }],
                    { title: 'MIX-FPGA: which constraints file should the project use now?' },
                );
                if (pick?.path) await service.useConstraints(pick.path);
            }
        }
        const message = `Removed ${basename(path)} from the project. The file is still on your computer.`;
        if (!scripted) {
            const more = removed.topEntity ? 'Choose Top Entity…' : removed.testbench ? 'Choose Testbench…' : undefined;
            void vscode.window.showInformationMessage(message, ...(more ? [more] : []), 'Undo').then((c) => {
                if (c === 'Undo') void service.restoreToProject(path);
                else if (c === 'Choose Top Entity…') void vscode.commands.executeCommand('nexysvhdl.setTopEntity');
                else if (c === 'Choose Testbench…') void vscode.commands.executeCommand('nexysvhdl.setTestbench');
            });
        }
        return removed;
    });

    register('nexysvhdl.restoreToProject', async (arg?: Node | string) => {
        requireRoot();
        const path = typeof arg === 'string' ? arg : typeof arg?.payload === 'string' ? arg.payload : undefined;
        if (path) await service.restoreToProject(path);
    });

    // ------------------------------------------------------------- design view

    register('nexysvhdl.useClassroomAppearance', async () => {
        requireRoot();
        await appearance.useClassroom();
        vscode.window.setStatusBarMessage('$(check) NexysVHDL Classroom appearance is on for this project folder', 4000);
    });

    register('nexysvhdl.useMyAppearance', async () => {
        requireRoot();
        await appearance.useMine();
        vscode.window.setStatusBarMessage('$(check) Back to your own VS Code appearance', 4000);
    });

    register('nexysvhdl.design.showFiles', () => design.setMode('files'));
    register('nexysvhdl.design.showHierarchy', () => design.setMode('hierarchy'));

    // ------------------------------------------------------------- add file

    /**
     * "+ Add File": what (Source / Simulation Testbench / Constraint), how
     * (Create New / Copy From Computer), then the rules in project/add-file.ts.
     * Interactive by default; scripted use (tests, lab setup) may pass
     * { kind, mode, name?, from?, collision?, activate? } to skip the dialogs.
     */
    interface AddFileScript {
        kind: AddFileKind;
        mode: AddFileMode;
        name?: string;
        from?: string;
        /** Several files to copy in at once. */
        froms?: string[];
        /** Answer to the name-collision question (applies to every collision of the batch). */
        collision?: 'replace' | 'rename' | 'skip' | 'cancel';
        /** New name used when the collision answer is 'rename' (single file). */
        renameTo?: string;
        /** Answer to "make the new XDC active?". */
        activate?: boolean;
        /** Answer to "which entity is the top?" when several were added to a project without one. */
        top?: string;
        open?: boolean;
    }
    register('nexysvhdl.addFile', async (script?: AddFileScript) => {
        const root = requireRoot();
        const infoOf = (k: AddFileKind) => kindInfo(k);

        // 1. What?
        let kind = script?.kind;
        if (!kind) {
            const pick = await vscode.window.showQuickPick(
                addFileKindsFor(service.snapshot?.constraintFormat ?? 'xdc').map((k) => ({ label: k.label, description: k.description, fileKind: k.kind })),
                { title: 'Add File (1 of 2): what are you adding?', placeHolder: 'Source, Simulation Testbench or Constraint' },
            );
            if (!pick) return undefined;
            kind = pick.fileKind;
        }
        // 2. How?
        let mode = script?.mode;
        if (!mode) {
            const pick = await vscode.window.showQuickPick(
                [
                    { label: '$(new-file) Create New', description: 'start from a skeleton', mode: 'new' as const },
                    { label: '$(file-symlink-file) Copy From Computer', description: `copy one or more existing ${infoOf(kind).extension} files into the project`, mode: 'copy' as const },
                ],
                { title: `Add File (2 of 2): ${infoOf(kind).label}`, placeHolder: 'Create a new file, or copy files from your computer' },
            );
            if (!pick) return undefined;
            mode = pick.mode;
        }
        const folder = infoOf(kind).folder;

        // 3. Which files? Create: one name. Copy: any number of files, each checked.
        const chosen: Array<{ from?: string; name: string }> = [];
        if (mode === 'new') {
            const typed =
                script?.name ??
                (await vscode.window.showInputBox({
                    title: `New ${infoOf(kind).label.toLowerCase()} (created in ${folder}/)`,
                    prompt: isConstraintKind(kind) ? `File name (the ${infoOf(kind).extension} extension is added for you)` : 'File name = entity name (the .vhd extension is added for you)',
                    placeHolder: kind === 'qsf' ? 'my_pins' : kind === 'sdc' ? 'my_clock' : kind === 'constraints' ? 'my_pins' : kind === 'simulation' ? 'alu_tb' : 'alu',
                    validateInput: (v) => validateFileName(kind!, v),
                }));
            if (typed === undefined) return undefined;
            const problem = validateFileName(kind, typed);
            if (problem) throw new NexysError(problem);
            chosen.push({ name: normalizeFileName(kind, typed) });
        } else {
            for (;;) {
                const picked: string[] =
                    script?.froms ??
                    (script?.from ? [script.from] : undefined) ??
                    (
                        (await vscode.window.showOpenDialog({
                            canSelectFiles: true,
                            canSelectFolders: false,
                            canSelectMany: true,
                            openLabel: 'Copy Into Project',
                            title: `Choose the ${infoOf(kind).extension} file${isConstraintKind(kind) ? 's' : '(s)'} to copy into ${folder}/ (select several with Ctrl or Shift)`,
                            filters: { [isConstraintKind(kind) ? `${infoOf(kind).extension.slice(1).toUpperCase()} constraints` : 'VHDL files']: [infoOf(kind).extension.slice(1)] },
                        })) ?? []
                    ).map((u) => u.fsPath);
                if (picked.length === 0) return undefined;
                const refused = picked.map((f) => ({ f, why: checkCopySource(kind!, f) })).filter((x) => x.why !== undefined);
                for (const f of picked) if (!checkCopySource(kind, f)) chosen.push({ from: f, name: basename(f) });
                if (refused.length > 0) {
                    const text = refused.map((x) => x.why).join('\n');
                    if (chosen.length === 0 && script) throw new NexysError(text);
                    void vscode.window.showWarningMessage(`${refused.length} file${refused.length === 1 ? ' was' : 's were'} not added:\n${text}`);
                }
                if (chosen.length > 0) break;
                if (script) return undefined;
                const again = await vscode.window.showErrorMessage('None of the chosen files can be added here.', 'Choose Other Files');
                if (!again) return undefined;
            }
        }

        // 4. Each file: bad name or a file of that name already there? Replace / Rename / Skip (Cancel stops the batch).
        const placed: string[] = [];
        const skipped: string[] = [];
        const replacedPaths: string[] = [];
        let stopped = false;
        let scriptedAnswer = script?.collision;
        for (const item of chosen) {
            let fileName = item.name;
            let replace = false;
            let sameFile = false;
            let skip = false;
            for (;;) {
                const rel = targetPath(kind, fileName);
                if (item.from && isSameFile(item.from, root, rel)) {
                    sameFile = true; // the chosen file already is the project's copy
                    break;
                }
                const badName = mode === 'copy' ? validateCopyName(kind, fileName) : validateFileName(kind, fileName);
                const existing = badName ? undefined : await findExisting(root, kind, fileName);
                if (!badName && !existing) break;
                let choice: string | undefined;
                if (badName) choice = 'Rename';
                else if (script) choice = scriptedAnswer === 'replace' ? 'Replace' : scriptedAnswer === 'rename' ? 'Rename' : scriptedAnswer === 'skip' ? 'Skip' : undefined;
                else choice = await vscode.window.showWarningMessage(`${existing} already exists. Replace it, add this file under another name, or skip it?`, { modal: true }, 'Replace', 'Rename', 'Skip');
                if (choice === 'Replace') {
                    replace = true;
                    break;
                }
                if (choice === 'Skip') {
                    skip = true;
                    break;
                }
                if (choice !== 'Rename') {
                    stopped = true;
                    break;
                }
                const suggestion = await suggestFreeName(root, kind, badName ? fileName.replace(/[^A-Za-z0-9_.-]/g, '_') : fileName);
                const renamed = script
                    ? (script.renameTo ?? suggestion)
                    : await vscode.window.showInputBox({
                          title: badName ? `Rename the file: ${badName}` : `Rename the file (${existing} already exists)`,
                          prompt: 'New file name',
                          value: suggestion,
                          validateInput: async (v) => {
                              const problem = mode === 'copy' ? validateCopyName(kind!, v) : validateFileName(kind!, v);
                              if (problem) return problem;
                              return (await findExisting(root, kind!, v)) ? 'A file with that name already exists.' : undefined;
                          },
                      });
                if (renamed === undefined) {
                    stopped = true;
                    break;
                }
                fileName = normalizeFileName(kind, renamed);
                scriptedAnswer = 'cancel'; // a scripted rename that still collides is a failure, not a loop
            }
            if (stopped) break;
            const rel = targetPath(kind, fileName);
            if (skip) {
                skipped.push(item.from ?? rel);
                continue;
            }
            // 5. Copy or write it into the project, so the project stays portable.
            if (!sameFile) {
                if (mode === 'copy') await copyIntoProject(root, rel, item.from!, replace);
                else {
                    let content: string;
                    if (kind === 'source') content = sourceSkeleton(entityNameOf(fileName));
                    else if (kind === 'simulation') content = testbenchSkeleton(entityNameOf(fileName));
                    else {
                        const board = (await backend.boards()).get(service.project?.config.board ?? '');
                        const projectName = service.project!.config.name;
                        if (kind === 'qsf') content = board ? de10StarterQsf(projectName, board, { starterPorts: false }) : '# Device, pin and I/O assignments.\n';
                        else if (kind === 'sdc') content = board ? de10StarterSdc(board, { starterPorts: false }) : '# create_clock lines here.\n';
                        else content = board ? starterXdc(projectName, board, { starterPorts: false }) : '## Pin and clock constraints. Add set_property and create_clock lines here.\n';
                    }
                    await writeNewFile(root, rel, content, replace);
                }
            }
            placed.push(rel);
            if (replace) replacedPaths.push(rel);
            output.appendLine(`Added ${rel} (${mode === 'copy' ? (sameFile ? 'already in the project' : `copied from ${item.from}`) : 'created'}${replace ? ', replaced the existing file' : ''}).`);
        }
        if (placed.length === 0) return undefined;

        // 6. One project update and one refresh for the whole batch (hierarchy recomputed once), then active constraints and the editor.
        const outcome = await service.filesAdded(kind, placed);
        let activated = outcome.constraints === 'activated';
        let top = outcome.top;
        if (outcome.topCandidates) {
            // Several entities arrived and the project has no top: never pick one arbitrarily.
            const leave = 'Leave unset for now';
            const pick = script
                ? (script.top && outcome.topCandidates.some((c) => c.toLowerCase() === script.top!.toLowerCase()) ? script.top : undefined)
                : (
                      await vscode.window.showQuickPick(
                          [...outcome.topCandidates.map((c) => ({ label: c })), { label: leave, description: 'the project keeps showing "No top entity is set" until you choose one' }],
                          { title: `${outcome.topCandidates.length} entities were added and the project has no top entity. Which one is the top?`, placeHolder: 'The top entity is what gets built for the FPGA' },
                      )
                  )?.label;
            if (pick && pick !== leave) {
                await service.setTop(pick);
                top = service.project?.config.top;
            }
        }
        if (outcome.constraints === 'ask') {
            const current = service.project?.config.constraints;
            const candidates = outcome.candidates ?? placed;
            const keep = current ? `The project currently uses ${basename(current)} for pin constraints.` : 'The project currently generates its constraints from "pins".';
            let chosenXdc: string | undefined;
            if (script) chosenXdc = script.activate === true ? candidates[0] : undefined;
            else if (candidates.length === 1) {
                const use = `Use ${basename(candidates[0]!)}`;
                if ((await vscode.window.showInformationMessage(`${basename(candidates[0]!)} was added. ${keep} Make it the active constraints file?`, use, 'Keep Current')) === use) chosenXdc = candidates[0];
            } else {
                const pick = await vscode.window.showQuickPick(
                    [...candidates.map((c) => ({ label: basename(c), description: c, path: c as string | undefined })), { label: 'Keep current', description: current ? basename(current) : 'generated from pins', path: undefined }],
                    { title: `${candidates.length} constraints files were added. ${keep} Which one should the project use?` },
                );
                chosenXdc = pick?.path;
            }
            if (chosenXdc) activated = await activateConstraints(chosenXdc);
        }
        if (script?.open !== false) await showFile(vscode.Uri.file(join(root, ...placed[0]!.split('/'))));
        const summary = placed.length === 1 ? placed[0]! : `${placed.length} files`;
        vscode.window.setStatusBarMessage(`$(check) Added ${summary}${skipped.length ? `, skipped ${skipped.length}` : ''}${activated ? ' (active constraints)' : ''}`, 4000);
        return { path: placed[0], paths: placed, skipped, kind, mode, replaced: replacedPaths.length > 0, activated, ...(outcome.testbench ? { testbench: outcome.testbench } : {}), ...(top ? { top } : {}), ...(outcome.topCandidates ? { topCandidates: outcome.topCandidates } : {}) };
    });

    /** Finite simulation length for GHDL's --stop-time. Scripted: { value: '1us' } or { value: null } to clear. */
    register('nexysvhdl.setSimulationStopTime', async (scripted?: { value: string | null }) => {
        requireRoot();
        const current = service.project?.config.simulation?.stopTime;
        let value: string | undefined;
        if (scripted) value = scripted.value ?? undefined;
        else {
            const pick = await vscode.window.showQuickPick(
                [
                    { label: 'Run until the testbench stops itself', description: `default${current ? '' : ' (current)'} — the testbench ends with std.env.stop`, fixed: false },
                    { label: 'Stop after a fixed time…', description: current ? `current: ${current}` : 'for a testbench with a free-running clock that never ends', fixed: true },
                ],
                { title: 'MIX-FPGA: simulation length', placeHolder: 'How long should Simulate run?' },
            );
            if (!pick) return undefined;
            if (pick.fixed) {
                const typed = await vscode.window.showInputBox({
                    title: 'MIX-FPGA: stop the simulation after',
                    prompt: `A whole number and a unit: ${STOP_TIME_UNITS.join(', ')}. Examples: 500ns, 1us, 2ms`,
                    value: current ?? '1us',
                    validateInput: (v) => (normalizeStopTime(v) ? undefined : `Use a whole number and one of: ${STOP_TIME_UNITS.join(', ')} (for example 1us).`),
                });
                if (typed === undefined) return undefined;
                value = typed;
            }
        }
        const written = await service.setStopTime(value);
        vscode.window.setStatusBarMessage(written ? `$(check) Simulation stops after ${written}` : '$(check) Simulation runs until the testbench stops', 4000);
        return written;
    });

    // ------------------------------------------------------------- workflow

    register('nexysvhdl.check', async () => {
        service.ensureFree('check');
        await saveProjectFiles(requireRoot());
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'MIX-FPGA: Checking VHDL' }, () => service.check());
        if (result.status === 'succeeded') {
            vscode.window.setStatusBarMessage('$(check) MIX-FPGA: No VHDL errors', 4000);
        } else if (result.status === 'not-configured') {
            void vscode.window.showWarningMessage('The VHDL tools are not set up on this computer.', 'Show Environment').then((c) => c && vscode.commands.executeCommand('nexysvhdl.showEnvironment'));
        } else {
            const n = result.diagnostics.filter((d) => d.severity === 'error').length;
            void vscode.window.showErrorMessage(`Check found ${n || 'some'} error${n === 1 ? '' : 's'}.`, 'Show Problems').then((c) => c && vscode.commands.executeCommand('workbench.actions.view.problems'));
        }
    });

    /**
     * Simulate: the waveform viewer opens (or is revealed: there is only ever one) at once and is the
     * simulation workspace; the run starts from time 0. `duration` is what the viewer's "Run for"
     * field holds: undefined leaves the project's setting alone, '' (or null) clears it so the
     * testbench decides, otherwise it becomes `simulation.stopTime`: the one project setting for it.
     */
    const simulateFlow = async (duration?: string | null): Promise<void> => {
        requireRoot();
        waveform.show();
        service.ensureFree('simulate');
        await saveProjectFiles(requireRoot());
        if (duration !== undefined) {
            const text = duration === null ? '' : duration.trim();
            const normalized = text === '' ? undefined : normalizeStopTime(text);
            if (text !== '' && normalized === undefined) throw new NexysError(`"${duration}" is not a valid simulation duration. Use a whole number and a unit (${STOP_TIME_UNITS.join(', ')}), for example 2us.`);
            if (normalized !== service.project?.config.simulation?.stopTime) await service.setStopTime(normalized);
        }
        let outcome = await service.simulate();
        if (outcome.kind === 'needs-testbench') {
            if (outcome.candidates.length === 0) throw new NexysError('No testbench was found: add a testbench (an entity without ports) to sim/.');
            const tb = outcome.candidates.length === 1 ? outcome.candidates[0] : await pickEntity('MIX-FPGA: which testbench?', [...outcome.candidates]);
            if (!tb) return;
            await service.setTestbench(tb);
            outcome = await service.simulate(tb);
        }
        if (outcome.kind !== 'done') return;
        const r = outcome.result;
        if (r.cancelled) {
            vscode.window.setStatusBarMessage(`$(debug-stop) Simulation stopped by user${r.vcd ? ' (partial waveform shown)' : ''}`, 5000);
        } else if (r.status === 'not-configured') {
            void vscode.window.showWarningMessage('The simulator is not set up on this computer.', 'Show Environment').then((c) => c && vscode.commands.executeCommand('nexysvhdl.showEnvironment'));
        } else if (r.status === 'succeeded' && r.passed) {
            vscode.window.setStatusBarMessage(`$(check) Simulation passed: ${service.workflow.simulate.summary ?? ''}`, 5000);
        } else if (r.diagnostics.some((d) => d.code === 'SIM_NO_END')) {
            void vscode.window.showErrorMessage('The simulation never ended. A testbench with a free-running clock must stop itself with "std.env.stop;", or choose a duration in "Run for" in the waveform viewer.', 'Show Console').then((c) => c && nexysConsole.show());
        } else {
            void vscode.window
                .showErrorMessage(`Simulation failed: ${firstError(r.diagnostics) ?? r.messages[r.messages.length - 1] ?? 'see the console'}`, 'Show Console', 'Show Problems')
                .then((c) => (c === 'Show Console' ? nexysConsole.show() : c ? vscode.commands.executeCommand('workbench.actions.view.problems') : undefined));
        }
    };

    register('nexysvhdl.simulate', () => simulateFlow());
    /** The viewer's Run button: Run for <duration> from time 0. */
    register('nexysvhdl.runSimulation', (arg?: { duration?: string | null }) => simulateFlow(arg?.duration));
    /** The viewer's Stop button: ends the running GHDL process, keeps the partial waveform, frees the project. */
    register('nexysvhdl.stopSimulation', () => {
        if (!service.stopSimulation()) vscode.window.setStatusBarMessage('No simulation is running.', 3000);
    });

    register('nexysvhdl.build', async () => {
        service.ensureFree('build');
        await saveProjectFiles(requireRoot());
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'MIX-FPGA Build', cancellable: true },
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
            const reason = (stage && w.stages[stage].summary) ?? firstError(result.diagnostics) ?? (result.timing?.passed === false ? 'timing not met' : 'see the console');
            void vscode.window.showErrorMessage(`Build failed${stage ? ` in ${STAGE_LABEL[stage]}` : ''}: ${reason}`, 'Show Problems', 'Show Console').then((c) => {
                if (c === 'Show Console') nexysConsole.show();
                else if (c) void vscode.commands.executeCommand('workbench.actions.view.problems');
            });
        }
    });

    register('nexysvhdl.program', async (opts?: { serial?: string; allowStale?: boolean }) => {
        requireRoot();
        service.ensureFree('program');
        let options = { ...(opts ?? {}) };
        for (;;) {
            const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'MIX-FPGA: Programming FPGA…' }, () => service.program(options));
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
                void vscode.window.showErrorMessage(`Programming failed: ${firstError(r.diagnostics) ?? 'see the console'}`, 'Detect Boards', 'Show Console').then((c) => {
                    if (c === 'Show Console') nexysConsole.show();
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
            const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'MIX-FPGA: Checking VHDL' }, () => service.check());
            if (r.status !== 'succeeded') {
                void vscode.window.showWarningMessage('Check did not pass, so the RTL schematic cannot be generated.', 'Show Problems').then((c) => c && vscode.commands.executeCommand('workbench.actions.view.problems'));
                return;
            }
        }
        await rtl.show();
    });

    register('nexysvhdl.openWaveform', () => {
        requireRoot();
        waveform.show(); // reveals the one viewer; before any run it shows how to start one
    });

    register('nexysvhdl.goToEntity', async (node?: Node) => {
        const root = requireRoot();
        const p = node?.payload as HierarchyPayload | undefined;
        if (p?.entityFile) await vscode.commands.executeCommand('nexysvhdl.openLocation', root, p.entityFile, p.entityLine, 1);
    });

    // ------------------------------------------------------------- environment & log

    register('nexysvhdl.showEnvironment', async () => {
        const summary = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'MIX-FPGA: Inspecting tools' }, () => service.refreshEnvironment());
        if (!summary) throw new NexysError('The environment could not be inspected; see the log.');
        // Apple-silicon Macs: the Setup page (Board Support and Environment) replaces the older list for every board.
        const controller = await setup?.controller();
        if (controller) return showSetupPage(controller);
        const rows = [...summary.setup, boardRow(service.hardware, summary.hardwareLabel)];
        const tc = summary.toolchain;
        type Item = vscode.QuickPickItem & { action?: () => unknown };
        const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
        const items: Item[] = [
            sep(`MIX-FPGA ${extensionVersion} — Classroom Preview`),
            { label: '$(pass) MIX-FPGA', description: `Ready — ${extensionVersion}` },
            ...rows.map((r) => ({ label: `${SETUP_ICON[r.state]} ${r.label}`, description: r.status, ...(r.detail ? { detail: r.detail } : {}) })),
            sep(`Status: ${summary.status}`),
        ];
        if (tc?.state === 'ready' || tc?.state === 'problem') items.push(sep(`MIX-FPGA Toolchain ${tc.installedVersion ?? tc.requiredVersion}${tc.platform ? ` — ${tc.platform}` : ''}`));
        else if (summary.engine) items.push(sep('Details'));
        else if (!tc) items.push(sep('Tools'));
        if (tc?.state !== 'not-installed') {
            for (const i of summary.engine ? summary.items : summary.items.slice(0, -1)) items.push({ label: `${i.ok ? (i.warn ? '$(warning)' : '$(pass)') : '$(error)'} ${i.label}`, description: `${i.detail}${i.ok && !i.warn ? '   Ready' : ''}` });
        }
        if (summary.problems.length && summary.level !== 'ready') items.push(sep('Notes'), ...summary.problems.map((p) => ({ label: `$(info) ${p}` })));
        items.push(sep('Actions'));
        if (tc && tc.state !== 'ready') items.push({ label: '$(desktop-download) Install FPGA Toolchain…', ...(tc.archiveName ? { description: tc.archiveName } : {}), action: () => vscode.commands.executeCommand('nexysvhdl.installToolchain') });
        const guide = summary.programmerGuide;
        if (guide && rows.some((r) => r.id === 'programmer' && r.state !== 'ready')) {
            items.push({ label: `$(link-external) How to install ${guide.name}`, ...(guide.instructions ? { detail: guide.instructions } : {}), action: () => guide.url && vscode.env.openExternal(vscode.Uri.parse(guide.url)) });
        }
        if (tc?.state === 'ready') items.push({ label: '$(verified) Verify Toolchain', description: 'checks every installed file', action: () => vscode.commands.executeCommand('nexysvhdl.verifyToolchain') });
        if (summary.engine) {
            items.push(
                { label: '$(verified) Verify Environment', description: 'checks the tools and proves the FPGA engine runs', action: () => vscode.commands.executeCommand('nexysvhdl.verifyEnvironment') },
                { label: '$(debug-restart) Restart FPGA Engine', description: 'stops and starts it again', action: () => vscode.commands.executeCommand('nexysvhdl.restartFpgaEngine') },
            );
        }
        items.push(
            { label: '$(book) Getting Started', action: () => vscode.commands.executeCommand('nexysvhdl.gettingStarted') },
            { label: '$(law) Third-Party Notices', action: () => vscode.commands.executeCommand('nexysvhdl.openThirdPartyNotices') },
            { label: '$(output) Engineering details (paths, versions) in the log', action: () => showEngineeringDetails() },
        );
        const pick = await vscode.window.showQuickPick(items, { title: 'MIX-FPGA Environment', placeHolder: summary.status, matchOnDescription: true });
        await pick?.action?.();
    });

    // ------------------------------------------------------------- Setup (Install / Repair / Verify) for boards with an FPGA engine

    const runSetup = async (kind: 'install' | 'repair', boards?: BoardSupportId[]): Promise<SetupResult | undefined> => {
        const controller = await setup?.controller();
        if (!controller) throw new NexysError('Setup is not available in this build of MIX-FPGA.');
        nexysConsole.begin('Environment', kind === 'install' ? 'Install Board Support' : 'Repair');
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: kind === 'install' ? 'MIX-FPGA: Installing board support' : 'MIX-FPGA: Repairing', cancellable: true }, async (progress, token) => {
            const abort = new AbortController();
            token.onCancellationRequested(() => abort.abort());
            const ui = new VsCodeSetupInteraction((m) => progress.report({ message: m }), (l) => nexysConsole.say('Environment', l));
            return kind === 'install' ? controller.install(ui, abort.signal, boards) : controller.repair(ui, abort.signal, boards);
        });
        if (result.outcome === 'complete') nexysConsole.pass('Environment', result.message);
        else nexysConsole.fail('Environment', result.message);
        nexysConsole.endAction();
        await service.refreshEnvironment();
        if (result.outcome === 'complete') void vscode.window.showInformationMessage(`MIX-FPGA: ${result.message}`);
        else if (result.outcome !== 'busy') void vscode.window.showWarningMessage(`MIX-FPGA: ${result.message}`, 'Show Console').then((c) => c && nexysConsole.show());
        return result;
    };

    const boardArg = (b: unknown): BoardSupportId[] | undefined => (isBoardSupportId(b) ? [b] : undefined);
    register('nexysvhdl.setup.install', (board?: unknown) => runSetup('install', boardArg(board)));
    register('nexysvhdl.setup.repair', (board?: unknown) => runSetup('repair', boardArg(board)));
    /** Upgrade from NexysVHDL: take its validated Nexys A7 tools over into MIX-FPGA (verified, APFS clone, no download). */
    register('nexysvhdl.setup.adoptNexys', async (scripted?: { dryRun?: boolean }) => {
        const controller = await setup?.controller();
        if (!controller) throw new NexysError('Setup is not available in this build of MIX-FPGA.');
        const out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'MIX-FPGA: Taking over your Nexys A7 tools (no download)', cancellable: false }, (progress) => controller.adoptNexysVhdl({ dryRun: scripted?.dryRun === true, progress: (m) => progress.report({ message: m }) }));
        nexysConsole.begin('Environment', 'Nexys A7 tools from NexysVHDL');
        nexysConsole.say('Environment', `${out.plan.status}: ${out.plan.reasons.join('; ')}${out.plan.files ? ` (${out.plan.files} files)` : ''}`);
        if (out.result) nexysConsole[out.result.ok ? 'pass' : 'fail']('Environment', out.result.message);
        nexysConsole.endAction();
        await service.refreshEnvironment();
        return out;
    });
    register('nexysvhdl.setup.verify', async () => {
        const controller = await setup?.controller();
        if (!controller) throw new NexysError('Setup is not available in this build of MIX-FPGA.');
        const v = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'MIX-FPGA: Verifying the environment (the FPGA engine may start)', cancellable: false }, () => controller.verify());
        nexysConsole.begin('Environment', 'Verify Environment');
        for (const st of v.steps) nexysConsole[st.ok ? 'say' : 'warning']('Environment', `${st.ok ? 'OK ' : 'FAIL'}  ${st.label}${st.detail ? ` — ${st.detail}` : ''}`);
        if (v.ok) nexysConsole.pass('Environment', 'PASS');
        else nexysConsole.fail('Environment', 'FAIL — see the lines above');
        nexysConsole.endAction();
        await service.refreshEnvironment();
        if (v.ok) void vscode.window.showInformationMessage('MIX-FPGA: the environment is ready.');
        else void vscode.window.showWarningMessage('MIX-FPGA: some parts of the environment need attention.', 'Repair', 'Show Console').then((c) => (c === 'Repair' ? vscode.commands.executeCommand('nexysvhdl.setup.repair') : c && nexysConsole.show()));
        return v;
    });

    /** The student's Setup page: four rows, three actions; technical detail only under Details. */
    const showSetupPage = async (controller: NonNullable<Awaited<ReturnType<NonNullable<typeof setup>['controller']>>>): Promise<void> => {
        const { view } = await controller.status();
        type Item = vscode.QuickPickItem & { action?: () => unknown };
        const ICON = { ready: '$(pass)', 'not-installed': '$(warning)', working: '$(sync)', 'needs-repair': '$(warning)', problem: '$(error)', 'not-connected': '$(circle-outline)', 'not-checked': '$(circle-outline)' } as const;
        const BOARD_ICON = { installed: '$(pass)', 'not-installed': '$(circle-outline)', installing: '$(sync)', incomplete: '$(warning)', 'needs-repair': '$(warning)', 'not-supported': '$(error)' } as const;
        const items: Item[] = [
            { label: `MIX-FPGA ${extensionVersion} — Board Support`, kind: vscode.QuickPickItemKind.Separator },
            ...view.boards.map((b): Item => {
                const act = view.actions.find((a) => a.board === b.id);
                return { label: `${BOARD_ICON[b.state]} ${b.name}`, description: b.word, ...(b.action ? { detail: `${act?.label ?? (b.action === 'install' ? 'Install' : 'Repair')} — ${act?.detail ?? ''}`, action: () => vscode.commands.executeCommand(`nexysvhdl.setup.${b.action}`, b.id) } : {}) };
            }),
            { label: 'Environment', kind: vscode.QuickPickItemKind.Separator },
            ...view.rows.map((r) => ({ label: `${ICON[r.state]} ${r.label}`, description: r.word, ...(r.hint ? { detail: r.hint } : {}) })),
            { label: 'Actions', kind: vscode.QuickPickItemKind.Separator },
            ...view.actions.filter((a) => !a.board).map((a): Item => ({ label: `${a.id === 'install' ? '$(desktop-download)' : a.id === 'repair' ? '$(tools)' : '$(verified)'} ${a.label}`, detail: a.detail, action: () => vscode.commands.executeCommand(`nexysvhdl.setup.${a.id}`, a.board) })),
            { label: '$(book) Getting Started', action: () => vscode.commands.executeCommand('nexysvhdl.gettingStarted') },
            { label: '$(law) Third-Party Notices', action: () => vscode.commands.executeCommand('nexysvhdl.openThirdPartyNotices') },
            { label: '$(output) Details in the Console', detail: 'Every part with its version and who supplies it.', action: () => { for (const d of view.details) nexysConsole.say('Environment', `${d.label}: ${d.word} — ${d.owner}${d.version ? `, ${d.version}` : ''}${d.note ? ` (${d.note})` : ''}`); nexysConsole.show(); } },
        ];
        const pick = await vscode.window.showQuickPick(items, { title: 'MIX-FPGA Setup', placeHolder: view.headline, matchOnDetail: true });
        await pick?.action?.();
    };

    /** Verify Environment: owned-tool integrity, then a real run of the FPGA engine (may start it). Only for boards that have an engine. */
    register('nexysvhdl.verifyEnvironment', async () => {
        const project = service.project;
        if (!project) throw new NexysError('Open a project first.');
        if (!backend.verifyEnvironment) throw new NexysError('This board has nothing to verify here. Use Verify Toolchain in the Environment page.');
        const v = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'MIX-FPGA: Verifying the environment (the FPGA engine may start)', cancellable: false }, () => backend.verifyEnvironment!(project));
        if (!v) throw new NexysError('This board has nothing to verify here. Use Verify Toolchain in the Environment page.');
        nexysConsole.begin('Environment', 'Verify Environment');
        for (const st of v.steps) nexysConsole[st.ok ? 'say' : 'warning']('Environment', `${st.ok ? 'OK ' : 'FAIL'}  ${st.label}${st.detail ? ` — ${st.detail}` : ''}`);
        if (v.ok) nexysConsole.pass('Environment', 'PASS');
        else nexysConsole.fail('Environment', 'FAIL — see the lines above');
        nexysConsole.endAction();
        await service.refreshEnvironment();
        if (v.ok) void vscode.window.showInformationMessage('MIX-FPGA: the environment is ready.');
        else void vscode.window.showWarningMessage('MIX-FPGA: some parts of the environment need attention.', 'Show Console').then((c) => c && output.show());
        return v;
    });

    /** Restart FPGA Engine: stops and starts the hidden engine again. The only engine control a student gets. */
    register('nexysvhdl.restartFpgaEngine', async () => {
        const project = service.project;
        if (!project) throw new NexysError('Open a project first.');
        if (!backend.restartEngine) throw new NexysError('This board has no FPGA engine to restart.');
        const s = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'MIX-FPGA: Restarting the FPGA engine', cancellable: false }, () => backend.restartEngine!(project));
        if (!s) throw new NexysError('This board has no FPGA engine to restart.');
        nexysConsole.begin('Environment', 'Restart FPGA Engine');
        if (s.state === 'running') nexysConsole.pass('Environment', 'FPGA engine restarted');
        else nexysConsole.fail('Environment', `FPGA engine: ${s.problems[0]?.message ?? s.state}`);
        nexysConsole.endAction();
        await service.refreshEnvironment();
        return s;
    });

    const showEngineeringDetails = () => {
        const report = service.environmentReport;
        output.appendLine(`MIX-FPGA ${extensionVersion} environment details:`);
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
            filters: { 'MIX-FPGA toolchain': ['gz'] },
            openLabel: 'Install Toolchain',
            title: `MIX-FPGA: choose the toolchain file${name ? ` (${name})` : ''}`,
        });
        if (!picked?.[0]) return undefined;
        const archive = picked[0].fsPath;
        nexysConsole.begin('Toolchain', `Installing the MIX-FPGA FPGA toolchain from ${basename(archive)}...`);
        const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing the MIX-FPGA FPGA toolchain', cancellable: true }, async (progress, token) => {
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
            for (const d of outcome.diagnostics) nexysConsole.error('Toolchain', d.message);
            nexysConsole.fail('Toolchain', 'FAIL');
            nexysConsole.endAction();
            void vscode.window.showErrorMessage(outcome.diagnostics[0]?.message ?? 'The toolchain could not be installed.', 'Show Console').then((c) => c && nexysConsole.show());
            return outcome;
        }
        nexysConsole.pass('Toolchain', `PASS — toolchain ${outcome.version} ${outcome.status === 'installed' ? 'installed' : 'was already installed'}`);
        nexysConsole.endAction();
        output.appendLine(`Toolchain ${outcome.version} ${outcome.status === 'installed' ? 'installed' : 'was already installed'} at ${outcome.location}`);
        await service.refreshEnvironment();
        const done = outcome.status === 'installed' ? `MIX-FPGA FPGA toolchain ${outcome.version} installed.` : `MIX-FPGA FPGA toolchain ${outcome.version} is already installed.`;
        void vscode.window.showInformationMessage(done, 'Show Environment').then((c) => c && vscode.commands.executeCommand('nexysvhdl.showEnvironment'));
        return outcome;
    });

    register('nexysvhdl.verifyToolchain', async () => {
        const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'MIX-FPGA: verifying the toolchain' }, async (progress) => {
            let n = 0;
            return backend.verifyToolchain(() => {
                if (++n % 500 === 0) progress.report({ message: `${n.toLocaleString('en-US')} files checked` });
            });
        });
        if (r.ok) void vscode.window.showInformationMessage(`MIX-FPGA toolchain verified: all ${r.files?.toLocaleString('en-US') ?? ''} files are unchanged.`);
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

    register('nexysvhdl.showConsole', () => nexysConsole.show());

    /** Removes the diagnostics NexysVHDL published (its own collection only); the Console and the Log are not cleared. */
    register('nexysvhdl.clearProblems', () => {
        service.clearProblems();
        vscode.window.setStatusBarMessage('$(check) MIX-FPGA problems cleared', 3000);
    });

    /** Switches the Console between the short student-readable output and the full streamed tool output. */
    register('nexysvhdl.toggleConsoleDetail', async () => {
        const config = vscode.workspace.getConfiguration('nexysvhdl');
        const next = config.get<string>('console.detail', 'normal') === 'detailed' ? 'normal' : 'detailed';
        await config.update('console.detail', next, vscode.ConfigurationTarget.Global);
        nexysConsole.say('Project', next === 'detailed' ? 'Detailed output is ON: the raw output of the FPGA tools is shown while actions run.' : 'Detailed output is OFF: the Console shows progress and results only.');
        nexysConsole.show();
        return next;
    });
}
