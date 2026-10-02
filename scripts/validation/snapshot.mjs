#!/usr/bin/env node
// External-state snapshot for installed-package validation: proves that
// NexysVHDL leaves other tool installations (e.g. ~/.apio, Digilent, a
// developer GHDL) untouched. Records path, size, mtime and SHA-256 of every
// file, plus whether each root exists.
//
//   node scripts/validation/snapshot.mjs take <out.json> <path>...
//   node scripts/validation/snapshot.mjs compare <before.json> <after.json>
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

async function sha256(path) {
    const h = createHash('sha256');
    for await (const c of createReadStream(path)) h.update(c);
    return h.digest('hex');
}

async function snapshotPath(root) {
    if (!existsSync(root)) return { root, exists: false, files: {} };
    const files = {};
    const add = async (full) => {
        const st = await stat(full);
        files[relative(root, full).split(sep).join('/') || '.'] = { size: st.size, mtimeMs: st.mtimeMs, sha256: await sha256(full) };
    };
    if ((await stat(root)).isFile()) await add(root);
    else for (const e of await readdir(root, { recursive: true, withFileTypes: true })) if (e.isFile()) await add(join(e.parentPath, e.name));
    return { root, exists: true, files };
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'take') {
    const [out, ...roots] = rest;
    const taken = { at: new Date().toISOString(), roots: [] };
    for (const r of roots) {
        const s = await snapshotPath(r);
        taken.roots.push(s);
        console.log(`${r}: ${s.exists ? `${Object.keys(s.files).length} files` : 'does not exist'}`);
    }
    await writeFile(out, JSON.stringify(taken));
} else if (mode === 'compare') {
    const [a, b] = await Promise.all(rest.map(async (f) => JSON.parse(await readFile(f, 'utf8'))));
    let changed = 0;
    for (const before of a.roots) {
        const after = b.roots.find((r) => r.root === before.root);
        const diff = { added: [], removed: [], modified: [], touched: [] };
        if (!after || after.exists !== before.exists) {
            console.log(`${before.root}: existence changed (${before.exists} -> ${after?.exists})`);
            changed++;
            continue;
        }
        for (const [p, f] of Object.entries(before.files)) {
            const g = after.files[p];
            if (!g) diff.removed.push(p);
            else if (g.sha256 !== f.sha256 || g.size !== f.size) diff.modified.push(p);
            else if (g.mtimeMs !== f.mtimeMs) diff.touched.push(p);
        }
        for (const p of Object.keys(after.files)) if (!before.files[p]) diff.added.push(p);
        const n = diff.added.length + diff.removed.length + diff.modified.length + diff.touched.length;
        changed += n;
        console.log(`${before.root}: ${before.exists ? `${Object.keys(before.files).length} files` : 'absent'} — ${n === 0 ? 'UNCHANGED (content and timestamps)' : JSON.stringify(diff)}`);
    }
    process.exit(changed ? 1 : 0);
} else {
    console.error('usage: snapshot.mjs take <out.json> <path>... | compare <before.json> <after.json>');
    process.exit(2);
}
