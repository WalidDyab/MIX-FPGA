import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const mac = process.platform === 'darwin' && process.arch === 'arm64';
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
        for (const f of readdirSync(src('macos')).filter((x) => x === 'Core.swift')) {
            const text = readFileSync(src('macos', f), 'utf8');
            assert.doesNotMatch(text, /import AppKit|NSWorkspace|NSApplication|Process\(\)|posix_spawn/, `macos/${f} (the shared rules) must stay platform-neutral`);
        }
        for (const f of readdirSync(src('macos'))) {
            const text = readFileSync(src('macos', f), 'utf8');
            assert.doesNotMatch(text, /Terminal\.app|osascript|\/bin\/(ba|z)?sh|"open -a Terminal"|\/usr\/bin\/script/, `macos/${f} never opens Terminal or a shell`);
        }
        for (const f of readdirSync(src('windows'))) {
            const text = readFileSync(src('windows', f), 'utf8');
            assert.doesNotMatch(text, /powershell|WScript\.Shell\.Run|"cmd\.exe", "\/k|\/k /i, `windows/${f} never opens an interactive shell`);
            if (f !== 'Setup.cs') assert.doesNotMatch(text, /cmd\.exe/, `windows/${f}`);
        }
    });

    it('never touches the project scaffolding, the toolchain or the VS Code settings', () => {
        for (const dir of ['core', 'windows', 'macos']) {
            for (const f of readdirSync(src(dir))) {
                const text = readFileSync(src(dir, f), 'utf8');
                assert.doesNotMatch(text, /settings\.json|workbench\.colorTheme|--uninstall-extension|\.tar\.gz/i, `${dir}/${f}`);
            }
        }
        assert.doesNotMatch(readFileSync(join(REPO, 'scripts', 'launcher', 'build-windows.mjs'), 'utf8'), /toolchain\/|toolchains\/bundle|tar\.gz/);
        assert.doesNotMatch(readFileSync(join(REPO, 'scripts', 'launcher', 'build-macos.mjs'), 'utf8'), /toolchain\/|toolchains\/bundle|tar\.gz/);
    });

    it('the macOS launcher repeats the C# rules: same New Project link, same .nvproj format and messages', () => {
        const cs = readFileSync(src('core', 'LauncherService.cs'), 'utf8');
        const swift = readFileSync(src('macos', 'Core.swift'), 'utf8');
        for (const needle of ['vscode://emxplore.nexysvhdl/newProject', 'https://code.visualstudio.com/Download', 'nexysvhdl-project', 'nexysvhdl.json', '.nvproj']) {
            assert.ok(cs.includes(needle) || readFileSync(src('core', 'RecentProjects.cs'), 'utf8').includes(needle), `C# has ${needle}`);
            assert.ok(swift.includes(needle), `Swift has ${needle}`);
        }
        // Every student-facing sentence of the project-file checks exists in both implementations.
        const sentences = [
            'This NexysVHDL project file is damaged: it is not valid JSON.',
            'This NexysVHDL project file has an invalid \\"version\\".',
            'which was not found next to it. Was the project folder copied without it?',
            'Update NexysVHDL to open it.',
            'is not a NexysVHDL project: it has no',
            'Visual Studio Code is not installed. NexysVHDL runs inside VS Code, which is free.',
            'The NexysVHDL extension is not installed in Visual Studio Code yet.',
        ];
        const csAll = readFileSync(src('core', 'LauncherService.cs'), 'utf8');
        for (const t of sentences) {
            assert.ok(csAll.includes(t), `C#: ${t}`);
            assert.ok(swift.includes(t), `Swift: ${t}`);
        }
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
        assert.ok(lines.filter((l) => l.startsWith('ok ')).length >= 18, r.stdout);
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

    describe('.nvproj project files', () => {
        /** Builds the launcher and a recording stand-in for Code.exe once. */
        let launcher: string;
        let fakeCode: string;
        before(() => {
            launcher = join(build, 'NexysVHDL-nvproj.exe');
            compile(launcher, 'winexe', [...core, src('windows', 'WindowsPlatform.cs'), src('windows', 'FolderPicker.cs'), src('windows', 'MainForm.cs'), src('windows', 'Program.cs')]);
            fakeCode = join(build, 'Code.exe');
            compile(fakeCode, 'exe', [src('tests', 'FakeCode.cs')]);
            mkdirSync(join(build, 'abc123', 'resources', 'app', 'out'), { recursive: true });
            writeFileSync(join(build, 'abc123', 'resources', 'app', 'out', 'cli.js'), '');
        });

        function project(dir: string, name: string): string {
            const root = join(dir, name);
            mkdirSync(root, { recursive: true });
            writeFileSync(join(root, 'nexysvhdl.json'), JSON.stringify({ name }));
            writeFileSync(join(root, `${name}.nvproj`), JSON.stringify({ format: 'nexysvhdl-project', version: 1, config: 'nexysvhdl.json' }));
            return root;
        }

        /** Starts the launcher exactly as Windows does for a double-click: one argument, the file, no shell. */
        function doubleClick(dir: string, args: string[]) {
            const extensions = join(dir, 'ext');
            mkdirSync(join(extensions, 'emxplore.nexysvhdl-0.5.0-win32-x64'), { recursive: true });
            const out = join(dir, 'fakecode.txt');
            const message = join(dir, 'message.txt');
            const r = spawnSync(launcher, args, {
                env: {
                    SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
                    NEXYSVHDL_VSCODE_PATH: fakeCode,
                    NEXYSVHDL_VSCODE_EXTENSIONS_DIR: extensions,
                    NEXYSVHDL_LAUNCHER_STATE_DIR: join(dir, 'state'),
                    NEXYSVHDL_LAUNCHER_DATA_ROOT: join(dir, 'data'),
                    NEXYS_FAKECODE_OUT: out,
                    NEXYSVHDL_LAUNCHER_MESSAGE_FILE: message,
                },
                timeout: 30000,
            });
            return { status: r.status, started: existsSync(out) ? readFileSync(out, 'utf8') : undefined, message: existsSync(message) ? readFileSync(message, 'utf8') : undefined, stderr: String(r.stderr) };
        }

        it('double-clicking a .nvproj (path with spaces) starts VS Code on that project folder, without a terminal or a vscode:// link', async () => {
            const dir = await mkdtemp(join(tmpdir(), 'nexys launcher nvproj '));
            const root = project(join(dir, 'My Courses'), 'Lab 1 Counter');
            const r = doubleClick(dir, [join(root, 'Lab 1 Counter.nvproj')]);
            assert.equal(r.status, 0, r.stderr);
            assert.ok(r.started, 'VS Code was started');
            const args = r.started.split('\n');
            assert.equal(args[0], root, 'the first argument is the project FOLDER, as one argument');
            assert.doesNotMatch(r.started, /--open-url|vscode:\/\//, 'no URI hand-off, so no VS Code confirmation prompt');
            assert.equal(subsystem(launcher), 2, 'a Windows-subsystem program: no console window');
        });

        it('--open accepts a project file too, and the folder form still works for projects without one', async () => {
            const dir = await mkdtemp(join(tmpdir(), 'nexys launcher nvproj '));
            const root = project(dir, 'WithFile');
            assert.equal(doubleClick(dir, ['--open', join(root, 'WithFile.nvproj')]).started?.split('\n')[0], root);
            const legacy = join(dir, 'Legacy');
            mkdirSync(legacy);
            writeFileSync(join(legacy, 'nexysvhdl.json'), '{}');
            rmSync(join(dir, 'fakecode.txt'), { force: true });
            const r = doubleClick(dir, ['--open', legacy]);
            assert.equal(r.status, 0);
            assert.equal(r.started?.split('\n')[0], legacy);
        });

        it('a moved project folder opens from its new place', async () => {
            const dir = await mkdtemp(join(tmpdir(), 'nexys launcher nvproj '));
            const root = project(dir, 'Original');
            const moved = join(dir, 'Archive 2026', 'Original');
            mkdirSync(join(dir, 'Archive 2026'));
            renameSync(root, moved);
            const r = doubleClick(dir, [join(moved, 'Original.nvproj')]);
            assert.equal(r.status, 0, r.stderr);
            assert.equal(r.started?.split('\n')[0], moved);
        });

        it('a malformed .nvproj or one without nexysvhdl.json is explained and VS Code is not started', async () => {
            const dir = await mkdtemp(join(tmpdir(), 'nexys launcher nvproj '));
            const root = project(dir, 'Broken');
            writeFileSync(join(root, 'Broken.nvproj'), '{ not json');
            const bad = doubleClick(dir, [join(root, 'Broken.nvproj')]);
            assert.equal(bad.status, 1);
            assert.equal(bad.started, undefined, 'nothing was launched');
            assert.match(bad.message ?? '', /damaged/);
            rmSync(join(root, 'nexysvhdl.json'));
            writeFileSync(join(root, 'Broken.nvproj'), JSON.stringify({ format: 'nexysvhdl-project', version: 1, config: 'nexysvhdl.json' }));
            const missing = doubleClick(dir, [join(root, 'Broken.nvproj')]);
            assert.equal(missing.status, 1);
            assert.equal(missing.started, undefined);
            assert.match(missing.message ?? '', /nexysvhdl\.json, which was not found next to it/);
        });
    });

    it('the .nvproj file association (per user): registered with the icon and "exe" "%1", removed without touching unrelated associations (scratch registry key)', () => {
        const exe = join(build, 'AssociationTests.exe');
        const r0 = spawnSync(csc, ['/nologo', '/target:exe', '/main:AssociationTests', `/out:${exe}`, ...refs, ...core, src('windows', 'WindowsPlatform.cs'), src('windows', 'Setup.cs'), src('tests', 'AssociationTests.cs')], { encoding: 'utf8' });
        assert.equal(r0.status, 0, `${r0.stdout}${r0.stderr}`);
        const r = spawnSync(exe, [], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stdout);
        const lines = r.stdout.split(/\r?\n/).filter(Boolean);
        assert.ok(lines.filter((l) => l.startsWith('ok ')).length >= 5, r.stdout);
        assert.equal(lines[lines.length - 1], 'ALL OK');
    });

    it('the installer registers the association and the uninstaller removes it; the project file keeps the NexysVHDL icon', () => {
        const setup = readFileSync(src('windows', 'Setup.cs'), 'utf8');
        assert.match(setup, /FileAssociation\.Register\(exe, ico, FileAssociation\.ClassesKey\(\)\)/);
        assert.match(setup, /FileAssociation\.Remove\(FileAssociation\.ClassesKey\(\)\)/);
        assert.match(setup, /Registry\.CurrentUser\.CreateSubKey\(classesKey\)/, 'per user (HKCU), no administrator rights');
        assert.doesNotMatch(setup, /Registry\.LocalMachine|ClassesRoot/);
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

describe('launcher (macOS)', { skip: !mac || spawnSync('which', ['swiftc']).status !== 0 }, () => {
    let appDir: string;
    let work: string;
    let vsixFile: string;
    let exe: string;
    const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000 });

    before(async () => {
        work = await mkdtemp(join(tmpdir(), 'nexys-launcher-mac-'));
        // A bundled extension file: a real zip so the "is the installed build the bundled one" check can read it.
        const staging = join(work, 'vsix-src');
        mkdirSync(join(staging, 'extension', 'dist'), { recursive: true });
        writeFileSync(join(staging, 'extension', 'dist', 'extension.js'), 'bundled build');
        vsixFile = join(work, 'nexysvhdl.vsix');
        assert.equal(spawnSync('zip', ['-qr', vsixFile, 'extension'], { cwd: staging }).status, 0);
        const b = spawnSync(process.execPath, [join(REPO, 'scripts', 'launcher', 'build-macos.mjs'), '--vsix', vsixFile, '--out', join(work, 'out')], { encoding: 'utf8', timeout: 600000 });
        assert.equal(b.status, 0, `${b.stdout}${b.stderr}`);
        appDir = join(work, 'out', 'NexysVHDL.app');
        exe = join(appDir, 'Contents', 'MacOS', 'NexysVHDL');
    });

    const plist = (key: string): string => sh('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(appDir, 'Contents', 'Info.plist')]).stdout.trim();

    it('is a native Apple-silicon NexysVHDL.app with the NexysVHDL icon, the bundled VSIX and a valid signature structure', () => {
        assert.equal(sh('lipo', ['-archs', exe]).stdout.trim(), 'arm64');
        assert.equal(plist('CFBundleIdentifier'), 'com.emxplore.nexysvhdl');
        assert.equal(plist('CFBundleShortVersionString'), (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version);
        assert.equal(plist('LSMinimumSystemVersion'), '13.0');
        assert.ok(existsSync(join(appDir, 'Contents', 'Resources', 'NexysVHDL.icns')));
        assert.ok(existsSync(join(appDir, 'Contents', 'Resources', 'nexysvhdl.vsix')));
        assert.equal(sh('codesign', ['--verify', '--deep', '--strict', appDir]).status, 0);
        assert.doesNotMatch(sh('otool', ['-L', exe]).stdout, /Terminal/);
    });

    it('registers .nvproj as a NexysVHDL document type (CFBundleDocumentTypes + exported UTI) and never claims other file types', () => {
        assert.equal(plist('CFBundleDocumentTypes:0:CFBundleTypeExtensions:0'), 'nvproj');
        assert.equal(plist('CFBundleDocumentTypes:0:CFBundleTypeName'), 'NexysVHDL Project');
        assert.equal(plist('CFBundleDocumentTypes:0:LSItemContentTypes:0'), 'com.emxplore.nexysvhdl.project');
        assert.equal(plist('UTExportedTypeDeclarations:0:UTTypeIdentifier'), 'com.emxplore.nexysvhdl.project');
        assert.equal(plist('UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension:0'), 'nvproj');
        assert.equal(plist('UTExportedTypeDeclarations:0:UTTypeConformsTo:0'), 'public.data');
        assert.doesNotMatch(readFileSync(join(appDir, 'Contents', 'Info.plist'), 'utf8'), /public\.json|public\.text|<string>vhdl?<\/string>/i);
    });

    /** Runs the launcher's headless forms exactly as a double-click reaches the code: one path argument, no shell. */
    function launch(dir: string, args: string[], extra: Record<string, string> = {}) {
        const extensions = join(dir, 'ext');
        mkdirSync(join(extensions, 'emxplore.nexysvhdl-0.6.0-darwin-arm64'), { recursive: true });
        const fake = join(dir, 'Code');
        if (!existsSync(fake)) {
            writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "$NEXYS_FAKECODE_OUT"\n', { mode: 0o755 });
        }
        const out = join(dir, 'fakecode.txt');
        const message = join(dir, 'message.txt');
        const r = spawnSync(exe, args, {
            env: { PATH: '', HOME: dir, NEXYSVHDL_VSCODE_PATH: fake, NEXYSVHDL_VSCODE_EXTENSIONS_DIR: extensions, NEXYSVHDL_LAUNCHER_STATE_DIR: join(dir, 'state'), NEXYSVHDL_LAUNCHER_DATA_ROOT: join(dir, 'data'), NEXYS_FAKECODE_OUT: out, NEXYSVHDL_LAUNCHER_MESSAGE_FILE: message, ...extra },
            encoding: 'utf8',
            timeout: 30000,
        });
        // The stand-in is started detached; give it a moment to record its arguments.
        for (let i = 0; i < 50 && !existsSync(out) && r.status === 0; i++) spawnSync('sleep', ['0.1']);
        return { status: r.status, started: existsSync(out) ? readFileSync(out, 'utf8') : undefined, message: existsSync(message) ? readFileSync(message, 'utf8') : undefined, stderr: String(r.stderr) };
    }

    function project(dir: string, name: string): string {
        const root = join(dir, name);
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'nexysvhdl.json'), JSON.stringify({ name }));
        writeFileSync(join(root, `${name}.nvproj`), JSON.stringify({ format: 'nexysvhdl-project', version: 1, config: 'nexysvhdl.json' }));
        return root;
    }

    function report(env: Record<string, string>): Record<string, unknown> {
        const out = join(work, `report-${Math.random().toString(36).slice(2)}.json`);
        const r = spawnSync(exe, ['--status-report', out], { env: { PATH: '', ...env }, timeout: 30000 });
        assert.equal(r.status, 0, String(r.stderr));
        return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    }

    it('opening a .nvproj (path with spaces) starts VS Code on that project folder, without a terminal or a vscode:// link', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nexys launcher nvproj '));
        const root = project(join(dir, 'My Courses'), 'Lab 1 Counter');
        const r = launch(dir, [join(root, 'Lab 1 Counter.nvproj')]);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.started, 'VS Code was started');
        assert.equal(r.started.split('\n')[0], root, 'the first argument is the project FOLDER, as one argument');
        assert.doesNotMatch(r.started, /--open-url|vscode:\/\//, 'no URI hand-off, so no VS Code confirmation prompt');
        const recent = JSON.parse(readFileSync(join(dir, 'state', 'recent-projects.json'), 'utf8')) as { version: number; projects: Array<{ path: string; name: string }> };
        assert.equal(recent.version, 1);
        assert.deepEqual(recent.projects.map((p) => p.name), ['Lab 1 Counter']);
    });

    it('--open accepts a project file or a folder; a moved project folder opens from its new place', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nexys launcher nvproj '));
        const root = project(dir, 'WithFile');
        assert.equal(launch(dir, ['--open', join(root, 'WithFile.nvproj')]).started?.split('\n')[0], root);
        const legacy = join(dir, 'Legacy');
        mkdirSync(legacy);
        writeFileSync(join(legacy, 'nexysvhdl.json'), '{}');
        rmSync(join(dir, 'fakecode.txt'), { force: true });
        assert.equal(launch(dir, ['--open', legacy]).started?.split('\n')[0], legacy);
        const moved = join(dir, 'Archive 2026', 'WithFile');
        mkdirSync(join(dir, 'Archive 2026'));
        renameSync(root, moved);
        rmSync(join(dir, 'fakecode.txt'), { force: true });
        assert.equal(launch(dir, [join(moved, 'WithFile.nvproj')]).started?.split('\n')[0], moved);
    });

    it('a malformed .nvproj, a foreign or newer one, or one without nexysvhdl.json is explained and VS Code is not started', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nexys launcher nvproj '));
        const root = project(dir, 'Broken');
        const file = join(root, 'Broken.nvproj');
        const cases: Array<[string, RegExp, string?]> = [
            ['{ not json', /damaged/],
            [JSON.stringify({ format: 'other', version: 1, config: 'nexysvhdl.json' }), /not a NexysVHDL project file/],
            [JSON.stringify({ format: 'nexysvhdl-project', version: 2, config: 'nexysvhdl.json' }), /newer NexysVHDL/],
            [JSON.stringify({ format: 'nexysvhdl-project', version: 1, config: '../nexysvhdl.json' }), /unusable settings file/],
            [JSON.stringify({ format: 'nexysvhdl-project', version: 1, config: '/etc/nexysvhdl.json' }), /unusable settings file/],
        ];
        for (const [text, pattern] of cases) {
            writeFileSync(file, text);
            rmSync(join(dir, 'message.txt'), { force: true });
            const bad = launch(dir, [file]);
            assert.equal(bad.status, 1, text);
            assert.equal(bad.started, undefined, 'nothing was launched');
            assert.match(bad.message ?? '', pattern, text);
        }
        rmSync(join(root, 'nexysvhdl.json'));
        writeFileSync(file, JSON.stringify({ format: 'nexysvhdl-project', version: 1, config: 'nexysvhdl.json' }));
        const missing = launch(dir, [file]);
        assert.equal(missing.status, 1);
        assert.match(missing.message ?? '', /nexysvhdl\.json, which was not found next to it/);
    });

    it('a folder without nexysvhdl.json is refused with a friendly message', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nexys launcher nvproj '));
        const plain = join(dir, 'Plain');
        mkdirSync(plain);
        const r = launch(dir, ['--open', plain]);
        assert.equal(r.status, 1);
        assert.equal(r.started, undefined);
        assert.match(r.message ?? '', /is not a NexysVHDL project: it has no nexysvhdl\.json file/);
    });

    it('New Project hands the extension\'s own vscode:// link to VS Code', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nexys launcher new '));
        const r = launch(dir, ['--new-project']);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(r.started?.trim().split('\n'), ['--open-url', '--extensions-dir', join(dir, 'ext'), '--', 'vscode://emxplore.nexysvhdl/newProject']);
    });

    it('finds VS Code without PATH: an explicit override, and on the real machine through the standard Applications folders', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nexys-launcher-vs-'));
        const fake = join(dir, 'Code');
        writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 });
        const overridden = report({ HOME: dir, NEXYSVHDL_VSCODE_PATH: fake, NEXYSVHDL_LAUNCHER_STATE_DIR: join(dir, 's') });
        assert.equal(overridden['vscodeFound'], true);
        assert.equal(overridden['vscodeExecutable'], fake);
        assert.equal(overridden['vscodeScope'], 'override');
        const realHome = process.env['HOME'] ?? '';
        const real = report({ HOME: realHome, NEXYSVHDL_LAUNCHER_STATE_DIR: join(dir, 's2') });
        if (['/Applications', join(realHome, 'Applications')].some((d) => existsSync(join(d, 'Visual Studio Code.app')))) {
            assert.equal(real['vscodeFound'], true, 'VS Code is installed here and PATH is empty');
            assert.match(String(real['vscodeExecutable']), /Visual Studio Code\.app\/Contents\/MacOS\/Code$/);
            assert.ok(['user', 'system'].includes(String(real['vscodeScope'])));
            assert.match(String(real['vscodeCli']), /Contents\/Resources\/app\/out\/cli\.js$/);
        }
    });

    it('reports VS Code as missing when it is not installed', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nexys-launcher-none-'));
        const r = report({ NEXYSVHDL_LAUNCHER_FORCE_NO_VSCODE: '1', NEXYSVHDL_LAUNCHER_STATE_DIR: join(dir, 's') });
        assert.equal(r['vscodeFound'], false);
        assert.equal(r['extensionFound'], false);
        assert.equal(r['vscodeExecutable'], null);
    });

    it('detects the NexysVHDL extension: newest version, ignoring folders VS Code marked obsolete; and whether it is the bundled build', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nexys-launcher-ext-'));
        const fake = join(dir, 'Code');
        writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 });
        const ext = join(dir, 'extensions');
        for (const f of ['emxplore.nexysvhdl-0.4.9', 'emxplore.nexysvhdl-0.5.0-darwin-arm64', 'emxplore.nexysvhdl-0.6.1-darwin-arm64', 'other.publisher-9.9.9', 'emxplore.nexysvhdl-notaversion']) mkdirSync(join(ext, f), { recursive: true });
        const env = { HOME: dir, NEXYSVHDL_VSCODE_PATH: fake, NEXYSVHDL_VSCODE_EXTENSIONS_DIR: ext, NEXYSVHDL_LAUNCHER_STATE_DIR: join(dir, 's') };
        assert.equal(report(env)['extensionVersion'], '0.6.1');
        writeFileSync(join(ext, '.obsolete'), JSON.stringify({ 'emxplore.nexysvhdl-0.6.1-darwin-arm64': true }));
        assert.equal(report(env)['extensionVersion'], '0.5.0');
        rmSync(join(ext, 'emxplore.nexysvhdl-0.5.0-darwin-arm64'), { recursive: true });
        rmSync(join(ext, 'emxplore.nexysvhdl-0.4.9'), { recursive: true });
        assert.equal(report(env)['extensionFound'], false);
        // The bundled VSIX is the one inside the app: an installed copy that differs is "outdated", an identical one is not.
        const installed = join(ext, 'emxplore.nexysvhdl-0.6.0-darwin-arm64');
        mkdirSync(join(installed, 'dist'), { recursive: true });
        writeFileSync(join(installed, 'dist', 'extension.js'), 'an older build');
        assert.equal(report(env)['extensionOutdated'], true);
        writeFileSync(join(installed, 'dist', 'extension.js'), 'bundled build');
        assert.equal(report(env)['extensionOutdated'], false);
    });

    it('reads the toolchain state from the per-user marker only', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nexys-launcher-tc-'));
        const base = { NEXYSVHDL_LAUNCHER_FORCE_NO_VSCODE: '1', NEXYSVHDL_LAUNCHER_STATE_DIR: join(dir, 's'), NEXYSVHDL_LAUNCHER_DATA_ROOT: join(dir, 'data') };
        assert.equal(report(base)['toolchainInstalled'], false);
        const versionDir = join(dir, 'data', 'toolchains', 'darwin-arm64', '1.0');
        mkdirSync(versionDir, { recursive: true });
        writeFileSync(join(versionDir, '.nexysvhdl-installed.json'), JSON.stringify({ bundleVersion: '1.0', target: 'darwin-arm64' }));
        assert.equal(report(base)['toolchainInstalled'], true);
        writeFileSync(join(versionDir, '.nexysvhdl-installed.json'), '{ damaged');
        assert.equal(report(base)['toolchainInstalled'], false, 'a damaged marker is simply "not installed"');
    });

    it('recent projects: newest first, at most 10, a deleted folder is dropped when chosen', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'nexys launcher recent '));
        for (let i = 0; i < 12; i++) assert.equal(launch(dir, ['--open', project(dir, `P${i}`)]).status, 0);
        const recent = JSON.parse(readFileSync(join(dir, 'state', 'recent-projects.json'), 'utf8')) as { projects: Array<{ name: string }> };
        assert.equal(recent.projects.length, 10);
        assert.equal(recent.projects[0]!.name, 'P11');
        rmSync(join(dir, 'P11'), { recursive: true });
        assert.equal(launch(dir, ['--open', join(dir, 'P11')]).status, 1);
        const after = JSON.parse(readFileSync(join(dir, 'state', 'recent-projects.json'), 'utf8')) as { projects: Array<{ name: string }> };
        assert.ok(!after.projects.some((p) => p.name === 'P11'));
    });
});
