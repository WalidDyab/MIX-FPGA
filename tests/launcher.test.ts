import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { routeUri } from '../extension/commands/uri-routes';
import { REPO } from './helpers';

/**
 * The NexysVHDL launcher (launcher/): reusable C# logic tested against a fake
 * platform, the Windows layer tested through the real built NexysVHDL.exe, and the
 * extension's link handler. The C# tests need the .NET Framework compiler that
 * ships with Windows, so they run on Windows only; the architecture checks run everywhere.
 */
const win = process.platform === 'win32';
const csc = join(process.env['WINDIR'] ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const src = (...p: string[]) => join(REPO, 'launcher', ...p);
const refs = ['System.dll', 'System.Core.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll'].map((r) => `/r:${r}`);
const core = ['Model.cs', 'Json.cs', 'RecentProjects.cs', 'LauncherService.cs'].map((f) => src('core', f));

let build: string;
function compile(out: string, target: 'exe' | 'winexe', files: string[]): void {
    const r = spawnSync(csc, ['/nologo', `/target:${target}`, `/out:${out}`, ...refs, ...files], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
}

/** PE "Subsystem": 2 = Windows GUI (no console window can ever appear), 3 = console. */
function subsystem(file: string): number {
    const b = readFileSync(file);
    const pe = b.readUInt32LE(0x3c);
    return b.readUInt16LE(pe + 24 + 68);
}

describe('launcher: the extension link handler', () => {
    it('maps only the listed routes to existing commands, whatever the case or trailing slash', () => {
        assert.equal(routeUri('/newProject'), 'nexysvhdl.createProject');
        assert.equal(routeUri('/NEWPROJECT/'), 'nexysvhdl.createProject');
        assert.equal(routeUri('/gettingStarted'), 'nexysvhdl.gettingStarted');
        assert.equal(routeUri('/showEnvironment'), 'nexysvhdl.showEnvironment');
        for (const bad of ['', '/', '/check', '/build', '/program', '/workbench.action.terminal.new', '/newProject/../x', '/__proto__', '/constructor']) {
            assert.equal(routeUri(bad), undefined, bad);
        }
    });

    it('the extension activates on a link and registers the handler; the launcher uses exactly that link', async () => {
        const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { activationEvents: string[]; publisher: string; name: string; contributes: { commands: Array<{ command: string }> } };
        assert.ok(pkg.activationEvents.includes('onUri'));
        assert.ok(pkg.activationEvents.includes('workspaceContains:nexysvhdl.json'), 'opening a project still activates it');
        assert.match(readFileSync(join(REPO, 'extension', 'extension.ts'), 'utf8'), /registerUriHandler/);
        const service = readFileSync(src('core', 'LauncherService.cs'), 'utf8');
        assert.ok(service.includes(`vscode://${pkg.publisher}.${pkg.name}/newProject`));
        assert.ok(pkg.contributes.commands.some((c) => c.command === routeUri('/newProject')), 'the route targets a contributed command');
    });
});

describe('launcher: architecture', () => {
    it('keeps reusable logic free of Windows and UI APIs, and never starts a terminal', () => {
        for (const f of readdirSync(src('core'))) {
            const text = readFileSync(src('core', f), 'utf8');
            assert.doesNotMatch(text, /System\.Windows\.Forms|Microsoft\.Win32|DllImport|ComImport|Registry|Process\.Start|ProcessStartInfo/, `core/${f} must stay platform-neutral`);
        }
        for (const f of readdirSync(src('windows'))) {
            const text = readFileSync(src('windows', f), 'utf8');
            assert.doesNotMatch(text, /powershell|WScript\.Shell\.Run|"cmd\.exe", "\/k|\/k /i, `windows/${f} never opens an interactive shell`);
            if (f !== 'Setup.cs') assert.doesNotMatch(text, /cmd\.exe/, `windows/${f}`);
        }
    });

    it('never touches the project scaffolding, the toolchain or the VS Code settings', () => {
        for (const dir of ['core', 'windows']) {
            for (const f of readdirSync(src(dir))) {
                const text = readFileSync(src(dir, f), 'utf8');
                assert.doesNotMatch(text, /settings\.json|workbench\.colorTheme|--uninstall-extension|\.tar\.gz/i, `${dir}/${f}`);
            }
        }
        assert.doesNotMatch(readFileSync(join(REPO, 'scripts', 'launcher', 'build-windows.mjs'), 'utf8'), /toolchain\/|toolchains\/bundle|tar\.gz/);
    });
});

describe('launcher (Windows)', { skip: !win || !existsSync(csc) }, () => {
    before(async () => {
        build = await mkdtemp(join(tmpdir(), 'nexys-launcher-build-'));
    });

    it('reusable logic: open, refuse, recents, missing VS Code / extension, New Project link (C# tests)', () => {
        const exe = join(build, 'CoreTests.exe');
        compile(exe, 'exe', [...core, src('tests', 'CoreTests.cs')]);
        const r = spawnSync(exe, [], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stdout);
        const lines = r.stdout.split(/\r?\n/).filter(Boolean);
        assert.ok(lines.filter((l) => l.startsWith('ok ')).length >= 13, r.stdout);
        assert.equal(lines[lines.length - 1], 'ALL OK');
    });

    it('the launcher and the installer are Windows-subsystem programs: no console window can appear', () => {
        const launcher = join(build, 'NexysVHDL.exe');
        compile(launcher, 'winexe', [...core, src('windows', 'WindowsPlatform.cs'), src('windows', 'FolderPicker.cs'), src('windows', 'MainForm.cs'), src('windows', 'Program.cs')]);
        assert.equal(subsystem(launcher), 2);
        const setup = join(build, 'Setup.exe');
        compile(setup, 'winexe', [...core, src('windows', 'WindowsPlatform.cs'), src('windows', 'Setup.cs')]);
        assert.equal(subsystem(setup), 2);
        assert.equal(subsystem(join(build, 'CoreTests.exe')), 3, 'sanity: a console build reads as console');
    });

    function report(env: Record<string, string>): Record<string, unknown> {
        const out = join(build, `report-${Math.random().toString(36).slice(2)}.json`);
        const r = spawnSync(join(build, 'NexysVHDL.exe'), ['--status-report', out], { env: { SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows', ...env }, timeout: 30000 });
        assert.equal(r.status, 0, String(r.stderr));
        return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    }

    function fakeVsCode(root: string): string {
        const exe = join(root, 'Code.exe');
        mkdirSync(join(root, 'abc123', 'resources', 'app', 'out'), { recursive: true });
        writeFileSync(exe, 'MZ');
        writeFileSync(join(root, 'abc123', 'resources', 'app', 'out', 'cli.js'), '');
        return exe;
    }

    it('finds VS Code without PATH: on the real machine through its standard install locations, and an explicit override', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nexys-launcher-vs-'));
        const exe = fakeVsCode(join(dir, 'Fake VS Code'));
        const overridden = report({ NEXYSVHDL_VSCODE_PATH: exe, NEXYSVHDL_LAUNCHER_STATE_DIR: join(dir, 's'), PATH: '' });
        assert.equal(overridden['vscodeFound'], true);
        assert.equal(overridden['vscodeExecutable'], exe);
        assert.equal(overridden['vscodeScope'], 'override');
        assert.match(String(overridden['vscodeCli']), /abc123.resources.app.out.cli\.js$/, 'the versioned update folder is searched');
        // Real discovery (registry + standard folders), with an empty PATH and APPDATA-style variables from the user environment.
        const real = report({ PATH: '', LOCALAPPDATA: process.env['LOCALAPPDATA'] ?? '', ProgramFiles: process.env['ProgramFiles'] ?? '', USERPROFILE: process.env['USERPROFILE'] ?? '', APPDATA: process.env['APPDATA'] ?? '' });
        const installed = [join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'), join(process.env['ProgramFiles'] ?? '', 'Microsoft VS Code', 'Code.exe')].some(existsSync);
        if (installed) {
            assert.equal(real['vscodeFound'], true, 'VS Code is installed here and PATH is empty');
            assert.match(String(real['vscodeExecutable']), /Code\.exe$/);
            assert.ok(['user', 'system'].includes(String(real['vscodeScope'])));
        }
    });

    it('reports VS Code as missing when it is not installed', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nexys-launcher-none-'));
        const r = report({ NEXYSVHDL_LAUNCHER_FORCE_NO_VSCODE: '1', NEXYSVHDL_LAUNCHER_STATE_DIR: join(dir, 's') });
        assert.equal(r['vscodeFound'], false);
        assert.equal(r['extensionFound'], false);
        assert.equal(r['vscodeExecutable'], null);
    });

    it('detects the NexysVHDL extension: newest version, ignoring folders VS Code marked obsolete', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nexys-launcher-ext-'));
        const exe = fakeVsCode(join(dir, 'vs'));
        const ext = join(dir, 'extensions');
        for (const f of ['emxplore.nexysvhdl-0.4.9', 'emxplore.nexysvhdl-0.5.0-win32-x64', 'emxplore.nexysvhdl-0.6.1-win32-x64', 'other.publisher-9.9.9', 'emxplore.nexysvhdl-notaversion']) mkdirSync(join(ext, f), { recursive: true });
        const env = { NEXYSVHDL_VSCODE_PATH: exe, NEXYSVHDL_VSCODE_EXTENSIONS_DIR: ext, NEXYSVHDL_LAUNCHER_STATE_DIR: join(dir, 's') };
        assert.equal(report(env)['extensionVersion'], '0.6.1');
        writeFileSync(join(ext, '.obsolete'), JSON.stringify({ 'emxplore.nexysvhdl-0.6.1-win32-x64': true }));
        assert.equal(report(env)['extensionVersion'], '0.5.0');
        rmSync(join(ext, 'emxplore.nexysvhdl-0.5.0-win32-x64'), { recursive: true });
        rmSync(join(ext, 'emxplore.nexysvhdl-0.4.9'), { recursive: true });
        assert.equal(report(env)['extensionFound'], false);
    });

    it('reads the toolchain state from the per-user marker only', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nexys-launcher-tc-'));
        const base = { NEXYSVHDL_LAUNCHER_FORCE_NO_VSCODE: '1', NEXYSVHDL_LAUNCHER_STATE_DIR: join(dir, 's'), NEXYSVHDL_LAUNCHER_DATA_ROOT: join(dir, 'data') };
        assert.equal(report(base)['toolchainInstalled'], false);
        const versionDir = join(dir, 'data', 'toolchains', 'win32-x64', '1.0');
        mkdirSync(versionDir, { recursive: true });
        writeFileSync(join(versionDir, '.nexysvhdl-installed.json'), JSON.stringify({ bundleVersion: '1.0', target: 'win32-x64' }));
        assert.equal(report(base)['toolchainInstalled'], true);
        writeFileSync(join(versionDir, '.nexysvhdl-installed.json'), '{ damaged');
        assert.equal(report(base)['toolchainInstalled'], false, 'a damaged marker is simply "not installed"');
    });
});
