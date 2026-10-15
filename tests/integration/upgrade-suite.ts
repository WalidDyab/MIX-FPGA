/**
 * NexysVHDL 0.6.0 -> MIX-FPGA 0.7.0 update validation inside a real VS Code (NOT part of `npm test`). Works against whichever version
 * is INSTALLED in the private extensions folder (run-phase6 with NEXYSVHDL_P6_EXTENSIONS_DIR / NEXYSVHDL_P6_HOST_DIR), so the same
 * session is run before and after the update. Uses only what both versions offer: activate, Check, Simulate, RTL Schematic, Environment.
 *   UPG_PHASE=<label>   names the report section and the file-hash record written beside the report
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { NexysVhdlApi } from '../../extension/extension';
import { EXTENSION_ID, log, report, step, waitFor } from './edh-suite';

async function hashes(root: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const e of await readdir(root, { withFileTypes: true, recursive: true })) {
        if (!e.isFile()) continue;
        const full = join(e.parentPath, e.name);
        const rel = full.slice(root.length + 1);
        if (rel.split('/').some((p) => p.startsWith('.') && p !== '.nvproj')) continue; // generated output (.nexysvhdl/, .mix-fpga/) is not the student's
        out[rel] = createHash('sha256').update(await readFile(full)).digest('hex');
    }
    return out;
}

export async function run(): Promise<void> {
    const out = process.env['NEXYS_EDH_REPORT']!;
    const phase = process.env['UPG_PHASE'] ?? 'run';
    try {
        const ext = vscode.extensions.getExtension<NexysVhdlApi>(EXTENSION_ID)!;
        const pkg = ext.packageJSON as { version: string; displayName: string; name: string; publisher: string };
        step('identity', { id: EXTENSION_ID, version: pkg.version, displayName: pkg.displayName, installedAt: ext.extensionPath });
        const { service } = await ext.activate();
        await waitFor('project open', () => service.project, 30_000);
        await service.refreshNow();
        const root = service.projectRoot!;
        const before = await hashes(root);
        step('project', { name: service.project?.config.name, board: service.project?.config.board, files: Object.keys(before).length });
        const cmds = await vscode.commands.getCommands(true);
        step('commands', { nexysvhdl: cmds.filter((c) => c.startsWith('nexysvhdl.')).length, hasSetup: cmds.includes('nexysvhdl.setup.install'), hasInstallToolchain: cmds.includes('nexysvhdl.installToolchain') });
        const env = await service.refreshEnvironment();
        step('environment', { headline: env?.headline, rows: env?.setup.map((r) => `${r.label}=${r.status}`) });
        await vscode.commands.executeCommand('nexysvhdl.check');
        await waitFor('check', () => (service.workflow.check.state === 'passed' || service.workflow.check.state === 'failed' ? service.workflow.check : undefined), 60_000);
        step('check', service.workflow.check);
        await vscode.commands.executeCommand('nexysvhdl.simulate');
        await waitFor('simulate', () => (service.workflow.simulate.state === 'passed' || service.workflow.simulate.state === 'failed' ? service.workflow.simulate : undefined), 90_000);
        step('simulate', service.workflow.simulate);
        await vscode.commands.executeCommand('nexysvhdl.openRtlSchematic');
        await waitFor('rtl', () => (service.rtl.status === 'ready' || service.rtl.status === 'failed' || service.rtl.status === 'unavailable' ? service.rtl : undefined), 90_000);
        step('rtl', { status: service.rtl.status });
        const after = await hashes(root);
        step('studentFilesUnchangedByTheSession', JSON.stringify(before) === JSON.stringify(after));
        if (process.env['UPG_HASHES']) await writeFile(process.env['UPG_HASHES'], JSON.stringify(after, null, 2));
        step('result', 'PASS');
    } catch (err) {
        step('result', `FAILED: ${(err as Error).stack ?? String(err)}`);
        throw err;
    } finally {
        await writeFile(out, JSON.stringify({ phase, report, log }, null, 2));
    }
}
