#!/usr/bin/env node
// Builds "MIX-FPGA Installer.app" (native arm64, AppKit; Swift sources in installer/macos) with the tools macOS developer tools already
// have (swiftc, iconutil, codesign). The app contains only the installer and bridge.js; the release files stay beside it in the DMG.
//   node scripts/installer/build-installer.mjs [--out <folder>]
// Signing: AD-HOC only (Apple silicon will not run unsigned arm64 code at all). It is NOT a Developer ID signature and is not notarized.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const argv = process.argv.slice(2);
const out = argv.includes('--out') ? resolve(argv[argv.indexOf('--out') + 1]) : join(root, '.artifacts', 'installer');
const fail = (m) => { console.error(`installer build failed: ${m}`); process.exit(1); };
const run = (exe, args) => { const r = spawnSync(exe, args, { encoding: 'utf8' }); if (r.status !== 0) fail(`${exe} ${args.join(' ')}\n${r.stdout}${r.stderr}`); return r; };
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const obj = join(out, 'obj');
rmSync(out, { recursive: true, force: true });
mkdirSync(obj, { recursive: true });

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
    return ['-vfsoverlay', overlay, '-Xcc', '-ivfsoverlay', '-Xcc', overlay];
}
const flags = swiftFlags();
const iconTool = join(obj, 'make-icon');
run('swiftc', [...flags, join(root, 'scripts', 'launcher', 'make-icon.swift'), '-o', iconTool]);
const iconset = join(obj, 'MIXFPGA.iconset');
run(iconTool, [iconset]);
const icns = join(obj, 'MIXFPGA.icns');
run('iconutil', ['-c', 'icns', iconset, '-o', icns]);

const app = join(out, 'MIX-FPGA Installer.app');
mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
const exe = join(app, 'Contents', 'MacOS', 'MIXFPGAInstaller');
run('swiftc', [...flags, '-swift-version', '5', '-O', '-target', 'arm64-apple-macosx13.0', '-o', exe, ...['Core.swift', 'Flow.swift', 'UI.swift', 'main.swift'].map((f) => join(root, 'installer', 'macos', f))]);
copyFileSync(join(root, 'installer', 'macos', 'bridge.js'), join(app, 'Contents', 'Resources', 'bridge.js'));
copyFileSync(icns, join(app, 'Contents', 'Resources', 'MIXFPGA.icns'));
writeFileSync(join(app, 'Contents', 'PkgInfo'), 'APPL????');
writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key><string>en</string>
    <key>CFBundleExecutable</key><string>MIXFPGAInstaller</string>
    <key>CFBundleIconFile</key><string>MIXFPGA</string>
    <key>CFBundleIdentifier</key><string>com.emxplore.mixfpga.installer</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleName</key><string>MIX-FPGA Installer</string>
    <key>CFBundleDisplayName</key><string>MIX-FPGA Installer</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
    <key>CFBundleVersion</key><string>${pkg.version}</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSArchitecturePriority</key><array><string>arm64</string></array>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSHumanReadableCopyright</key><string>MIX-FPGA is an EMXplore project. Copyright 2026 Walid Dyab.</string>
    <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
`);
run('codesign', ['--force', '--sign', '-', '--timestamp=none', app]);
console.log(`built ${app}`);
