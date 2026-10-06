/**
 * Launches a real Extension Development Host for tests/integration/phase6-suite.ts.
 * NOT part of `npm test` (needs VS Code, the FPGA toolchain and a desktop).
 *
 *   node dist/tests/integration/run-phase6.js <Code executable> <workspace folder> <report.json> [screenshot marker folder]
 *
 * With NEXYSVHDL_P6_EXTENSIONS_DIR=<folder with the INSTALLED extension> and NEXYSVHDL_P6_HOST_DIR=<folder
 * with an empty package.json> the suite runs against that installed VSIX instead of the working tree.
 *
 * Uses a private user-data folder and extensions folder: the developer's own
 * VS Code settings, themes and extensions are never read or written.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageRoot } from '../../core';

const [code, workspace, reportFile, shots] = process.argv.slice(2);
if (!code || !workspace || !reportFile) {
    console.error('usage: run-phase6 <Code executable> <workspace folder> <report.json> [screenshot marker folder]');
    process.exit(2);
}
const env: NodeJS.ProcessEnv = { ...process.env, NEXYS_EDH_REPORT: reportFile, ...(shots ? { NEXYS_P6_SHOTS: shots } : {}) };
delete env['ELECTRON_RUN_AS_NODE'];
const installed = process.env['NEXYSVHDL_P6_EXTENSIONS_DIR'];
const userData = mkdtempSync(join(tmpdir(), 'nexys-p6-'));
const child = spawn(
    code,
    [
        workspace,
        // VS Code only runs an --extensionTestsPath suite next to an --extensionDevelopmentPath; for an installed
        // extension that is an empty host folder (NEXYSVHDL_P6_HOST_DIR), so the INSTALLED extension is the one tested.
        `--extensionDevelopmentPath=${installed ? (process.env['NEXYSVHDL_P6_HOST_DIR'] ?? packageRoot(__dirname)) : packageRoot(__dirname)}`,
        `--extensionTestsPath=${join(__dirname, 'phase6-suite.js')}`,
        `--user-data-dir=${join(userData, 'user')}`,
        `--extensions-dir=${installed ?? join(userData, 'extensions')}`,
        ...(installed ? [] : ['--disable-extensions']),
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--new-window',
    ],
    { stdio: 'inherit', env },
);
child.on('exit', (exitCode) => process.exit(exitCode ?? 1));
