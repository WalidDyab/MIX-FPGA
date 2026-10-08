import assert from 'node:assert/strict';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
    createNvprojFile,
    findNvprojFiles,
    formatNvproj,
    isNvprojPath,
    NVPROJ_FORMAT,
    NVPROJ_VERSION,
    nvprojNameFor,
    parseNvproj,
    resolveNvproj,
    updateProjectFile,
    whenFileJobsSettled,
} from '../core';
import { resolveOpenTarget } from '../extension/project/open-target';
import { createProject } from '../extension/project/scaffold';
import { repoBoards, tempDir } from './helpers';

const board = async () => (await repoBoards()).get('nexys-a7-100t')!;
const valid = (extra: Record<string, unknown> = {}) => JSON.stringify({ format: NVPROJ_FORMAT, version: NVPROJ_VERSION, config: 'nexysvhdl.json', ...extra });

/** The same cases the launcher's C# tests run (launcher/tests/CoreTests.cs); the message fragments must agree. */
const REJECTED: Array<[string, string]> = [
    ['{ broken', 'damaged'],
    ['[1,2]', 'damaged'],
    [valid({ format: 'something-else' }), 'not a NexysVHDL project file'],
    [valid({ version: 2 }), 'newer NexysVHDL'],
    [valid({ version: 0 }), 'invalid "version"'],
    [valid({ version: 1.5 }), 'invalid "version"'],
    [valid({ version: '1' }), 'invalid "version"'],
    [JSON.stringify({ format: NVPROJ_FORMAT, version: 1 }), 'unusable settings file'],
    [valid({ config: 'C:\\Users\\x\\nexysvhdl.json' }), 'unusable settings file'],
    [valid({ config: '/etc/nexysvhdl.json' }), 'unusable settings file'],
    [valid({ config: '../nexysvhdl.json' }), 'unusable settings file'],
    [valid({ config: 'other.json' }), 'unusable settings file'],
];

describe('.nvproj format', () => {
    it('the descriptor is minimal, versioned and relative: it never duplicates project settings', () => {
        const text = formatNvproj();
        assert.deepEqual(JSON.parse(text), { format: 'nexysvhdl-project', version: 1, config: 'nexysvhdl.json' });
        assert.doesNotMatch(text, /[A-Za-z]:\\|\/Users\/|top|constraints|testbench|sources/);
        assert.deepEqual(parseNvproj(text), { ok: true, config: 'nexysvhdl.json' });
    });

    it('accepts a BOM, unknown future fields and a relative nested config; normalizes separators', () => {
        assert.deepEqual(parseNvproj('\uFEFF' + valid({ future: { a: 1 } })), { ok: true, config: 'nexysvhdl.json' });
        assert.deepEqual(parseNvproj(valid({ config: 'inner\\nexysvhdl.json' })), { ok: true, config: 'inner/nexysvhdl.json' });
    });

    for (const [text, fragment] of REJECTED) {
        it(`rejects ${text.slice(0, 60)} with a clear message`, () => {
            const r = parseNvproj(text);
            assert.equal(r.ok, false);
            assert.ok(!r.ok && r.message.includes(fragment), `${!r.ok && r.message} should mention "${fragment}"`);
        });
    }

    it('names the file after the folder and recognises the extension case-insensitively', () => {
        assert.equal(nvprojNameFor('MyProject'), 'MyProject.nvproj');
        assert.equal(nvprojNameFor('My Project'), 'My Project.nvproj');
        assert.equal(nvprojNameFor('a:b'), 'a_b.nvproj');
        assert.ok(isNvprojPath('X\\Y.NVPROJ'));
        assert.ok(!isNvprojPath('nexysvhdl.json'));
    });
});

describe('.nvproj resolution', () => {
    it('a valid project file resolves to its project folder, also when the path contains spaces', async (t) => {
        const parent = await tempDir(t, 'nexys nvproj ');
        await mkdir(join(parent, 'Folder With Spaces'));
        const r = await createProject({ parentDir: join(parent, 'Folder With Spaces'), name: 'My-Project', board: await board(), template: 'empty' });
        assert.ok(r.ok);
        const file = join(r.root, 'My-Project.nvproj');
        const resolved = await resolveNvproj(file);
        assert.ok(resolved.ok);
        assert.equal(resolved.root, r.root);
        assert.equal(resolved.configFile, join(r.root, 'nexysvhdl.json'));
    });

    it('a malformed project file is explained, not thrown', async (t) => {
        const dir = await tempDir(t);
        await writeFile(join(dir, 'nexysvhdl.json'), '{}');
        for (const [text, fragment] of REJECTED) {
            await writeFile(join(dir, 'P.nvproj'), text);
            const r = await resolveNvproj(join(dir, 'P.nvproj'));
            assert.ok(!r.ok && r.message.includes(fragment), `${text}: ${!r.ok && r.message}`);
        }
    });

    it('a missing nexysvhdl.json is named, and so is a project file that is gone', async (t) => {
        const dir = await tempDir(t);
        await writeFile(join(dir, 'P.nvproj'), formatNvproj());
        const missing = await resolveNvproj(join(dir, 'P.nvproj'));
        assert.ok(!missing.ok && missing.code === 'CONFIG_MISSING' && /not found next to it/.test(missing.message));
        const gone = await resolveNvproj(join(dir, 'Gone.nvproj'));
        assert.ok(!gone.ok && gone.code === 'NOT_FOUND');
    });

    it('a copied or moved project folder still opens from the new place: the descriptor holds only relative paths', async (t) => {
        const parent = await tempDir(t);
        const r = await createProject({ parentDir: parent, name: 'Moved', board: await board() });
        assert.ok(r.ok);
        const text = await readFile(join(r.root, 'Moved.nvproj'), 'utf8');
        assert.ok(!text.includes(parent), 'no machine path inside the file');
        const copy = join(parent, 'Elsewhere', 'Deeper Folder', 'Moved Copy');
        await cp(r.root, copy, { recursive: true });
        const resolved = await resolveNvproj(join(copy, 'Moved.nvproj'));
        assert.ok(resolved.ok);
        assert.equal(resolved.root, copy);
    });

    it('a nested config resolves to the folder that holds nexysvhdl.json', async (t) => {
        const dir = await tempDir(t);
        await mkdir(join(dir, 'inner'));
        await writeFile(join(dir, 'inner', 'nexysvhdl.json'), '{}');
        await writeFile(join(dir, 'Outer.nvproj'), valid({ config: 'inner/nexysvhdl.json' }));
        const r = await resolveNvproj(join(dir, 'Outer.nvproj'));
        assert.ok(r.ok);
        assert.equal(r.root, join(dir, 'inner'));
    });
});

describe('New Project and legacy projects', () => {
    it('every new project, whatever its template, gets <name>.nvproj beside nexysvhdl.json, the single source of truth', async (t) => {
        for (const template of ['empty', 'starter'] as const) {
            const parent = await tempDir(t);
            const r = await createProject({ parentDir: parent, name: 'Counter', board: await board(), template });
            assert.ok(r.ok);
            assert.ok(r.files.includes('Counter.nvproj'), template);
            assert.deepEqual(JSON.parse(await readFile(join(r.root, 'Counter.nvproj'), 'utf8')), { format: 'nexysvhdl-project', version: 1, config: 'nexysvhdl.json' });
            const settings = await readFile(join(r.root, 'nexysvhdl.json'), 'utf8');
            assert.doesNotMatch(settings, /nvproj/, 'the settings file does not know about the descriptor');
            assert.deepEqual(await findNvprojFiles(r.root), [join(r.root, 'Counter.nvproj')]);
        }
    });

    it('a legacy project without a .nvproj opens as before; creating the file adds exactly one file and never overwrites', async (t) => {
        const parent = await tempDir(t);
        const r = await createProject({ parentDir: parent, name: 'Legacy', board: await board(), template: 'empty' });
        assert.ok(r.ok);
        await (await import('node:fs/promises')).rm(join(r.root, 'Legacy.nvproj'));
        const before = (await readdir(r.root)).sort();
        const settings = await readFile(join(r.root, 'nexysvhdl.json'), 'utf8');
        const target = await resolveOpenTarget(r.root);
        assert.ok(target.ok && target.via === 'folder' && target.root === r.root);
        assert.deepEqual(await findNvprojFiles(r.root), []);

        const created = await createNvprojFile(r.root);
        assert.equal(created.created, true);
        assert.deepEqual((await readdir(r.root)).sort(), [...before, 'Legacy.nvproj'].sort(), 'exactly one new file');
        assert.equal(await readFile(join(r.root, 'nexysvhdl.json'), 'utf8'), settings, 'the project settings are untouched');

        await writeFile(created.file, 'my own content');
        const again = await createNvprojFile(r.root);
        assert.equal(again.created, false);
        assert.equal(await readFile(created.file, 'utf8'), 'my own content', 'never overwritten');
    });

    it('Open Project resolves a folder, a .nvproj and a nexysvhdl.json to the same project, and explains everything else', async (t) => {
        const parent = await tempDir(t);
        const r = await createProject({ parentDir: parent, name: 'Same', board: await board() });
        assert.ok(r.ok);
        for (const path of [r.root, join(r.root, 'Same.nvproj'), join(r.root, 'nexysvhdl.json')]) {
            const target = await resolveOpenTarget(path);
            assert.ok(target.ok, path);
            assert.equal(target.root, r.root);
        }
        assert.equal((await resolveOpenTarget(join(r.root, 'Same.nvproj')) as { via: string }).via, 'project-file');
        const plain = join(parent, 'Photos');
        await mkdir(plain);
        for (const bad of [plain, join(parent, 'nothing'), join(r.root, 'src', 'top.vhd')]) {
            const target = await resolveOpenTarget(bad);
            assert.ok(!target.ok && target.message.length > 10, bad);
        }
        await writeFile(join(parent, 'broken.nvproj'), '{ nope');
        const broken = await resolveOpenTarget(join(parent, 'broken.nvproj'));
        assert.ok(!broken.ok && /damaged/.test(broken.message));
    });
});

describe('nexysvhdl.json writes', () => {
    it('simultaneous updates never lose each other, and no temporary file is left behind', async (t) => {
        const parent = await tempDir(t);
        const r = await createProject({ parentDir: parent, name: 'Race', board: await board(), template: 'empty' });
        assert.ok(r.ok);
        const file = join(r.root, 'nexysvhdl.json');
        await Promise.all([
            updateProjectFile(file, { top: 'one' }),
            updateProjectFile(file, { name: 'Renamed' }),
            updateProjectFile(file, { exclude: ['src/x.vhd'] }),
            updateProjectFile(file, { simulation: { sources: [], stopTime: '2us' } }),
        ]);
        await whenFileJobsSettled();
        const config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        assert.equal(config['top'], 'one');
        assert.equal(config['name'], 'Renamed');
        assert.deepEqual(config['exclude'], ['src/x.vhd']);
        assert.deepEqual((config['simulation'] as { stopTime: string }).stopTime, '2us');
        assert.deepEqual((await readdir(r.root)).filter((n) => n.endsWith('.tmp')), []);
    });
});
