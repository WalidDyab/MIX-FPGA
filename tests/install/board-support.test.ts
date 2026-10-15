import assert from 'node:assert/strict';
import { chmod, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createContext } from '../../runtime/context';
import { inventoryDirectory } from '../../core/toolchain/tar';
import { BOARD_SUPPORT, BoardSelectionStore, boardState } from '../../platform/macos/install/boards';
import { buildSetupView, TECHNICAL_TERMS } from '../../platform/macos/install/setup-view';
import { makeWritable } from '../../core/install/tree';
import { FakeRunner, trapProcesses } from '../helpers';
import { boardWord, DE10, rig, type Rig, word } from './setup-rig';

const MAC = { platform: 'darwin', arch: 'arm64', nodeVersion: 'v24.0.0-test' } as const;
const exists = (p: string) => stat(p).then(() => true, () => false);
const nexysDir = (r: Rig) => join(r.nexysRoot, 'toolchains', 'darwin-arm64', '1.0');
const tree = async (dir: string) => (await inventoryDirectory(dir)).treeSha256;

/** The Nexys flow's own resolution (runtime/context) against the isolated MIX-FPGA root, as the extension would do it. */
async function nexysFlowRoot(r: Rig): Promise<string | undefined> {
    const ctx = await createContext({ host: MAC, env: { HOME: join(r.f.dir, 'old-home'), MIXFPGA_HOME: r.layout.root }, runner: new FakeRunner(), classroom: { requirement: r.nexysRequirement } });
    return ctx.classroom?.toolchain?.root;
}

describe('board support: exactly two boards, each a set of Setup components', () => {
    it('knows only the Nexys A7-100T and the DE10-Lite', () => {
        assert.deepEqual(BOARD_SUPPORT.map((b) => b.id), ['nexys-a7-100t', 'de10-lite']);
        const de10 = BOARD_SUPPORT[1]!;
        assert.ok(de10.engine.includes('linux-vm') && BOARD_SUPPORT[0]!.engine.length === 0, 'only the DE10-Lite has an FPGA engine');
    });

    it('remembers the chosen boards, in board order, without duplicates', async (t) => {
        const r = await rig(t);
        const s = new BoardSelectionStore(join(r.layout.stateDir, 'board-support.json'));
        assert.deepEqual(await s.read(), []);
        await s.add(['de10-lite']);
        assert.deepEqual(await s.add(['nexys-a7-100t', 'de10-lite']), ['nexys-a7-100t', 'de10-lite']);
    });

    it('the student view never names internal packages', () => {
        for (const v of [buildSetupView([], DE10), buildSetupView([], DE10, ['nexys-a7-100t']), buildSetupView([], DE10, ['de10-lite', 'nexys-a7-100t'])]) {
            for (const x of [v.headline, ...v.boards.flatMap((b) => [b.name, b.word]), ...v.rows.flatMap((x) => [x.label, x.word, x.hint ?? '']), ...v.actions.flatMap((a) => [a.label, a.detail])]) assert.doesNotMatch(x, TECHNICAL_TERMS, x);
        }
    });
});

describe('fresh installation: choose Nexys, DE10 or both', () => {
    it('Case 1, Nexys only: installs the Nexys tools and nothing of the DE10-Lite (no engine, no Quartus, no Rosetta)', async (t) => {
        const r = await rig(t);
        r.ui.boards = ['nexys-a7-100t'];
        const out = await r.ctl.install(r.ui);
        assert.equal(out.outcome, 'complete', `${out.message} ${r.ui.logs.join(' | ')}`);
        assert.deepEqual(r.ui.questions, ['boards', 'confirm']);
        assert.deepEqual(r.ui.offeredBoards[0]!.map((b) => b.name), ['Nexys A7-100T', 'DE10-Lite']);
        assert.deepEqual(out.view.boards.map((b) => b.word), ['Installed', 'Not installed']);
        assert.deepEqual(out.view.rows.map((x) => x.label), ['VHDL Tools', 'Programmer', 'Hardware'], 'a Nexys-only computer has no FPGA Engine row');
        assert.equal(out.view.allReady, true);
        // Nothing of the DE10-Lite: no engine, no Rosetta install, no Quartus question, no DE10 toolchain.
        assert.deepEqual(r.m.calls.filter((c) => c[0] !== 'list'), []);
        assert.equal(r.m.rosettaCommands.length, 0);
        assert.equal(await exists(r.layout.toolchainDir), false);
        assert.equal(await exists(r.layout.instanceDir), false);
        // The Nexys flow itself now finds its tools in the MIX-FPGA store (no NexysVHDL needed).
        assert.equal(await nexysFlowRoot(r), nexysDir(r));
        assert.equal((await inventoryDirectory(nexysDir(r), { exclude: ['.nexysvhdl-installed.json'] })).treeSha256, r.nexysRequirement.targets['darwin-arm64']!.treeSha256);
    });

    it('Case 2, DE10 only: installs the DE10-Lite support from its archive and none of the Nexys tools', async (t) => {
        const r = await rig(t, { de10Archive: true });
        r.ui.boards = ['de10-lite'];
        const out = await r.ctl.install(r.ui);
        assert.equal(out.outcome, 'complete', `${out.message} ${r.ui.logs.join(' | ')}`);
        assert.deepEqual(r.ui.questions, ['boards', 'confirm', 'rosetta', 'files', 'license']);
        assert.deepEqual(out.view.boards.map((b) => b.word), ['Not installed', 'Installed']);
        assert.deepEqual(out.view.rows.map((x) => x.label), ['VHDL Tools', 'FPGA Engine', 'Programmer', 'Hardware']);
        assert.equal(await exists(r.nexysRoot), false, 'no Nexys tools');
        assert.equal(r.m.count('create'), 1, 'the managed engine was created');
        assert.equal(r.m.quartusInstalls, 1, 'the guided Quartus install ran');
        assert.equal(await exists(join(r.layout.root, '.payload')) && (await readdir(join(r.layout.root, '.payload'))).length > 0, false, 'the extracted payload is removed');
        assert.equal(await nexysFlowRoot(r), undefined, 'the Nexys flow has nothing to run');
    });

    it('Case 3, both: each board\'s support once, both installed', async (t) => {
        const r = await rig(t, { de10Archive: true });
        r.ui.boards = ['nexys-a7-100t', 'de10-lite'];
        const out = await r.ctl.install(r.ui);
        assert.equal(out.outcome, 'complete', `${out.message} ${r.ui.logs.join(' | ')}`);
        assert.deepEqual(out.view.boards.map((b) => b.word), ['Installed', 'Installed']);
        assert.deepEqual(r.ui.summaries.length, 1, 'one plan, one confirmation for both boards');
        assert.deepEqual(r.ui.summaries[0]!.items, ['the Nexys A7 tools', 'VHDL tools and the programmer', 'Rosetta (from Apple)', 'the FPGA engine', 'Quartus Prime Lite and MAX 10 support (from Altera)']);
        // One copy of each support: the Nexys bundle once, the DE10 toolchain once.
        assert.deepEqual(await readdir(join(r.nexysRoot, 'toolchains', 'darwin-arm64')), ['1.0']);
        assert.deepEqual((await readdir(join(r.layout.toolchainsDir, '1.0'))).filter((n) => !n.startsWith('.')), ['macos-arm64']);
        assert.equal(r.m.count('create'), 1);
        assert.equal(await nexysFlowRoot(r), nexysDir(r));
    });

    it('a board can be added later: Nexys first, then DE10 installs only the DE10 parts', async (t) => {
        const r = await rig(t);
        r.ui.boards = ['nexys-a7-100t'];
        await r.ctl.install(r.ui);
        const nexysBefore = await tree(nexysDir(r));
        r.ui.questions.length = 0;
        const out = await r.ctl.install(r.ui, undefined, ['de10-lite']);
        assert.equal(out.outcome, 'complete', out.message);
        assert.deepEqual(r.ui.questions, ['confirm', 'rosetta', 'files', 'license'], 'not asked to choose again');
        assert.ok(!r.ui.summaries[1]!.items.includes('the Nexys A7 tools'), 'the Nexys tools are not reinstalled');
        assert.deepEqual(out.view.boards.map((b) => b.word), ['Installed', 'Installed']);
        assert.equal(await tree(nexysDir(r)), nexysBefore);
    });

    it('…and DE10 first, then Nexys installs only the Nexys tools', async (t) => {
        const r = await rig(t);
        await r.ctl.install(r.ui);
        const creates = r.m.count('create');
        r.ui.questions.length = 0;
        const out = await r.ctl.install(r.ui, undefined, ['nexys-a7-100t']);
        assert.equal(out.outcome, 'complete', out.message);
        assert.deepEqual(r.ui.questions, ['confirm']);
        assert.equal(r.m.count('create'), creates, 'the engine is not touched');
        assert.equal(r.m.quartusInstalls, 1);
        assert.deepEqual(out.view.boards.map((b) => b.word), ['Installed', 'Installed']);
    });

    it('Install with no choice made asks once and remembers the answer; declining changes nothing', async (t) => {
        const r = await rig(t);
        r.ui.boards = undefined;
        const out = await r.ctl.install(r.ui);
        assert.equal(out.outcome, 'stopped');
        assert.equal(await exists(r.nexysRoot), false);
        r.ui.boards = ['nexys-a7-100t'];
        await r.ctl.install(r.ui);
        r.ui.questions.length = 0;
        const again = await r.ctl.install(r.ui);
        assert.deepEqual([again.outcome, r.ui.questions], ['complete', []], 'Setup opened again: nothing to ask, nothing to do');
    });

    it('an interrupted addition leaves the first board working and resumes', async (t) => {
        const r = await rig(t);
        r.ui.boards = ['nexys-a7-100t'];
        await r.ctl.install(r.ui);
        r.crashToolchainOnce = true;
        const failed = await r.ctl.install(r.ui, undefined, ['de10-lite']);
        assert.equal(failed.outcome, 'failed');
        assert.equal(boardWord(failed.view, 'nexys-a7-100t'), 'Installed');
        assert.notEqual(boardWord(failed.view, 'de10-lite'), 'Installed');
        assert.ok(failed.view.actions.some((a) => a.board === 'de10-lite'));
        const resumed = await r.ctl.install(r.ui, undefined, ['de10-lite']);
        assert.equal(resumed.outcome, 'complete', resumed.message);
        assert.deepEqual(resumed.view.boards.map((b) => b.word), ['Installed', 'Installed']);
    });

    it('repairs one board without touching the other', async (t) => {
        const r = await rig(t);
        r.ui.boards = ['nexys-a7-100t', 'de10-lite'];
        await r.ctl.install(r.ui);
        const de10Before = await tree(r.layout.toolchainDir);
        // Damage one file of the Nexys tools (same size): only a full check sees it.
        const victim = join(nexysDir(r), 'ghdl', 'bin', 'ghdl');
        await chmod(victim, 0o755);
        await writeFile(victim, '#!/bin/sh\necho damaged\n');
        r.ui.questions.length = 0;
        const out = await r.ctl.repair(r.ui, undefined, ['nexys-a7-100t']);
        assert.equal(out.outcome, 'complete', `${out.message} ${r.ui.logs.join(' | ')}`);
        assert.deepEqual(r.ui.questions, ['confirm']);
        assert.equal((await inventoryDirectory(nexysDir(r), { exclude: ['.nexysvhdl-installed.json'] })).treeSha256, r.nexysRequirement.targets['darwin-arm64']!.treeSha256);
        await makeWritable(r.layout.toolchainDir).catch(() => undefined);
        assert.equal(await tree(r.layout.toolchainDir), de10Before, 'the DE10-Lite tools are untouched');
    });

    it('New Project can ask before creating a project for a board without support', async (t) => {
        const r = await rig(t);
        assert.equal(await r.ctl.isBoardReady('nexys-a7-100t'), false);
        assert.equal(await r.ctl.isBoardReady('de10-lite'), false);
        r.ui.boards = ['nexys-a7-100t'];
        await r.ctl.install(r.ui);
        assert.equal(await r.ctl.isBoardReady('nexys-a7-100t'), true);
        assert.equal(await r.ctl.isBoardReady('de10-lite'), false);
    });

    it('the board states follow the components', () => {
        const nexys = BOARD_SUPPORT[0]!;
        const de10 = BOARD_SUPPORT[1]!;
        assert.equal(boardState([{ id: 'nexys-toolchain', state: 'ready', ownership: 'managed' }], nexys), 'installed');
        assert.equal(boardState([{ id: 'rosetta', state: 'ready', ownership: 'system' }], de10), 'not-installed', 'Rosetta alone is not DE10 support');
        assert.equal(boardState([{ id: 'toolchain', state: 'ready', ownership: 'managed' }, { id: 'ghdl', state: 'ready', ownership: 'managed' }], de10), 'incomplete');
        assert.equal(boardState([{ id: 'nexys-toolchain', state: 'repairable', ownership: 'managed' }], nexys), 'needs-repair');
    });
});

describe('update from NexysVHDL 0.6.0', () => {
    it('Nexys A7 is ready straight away by reusing the existing NexysVHDL tools; DE10-Lite is offered', async (t) => {
        const r = await rig(t, { legacyNexys: true, pinnedNexys: false });
        const { view } = await r.ctl.status();
        assert.deepEqual(view.boards.map((b) => [b.name, b.word, b.action ?? '']), [['Nexys A7-100T', 'Installed', ''], ['DE10-Lite', 'Not installed', 'install']]);
        assert.equal(view.fresh, false);
        assert.equal(await r.ctl.isBoardReady('nexys-a7-100t'), true);
        assert.equal(await exists(r.nexysRoot), false, 'nothing was copied just by looking');
    });

    it('taking over the NexysVHDL tools: dry run first, then a verified APFS clone; NexysVHDL is never modified', async (t) => {
        const r = await rig(t, { legacyNexys: true, pinnedNexys: false });
        const legacyDir = join(r.legacyRoot, 'toolchains', 'darwin-arm64', '1.0');
        const before = await tree(legacyDir);
        const dry = await r.ctl.adoptNexysVhdl({ dryRun: true });
        assert.equal(dry.plan.status, 'adoptable');
        assert.equal(dry.plan.treeSha256, r.nexysRequirement.targets['darwin-arm64']!.treeSha256);
        assert.equal(dry.result, undefined);
        assert.equal(await exists(r.nexysRoot), false, 'the dry run changes nothing');
        const done = await r.ctl.adoptNexysVhdl({ dryRun: false });
        assert.equal(done.result?.ok, true, done.result?.message);
        assert.deepEqual(r.runner.copies.map((c) => c.args.slice(0, 3)), [['-c', '-R', '-p']], 'an APFS clone');
        assert.equal(await tree(legacyDir), before, 'the NexysVHDL folder is byte-for-byte unchanged');
        assert.equal((await inventoryDirectory(nexysDir(r), { exclude: ['.nexysvhdl-installed.json'] })).treeSha256, r.nexysRequirement.targets['darwin-arm64']!.treeSha256);
        const marker = JSON.parse(await (await import('node:fs/promises')).readFile(join(nexysDir(r), '.nexysvhdl-installed.json'), 'utf8')) as { source: string };
        assert.match(marker.source, /adopted from NexysVHDL/);
        // The Nexys flow now runs from MIX-FPGA's own store.
        trapProcesses(t);
        const ctx = await createContext({ host: MAC, env: { HOME: join(r.f.dir, 'old-home') }, runner: new FakeRunner(), classroom: { requirement: r.nexysRequirement, dataRoot: r.nexysRoot } });
        assert.equal(ctx.classroom?.toolchain?.root, nexysDir(r));
        const again = await r.ctl.adoptNexysVhdl({ dryRun: false });
        assert.equal(again.plan.status, 'already-installed');
    });

    it('refuses to take over modified NexysVHDL tools, and leaves them alone', async (t) => {
        const r = await rig(t, { legacyNexys: true, pinnedNexys: false });
        const victim = join(r.legacyRoot, 'toolchains', 'darwin-arm64', '1.0', 'ghdl', 'bin', 'ghdl');
        await writeFile(victim, '#!/bin/sh\necho modified\n');
        const before = await tree(join(r.legacyRoot, 'toolchains', 'darwin-arm64', '1.0'));
        const out = await r.ctl.adoptNexysVhdl({ dryRun: false });
        assert.equal(out.plan.status, 'blocked');
        assert.equal(out.result, undefined);
        assert.equal(await exists(r.nexysRoot), false);
        assert.equal(await tree(join(r.legacyRoot, 'toolchains', 'darwin-arm64', '1.0')), before);
    });

    it('after the update DE10-Lite support can be added and both boards are ready from the same Setup', async (t) => {
        const r = await rig(t, { legacyNexys: true, pinnedNexys: false });
        const out = await r.ctl.install(r.ui, undefined, ['de10-lite']);
        assert.equal(out.outcome, 'complete', out.message);
        assert.deepEqual(out.view.boards.map((b) => b.word), ['Installed', 'Installed']);
        assert.equal(r.ui.questions.includes('nexys-file'), false, 'Nexys is never re-downloaded');
        assert.equal(word(out.view, 'fpga-engine'), 'Ready');
    });

    it('a fresh computer without a packaged Nexys file asks the student for it (and a refusal installs nothing)', async (t) => {
        const r = await rig(t, { pinnedNexys: false });
        r.ui.boards = ['nexys-a7-100t'];
        r.ui.nexysArchive = undefined;
        const out = await r.ctl.install(r.ui);
        assert.equal(out.outcome, 'failed');
        assert.deepEqual(r.ui.questions, ['boards', 'confirm', 'nexys-file']);
        assert.equal(await exists(join(r.nexysRoot, 'toolchains', 'darwin-arm64', '1.0')), false);
        r.ui.nexysArchive = r.nexysArchive;
        assert.equal((await r.ctl.install(r.ui)).outcome, 'complete');
    });
});
