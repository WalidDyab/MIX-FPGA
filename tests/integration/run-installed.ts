/**
 * Installed-package validation driver (NOT part of `npm test`; needs VS Code,
 * a desktop and the classroom distribution). Behaves like a student machine:
 * a private VS Code profile and extensions folder, NexysVHDL installed from
 * its .vsix, a private LOCALAPPDATA (so the per-user toolchain store starts
 * empty), a PATH reduced to the operating-system folders, and deliberately
 * hostile settings (APIO_HOME pointing at the developer's ~/.apio, a bogus
 * PYTHONPATH) that NexysVHDL must ignore.
 *
 *   node dist/tests/integration/run-installed.js install <work dir> <vsix>
 *   node dist/tests/integration/run-installed.js run <work dir> <setup|project|update> <report.json> [folder]
 *
 * Environment: NEXYS_VSCODE (VS Code install folder, default %LOCALAPPDATA%\Programs\Microsoft VS Code),
 * NEXYS_ARCHIVE (toolchain archive for the setup phase).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [command, work, ...rest] = process.argv.slice(2);
if (!command || !work) {
    console.error('usage: run-installed install <work dir> <vsix> | run <work dir> <phase> <report.json> [folder]');
    process.exit(2);
}
const vscodeDir = process.env['NEXYS_VSCODE'] ?? join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Microsoft VS Code');
const dirs = { user: join(work, 'user-data'), extensions: join(work, 'extensions'), localAppData: join(work, 'LocalAppData'), students: join(work, 'students'), harness: join(work, 'validation-harness') };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

if (command === 'install') {
    const vsix = rest[0]!;
    // What bin\code.cmd does, without a shell: Code.exe as Node running VS Code's CLI.
    const cli = readFileSync(join(vscodeDir, 'bin', 'code.cmd'), 'utf8').match(/%~dp0\.\.\\([^"]*cli\.js)/)?.[1];
    if (!cli) throw new Error('cannot find the VS Code CLI entry point');
    const r = spawnSync(join(vscodeDir, 'Code.exe'), [join(vscodeDir, cli), '--user-data-dir', dirs.user, '--extensions-dir', dirs.extensions, '--install-extension', vsix, '--force'], {
        stdio: 'inherit',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' },
    });
    process.exit(r.status ?? 1);
}

const [phase, reportFile, folder] = rest;
// A trivial development extension that only hosts the test entry point; NexysVHDL itself is the installed .vsix.
writeFileSync(join(dirs.harness, 'package.json'), JSON.stringify({ name: 'nexysvhdl-validation-harness', publisher: 'validation', version: '0.0.1', engines: { vscode: '^1.120.0' } }, null, 2));

const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
const env: NodeJS.ProcessEnv = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(path|apio_.*|python.*|nexysvhdl_.*|electron_run_as_node)$/i.test(k)) env[k] = v;
Object.assign(env, {
    // Only the operating system: no developer Python, Git, MSYS2, GHDL or Apio on PATH.
    PATH: [join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32', 'Wbem'), vscodeDir].join(';'),
    LOCALAPPDATA: dirs.localAppData,
    // Hostile settings NexysVHDL must ignore.
    APIO_HOME: join(homedir(), '.apio'),
    PYTHONPATH: 'C:\\Python314\\Lib',
    NEXYSVHDL_GHDL: 'C:\\does-not-exist\\ghdl.exe',
    NEXYS_PHASE: phase,
    NEXYS_REPORT: reportFile,
    NEXYS_PARENT: dirs.students,
});
const child = spawn(
    join(vscodeDir, 'Code.exe'),
    [
        ...(folder ? [folder] : []),
        `--extensionDevelopmentPath=${dirs.harness}`,
        `--extensionTestsPath=${join(__dirname, 'installed-suite.js')}`,
        `--user-data-dir=${dirs.user}`,
        `--extensions-dir=${dirs.extensions}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-updates',
    ],
    { stdio: 'inherit', env },
);
child.on('exit', (code) => process.exit(code ?? 1));
