import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { inventoryTree, makeWritable, treeBytes, treeDigest } from '../../core/install/tree';
import { type ExpectedToolchain, type LoadedExpected, type ToolchainUnit } from '../../platform/macos/install/expected';
import { resolveRuntimeLayout } from '../../platform/macos/install/layout';
import { DirectoryPayload } from '../../platform/macos/install/payload';
import { REPO } from '../helpers';
import { type ToolchainContext } from '../../platform/macos/install/toolchain-installer';

const TOOLS = ['ghdl', 'yosys', 'openfpgaloader', 'lima'] as const;

/** A small stand-in for the validated tools: real files, an executable, a symlink, nested folders. */
export async function makeSourceTools(root: string, realEngine = false): Promise<Record<string, string>> {
    const sources: Record<string, string> = {};
    for (const id of TOOLS) {
        const dir = join(root, `${id}-src`);
        await mkdir(join(dir, 'bin'), { recursive: true });
        await mkdir(join(dir, 'lib', 'deep'), { recursive: true });
        await writeFile(join(dir, 'bin', id), `#!/bin/sh\necho ${id} 1.0\n`);
        await chmod(join(dir, 'bin', id), 0o755);
        await writeFile(join(dir, 'lib', `lib${id}.dylib`), `${id}-library-${'x'.repeat(4096)}`);
        await writeFile(join(dir, 'lib', 'deep', 'data.txt'), `data for ${id}`);
        if (id === 'lima') {
            await symlink('../../lima/templates', join(dir, 'lib', 'templates'));
            await writeFile(join(dir, 'bin', 'limactl'), '#!/bin/sh\n');
            await chmod(join(dir, 'bin', 'limactl'), 0o755);
        }
        sources[id] = dir;
    }
    const engine = join(root, 'engine-src');
    if (realEngine) await cp(join(REPO, 'platform', 'macos', 'lima'), engine, { recursive: true });
    else {
        await mkdir(engine, { recursive: true });
        await writeFile(join(engine, 'provision.sh'), '#!/bin/bash\ntrue\n');
        await chmod(join(engine, 'provision.sh'), 0o755);
    }
    const lic = join(root, 'licenses-src');
    await mkdir(join(lic, 'ghdl'), { recursive: true });
    await writeFile(join(lic, 'ghdl', 'COPYING'), 'GPL text');
    await writeFile(join(root, 'notices-src.txt'), 'notices');
    Object.assign(sources, { engine, licenses: lic, notices: join(root, 'notices-src.txt') });
    return sources;
}

export async function expectedFor(sources: Record<string, string>): Promise<LoadedExpected> {
    const units: ToolchainUnit[] = [];
    const add = async (u: Omit<ToolchainUnit, 'files' | 'links' | 'treeSha256' | 'bytes'>, src: string) => {
        const inv = await inventoryTree(src);
        units.push({ ...u, files: inv.files, links: inv.links, treeSha256: treeDigest(inv), bytes: treeBytes(inv) });
    };
    for (const id of TOOLS) await add({ id, kind: 'tool', name: id.toUpperCase(), version: '1.0.0', path: id, executable: `bin/${id}` }, sources[id]!);
    await add({ id: 'engine', kind: 'support', name: 'Engine scripts', path: 'engine' }, sources['engine']!);
    await add({ id: 'licenses', kind: 'support', name: 'Licences', path: 'LICENSES' }, sources['licenses']!);
    await add({ id: 'notices', kind: 'support', name: 'Notices', path: 'THIRD_PARTY_NOTICES.txt' }, sources['notices']!);
    const toolchain: ExpectedToolchain = { schemaVersion: 1, product: 'MIX-FPGA', toolchainVersion: '1.0', target: 'macos-arm64', units };
    const text = `${JSON.stringify(toolchain, null, 1)}\n`;
    return { toolchain, text, sha256: createHash('sha256').update(text).digest('hex') };
}

export interface Fixture {
    readonly dir: string;
    readonly sources: Record<string, string>;
    readonly ctx: ToolchainContext;
    /** Units whose bytes the payload was asked for. */
    readonly copied: string[];
}

export async function fixture(t: TestContext, over: Partial<ToolchainContext> = {}, opts: { realEngine?: boolean; shortRoot?: boolean } = {}): Promise<Fixture> {
    const dir = await mkdtemp(join(opts.shortRoot ? '/tmp' : tmpdir(), opts.shortRoot ? 'mfs ' : 'mixfpga install '));
    const sources = await makeSourceTools(dir, opts.realEngine ?? false);
    const expected = await expectedFor(sources);
    const layout = resolveRuntimeLayout({ env: { MIXFPGA_HOME: join(dir, 'home', 'MIX-FPGA') } });
    const copied: string[] = [];
    const inner = new DirectoryPayload(sources, 'test payload');
    const payload = {
        kind: 'directory' as const,
        describe: () => inner.describe(),
        has: (u: ToolchainUnit) => inner.has(u),
        materialize: async (u: ToolchainUnit, dest: string, signal?: AbortSignal) => {
            copied.push(u.id);
            await inner.materialize(u, dest, signal);
        },
    };
    // Installed trees are read-only on purpose; open them up before the folder is removed.
    t.after(async () => {
        await makeWritable(dir).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
    });
    return { dir, sources, copied, ctx: { layout, expected, payload, host: { platform: 'darwin', arch: 'arm64' }, freeBytes: async () => 1e12, ...over } };
}

export const noProgress = { progress: () => undefined };
