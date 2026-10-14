import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { BoardEnvironment } from '../../core/backend';
import { boardRow, summarizeBoardEnvironment, summarizeEnvironment } from '../../extension/services/environment-summary';
import { REPO } from '../helpers';
import { makeHarness } from './harness';

const env = (over: Partial<BoardEnvironment> = {}): BoardEnvironment => ({
    boardId: 'de10-lite',
    displayName: 'DE10-Lite',
    engine: { state: 'running', toolVersion: 'Version 25.1std.0 Build 1129', problems: [] },
    vhdlReady: true,
    programmer: { available: true, detail: 'openFPGALoader v1.1.1' },
    tools: [
        { id: 'ghdl', label: 'GHDL', found: true, version: '6.0.0', ownership: 'owned' },
        { id: 'quartus', label: 'Quartus Prime Lite', found: true, version: 'Version 25.1std.0 Build 1129', ownership: 'external' },
    ],
    ...over,
});
const row = (s: ReturnType<typeof summarizeBoardEnvironment>, label: string) => s.setup.find((r) => r.label === label)!;

describe('DE10-Lite Environment (normal mode)', () => {
    it('shows Board / VHDL Tools / FPGA Engine / Programmer / Hardware, all Ready', () => {
        const s = summarizeBoardEnvironment(env());
        assert.deepEqual(s.setup.map((r) => [r.label, r.status]), [['Board', 'DE10-Lite'], ['VHDL Tools', 'Ready'], ['FPGA Engine', 'Ready'], ['Programmer', 'Ready']]);
        assert.equal(s.level, 'ready');
        assert.equal(s.headline, 'Ready');
        assert.equal(boardRow({ status: 'one', boards: [{ selector: 's', productName: 'DE10-Lite', serialNumber: '91d28408' }], diagnostics: [] }, s.hardwareLabel).status, 'Connected');
        assert.equal(boardRow({ status: 'none', boards: [], diagnostics: [] }, s.hardwareLabel).status, 'Not Connected');
        assert.equal(s.hardwareLabel, 'Hardware');
        const words = s.setup.map((r) => `${r.label} ${r.status} ${r.detail ?? ''}`).join(' ');
        assert.doesNotMatch(words, /lima|linux|rosetta|quartus|vm\b|ubuntu/i, 'no infrastructure words in normal mode');
    });

    it('a stopped engine is normal: it starts when you build', () => {
        const s = summarizeBoardEnvironment(env({ engine: { state: 'stopped', problems: [] } }));
        assert.deepEqual([row(s, 'FPGA Engine').status, row(s, 'FPGA Engine').detail, s.level], ['Ready', 'Starts when you build.', 'ready']);
    });

    it('an engine that is not installed needs setup; Build is said to be unavailable', () => {
        const s = summarizeBoardEnvironment(env({ engine: { state: 'not-installed', problems: [] } }));
        assert.equal(row(s, 'FPGA Engine').state, 'setup-required');
        assert.equal(s.level, 'setup-required');
        assert.ok(s.problems.some((p) => /Build is unavailable/.test(p)));
    });

    it('the Rosetta crash is reported as an engine problem with the real message, level warning', () => {
        const s = summarizeBoardEnvironment(env({ engine: { state: 'unhealthy', problems: [{ severity: 'error', source: 'toolchain', code: 'QUARTUS_SIGBUS', message: 'Quartus died with a bus error' }] } }));
        assert.equal(row(s, 'FPGA Engine').status, 'Problem');
        assert.match(row(s, 'FPGA Engine').detail!, /bus error/);
        assert.equal(s.headline, 'Problem with the FPGA engine');
        assert.equal(s.level, 'warning');
        assert.equal(s.engine?.state, 'unhealthy');
    });

    it('missing VHDL tools or programmer are reported without hiding the rest', () => {
        const noVhdl = summarizeBoardEnvironment(env({ vhdlReady: false }));
        assert.equal(row(noVhdl, 'VHDL Tools').state, 'setup-required');
        assert.equal(noVhdl.level, 'setup-required');
        const noProg = summarizeBoardEnvironment(env({ programmer: { available: false, detail: 'programmer not found' } }));
        assert.equal(noProg.level, 'warning');
        assert.equal(noProg.headline, 'Ready (programming needs setup)');
        assert.equal(row(noProg, 'FPGA Engine').status, 'Ready');
    });

    it('Details list the real tools; an unchecked Quartus is not a failure while the engine is off', () => {
        const s = summarizeBoardEnvironment(env({
            engine: { state: 'stopped', problems: [] },
            tools: [{ id: 'quartus', label: 'Quartus Prime Lite', found: false, detail: 'checked when the FPGA engine starts', ownership: 'external' }, { id: 'ghdl', label: 'GHDL', found: false, detail: 'not installed', ownership: 'owned' }],
        }));
        assert.deepEqual(s.items.map((i) => [i.label, i.ok]), [['Quartus Prime Lite', true], ['GHDL', false]]);
    });

    it('summarizeEnvironment switches to the board summary when the report has one, and has no toolchain install prompt', () => {
        const report = { adapter: { id: 'x', displayName: 'x', status: '' }, toolchain: { overall: 'compatible', tools: [] }, diagnostics: [], providers: {}, board: env() } as unknown as Parameters<typeof summarizeEnvironment>[0];
        const s = summarizeEnvironment(report);
        assert.equal(s.toolchain, undefined, 'the Nexys toolchain-not-installed prompt can never show for a DE10 project');
        assert.equal(s.setup[0]?.label, 'Board');
    });
});

describe('Environment through the backend', () => {
    it('a DE10 project reports the stopped engine WITHOUT starting it, and lists the owned tools', async (t) => {
        const h = await makeHarness(t, { vm: { vm: 'Stopped' } });
        const p = await h.de10Project();
        const report = await h.backend.environment(p);
        assert.equal(report.board?.engine.state, 'stopped');
        assert.ok(!h.vm.limaArgs.some((a) => a[0] === 'start'), 'the engine was not started');
        assert.deepEqual(report.board!.tools.filter((x) => x.ownership === 'owned').map((x) => x.id).sort(), ['ghdl', 'lima', 'openfpgaloader', 'yosys']);
        assert.equal(report.board!.tools.find((x) => x.id === 'ghdl')?.version, '6.0.0');
        assert.equal(report.board!.vhdlReady, true);
    });

    it('a Nexys project keeps the original report (no board section)', async (t) => {
        const h = await makeHarness(t);
        const report = await h.backend.environment(undefined);
        assert.equal(report.board, undefined);
    });
});

describe('product naming', () => {
    it('the extension, its views, commands and console say MIX-FPGA; the old name remains only in the Classroom appearance theme', async () => {
        const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { displayName: string; description: string; contributes: { viewsContainers: { activitybar: { title: string }[] }; commands: { title: string; category?: string }[] } };
        assert.equal(pkg.displayName, 'MIX-FPGA');
        assert.match(pkg.description, /EMXplore/);
        assert.equal(pkg.contributes.viewsContainers.activitybar[0]!.title, 'MIX-FPGA');
        for (const c of pkg.contributes.commands) {
            assert.ok(!/NexysVHDL/.test(`${c.title} ${c.category ?? ''}`) || /Classroom Appearance/.test(c.title), c.title);
            assert.ok(c.category === undefined || c.category === 'MIX-FPGA', `${c.title}: ${c.category}`);
        }
        assert.ok(pkg.contributes.commands.some((c) => c.title === 'Show MIX-FPGA Console'));
        const ext = await readFile(join(REPO, 'extension', 'extension.ts'), 'utf8');
        assert.match(ext, /createOutputChannel\('MIX-FPGA Console'\)/);
        assert.match(ext, /createOutputChannel\('MIX-FPGA Log'/);
        assert.doesNotMatch(ext, /createOutputChannel\('NexysVHDL/);
    });

    it('internal identifiers are deliberately unchanged (command ids, project file, workspace folder)', async () => {
        const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { name: string; contributes: { commands: { command: string }[] } };
        assert.equal(pkg.name, 'nexysvhdl');
        assert.ok(pkg.contributes.commands.every((c) => c.command.startsWith('nexysvhdl.')));
    });
});
