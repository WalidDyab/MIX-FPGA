#!/usr/bin/env node
// MIX-FPGA Windows toolchain: assemble the portable tools MIX-FPGA owns into toolchains/experimental (git-ignored).
//   node scripts/mixfpga/assemble-windows.mjs [--source <installed NexysVHDL toolchain folder>] [--dest <folder>]
//
// The validated NexysVHDL Toolchain 1.0 is a PROVENANCE SOURCE ONLY: files are copied byte-for-byte and never modified, and
// nothing in the MIX-FPGA runtime ever points back into it. Every DLL an executable needs is found by reading its PE import
// table (recursively), so the copy is the exact closure, not a guess. Windows system DLLs are expected from the OS.
//
// Layout produced (all relative to the destination):
//   ghdl-6.0.0/{bin,lib,include}          the official mcode UCRT64 GHDL, as shipped
//   yosys-0.63/{bin,share/yosys}          yosys.exe with its DLL closure next to it
//   licenses/                             the license texts shipped with those tools
// Afterwards run `node scripts/mixfpga/toolchain.mjs record windows-x64` to (re)write the hashes in the manifest.
import { cp, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const source = resolve(arg('--source') ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'NexysVHDL', 'toolchains', 'win32-x64', '1.0'));
const dest = resolve(arg('--dest') ?? join(repo, 'toolchains', 'experimental'));
const suite = join(source, 'apio', 'packages', 'oss-cad-suite');

/** Names of the DLLs a PE file imports (import table + delay-load table is not needed for these tools). */
export async function peImports(file) {
    const fh = await open(file, 'r');
    try {
        const buf = await readFile(file);
        const u16 = (o) => buf.readUInt16LE(o);
        const u32 = (o) => buf.readUInt32LE(o);
        const pe = u32(0x3c);
        if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') return [];
        const nSections = u16(pe + 6);
        const optSize = u16(pe + 20);
        const opt = pe + 24;
        const magic = u16(opt);
        const dirBase = opt + (magic === 0x20b ? 112 : 96);
        const importRva = u32(dirBase + 8);
        if (!importRva) return [];
        const sections = [];
        for (let i = 0; i < nSections; i++) {
            const s = opt + optSize + i * 40;
            sections.push({ va: u32(s + 12), size: Math.max(u32(s + 8), u32(s + 16)), raw: u32(s + 20) });
        }
        const off = (rva) => { const s = sections.find((x) => rva >= x.va && rva < x.va + x.size); return s ? rva - s.va + s.raw : -1; };
        const names = [];
        for (let d = off(importRva); d >= 0; d += 20) {
            if (u32(d + 12) === 0) break;
            const n = off(u32(d + 12));
            names.push(buf.toString('latin1', n, buf.indexOf(0, n)));
        }
        return names;
    } finally {
        await fh.close();
    }
}

async function closure(exe, libDirs) {
    const found = new Map(); // lowercase name -> path
    const system = new Set();
    const queue = [exe];
    while (queue.length) {
        const f = queue.pop();
        for (const dll of await peImports(f)) {
            const key = dll.toLowerCase();
            if (found.has(key) || system.has(key)) continue;
            let hit;
            for (const dir of libDirs) {
                const names = await readdir(dir).catch(() => []);
                const real = names.find((n) => n.toLowerCase() === key);
                if (real) { hit = join(dir, real); break; }
            }
            if (hit) { found.set(key, hit); queue.push(hit); } else system.add(key);
        }
    }
    return { files: [...found.values()], system: [...system].sort() };
}

async function must(p) {
    if (!(await stat(p).then((s) => s.isFile() || s.isDirectory(), () => false))) throw new Error(`source file missing: ${p}`);
    return p;
}

const summary = {};
const copyTool = async (id, destDir, exeSrc, libDirs, extra = []) => {
    await must(exeSrc);
    await rm(destDir, { recursive: true, force: true });
    await mkdir(join(destDir, 'bin'), { recursive: true });
    await cp(exeSrc, join(destDir, 'bin', exeSrc.split(/[\\/]/).pop()));
    const c = await closure(exeSrc, libDirs);
    for (const f of c.files) await cp(f, join(destDir, 'bin', f.split(/[\\/]/).pop()));
    for (const [from, to] of extra) await cp(await must(from), join(destDir, to), { recursive: true });
    summary[id] = { dlls: c.files.map((f) => f.split(/[\\/]/).pop()).sort(), system: c.system };
};

console.log(`source: ${source}\ndest:   ${dest}`);
// GHDL: the whole shipped tree (bin + the IEEE/std libraries it compiles against).
const ghdlDest = join(dest, 'ghdl-6.0.0');
await rm(ghdlDest, { recursive: true, force: true });
await mkdir(ghdlDest, { recursive: true });
for (const d of ['bin', 'lib', 'include']) await cp(await must(join(source, 'ghdl', d)), join(ghdlDest, d), { recursive: true });
summary.ghdl = { dlls: (await readdir(join(ghdlDest, 'bin'))).filter((n) => n.endsWith('.dll')), system: (await closure(join(ghdlDest, 'bin', 'ghdl.exe'), [join(ghdlDest, 'bin'), join(ghdlDest, 'lib')])).system };

const libs = [join(suite, 'lib'), join(suite, 'bin')];
await copyTool('yosys', join(dest, 'yosys-0.63'), join(suite, 'bin', 'yosys.exe'), libs, [[join(suite, 'share', 'yosys'), join('share', 'yosys')]]);
// No openFPGALoader on Windows: it cannot open the standard Altera USB-Blaster driver, and MIX-FPGA never replaces drivers. Programming is quartus_pgm.

// Licenses that travel with these tools (texts as shipped by their suppliers).
const lic = join(dest, 'licenses');
await rm(lic, { recursive: true, force: true });
await mkdir(lic, { recursive: true });
for (const [from, to] of [
    [join(source, 'licenses', 'GHDL-COPYING.md'), 'GHDL-COPYING.md'],
    [join(source, 'licenses', 'GCC-RUNTIME-EXCEPTION-3.1.txt'), 'GCC-RUNTIME-EXCEPTION-3.1.txt'],
    [join(source, 'licenses', 'GPL-2.0.txt'), 'GPL-2.0.txt'],
    [join(source, 'licenses', 'GPL-3.0.txt'), 'GPL-3.0.txt'],
    [join(source, 'licenses', 'LGPL-2.1.txt'), 'LGPL-2.1.txt'],
    [join(source, 'licenses', 'LGPL-3.0.txt'), 'LGPL-3.0.txt'],
    [join(source, 'licenses', 'zlib-LICENSE.txt'), 'zlib-LICENSE.txt'],
    [join(source, 'licenses', 'yosys-COPYING.txt'), 'yosys-COPYING.txt'],
]) await cp(from, join(lic, to)).catch((e) => console.log(`license not copied: ${to} (${e.code})`));

console.log(JSON.stringify(summary, null, 2));
