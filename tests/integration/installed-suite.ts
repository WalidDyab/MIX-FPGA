/**
 * Installed-package validation (NOT part of `npm test`): runs inside a real
 * VS Code where NexysVHDL is installed from its .vsix into a private
 * extensions folder. Started by tests/integration/run-installed.ts through
 * VS Code's --extensionTestsPath entry point, with a trivial, separate
 * "validation harness" as the development extension: NexysVHDL itself is
 * never loaded with --extensionDevelopmentPath. Never programs a board.
 *
 *   NEXYS_PHASE=setup    empty window: Show Environment state, Getting Started,
 *                        Install FPGA Toolchain (dialog scripted), Create Project
 *   NEXYS_PHASE=project  the created project: the full Phase 4A workflow
 *   NEXYS_PHASE=update   empty window after installing a newer extension version:
 *                        the installed toolchain is reused untouched
 *   NEXYS_REPORT=<file>  JSON report
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import type { NexysVhdlApi } from '../../extension/extension';
import { EXTENSION_ID, log, projectPhase, report, step, tree, waitFor } from './edh-suite';

function nexysExtension(): vscode.Extension<NexysVhdlApi> {
    const ext = vscode.extensions.getExtension<NexysVhdlApi>(EXTENSION_ID);
    if (!ext) throw new Error(`${EXTENSION_ID} is not installed in this profile`);
    return ext;
}

/** Where every loaded NexysVHDL module came from (proof that nothing loads from the repository). */
function loadedModules(extensionPath: string) {
    const keys = Object.keys(require.cache);
    // VS Code may report the drive letter in another case than require.cache does.
    const within = (k: string) => k.toLowerCase().startsWith((extensionPath + sep).toLowerCase());
    const inside = keys.filter(within);
    const nexysLike = keys.filter((k) => /[\\/]dist[\\/](core|platform|runtime|extension)[\\/]/.test(k));
    return {
        extensionPath,
        fromInstalledExtension: inside.length,
        nexysModulesOutsideInstall: nexysLike.filter((k) => !within(k)),
        typeScriptSources: keys.filter((k) => k.endsWith('.ts')),
        sample: inside.slice(0, 3).map((k) => relative(extensionPath.toLowerCase(), k.toLowerCase())),
    };
}

function identity(ext: vscode.Extension<NexysVhdlApi>) {
    const pkg = ext.packageJSON as { version: string; contributes: { grammars: Array<{ path: string }> } };
    return {
        id: ext.id,
        version: pkg.version,
        extensionPath: ext.extensionPath,
        grammar: join(ext.extensionPath, pkg.contributes.grammars[0]!.path),
        extensionKind: ext.extensionKind,
    };
}

async function setupPhase(): Promise<void> {
    const ext = nexysExtension();
    step('identity', identity(ext));
    step('activeBeforeUse', ext.isActive);
    const { service } = await ext.activate();
    step('modulesAfterActivation', loadedModules(ext.extensionPath));
    const commands = (await vscode.commands.getCommands(true)).filter((c) => c.startsWith('nexysvhdl.')).sort();
    step('commands', commands);

    const before = await service.refreshEnvironment();
    step('environment.beforeToolchain', { headline: before?.headline, status: before?.status, toolchain: before?.toolchain, setup: before?.setup, problems: before?.problems });

    // Getting Started (native walkthrough).
    await vscode.commands.executeCommand('nexysvhdl.gettingStarted');
    await new Promise((r) => setTimeout(r, 1500));
    step('gettingStarted.tabs', vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label)));

    // Install FPGA Toolchain… — the command's own code path, with the archive passed instead of
    // picked in the file dialog (another extension's dialog cannot be scripted).
    const archive = process.env['NEXYS_ARCHIVE']!;
    const started = Date.now();
    const installed = (await vscode.commands.executeCommand('nexysvhdl.installToolchain', archive)) as { status: string; version?: string; location?: string; diagnostics: unknown[] } | undefined;
    step('installToolchain', { outcome: installed, seconds: Math.round((Date.now() - started) / 100) / 10 });
    const after = service.environment;
    const rep = service.environmentReport;
    step('environment.afterInstall', {
        headline: after?.headline,
        status: after?.status,
        toolchain: after?.toolchain,
        setup: after?.setup,
        items: after?.items.map((i) => `${i.label}: ${i.ok ? 'ok' : 'missing'} ${i.detail}`),
        tools: rep?.toolchain.tools.map((t) => ({ tool: t.tool, status: t.status, version: t.detected?.version, path: t.detected?.path, method: t.detected?.method })),
        dataRoot: rep?.classroom?.dataRoot,
        stateDir: rep?.classroom?.installed?.paths.stateDir,
        bundleEnvironment: rep?.classroom?.toolchain ? Object.fromEntries(Object.entries(rep.classroom.toolchain.environment).filter(([, v]) => v !== undefined)) : undefined,
    });
    // A second install of the same version is a no-op.
    step('installToolchain.again', await vscode.commands.executeCommand('nexysvhdl.installToolchain', archive));

    // Create Project, scripted, in the student folder outside the repository.
    const parent = process.env['NEXYS_PARENT']!;
    const created = await vscode.commands.executeCommand('nexysvhdl.createProject', { parentDir: parent, name: 'StudentDemo' });
    step('createProject.result', created);
    const duplicate = await vscode.commands.executeCommand('nexysvhdl.createProject', { parentDir: parent, name: 'StudentDemo' });
    step('createProject.duplicate', duplicate);
    step('createProject.tree', await tree(join(parent, 'StudentDemo')));
    step('createProject.nexysvhdlJson', JSON.parse(await readFile(join(parent, 'StudentDemo', 'nexysvhdl.json'), 'utf8')));
    step('modulesAtEnd', loadedModules(ext.extensionPath));
}

async function projectPhaseInstalled(): Promise<void> {
    const ext = nexysExtension();
    step('identity', identity(ext));
    await projectPhase();
    const { service } = await ext.activate();
    // Results view model and setup rows after the workflow.
    const b = service.lastBuild;
    step('results', b ? { success: b.success, timing: b.timing, utilization: b.utilization, bitstream: b.bitstream && { size: b.bitstream.sizeBytes }, logs: b.logs.map((l) => l.label) } : 'no build');
    const env = service.environment;
    step('setupAfterWorkflow', { status: env?.status, setup: env?.setup, hardware: service.hardware.status });
    // Verify Toolchain: every installed file still matches the validated content after Check/RTL/Simulate/Build.
    step('verifyToolchainAfterWorkflow', await vscode.commands.executeCommand('nexysvhdl.verifyToolchain'));
    step('modulesAtEnd', loadedModules(ext.extensionPath));
}

async function updatePhase(): Promise<void> {
    const ext = nexysExtension();
    step('identity', identity(ext));
    const { service } = await ext.activate();
    const env = await service.refreshEnvironment();
    const rep = service.environmentReport;
    const marker = rep?.classroom?.installed?.status === 'installed' ? rep.classroom.installed.marker : undefined;
    step('environment', { headline: env?.headline, status: env?.status, toolchain: env?.toolchain, setup: env?.setup });
    step('reusedToolchain', {
        versionDir: rep?.classroom?.installed?.paths.versionDir,
        marker,
        markerMtime: rep?.classroom?.installed ? (await stat(join(rep.classroom.installed.paths.versionDir, '.nexysvhdl-installed.json'))).mtime.toISOString() : undefined,
    });
    step('modulesAtEnd', loadedModules(ext.extensionPath));
}

export async function run(): Promise<void> {
    const phase = process.env['NEXYS_PHASE'];
    const out = process.env['NEXYS_REPORT']!;
    step('process', { pathVariable: process.env['PATH'] ?? process.env['Path'], apioHomeVariable: process.env['APIO_HOME'], localAppData: process.env['LOCALAPPDATA'], vscode: vscode.version });
    try {
        if (phase === 'setup') await setupPhase();
        else if (phase === 'update') await updatePhase();
        else await projectPhaseInstalled();
        report['result'] = 'completed';
    } catch (err) {
        report['result'] = `FAILED: ${(err as Error).stack ?? String(err)}`;
    }
    await writeFile(out, JSON.stringify({ report, log }, null, 2));
    await waitFor('report written', () => true);
    if (String(report['result']).startsWith('FAILED')) throw new Error(String(report['result']));
}
