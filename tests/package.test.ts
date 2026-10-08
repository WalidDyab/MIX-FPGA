import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { validateRequirement } from '../core';
import { REPO } from './helpers';

interface Pkg {
    name: string;
    version: string;
    publisher: string;
    displayName: string;
    main: string;
    engines: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies: Record<string, string>;
    activationEvents?: string[];
    scripts: Record<string, string>;
    contributes: {
        commands: Array<{ command: string }>;
        menus: Record<string, Array<{ command: string }>>;
        viewsWelcome: Array<{ view: string; contents: string; when: string }>;
        walkthroughs: Array<{ id: string; steps: Array<{ id: string; description: string; media: { markdown: string } }> }>;
        languages: Array<{ configuration: string; extensions: string[] }>;
        grammars: Array<{ path: string }>;
    };
}

const pkg = async (): Promise<Pkg> => JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as Pkg;
const commandLinks = (text: string) => [...text.matchAll(/command:([\w.]+)/g)].map((m) => m[1]!);

describe('package manifest (Classroom Preview)', () => {
    it('identity, version and VS Code engine', async () => {
        const p = await pkg();
        assert.equal(p.name, 'nexysvhdl');
        assert.equal(p.displayName, 'NexysVHDL');
        assert.equal(p.publisher, 'emxplore');
        assert.equal(p.version, '0.6.0');
        assert.equal(p.engines['vscode'], '^1.120.0');
        // The API typings must not be newer than the declared minimum VS Code.
        assert.match(p.devDependencies['@types/vscode']!, /^~?1\.120\./);
        assert.equal(p.dependencies, undefined, 'no runtime npm dependencies: the VSIX needs no node_modules');
        assert.equal(p.main, 'dist/extension/extension.js');
    });

    it('every contributed command is registered and every command link points to a contributed command', async () => {
        const p = await pkg();
        const contributed = new Set(p.contributes.commands.map((c) => c.command));
        const sources = (await readFile(join(REPO, 'extension', 'commands', 'commands.ts'), 'utf8')) + (await readFile(join(REPO, 'extension', 'extension.ts'), 'utf8'));
        for (const c of contributed) assert.match(sources, new RegExp(`register\\('${c.replace(/\./g, '\\.')}'`), `${c} has a handler`);
        const links = [
            ...p.contributes.viewsWelcome.flatMap((w) => commandLinks(w.contents)),
            ...p.contributes.walkthroughs.flatMap((w) => w.steps.flatMap((s) => commandLinks(s.description))),
            ...Object.values(p.contributes.menus).flatMap((m) => m.map((x) => x.command)),
        ];
        const builtIn = new Set(['nexysvhdl.design.focus']);
        for (const l of links) assert.ok(contributed.has(l) || builtIn.has(l), `${l} is contributed`);
    });

    it('empty-workspace welcome: create, open, getting started, environment, and install toolchain', async () => {
        const p = await pkg();
        const noProject = p.contributes.viewsWelcome.find((w) => w.view === 'nexysvhdl.project' && w.when === '!nexysvhdl.hasProject')!;
        assert.deepEqual(commandLinks(noProject.contents), ['nexysvhdl.createProject', 'nexysvhdl.openProject', 'nexysvhdl.gettingStarted', 'nexysvhdl.showEnvironment']);
        const install = p.contributes.viewsWelcome.find((w) => w.when === 'nexysvhdl.toolchainState == not-installed')!;
        assert.deepEqual(commandLinks(install.contents), ['nexysvhdl.installToolchain']);
        assert.ok(p.contributes.viewsWelcome.some((w) => w.view === 'explorer' && w.when === 'workbenchState == empty'));
    });

    it('Getting Started walkthrough: the ten classroom steps, each with its page', async () => {
        const p = await pkg();
        const w = p.contributes.walkthroughs.find((x) => x.id === 'nexysvhdl.gettingStarted')!;
        assert.deepEqual(w.steps.map((s) => s.id), ['setup', 'project', 'edit', 'xdc', 'check', 'simulate', 'waveform', 'rtl', 'build', 'program']);
        for (const s of w.steps) assert.ok(existsSync(join(REPO, s.media.markdown)), s.media.markdown);
        const xdc = await readFile(join(REPO, 'resources', 'walkthrough', 'xdc.md'), 'utf8');
        assert.match(xdc, /PACKAGE_PIN/);
        assert.match(xdc, /Vivado/);
    });

    it('runtime resources exist: VHDL grammar, language configuration, board data, requirement, notices, student docs', async () => {
        const p = await pkg();
        assert.deepEqual(p.contributes.languages[0]!.extensions, ['.vhd', '.vhdl']);
        for (const f of [
            ...p.contributes.languages.map((l) => l.configuration),
            ...p.contributes.grammars.map((g) => g.path),
            'resources/nexysvhdl.svg',
            'boards/nexys-a7-100t/board.json',
            'toolchains/bundle/requirement.json',
            'THIRD_PARTY_NOTICES.md',
            'CHANGELOG.md',
            'docs/student-install-windows.md',
            'docs/student-install-macos.md',
            'docs/student-quick-start.md',
            'docs/vsix-readme.md',
        ]) {
            assert.ok(existsSync(join(REPO, f)), f);
        }
    });

    it('build and package scripts exist for both platforms', async () => {
        const p = await pkg();
        for (const s of ['build', 'typecheck', 'test', 'toolchain:assemble', 'toolchain:pack', 'package:win', 'package:mac']) assert.ok(p.scripts[s], s);
        assert.match(p.scripts['package:win']!, /--target win32-x64/);
        assert.match(p.scripts['package:mac']!, /--target darwin-arm64/);
    });
});

describe('license: NexysVHDL is Apache-2.0; third-party software keeps its own licenses', () => {
    it('package metadata, the canonical Apache-2.0 text and the NOTICE file', async () => {
        const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'));
        assert.equal(pkg.license, 'Apache-2.0');
        const license = await readFile(join(REPO, 'LICENSE'));
        // SHA-256 of https://www.apache.org/licenses/LICENSE-2.0.txt (unmodified).
        assert.equal(createHash('sha256').update(license).digest('hex'), 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
        const notice = await readFile(join(REPO, 'NOTICE'), 'utf8');
        assert.match(notice, /^NexysVHDL\nCopyright \d{4} /);
        assert.match(notice, /Apache License, Version 2\.0/);
        assert.match(notice, /NOT\s+licensed under the Apache License/);
        const script = await readFile(join(REPO, 'scripts', 'package.mjs'), 'utf8');
        assert.doesNotMatch(script, /--skip-license/, 'vsce checks the license');
        for (const f of ["'LICENSE'", "'NOTICE'"]) assert.ok(script.includes(f), `package gate requires ${f}`);
    });

    it('the notices never present the FPGA toolchain as Apache-2.0', async () => {
        const notices = await readFile(join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8');
        assert.match(notices, /Third-party software is not relicensed/);
        assert.match(notices, /The Apache License does not apply to them/);
        for (const recipe of ['win32-x64', 'darwin-arm64']) {
            const r = JSON.parse(await readFile(join(REPO, 'toolchains', 'bundle', `${recipe}.json`), 'utf8'));
            for (const c of r.components) assert.doesNotMatch(`${c.license} ${c.licenseEvidence}`, /NexysVHDL/, `${recipe} ${c.id}: licensed by its authors, not by NexysVHDL`);
        }
    });
});

describe('VSIX content control (.vscodeignore)', () => {
    it('is an allowlist: compiled JavaScript and runtime data only', async () => {
        const lines = (await readFile(join(REPO, '.vscodeignore'), 'utf8')).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
        assert.equal(lines[0], '**', 'everything is excluded unless listed');
        const allowed = lines.filter((l) => l.startsWith('!')).map((l) => l.slice(1));
        for (const a of allowed) {
            assert.doesNotMatch(a, /\.ts$|\.map$|^tests|^dist\/tests|^dist\/cli|^toolchain\/|^tools|^examples|^experiments|^notes|^node_modules|^scripts|^docs\/images|\.nexysvhdl/, `allowlist entry ${a}`);
        }
        for (const required of ['dist/extension/**/*.js', 'dist/core/**/*.js', 'dist/runtime/**/*.js', 'dist/platform/**/*.js', 'package.json', 'resources/**', 'boards/**/*.json', 'toolchains/bundle/requirement.json', 'THIRD_PARTY_NOTICES.md', 'LICENSE', 'NOTICE']) {
            assert.ok(allowed.includes(required), required);
        }
    });

    it('the extension does not need TypeScript or any npm package at runtime', async () => {
        const files = (await readdir(join(REPO, 'dist'), { recursive: true, withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.js') && !/[\\/]dist[\\/](tests|cli)([\\/]|$)/.test(`${e.parentPath}${'/'}`));
        assert.ok(files.length > 50);
        for (const f of files) {
            const text = await readFile(join(f.parentPath, f.name), 'utf8');
            for (const m of text.matchAll(/require\("([^"]+)"\)/g)) {
                const id = m[1]!;
                assert.ok(id.startsWith('.') || id.startsWith('node:') || id === 'vscode', `${relative(REPO, join(f.parentPath, f.name))} requires ${id}`);
                assert.doesNotMatch(id, /\.ts$/);
            }
        }
    });
});

describe('toolchain requirement and recipes', () => {
    it('requires toolchain 1.0: Windows and macOS validated, each with its own content hash and archive', async () => {
        const req = JSON.parse(await readFile(join(REPO, 'toolchains', 'bundle', 'requirement.json'), 'utf8'));
        assert.deepEqual(validateRequirement(req), []);
        assert.equal(req.bundleVersion, '1.0');
        assert.equal(req.targets['win32-x64'].status, 'validated');
        assert.equal(req.targets['win32-x64'].archive, 'nexysvhdl-toolchain-1.0-win32-x64.tar.gz');
        // Windows toolchain 1.0 pre-release payload. The earlier internal validation candidate 43b3fb80… was replaced
        // before any external release (ADR-007 §6: immutable from release freeze; afterwards a change needs a new
        // version): the unused drivers and graphviz packages became placeholders, every used component is byte-identical.
        assert.equal(req.targets['win32-x64'].treeSha256, '57f0f0da89e6565d6e46d20780fa57af86f8ac36d45a78b750203fc8f381820b');
        assert.equal(req.targets['win32-x64'].files, 21208);
        // The macOS toolchain 1.0 validated on the Mac is unchanged by the Windows compliance work.
        assert.equal(req.targets['darwin-arm64'].treeSha256, 'f04022180f9bb746dc5dc467bc7d1d379512f302159763f8c4a8c0ed50b2aac7');
        assert.equal(req.targets['darwin-arm64'].status, 'validated');
        assert.equal(req.targets['darwin-arm64'].archive, 'nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz');
        assert.match(req.targets['darwin-arm64'].treeSha256, /^[0-9a-f]{64}$/);
        assert.notEqual(req.targets['darwin-arm64'].treeSha256, req.targets['win32-x64'].treeSha256);
        assert.deepEqual(Object.keys(req.targets).sort(), ['darwin-arm64', 'win32-x64'], 'no Linux, Windows ARM or Intel macOS');
    });

    it('the Windows and macOS recipes are fully pinned, validated and match the requirement version', async () => {
        const lib = (await import(pathToFileURL(join(REPO, 'scripts', 'toolchain', 'lib.mjs')).href)) as { validateRecipe(r: unknown, target: string): string[] };
        const win = JSON.parse(await readFile(join(REPO, 'toolchains', 'bundle', 'win32-x64.json'), 'utf8'));
        assert.deepEqual(lib.validateRecipe(win, 'win32-x64'), []);
        assert.equal(win.bundleVersion, '1.0');
        assert.deepEqual(win.versions, { ghdl: '6.0.0', apio: '1.6.0', openxc7: '2026-09-24', openxc7PartsIndexSchema: 5, yosys: '0.63+173', 'nextpnr-xilinx': '0eae9fb' });
        assert.equal(win.programmer.bundled, false, 'Digilent software is not redistributed');
        assert.ok(!JSON.stringify(win).match(/digilent\.com\/[^"\s]*\.(exe|msi|zip)/i), 'no Digilent installer is mirrored');
        assert.ok(!win.components.some((c: { archive?: { url: string } }) => /digilent/i.test(c.archive?.url ?? '')), 'no Digilent component');
        // Every redistributed component comes from an official release; the unused drivers and graphviz
        // packages are empty placeholders (nothing redistributed, see tests/compliance.test.ts).
        for (const c of win.components) {
            if (c.placeholder) assert.equal(c.archive, undefined, `${c.id}: a placeholder redistributes nothing`);
            else assert.match(c.archive.url, /^https:\/\/github\.com\/(ghdl|fpgawars)\//i, `${c.id} comes from an official release`);
        }
    });

    it('the macOS recipe pins exactly the validated Apple-silicon toolchain (no upgrades, no Windows-only packages)', async () => {
        const lib = (await import(pathToFileURL(join(REPO, 'scripts', 'toolchain', 'lib.mjs')).href)) as { validateRecipe(r: unknown, target: string): string[]; apioRemoteConfig(r: unknown): { packages: Record<string, { release: { tag: string } }> } };
        const mac = JSON.parse(await readFile(join(REPO, 'toolchains', 'bundle', 'darwin-arm64.json'), 'utf8'));
        assert.deepEqual(lib.validateRecipe(mac, 'darwin-arm64'), []);
        assert.equal(mac.status, 'validated');
        assert.equal(mac.bundleVersion, '1.0');
        assert.deepEqual(mac.versions, { ghdl: '6.0.0', apio: '1.7.0', openxc7: '2026-09-25', openxc7PartsIndexSchema: 7, yosys: '0.63+173', 'nextpnr-xilinx': 'e860c9c8', openFPGALoader: '1.1.1' });
        assert.equal(mac.apio.platformId, 'darwin-arm64');
        assert.deepEqual(mac.executables, { ghdl: 'ghdl/bin/ghdl', apio: 'apio/bin/apio', programmer: 'apio/packages/oss-cad-suite/bin/openFPGALoader' });
        // GHDL 6.0.0 from the official release, never Apio's oss-cad-suite GHDL (duplicate LC_RPATH on macOS 27), and
        // the LLVM JIT build: the ahead-of-time LLVM build links each elaborated design with the system cc/ld, which
        // only exists on a Mac with Xcode Command Line Tools.
        const ghdl = mac.components.find((c: { id: string }) => c.id === 'ghdl');
        assert.equal(ghdl.version, '6.0.0');
        assert.equal(ghdl.archive.url, 'https://github.com/ghdl/ghdl/releases/download/v6.0.0/ghdl-llvm-jit-6.0.0-macos15-aarch64.tar.gz');
        assert.equal(ghdl.archive.sha256, 'c21312d5a0cc5833e6d8690d8c4343e67f4fc32f070c07343816cd11a31c7769');
        // Apio 1.7.0: the official darwin-arm64 PyInstaller bundle of release 2026-09-27 (its own Python; none needed on the Mac).
        const apio = mac.components.find((c: { id: string }) => c.id === 'apio');
        assert.equal(apio.archive.url, 'https://github.com/fpgawars/apio/releases/download/2026-09-27/apio-cli-darwin-arm64-20260927-bundle.tgz');
        // Apio 1.7.0 restricts drivers and graphviz to windows-amd64: the Mac bundle has exactly these packages.
        const pinned = lib.apioRemoteConfig(mac).packages;
        assert.deepEqual(Object.fromEntries(Object.entries(pinned).map(([k, v]) => [k, v.release.tag])), { definitions: '2026-09-17', 'oss-cad-suite': '2026-09-15', verible: '2026-09-20', openxc7: '2026-09-25' });
        assert.ok(!JSON.stringify(mac).includes('2026-09-27/apio-openxc7'), 'openXC7 2026-09-27 (parts-index schema 8) is never used');
        for (const c of mac.components) assert.match(c.archive.url, /^https:\/\/github\.com\/(ghdl|fpgawars)\//i, `${c.id} comes from an official release`);
        for (const c of mac.components) assert.ok(c.archive.url.endsWith(c.archive.file), `${c.id}: file name matches the URL`);
        // The programmer is bundled (openFPGALoader in oss-cad-suite); nothing from Digilent, no Homebrew.
        assert.equal(mac.programmer.kind, 'bundled');
        assert.equal(mac.programmer.testedVersion, '1.1.1');
        assert.ok(!mac.components.some((c: { archive: { url: string } }) => /digilent|brew|homebrew/i.test(c.archive.url)), 'no Digilent or Homebrew download');
        // No Python shim: openXC7's wrappers run the package's own Python on macOS.
        assert.deepEqual(mac.shims, []);
        assert.deepEqual(mac.environment.pathPrepend, []);
    });

    it('license texts referenced by the recipes exist (shared, or platform-specific in licenses-<target>/)', async () => {
        for (const target of ['win32-x64', 'darwin-arm64']) {
            const recipe = JSON.parse(await readFile(join(REPO, 'toolchains', 'bundle', `${target}.json`), 'utf8'));
            for (const c of recipe.components) {
                for (const f of c.licenseFiles as string[]) {
                    if (!f.startsWith('licenses/')) continue;
                    const name = f.slice('licenses/'.length);
                    assert.ok(existsSync(join(REPO, 'toolchains', 'bundle', 'licenses', name)) || existsSync(join(REPO, 'toolchains', 'bundle', `licenses-${target}`, name)), `${target}: ${f}`);
                }
            }
        }
        // Platform-specific texts never land in the shared folder (that would change the released Windows content).
        for (const f of await readdir(join(REPO, 'toolchains', 'bundle', 'licenses-darwin-arm64'))) assert.ok(!existsSync(join(REPO, 'toolchains', 'bundle', 'licenses', f)), f);
    });
});

describe('privacy: shipped sources contain no developer paths or personal data', () => {
    it('no absolute developer paths, user names or e-mail addresses', async () => {
        const roots = ['core', 'platform', 'runtime', 'extension', 'resources', 'boards', 'toolchains/bundle'];
        const files = ['package.json', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'docs/student-install-windows.md', 'docs/student-install-macos.md', 'docs/student-quick-start.md', 'docs/vsix-readme.md', '.vscodeignore'];
        for (const r of roots) {
            for (const e of await readdir(join(REPO, r), { recursive: true, withFileTypes: true })) {
                if (e.isFile() && !e.parentPath.includes('licenses')) files.push(relative(REPO, join(e.parentPath, e.name)));
            }
        }
        const forbidden = [/[A-Za-z]:\\Users\\(?!student\b|Public\b)\w/, /\/Users\/(?!student\b)\w/, /WSClaude/, /@gmail\.com|wmdyab/i, /AppData\\Local\\Temp/];
        for (const f of files) {
            const text = await readFile(join(REPO, f), 'utf8');
            for (const r of forbidden) assert.doesNotMatch(text, r, f);
        }
    });
});
