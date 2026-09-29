/**
 * MANUAL macOS engineering validation (not part of `npm test`; needs the real
 * tools and, for `detect`/`program`, a connected Nexys A7).
 *
 *   npm run build
 *   node dist/tests/platform/macos/real-validation.js toolchain|build|detect|program
 *
 * Uses only createMacosAdapter(): every Apio call goes through its pinned runner.
 * Never goes through the CLI composition root (see docs/phase3b-macos.md).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    ALL_TOOL_IDS,
    BoardRegistry,
    currentHost,
    dataPaths,
    evaluateToolchain,
    loadManifests,
    loadProject,
    ProgrammingService,
    selectManifest,
    sha256File,
    WorkflowController,
    WorkspaceManager,
} from '../../../core';
import { createMacosAdapter, readBitstreamPart } from '../../../platform/macos';

const REPO = join(__dirname, '..', '..', '..', '..');
const EXAMPLE = join(REPO, 'examples', 'nexys-a7-counter');
const print = (label: string, value: unknown) => console.log(`${label}:`, typeof value === 'string' ? value : JSON.stringify(value, null, 2));

async function main(mode: string): Promise<number> {
    const host = currentHost();
    const adapter = createMacosAdapter(host);
    const { registry: boards } = await BoardRegistry.loadDirectory(dataPaths(REPO).boards);
    const board = boards.get('nexys-a7-100t')!;
    print('host', host);
    print('adapter', adapter.status);
    print('APIO_REMOTE_CONFIG_URL', adapter.apioEnvironment['APIO_REMOTE_CONFIG_URL']);

    if (mode === 'toolchain') {
        const { manifests } = await loadManifests(dataPaths(REPO).toolchains);
        const manifest = selectManifest(manifests, host);
        const report = await adapter.toolchainDetector().detect(manifest);
        for (const [tool, d] of report.tools) console.log(`  ${tool.padEnd(15)} ${String(d.version ?? '-').padEnd(12)} raw=${JSON.stringify((d.rawVersion ?? '').split('\n').at(-1))}  [${d.method}] ${d.path ?? ''}`);
        for (const [tool, a] of report.architectures) console.log(`  arch ${tool.padEnd(10)} ${a.status} ${a.architectures.join(',')} ${a.binary ?? ''}`);
        print('pin file', report.pin.file);
        print('pinned openxc7 tag', report.pin.tags['openxc7']);
        print('diagnostics', report.diagnostics);
        const ev = evaluateToolchain(manifest, report.tools, ALL_TOOL_IDS);
        for (const t of ev.tools) console.log(`  ${t.tool.padEnd(15)} ${t.status.padEnd(12)} ${t.reason}`);
        print('overall', ev.overall);
        return ev.overall === 'compatible' ? 0 : 1;
    }

    const loaded = await loadProject(EXAMPLE);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
    const project = loaded.project;
    if (mode === 'build') {
        const providers = await adapter.providers();
        print('located', providers.located);
        const controller = new WorkflowController({ boards, workspaces: new WorkspaceManager(), ...providers });
        const check = await controller.check(project);
        print('check', { status: check.status, elaborated: check.elaborated, diagnostics: check.diagnostics });
        const sim = await controller.simulate(project);
        print('simulate', { status: sim.status, passed: sim.passed, stoppedAt: sim.stoppedAt, messages: sim.messages, waveform: sim.waveform?.path });
        const build = await controller.build(project, { simulate: true });
        print('build.steps', build.steps.map((s) => `${s.step}: ${s.status} (${s.durationMs} ms)`));
        print('build.success', build.success);
        print('diagnostics', build.diagnostics);
        print('utilization', build.utilization);
        print('timing', build.timing);
        if (build.bitstream) {
            print('bitstream', { ...build.bitstream, part: await readBitstreamPart(build.bitstream.path) });
            const impl = join(project.root, '.nexysvhdl', 'impl');
            print('generated.xdc', await readFile(join(impl, 'generated.xdc'), 'utf8'));
            print('apio.ini', await readFile(join(impl, 'apio.ini'), 'utf8'));
        }
        print('logs', build.logs);
        return build.success ? 0 : 1;
    }

    const programmer = adapter.programmer!;
    print('availability', await programmer.availability());
    const detected = await programmer.detectBoards(board);
    print('detectBoards', detected);
    if (mode === 'detect') return detected.boards.length === 1 ? 0 : 1;

    if (mode === 'program') {
        const bit = join(project.root, '.nexysvhdl', 'impl', '_build', 'default', 'hardware.bit');
        const canonical = { kind: 'bitstream' as const, path: bit, canonical: true, sha256: await sha256File(bit) };
        const outputDir = join(project.root, '.nexysvhdl', 'program');
        const result = await new ProgrammingService(programmer).program(canonical, board, outputDir);
        print('program', result);
        print('canonical sha256 before/after', [canonical.sha256, await sha256File(bit)]);
        return result.status === 'succeeded' ? 0 : 1;
    }
    throw new Error(`unknown mode ${mode}`);
}

main(process.argv[2] ?? 'toolchain').then(
    (code) => process.exit(code),
    (err: unknown) => {
        console.error(err);
        process.exit(2);
    },
);
