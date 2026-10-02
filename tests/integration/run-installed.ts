/**
 * Installed-package validation driver (NOT part of `npm test`; needs VS Code,
 * a desktop and the classroom distribution). Behaves like a student machine:
 * a private VS Code profile and extensions folder, NexysVHDL installed from
 * its .vsix, a PATH reduced to the operating-system folders, and deliberately
 * hostile settings (APIO_HOME pointing at the developer's ~/.apio, a bogus
 * PYTHONPATH, NEXYSVHDL_* overrides) that NexysVHDL must ignore.
 *
 * Windows: a private LOCALAPPDATA, so the per-user toolchain store starts empty.
 * macOS: the store is the real ~/Library/NexysVHDL (derived from HOME, as for a
 * student; Apio refuses a HOME-relative store path with spaces). Extra hostile
 * settings: APIO_PACKAGES, PYTHONHOME, NEXYSVHDL_APIO/NEXYSVHDL_TOOLS_DIR, and
 * an unreachable HTTP(S) proxy so any network access by the tools fails.
 *
 *   node dist/tests/integration/run-installed.js install <work dir> <vsix>
 *   node dist/tests/integration/run-installed.js run <work dir> <setup|project|update> <report.json> [folder]
 *
 * Environment: NEXYS_VSCODE (VS Code install folder or, on macOS, the .app; default the standard
 * location), NEXYS_ARCHIVE (toolchain archive for the setup phase), NEXYS_PATH_PREPEND (folders put
 * first on PATH, e.g. decoy executables that log any use), NEXYS_HOSTILE_GHDL (a working GHDL the
 * NEXYSVHDL_GHDL override points at; NexysVHDL must ignore it), NEXYS_HOME (macOS: a simulated home
 * folder, e.g. with spaces and non-ASCII characters; the per-user store becomes <HOME>/Library/NexysVHDL).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const [command, work, ...rest] = process.argv.slice(2);
if (!command || !work) {
    console.error('usage: run-installed install <work dir> <vsix> | run <work dir> <phase> <report.json> [folder]');
    process.exit(2);
}
const mac = process.platform === 'darwin';
const vscodeDir = process.env['NEXYS_VSCODE'] ?? (mac ? '/Applications/Visual Studio Code.app' : join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Microsoft VS Code'));
/** The Electron executable and, run as Node, VS Code's CLI entry point. */
const electron = mac ? join(vscodeDir, 'Contents', 'MacOS', 'Code') : join(vscodeDir, 'Code.exe');
const dirs = { user: join(work, 'user-data'), extensions: join(work, 'extensions'), localAppData: join(work, 'LocalAppData'), students: join(work, 'students'), harness: join(work, 'validation-harness') };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

if (command === 'install') {
    const vsix = rest[0]!;
    // What bin/code(.cmd) does, without a shell: the Electron executable as Node running VS Code's CLI.
    const cli = mac ? join('Contents', 'Resources', 'app', 'out', 'cli.js') : readFileSync(join(vscodeDir, 'bin', 'code.cmd'), 'utf8').match(/%~dp0\.\.\\([^"]*cli\.js)/)?.[1];
    if (!cli) throw new Error('cannot find the VS Code CLI entry point');
    const r = spawnSync(electron, [join(vscodeDir, cli), '--user-data-dir', dirs.user, '--extensions-dir', dirs.extensions, '--install-extension', vsix, '--force'], {
        stdio: 'inherit',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' },
    });
    process.exit(r.status ?? 1);
}

const [phase, reportFile, folder] = rest;
// A trivial development extension that only hosts the test entry point; NexysVHDL itself is the installed .vsix.
writeFileSync(join(dirs.harness, 'package.json'), JSON.stringify({ name: 'nexysvhdl-validation-harness', publisher: 'validation', version: '0.0.1', engines: { vscode: '^1.120.0' } }, null, 2));

const env: NodeJS.ProcessEnv = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(path|apio_.*|python.*|nexysvhdl_.*|electron_run_as_node|vscode_.*|electron_.*)$/i.test(k)) env[k] = v;
const prepend = (process.env['NEXYS_PATH_PREPEND'] ?? '').split(delimiter).filter(Boolean);
if (mac) {
    const deadProxy = 'http://127.0.0.1:9';
    Object.assign(env, {
        ...(process.env['NEXYS_HOME'] ? { HOME: process.env['NEXYS_HOME'] } : {}),
        // Only the operating system (plus any decoys): no Homebrew, /usr/local, developer Python, GHDL or Apio on PATH.
        PATH: [...prepend, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
        // Hostile settings NexysVHDL must ignore.
        APIO_HOME: join(homedir(), '.apio'),
        APIO_PACKAGES: join(homedir(), '.apio', 'packages'),
        PYTHONPATH: join(homedir(), '.apio', 'packages', 'oss-cad-suite', 'lib', 'python3.11'),
        PYTHONHOME: '/nonexistent-python-home',
        NEXYSVHDL_GHDL: process.env['NEXYS_HOSTILE_GHDL'] ?? '/does-not-exist/ghdl',
        NEXYSVHDL_APIO: '/Applications/Apio/apio',
        NEXYSVHDL_TOOLS_DIR: join(homedir(), '.apio', 'packages'),
        HTTP_PROXY: deadProxy,
        HTTPS_PROXY: deadProxy,
        http_proxy: deadProxy,
        https_proxy: deadProxy,
    });
} else {
    const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
    Object.assign(env, {
        // Only the operating system: no developer Python, Git, MSYS2, GHDL or Apio on PATH.
        PATH: [...prepend, join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32', 'Wbem'), vscodeDir].join(';'),
        LOCALAPPDATA: dirs.localAppData,
        // Hostile settings NexysVHDL must ignore.
        APIO_HOME: join(homedir(), '.apio'),
        PYTHONPATH: 'C:\\Python314\\Lib',
        NEXYSVHDL_GHDL: 'C:\\does-not-exist\\ghdl.exe',
    });
}
Object.assign(env, { NEXYS_PHASE: phase, NEXYS_REPORT: reportFile, NEXYS_PARENT: dirs.students });
const child = spawn(
    electron,
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
