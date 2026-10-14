import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DE10_LITE_PROFILE } from '../../core/backend';
import { REPO, tempDir, writeFiles } from '../helpers';
import { loadManifest, treeSha256, verifyOwnedComponents } from '../../core/toolchain/mixfpga-manifest';
import { harness } from './harness';

describe('DE10-Lite on Windows: composition through the common backend', () => {
    it('a Windows host supports the DE10-Lite and resolves its providers; nothing OS-specific is visible to the router', async (t) => {
        const h = await harness(t);
        assert.equal(h.flows.hostKey, 'windows-x64');
        assert.equal(h.backend.supportsBoard(h.boards.get('de10-lite')!), true);
        assert.equal(h.backend.supportsBoard(h.boards.get('nexys-a7-100t')!), true);
        const impl = h.flows.registry.implementation(DE10_LITE_PROFILE);
        const prog = h.flows.registry.programming(DE10_LITE_PROFILE);
        assert.ok(impl.ok && impl.provider.id === 'quartus');
        assert.ok(prog.ok && prog.provider.id === 'native-jtag');
        assert.equal(h.flows.engineFor(DE10_LITE_PROFILE)?.id, 'native-quartus');
        assert.equal(h.router.calls.length, 0, 'composition starts no process');
    });

    it('Build: Check with MIX-FPGA GHDL, then native Quartus, normalized result in the board\'s words; no VM anywhere', async (t) => {
        const h = await harness(t);
        const p = await h.project();
        const stages: string[] = [];
        const r = await h.backend.build(p, () => undefined, undefined, (m) => stages.push(m));
        assert.equal(r.success, true, JSON.stringify(r.diagnostics));
        assert.equal(r.normalized?.boardId, 'de10-lite');
        assert.equal(r.normalized?.resources.logic?.label, 'Logic Elements');
        assert.deepEqual(h.router.quartus.chain, ['quartus_map', 'quartus_fit', 'quartus_sta', 'quartus_asm', 'quartus_cpf']);
        assert.ok(h.router.calls.some((c) => c.executable === h.env.paths.ghdl), 'Check ran in MIX-FPGA\'s own GHDL');
        assert.ok(h.router.calls.every((c) => !/lima|rosetta/i.test(`${c.executable} ${c.args.join(' ')}`)), 'no Lima or Rosetta on Windows');
        assert.ok(h.router.calls.every((c) => !/NexysVHDL[\/]toolchains/i.test(`${c.executable} ${c.args.join(' ')} ${c.env?.['PATH'] ?? ''}`)), 'nothing runs from the NexysVHDL toolchain');
    });

    it('Detect and Program go through quartus_pgm: the .sof into SRAM over JTAG, nothing else', async (t) => {
        const h = await harness(t);
        const p = await h.project();
        const r = await h.backend.build(p, () => undefined);
        assert.equal(r.success, true);
        const det = await h.backend.detectBoards(p);
        assert.equal(det.configured, true);
        const prog = await h.backend.program(p, undefined);
        assert.equal(prog.status, 'succeeded', JSON.stringify(prog.diagnostics));
        assert.equal(prog.destination, 'volatile');
        const runs = h.router.quartus.programRuns;
        assert.equal(runs.length, 1);
        assert.deepEqual(runs[0]!.slice(0, 5), ['-c', 'USB-Blaster [USB-0]', '-m', 'jtag', '-o']);
        assert.match(runs[0]![5]!, /^p;[^;]+\.sof@1$/, 'program (p) operation on a .sof only');
        assert.ok(h.router.calls.every((c) => !/openFPGALoader/i.test(c.executable)), 'openFPGALoader is never started on Windows');
    });

    it('Environment: owned tools, Quartus and MAX 10 are listed; Quartus answers; nothing is built', async (t) => {
        const h = await harness(t);
        const board = await h.flows.environmentFor!(DE10_LITE_PROFILE);
        assert.ok(board);
        assert.equal(board.engine.state, 'running');
        assert.equal(board.vhdlReady, true);
        assert.deepEqual(board.tools.map((x) => [x.id, x.found, x.ownership]), [['ghdl', true, 'owned'], ['yosys', true, 'owned'], ['quartus', true, 'external'], ['max10', true, 'external'], ['quartus_pgm', true, 'external']]);
        assert.equal(board.tools.find((x) => x.id === 'quartus')?.version, 'Version 25.1std.0 Build 1129');
        assert.equal(h.router.quartus.chain.length, 0);
    });

    it('Environment without Quartus: not installed, VHDL tools still ready (Check and Simulate stay usable)', async (t) => {
        const h = await harness(t, { install: 'none' });
        const board = await h.flows.environmentFor!(DE10_LITE_PROFILE);
        assert.equal(board?.engine.state, 'not-installed');
        assert.equal(board?.vhdlReady, true);
        assert.equal(board?.tools.find((x) => x.id === 'quartus')?.found, false);
    });

    it('Verify Environment checks the owned tools against the Windows manifest and then proves Quartus', async (t) => {
        const h = await harness(t);
        const v = await h.flows.verifyEnvironment!(DE10_LITE_PROFILE);
        assert.ok(v);
        // The fake tool files are not the real ones, so the integrity steps fail here; the Quartus step is real.
        assert.ok(v.steps.some((s) => /^GHDL 6\.0\.0/.test(s.label)));
        assert.ok(v.steps.some((s) => /^Yosys/.test(s.label)));
        assert.ok(!v.steps.some((s) => /openFPGALoader/i.test(s.label)), 'no openFPGALoader on Windows');
        assert.equal(v.steps.at(-1)?.label, 'Quartus and MAX 10 support');
        assert.equal(v.steps.at(-1)?.ok, true);
        assert.equal(v.ok, false);
    });

    it('Restart FPGA Engine is a harmless re-check on Windows', async (t) => {
        const h = await harness(t);
        const s = await h.backend.restartEngine(await h.project());
        assert.equal(s?.state, 'running');
    });
});

describe('MIX-FPGA Windows toolchain ownership', () => {
    it('the committed Windows manifest owns GHDL, Yosys and openFPGALoader with hashes, folder hashes, versions and licenses', async () => {
        const m = await loadManifest(REPO, 'windows-x64');
        assert.ok(m);
        assert.equal(m.target, 'windows-x64');
        const owned = m.components.filter((c) => c.ownership === 'owned' && c.executable);
        assert.deepEqual(owned.map((c) => c.id), ['ghdl', 'yosys']);
        for (const c of owned) {
            assert.match(c.sha256 ?? '', /^[0-9a-f]{64}$/, c.id);
            assert.match(c.treeSha256 ?? '', /^[0-9a-f]{64}$/, c.id);
            assert.ok(c.version && c.license && c.source, c.id);
            assert.doesNotMatch(c.executable!, /nexys/i, 'the runtime location is MIX-FPGA\'s own');
            assert.match(c.executable!, /\.exe$/);
        }
        assert.ok(m.components.some((c) => c.id === 'quartus' && c.ownership === 'external'), 'Quartus is never ours');
    });

    it('verifyOwnedComponents checks a whole component folder, so a changed DLL is caught', async (t) => {
        const root = await tempDir(t);
        await writeFiles(root, { 'tool-1/bin/tool.exe': 'EXE', 'tool-1/bin/dep.dll': 'DLL', 'tool-1/share/data.txt': 'DATA' });
        const sha = (s: string) => createHash('sha256').update(s).digest('hex');
        const tree = await treeSha256(join(root, 'tool-1'));
        const manifest = { schemaVersion: 1, product: 'MIX-FPGA', target: 'windows-x64', components: [{ id: 'tool', name: 'Tool', version: '1', ownership: 'owned' as const, dir: 'tool-1', executable: 'tool-1/bin/tool.exe', sha256: sha('EXE'), treeSha256: tree }] };
        assert.equal((await verifyOwnedComponents(manifest, root))[0]!.state, 'ok');
        await writeFile(join(root, 'tool-1', 'bin', 'dep.dll'), 'TAMPERED');
        assert.equal((await verifyOwnedComponents(manifest, root))[0]!.state, 'modified');
        await writeFile(join(root, 'tool-1', 'bin', 'dep.dll'), 'DLL');
        await mkdir(join(root, 'tool-1', 'extra'));
        await writeFile(join(root, 'tool-1', 'extra', 'new.bin'), 'x');
        assert.equal((await verifyOwnedComponents(manifest, root))[0]!.state, 'modified', 'an added file also changes the folder');
    });

    it('the Windows backend sources never reference the macOS engine, Lima, Rosetta or the NexysVHDL toolchain', async () => {
        const files = (await readdir(join(REPO, 'platform', 'windows', 'de10'))).filter((f) => f.endsWith('.ts'));
        assert.ok(files.length >= 5);
        for (const f of files) {
            const text = (await readFile(join(REPO, 'platform', 'windows', 'de10', f), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            assert.doesNotMatch(text, /lima|rosetta|platform\/macos|NexysVHDL|nexys-?toolchain|\.apio|djtgcfg|digilent/i, f);
        }
    });
});
