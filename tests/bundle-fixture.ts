import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { BundleManifest, ToolchainRequirement } from '../core';
import { inventoryDirectory, writeTarGz } from '../core';
import { writeFiles } from './helpers';

/**
 * A small fake NexysVHDL toolchain bundle with the real layout and manifest
 * shape (no real tools): enough for the loader, locator, runner, installer
 * and composition-root tests.
 */
export interface FakeBundleOptions {
    readonly target?: string;
    readonly version?: string;
    /** Bundle a programmer executable (macOS style). */
    readonly programmer?: boolean;
    /** Overrides of the generated manifest. */
    readonly manifest?: (m: BundleManifest) => BundleManifest;
    /** Extra or replaced files (relative POSIX path -> content). */
    readonly files?: Record<string, string>;
}

export const FAKE_PACKAGES = { definitions: '2026.09.17', openxc7: '2026.09.24' } as const;

export function fakeManifest(options: FakeBundleOptions = {}): BundleManifest {
    const target = options.target ?? 'win32-x64';
    const [platform, arch] = target.split('-') as [string, string];
    const exe = platform === 'win32' ? '.exe' : '';
    const m: BundleManifest = {
        schemaVersion: 1,
        product: 'NexysVHDL',
        bundleVersion: options.version ?? '1.0',
        target,
        platform,
        arch,
        displayPlatform: `Test ${target}`,
        versions: { ghdl: '6.0.0', apio: '1.6.0', openxc7: '2026-09-24', yosys: '0.63+173', 'nextpnr-xilinx': '0eae9fb' },
        executables: {
            ghdl: { path: `ghdl/bin/ghdl${exe}`, sha256: '0'.repeat(64) },
            apio: { path: `apio/bin/apio${exe}`, sha256: '0'.repeat(64) },
            ...(options.programmer ? { programmer: { path: 'apio/packages/oss-cad-suite/bin/openFPGALoader', sha256: '0'.repeat(64) } } : {}),
        },
        apio: {
            version: '1.6.0',
            platformId: platform === 'win32' ? 'windows-amd64' : 'darwin-arm64',
            packagesDir: 'apio/packages',
            remoteConfig: 'apio/remote-config/apio-1.6.x.jsonc',
            remoteConfigTemplate: 'apio/remote-config/apio-{major}.{minor}.x.jsonc',
            packages: { ...FAKE_PACKAGES, ...(options.programmer ? { 'oss-cad-suite': '2026.09.15' } : {}) },
        },
        environment: { pathPrepend: ['shims'], set: { PYTHONDONTWRITEBYTECODE: '1' } },
        programmer: options.programmer
            ? { kind: 'bundled', name: 'Bundled programmer', bundled: true, testedVersion: '1.1.1' }
            : { kind: 'system', name: 'System programmer', bundled: false, testedVersion: '2.7.1' },
        components: [],
    };
    return options.manifest ? options.manifest(m) : m;
}

/** Writes a fake bundle into `root` (a toolchain version folder). */
export async function writeFakeBundle(root: string, options: FakeBundleOptions = {}): Promise<BundleManifest> {
    const m = fakeManifest(options);
    // Files follow the standard layout even when a test overrides the manifest entries.
    const { manifest: _override, ...plain } = options;
    const layout = fakeManifest(plain);
    const platformId = m.apio.platformId;
    const packages = m.apio.packages;
    const installed = Object.fromEntries(Object.entries(packages).map(([name, version]) => [name, { version, platform: platformId, 'loaded-by': '1.6.0', 'loaded-at': '2026-09-26-22-17', 'loaded-from': `https://example.invalid/${name}.tgz` }]));
    const pinned = { packages: Object.fromEntries(Object.keys(packages).map((name) => [name, { repository: { name, organization: 'fpgawars' }, release: { tag: packages[name as keyof typeof packages]!.replaceAll('.', '-'), package: `${name}.tgz` } }])) };
    const files: Record<string, string> = {
        'toolchain-manifest.json': JSON.stringify(m, null, 2),
        [layout.executables.ghdl!.path]: 'fake ghdl',
        [layout.executables.apio!.path]: 'fake apio',
        'apio/packages/installed_packages.json': JSON.stringify(installed, null, 4),
        'apio/packages/definitions/boards.jsonc': '{}',
        'apio/packages/openxc7/BUILD-INFO.json': JSON.stringify({ 'release-tag': '2026-09-24' }),
        'apio/remote-config/apio-1.6.x.jsonc': `// pinned\n${JSON.stringify(pinned, null, 2)}\n`,
        'shims/python.cmd': '@echo off\r\n',
        'THIRD_PARTY_NOTICES.md': '# notices\n',
        ...(options.programmer ? { 'apio/packages/oss-cad-suite/bin/openFPGALoader': 'fake programmer' } : {}),
        ...(options.files ?? {}),
    };
    await writeFiles(root, files);
    for (const e of Object.values(layout.executables)) await chmod(join(root, ...e.path.split('/')), 0o755);
    return m;
}

/** Packs a fake bundle into a .tar.gz and returns the matching requirement. */
export async function fakeArchive(dir: string, bundleDir: string, options: FakeBundleOptions = {}): Promise<{ archive: string; requirement: ToolchainRequirement; treeSha256: string }> {
    const target = options.target ?? 'win32-x64';
    const version = options.version ?? '1.0';
    const inv = await inventoryDirectory(bundleDir);
    const archive = join(dir, `nexysvhdl-toolchain-${version}-${target}.tar.gz`);
    await writeTarGz(bundleDir, archive);
    return {
        archive,
        treeSha256: inv.treeSha256,
        requirement: { schemaVersion: 1, bundleVersion: version, targets: { [target]: { status: 'validated', treeSha256: inv.treeSha256, files: inv.entries.length, bytes: inv.bytes, archive: `nexysvhdl-toolchain-${version}-${target}.tar.gz` } } },
    };
}
