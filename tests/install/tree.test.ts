import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compareTree, copyTree, inventoryTree, makeReadOnly, makeWritable, treeDigest, treeIsIdentical } from '../../core/install/tree';
import { tempDir } from '../helpers';
import { makeSourceTools } from './fixtures';
import { ONLY_MACOS } from '../platform';

describe('tree inventory', () => {
    it('copies a tree exactly: bytes, executable bits and symbolic links', { skip: ONLY_MACOS }, async (t) => {
        const dir = await tempDir(t);
        const src = (await makeSourceTools(dir))['lima']!;
        await copyTree(src, join(dir, 'copy'));
        const a = await inventoryTree(src);
        const b = await inventoryTree(join(dir, 'copy'));
        assert.equal(treeDigest(a), treeDigest(b));
        assert.equal((await stat(join(dir, 'copy', 'bin', 'lima'))).mode & 0o111, 0o111);
        assert.equal(await readlink(join(dir, 'copy', 'lib', 'templates')), '../../lima/templates');
        assert.ok(a.links.length === 1 && a.files.some((f) => f.exec));
    });

    it('notices every kind of difference', { skip: ONLY_MACOS }, async (t) => {
        const dir = await tempDir(t);
        const src = (await makeSourceTools(dir))['lima']!;
        const expected = await inventoryTree(src);
        const flip = async (f: () => Promise<void>) => {
            await copyTree(src, join(dir, 'c'));
            await f();
            const d = compareTree(expected, await inventoryTree(join(dir, 'c')));
            await rm(join(dir, 'c'), { recursive: true });
            return d;
        };
        assert.deepEqual((await flip(() => rm(join(dir, 'c', 'lib', 'deep', 'data.txt')))).missing, ['lib/deep/data.txt']);
        assert.deepEqual((await flip(() => writeFile(join(dir, 'c', 'lib', 'deep', 'data.txt'), 'data for lima!'))).modified, ['lib/deep/data.txt']);
        // Same size, different byte: only the hash can tell.
        assert.deepEqual((await flip(() => writeFile(join(dir, 'c', 'lib', 'deep', 'data.txt'), 'data for limb'))).modified, ['lib/deep/data.txt']);
        assert.deepEqual((await flip(() => chmod(join(dir, 'c', 'bin', 'lima'), 0o644))).modeChanged, ['bin/lima']);
        assert.deepEqual((await flip(() => writeFile(join(dir, 'c', 'extra.txt'), 'x'))).extra, ['extra.txt']);
        assert.deepEqual((await flip(async () => { await rm(join(dir, 'c', 'lib', 'templates')); await symlink('elsewhere', join(dir, 'c', 'lib', 'templates')); })).linkChanged, ['lib/templates']);
        await copyTree(src, join(dir, 'ok'));
        assert.ok(treeIsIdentical(compareTree(expected, await inventoryTree(join(dir, 'ok')))));
    });

    it('makes a tree read-only and writable again, including folders', { skip: ONLY_MACOS }, async (t) => {
        const dir = await tempDir(t);
        const src = (await makeSourceTools(dir))['ghdl']!;
        await copyTree(src, join(dir, 'ro'));
        await makeReadOnly(join(dir, 'ro'));
        assert.equal((await lstat(join(dir, 'ro', 'bin'))).mode & 0o222, 0);
        assert.equal((await stat(join(dir, 'ro', 'bin', 'ghdl'))).mode & 0o222, 0);
        await assert.rejects(writeFile(join(dir, 'ro', 'bin', 'ghdl'), 'tamper'));
        await assert.rejects(mkdir(join(dir, 'ro', 'newdir')));
        assert.equal((await stat(join(dir, 'ro', 'bin', 'ghdl'))).mode & 0o111, 0o111, 'still executable');
        await makeWritable(join(dir, 'ro'));
        await rm(join(dir, 'ro'), { recursive: true });
    });
});
