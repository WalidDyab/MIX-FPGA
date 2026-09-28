import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import {
    BoardRegistry,
    type BuildArtifact,
    dataPaths,
    packageRoot,
    type Project,
    type ProjectFile,
    type ToolInvocation,
    type ToolRunResult,
    type ToolRunner,
} from '../core';

export const REPO = packageRoot(__dirname);
export const FIXTURES = join(REPO, 'tests', 'fixtures');

/** Fresh temp directory (name contains a space on purpose), removed after the test. */
export async function tempDir(t: TestContext, prefix = 'nexys test '): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
        const abs = join(root, ...rel.split('/'));
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf8');
    }
}

export const VALID_CONFIG: ProjectFile = {
    name: 'demo',
    board: 'nexys-a7-100t',
    language: 'vhdl',
    standard: '2008',
    top: 'top',
    sources: ['src/top.vhd'],
    simulation: { sources: ['sim/top_tb.vhd'], testbench: 'top_tb' },
    pins: { sw: 'SW0', led: 'LED0' },
};

/** Writes a project with placeholder VHDL files and returns it (not loaded from disk). */
export async function makeProject(t: TestContext, overrides: Partial<ProjectFile> = {}, createFiles = true): Promise<Project> {
    const root = await tempDir(t);
    const config = { ...VALID_CONFIG, ...overrides } as ProjectFile;
    if (createFiles) {
        const files: Record<string, string> = {};
        for (const s of [...(config.sources ?? []), ...(config.simulation?.sources ?? [])]) files[s] = '-- placeholder\n';
        await writeFiles(root, files);
    }
    const file = join(root, 'nexysvhdl.json');
    await writeFile(file, JSON.stringify(config, null, 2), 'utf8');
    return { root, file, config };
}

let cachedBoards: BoardRegistry | undefined;
export async function repoBoards(): Promise<BoardRegistry> {
    cachedBoards ??= (await BoardRegistry.loadDirectory(dataPaths(REPO).boards)).registry;
    return cachedBoards;
}

/** ToolRunner fake: records invocations and answers from a handler. */
export class FakeRunner implements ToolRunner {
    readonly calls: ToolInvocation[] = [];
    constructor(private readonly handler: (inv: ToolInvocation) => Partial<ToolRunResult> = () => ({})) {}
    async run(invocation: ToolInvocation): Promise<ToolRunResult> {
        this.calls.push(invocation);
        return { invocation, outcome: 'exited', exitCode: 0, stdout: '', stderr: '', durationMs: 1, ...this.handler(invocation) };
    }
}

export async function writeBitstream(dir: string, name = 'hardware.bit', content = 'canonical-bitstream-bytes'): Promise<BuildArtifact> {
    const path = join(dir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path, content);
    return { kind: 'bitstream', path, canonical: true, sizeBytes: content.length };
}
