#!/usr/bin/env node
// Builds the macOS NexysVHDL launcher (NexysVHDL.app) for Apple silicon, using only what macOS developer tools already
// have (swiftc, iconutil, codesign): no Xcode project, no downloads.
//
//   node scripts/launcher/build-macos.mjs [--vsix <file>] [--out <folder>]
//
// Output (.artifacts/launcher/):
//   NexysVHDL.app    native arm64 application: the launcher, the extension VSIX and the icon (not the FPGA toolchain)
//
// Signing: with NEXYSVHDL_CODESIGN_IDENTITY set (a "Developer ID Application: ..." identity from the keychain) the app is
// signed with the hardened runtime and a secure timestamp, ready to notarize (scripts/release/macos-release.mjs --notarize).
// Without it the app gets an AD-HOC signature only: that is what Apple silicon requires of any arm64 code to run at all,
// it is NOT a Developer ID signature and does NOT pass Gatekeeper for a downloaded copy. Nothing here fakes either.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const argv = process.argv.slice(2);
const out = argv.includes('--out') ? resolve(argv[argv.indexOf('--out') + 1]) : join(root, '.artifacts', 'launcher');
const fail = (m) => {
    console.error(`launcher build failed: ${m}`);
    process.exit(1);
};
if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('this builds the Apple-silicon macOS launcher');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
let vsix = argv.includes('--vsix') ? resolve(argv[argv.indexOf('--vsix') + 1]) : join(root, '.artifacts', 'dist', `nexysvhdl-${pkg.version}-darwin-arm64.vsix`);
if (!existsSync(vsix)) fail(`no extension .vsix found (${vsix}); run npm run package:mac or pass --vsix <file>`);

const run = (exe, args, opts = {}) => {
    const r = spawnSync(exe, args, { encoding: 'utf8', ...opts });
    if (r.status !== 0) fail(`${exe} ${args.join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}`);
    return r;
};
const src = (...p) => join(root, 'launcher', 'macos', ...p);
const bundleId = 'com.emxplore.nexysvhdl';
const projectUti = 'com.emxplore.nexysvhdl.project';

const obj = join(out, 'obj');
rmSync(obj, { recursive: true, force: true });
mkdirSync(obj, { recursive: true });

// Some Command Line Tools installs ship the same Swift module map twice, which stops every `import Foundation`
// ("redefinition of module 'SwiftBridging'"). If a trial compile shows that, hide the duplicate with a virtual file system
// overlay (nothing on disk is changed).
function swiftFlags() {
    const probe = join(obj, 'probe.swift');
    writeFileSync(probe, 'import Foundation\nprint(1)\n');
    const first = spawnSync('swiftc', [probe, '-o', join(obj, 'probe')], { encoding: 'utf8' });
    if (first.status === 0) return [];
    if (!/redefinition of module 'SwiftBridging'/.test(first.stderr)) fail(`swiftc cannot compile a trivial program:\n${first.stderr}`);
    const cltInclude = '/Library/Developer/CommandLineTools/usr/include/swift';
    writeFileSync(join(obj, 'empty.modulemap'), '');
    const overlay = join(obj, 'overlay.yaml');
    writeFileSync(overlay, JSON.stringify({ version: 0, 'case-sensitive': 'false', roots: [{ name: `${cltInclude}/module.modulemap`, type: 'file', 'external-contents': join(obj, 'empty.modulemap') }] }));
    const flags = ['-vfsoverlay', overlay, '-Xcc', '-ivfsoverlay', '-Xcc', overlay];
    const second = spawnSync('swiftc', [...flags, probe, '-o', join(obj, 'probe')], { encoding: 'utf8' });
    if (second.status !== 0) fail(`swiftc cannot compile a trivial program, even with the module-map workaround:\n${second.stderr}`);
    console.log('note: using a virtual file-system overlay for the duplicated SwiftBridging module map in the Command Line Tools');
    return flags;
}
const flags = swiftFlags();

// 1. Icon: drawn in code (same artwork as the Windows icon).
const iconTool = join(obj, 'make-icon');
run('swiftc', [...flags, join(root, 'scripts', 'launcher', 'make-icon.swift'), '-o', iconTool]);
const iconset = join(obj, 'NexysVHDL.iconset');
run(iconTool, [iconset]);
mkdirSync(out, { recursive: true });
const icns = join(out, 'NexysVHDL.icns');
run('iconutil', ['-c', 'icns', iconset, '-o', icns]);
console.log('icon      ', icns);

// 2. The launcher (native arm64).
const app = join(out, 'NexysVHDL.app');
rmSync(app, { recursive: true, force: true });
mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
const exe = join(app, 'Contents', 'MacOS', 'NexysVHDL');
run('swiftc', [...flags, '-O', '-target', 'arm64-apple-macosx13.0', '-o', exe, ...['Core.swift', 'MacPlatform.swift', 'UI.swift', 'main.swift'].map((f) => src(f))]);
console.log('launcher  ', exe);

// 3. Resources and Info.plist.
copyFileSync(icns, join(app, 'Contents', 'Resources', 'NexysVHDL.icns'));
copyFileSync(vsix, join(app, 'Contents', 'Resources', 'nexysvhdl.vsix'));
writeFileSync(join(app, 'Contents', 'PkgInfo'), 'APPL????');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key><string>en</string>
    <key>CFBundleExecutable</key><string>NexysVHDL</string>
    <key>CFBundleIconFile</key><string>NexysVHDL</string>
    <key>CFBundleIdentifier</key><string>${bundleId}</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleName</key><string>NexysVHDL</string>
    <key>CFBundleDisplayName</key><string>NexysVHDL</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${esc(pkg.version)}</string>
    <key>CFBundleVersion</key><string>${esc(pkg.version)}</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSArchitecturePriority</key><array><string>arm64</string></array>
    <key>LSApplicationCategoryType</key><string>public.app-category.education</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSHumanReadableCopyright</key><string>Copyright 2026 Walid Dyab. Apache-2.0.</string>
    <key>NSPrincipalClass</key><string>NSApplication</string>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key><string>NexysVHDL Project</string>
            <key>CFBundleTypeRole</key><string>Viewer</string>
            <key>CFBundleTypeIconFile</key><string>NexysVHDL</string>
            <key>CFBundleTypeExtensions</key><array><string>nvproj</string></array>
            <key>LSItemContentTypes</key><array><string>${projectUti}</string></array>
            <key>LSHandlerRank</key><string>Owner</string>
        </dict>
        <dict>
            <key>CFBundleTypeName</key><string>Folder</string>
            <key>CFBundleTypeRole</key><string>Viewer</string>
            <key>LSItemContentTypes</key><array><string>public.folder</string></array>
            <key>LSHandlerRank</key><string>None</string>
        </dict>
    </array>
    <key>UTExportedTypeDeclarations</key>
    <array>
        <dict>
            <key>UTTypeIdentifier</key><string>${projectUti}</string>
            <key>UTTypeDescription</key><string>NexysVHDL Project</string>
            <key>UTTypeConformsTo</key><array><string>public.data</string></array>
            <key>UTTypeIconFile</key><string>NexysVHDL</string>
            <key>UTTypeTagSpecification</key>
            <dict>
                <key>public.filename-extension</key><array><string>nvproj</string></array>
            </dict>
        </dict>
    </array>
</dict>
</plist>
`;
writeFileSync(join(app, 'Contents', 'Info.plist'), plist);
run('plutil', ['-lint', join(app, 'Contents', 'Info.plist')]);

// 4. Signature (see the header: ad-hoc unless a real identity is provided).
const identity = process.env.NEXYSVHDL_CODESIGN_IDENTITY;
if (identity) {
    run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, app]);
    console.log(`signed     with ${identity} (hardened runtime, timestamped)`);
} else {
    run('codesign', ['--force', '--sign', '-', app]);
    console.log('signed     AD-HOC only (no Developer ID identity): runs on this Mac; Gatekeeper will not accept a downloaded copy');
}
run('codesign', ['--verify', '--deep', '--strict', app]);
console.log('\nbuilt', app);
