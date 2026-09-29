import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import {
    BoardRegistry,
    type BuildArtifact,
    dataPaths,
    type HostInfo,
    packageRoot,
    type Project,
    type ProjectFile,
    type ToolInvocation,
    type ToolRunResult,
    type ToolRunner,
} from '../core';
import type { ContextOverrides } from '../cli/context';
import type { PlatformServices } from '../platform';

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

// ---------------------------------------------------------------------------
// Host isolation for tests (Phase 3C). Unit tests must never find or run the
// developer's real FPGA tools (GHDL, Apio, djtgcfg, openFPGALoader, Vivado):
// on macOS an unpinned `apio raw` once replaced an installed package.
// ---------------------------------------------------------------------------

/** A fixed host, so CLI output is identical on Windows, macOS and CI. */
export const TEST_HOST: HostInfo = { platform: 'win32', arch: 'x64', nodeVersion: 'v24.0.0-test' };

/** A runner that refuses everything and records what was attempted. */
export class ForbiddenRunner implements ToolRunner {
    readonly calls: ToolInvocation[] = [];
    async run(invocation: ToolInvocation): Promise<ToolRunResult> {
        this.calls.push(invocation);
        return {
            invocation, outcome: 'spawn-failed', exitCode: null, stdout: '', stderr: '', durationMs: 0,
            errorMessage: 'external tools are forbidden in unit tests',
        };
    }
}

/** A platform with no tools at all (unless given): nothing on the host can be reached through it. */
export function fakePlatform(extra: Partial<PlatformServices> = {}): PlatformServices {
    return { id: 'fake', displayName: 'Test platform', status: 'fake platform (no tools)', ...extra };
}

/** Context overrides for CLI tests: fake host, fake platform, forbidden runner, empty environment. */
export function isolatedCli(extra: ContextOverrides = {}): ContextOverrides & { runner: ToolRunner } {
    return { host: TEST_HOST, platform: fakePlatform(), runner: new ForbiddenRunner(), env: {}, ...extra };
}

/**
 * Makes every child_process entry point fail the test, except starting this
 * Node executable itself when `allowNode` is set. Restored after the test.
 */
const traps = new WeakMap<TestContext, { attempts: string[] }>();

export function trapProcesses(t: TestContext, options: { allowNode?: boolean } = {}): { attempts: string[] } {
    // One trap per test: stacked mocks of the same method would not restore cleanly.
    const existing = traps.get(t);
    if (existing) return existing;
    const attempts: string[] = [];
    traps.set(t, { attempts });
    type Fn = (...args: unknown[]) => unknown;
    const cp = require('node:child_process') as Record<string, Fn>;
    const mockMethod = t.mock.method.bind(t.mock) as unknown as (object: Record<string, Fn>, method: string, implementation: Fn) => unknown;
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        const original = cp[name]!;
        mockMethod(cp, name, (...args: unknown[]) => {
            const file = String(args[0]);
            if (options.allowNode && name === 'spawn' && file === process.execPath) return original(...args);
            attempts.push(`${name} ${file}`);
            throw new Error(`unit test tried to start an external process: ${name} ${file}`);
        });
    }
    return { attempts };
}
