#!/usr/bin/env node
// Builds the Windows NexysVHDL launcher and its installer, using only what Windows already has
// (the .NET Framework C# compiler and Windows PowerShell for the icon): no SDK, no downloads.
//
//   node scripts/launcher/build-windows.mjs [--vsix <file>]
//
// Output (.artifacts/launcher/):
//   NexysVHDL-Setup.exe   per-user installer: contains NexysVHDL.exe, the extension VSIX and the icon (not the FPGA toolchain)
//   NexysVHDL.exe         the launcher itself (also installed by the setup)
//   NexysVHDL.ico
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const out = join(root, '.artifacts', 'launcher');
const obj = join(out, 'obj');
mkdirSync(obj, { recursive: true });
const fail = (m) => {
    console.error(`launcher build failed: ${m}`);
    process.exit(1);
};
if (process.platform !== 'win32') fail('this builds the Windows launcher');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const argv = process.argv.slice(2);
let vsix = argv.includes('--vsix') ? resolve(argv[argv.indexOf('--vsix') + 1]) : undefined;
if (!vsix) {
    // The Phase 6 development package while this branch is in progress, else the release package.
    for (const dir of [join(root, '.artifacts', 'phase6'), join(root, '.artifacts', 'dist')]) {
        if (!existsSync(dir)) continue;
        const found = readdirSync(dir).filter((f) => f.endsWith('.vsix')).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
        if (found) { vsix = found; break; }
    }
}
if (!vsix || !existsSync(vsix)) fail('no extension .vsix found; pass --vsix <file>');

const csc = join(process.env.WINDIR ?? 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!existsSync(csc)) fail(`the .NET Framework C# compiler is missing: ${csc}`);
const run = (exe, args) => {
    const r = spawnSync(exe, args, { encoding: 'utf8' });
    if (r.status !== 0) fail(`${exe} ${args.join(' ')}\n${r.stdout}${r.stderr}`);
    return r;
};
const src = (...p) => join(root, 'launcher', ...p);
const refs = ['System.dll', 'System.Core.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll'].map((r) => `/r:${r}`);
const core = ['Model.cs', 'Json.cs', 'RecentProjects.cs', 'LauncherService.cs'].map((f) => src('core', f));

const ico = join(out, 'NexysVHDL.ico');
run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'launcher', 'make-icon.ps1'), '-Out', ico]);
console.log('icon      ', ico);

// Name and version shown by Windows (Task Manager, file properties): generated so the version follows package.json.
const numeric = (pkg.version.match(/^\d+\.\d+\.\d+/) ?? ['0.0.0'])[0] + '.0';
const info = (title) => `using System.Reflection;
[assembly: AssemblyTitle("${title}")]
[assembly: AssemblyProduct("NexysVHDL")]
[assembly: AssemblyCompany("EMXplore")]
[assembly: AssemblyCopyright("Copyright 2026 Walid Dyab")]
[assembly: AssemblyVersion("${numeric}")]
[assembly: AssemblyFileVersion("${numeric}")]
[assembly: AssemblyInformationalVersion("${pkg.version}")]
`;
writeFileSync(join(obj, 'AssemblyInfo.launcher.cs'), info('NexysVHDL'));
writeFileSync(join(obj, 'AssemblyInfo.setup.cs'), info('NexysVHDL Setup'));
const exe = join(out, 'NexysVHDL.exe');
run(csc, ['/nologo', '/target:winexe', '/optimize+', `/out:${exe}`, `/win32icon:${ico}`, ...refs, ...core, src('windows', 'WindowsPlatform.cs'), src('windows', 'FolderPicker.cs'), src('windows', 'MainForm.cs'), src('windows', 'Program.cs'), join(obj, 'AssemblyInfo.launcher.cs')]);
console.log('launcher  ', exe, statSync(exe).size, 'bytes');

writeFileSync(join(obj, 'version.txt'), pkg.version);
const setup = join(out, 'NexysVHDL-Setup.exe');
run(csc, [
    '/nologo', '/target:winexe', '/optimize+', `/out:${setup}`, `/win32icon:${ico}`, ...refs,
    `/resource:${exe},payload.NexysVHDL.exe`, `/resource:${vsix},payload.nexysvhdl.vsix`, `/resource:${ico},payload.NexysVHDL.ico`, `/resource:${join(obj, 'version.txt')},payload.version.txt`,
    ...core, src('windows', 'WindowsPlatform.cs'), src('windows', 'Setup.cs'), join(obj, 'AssemblyInfo.setup.cs'),
]);
copyFileSync(vsix, join(out, 'nexysvhdl.vsix'));
console.log('installer ', setup, statSync(setup).size, 'bytes');
console.log('extension ', vsix);
