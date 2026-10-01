/**
 * Launches a real Extension Development Host for tests/integration/edh-suite.ts.
 * NOT part of `npm test` (needs VS Code, the FPGA toolchain and a desktop).
 *
 *   node dist/tests/integration/run-edh.js <Code executable> <phase> <workspace folder> <report.json>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageRoot } from '../../core';

const [code, phase, workspace, reportFile] = process.argv.slice(2);
if (!code || !phase || !workspace || !reportFile) {
    console.error('usage: run-edh <Code executable> <create|project> <workspace folder> <report.json>');
    process.exit(2);
}
const env: NodeJS.ProcessEnv = { ...process.env, NEXYS_EDH_PHASE: phase, NEXYS_EDH_REPORT: reportFile };
delete env['ELECTRON_RUN_AS_NODE'];
const userData = mkdtempSync(join(tmpdir(), 'nexys-edh-'));
const child = spawn(
    code,
    [
        workspace,
        `--extensionDevelopmentPath=${packageRoot(__dirname)}`,
        `--extensionTestsPath=${join(__dirname, 'edh-suite.js')}`,
        `--user-data-dir=${join(userData, 'user')}`,
        // A private extensions folder: the host never touches the developer's installed extensions.
        `--extensions-dir=${join(userData, 'extensions')}`,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
    ],
    { stdio: 'inherit', env },
);
child.on('exit', (exitCode) => process.exit(exitCode ?? 1));
