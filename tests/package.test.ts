import assert from 'node:assert/strict';
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
        assert.match(p.version, /^0\.5\.\d+$/);
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
        const builtIn = new Set(['nexysvhdl.files.focus']);
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

describe('VSIX content control (.vscodeignore)', () => {
    it('is an allowlist: compiled JavaScript and runtime data only', async () => {
        const lines = (await readFile(join(REPO, '.vscodeignore'), 'utf8')).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
        assert.equal(lines[0], '**', 'everything is excluded unless listed');
        const allowed = lines.filter((l) => l.startsWith('!')).map((l) => l.slice(1));
        for (const a of allowed) {
            assert.doesNotMatch(a, /\.ts$|\.map$|^tests|^dist\/tests|^dist\/cli|^toolchain\/|^tools|^examples|^experiments|^notes|^node_modules|^scripts|^docs\/images|\.nexysvhdl/, `allowlist entry ${a}`);
        }
        for (const required of ['dist/extension/**/*.js', 'dist/core/**/*.js', 'dist/runtime/**/*.js', 'dist/platform/**/*.js', 'package.json', 'resources/**', 'boards/**/*.json', 'toolchains/bundle/requirement.json', 'THIRD_PARTY_NOTICES.md']) {
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
    it('requires toolchain 1.0: Windows validated, macOS pending', async () => {
        const req = JSON.parse(await readFile(join(REPO, 'toolchains', 'bundle', 'requirement.json'), 'utf8'));
        assert.deepEqual(validateRequirement(req), []);
        assert.equal(req.bundleVersion, '1.0');
        assert.equal(req.targets['win32-x64'].status, 'validated');
        assert.equal(req.targets['win32-x64'].archive, 'nexysvhdl-toolchain-1.0-win32-x64.tar.gz');
        assert.equal(req.targets['darwin-arm64'].status, 'pending');
        assert.deepEqual(Object.keys(req.targets).sort(), ['darwin-arm64', 'win32-x64'], 'no Linux, Windows ARM or Intel macOS');
    });

    it('the Windows recipe is fully pinned, validated and matches the requirement version; the macOS recipe is a draft', async () => {
        const lib = (await import(pathToFileURL(join(REPO, 'scripts', 'toolchain', 'lib.mjs')).href)) as { validateRecipe(r: unknown, target: string): string[] };
        const win = JSON.parse(await readFile(join(REPO, 'toolchains', 'bundle', 'win32-x64.json'), 'utf8'));
        assert.deepEqual(lib.validateRecipe(win, 'win32-x64'), []);
        assert.equal(win.bundleVersion, '1.0');
        assert.deepEqual(win.versions, { ghdl: '6.0.0', apio: '1.6.0', openxc7: '2026-09-24', openxc7PartsIndexSchema: 5, yosys: '0.63+173', 'nextpnr-xilinx': '0eae9fb' });
        assert.equal(win.programmer.bundled, false, 'Digilent software is not redistributed');
        assert.ok(!JSON.stringify(win).match(/digilent\.com\/[^"\s]*\.(exe|msi|zip)/i), 'no Digilent installer is mirrored');
        assert.ok(!win.components.some((c: { archive: { url: string } }) => /digilent/i.test(c.archive.url)), 'no Digilent component');
        for (const c of win.components) assert.match(c.archive.url, /^https:\/\/github\.com\/(ghdl|fpgawars)\//i, `${c.id} comes from an official release`);
        const mac = JSON.parse(await readFile(join(REPO, 'toolchains', 'bundle', 'darwin-arm64.json'), 'utf8'));
        assert.equal(mac.status, 'draft');
        assert.ok(lib.validateRecipe(mac, 'darwin-arm64').length > 0, 'a draft recipe cannot be assembled');
    });

    it('license texts referenced by the recipe exist', async () => {
        const win = JSON.parse(await readFile(join(REPO, 'toolchains', 'bundle', 'win32-x64.json'), 'utf8'));
        for (const c of win.components) {
            for (const f of c.licenseFiles as string[]) if (f.startsWith('licenses/')) assert.ok(existsSync(join(REPO, 'toolchains', 'bundle', f)), f);
        }
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
