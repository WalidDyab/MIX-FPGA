import assert from 'node:assert/strict';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { makeWritable } from '../../core/install/tree';
import { inventoryDirectory } from '../../core/toolchain/tar';
import { MODIFIED_HINT } from '../../platform/macos/install/setup-view';
import { ONLY_WINDOWS } from '../platform';
import { boardWord, rig, type Rig, word } from './rig';

/**
 * Windows counterpart of tests/install/modified-toolchain.test.ts (Phase 5D behaviour): a user who changes a file of the installed
 * toolchain (for example replaces a library, as the GPL/LGPL notices allow) keeps a working installation. It is reported as
 * modified, never as absent; nothing is restored unless the user chooses Repair; declining Repair changes nothing; a missing or
 * broken part is still a repair case.
 */
const nexysDir = (r: Rig) => join(r.nexysRoot, 'toolchains', 'win32-x64', '1.0');
const exists = (p: string) => stat(p).then(() => true, () => false);
const ghdlTool = (r: Rig) => join(r.layout.unit('ghdl'), 'bin', 'ghdl.exe');
const MINE = 'MZ my own GHDL build';

async function tamper(path: string, content: string): Promise<void> {
    await makeWritable(path);
    await writeFile(path, content);
}

describe('Windows: a modified toolchain is installed but modified, not absent', { skip: ONLY_WINDOWS }, () => {
    it('DE10-Lite: reported as modified, still usable, New Project not blocked, nothing restored by looking or by Install', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        assert.equal((await r.ctl.install(r.ui)).outcome, 'complete');
        const tool = ghdlTool(r);
        await tamper(tool, MINE);

        const { view } = await r.ctl.status();
        assert.equal(boardWord(view, 'de10-lite'), 'Installed (modified)');
        assert.equal(view.boards.find((b) => b.id === 'de10-lite')!.state, 'modified');
        assert.equal(word(view, 'vhdl-tools'), 'Modified');
        assert.equal(view.headline, 'Ready (modified toolchain)');
        assert.equal(view.allReady, false, 'it is not the verified configuration');
        assert.equal(await r.ctl.isBoardReady('de10-lite'), true, 'New Project is not blocked');
        assert.equal(await r.ctl.isBoardModified('de10-lite'), true);
        assert.equal(await r.ctl.isBoardModified('nexys-a7-100t'), false);
        const repair = view.actions.find((a) => a.id === 'repair' && a.board === 'de10-lite')!;
        assert.equal(repair.primary, false);
        assert.equal(repair.detail, MODIFIED_HINT);
        assert.equal(view.actions.some((a) => a.id === 'install' && a.board === 'de10-lite'), false, 'no "install" for something that is installed');
        assert.equal(await readFile(tool, 'utf8'), MINE, 'status did not touch the file');

        r.ui.questions.length = 0;
        const again = await r.ctl.install(r.ui, undefined, ['de10-lite']);
        assert.equal(again.outcome, 'complete', again.message);
        assert.deepEqual(r.ui.questions, [], 'no prompt, no copy');
        assert.equal(await readFile(tool, 'utf8'), MINE);
        assert.deepEqual(r.helper.events, [], 'nothing needs administrator rights');
    });

    it('Verify Environment reports the modification, passes, and does not restore anything', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        await r.ctl.install(r.ui);
        await tamper(ghdlTool(r), MINE);
        const v = await r.ctl.verify();
        assert.equal(v.ok, true, JSON.stringify(v.steps.filter((s) => !s.ok)));
        assert.equal(v.modified, true);
        assert.ok(v.steps.some((s) => /modified/.test(s.detail ?? '') && /no longer the verified MIX-FPGA configuration/.test(s.detail ?? '')));
        assert.equal(await readFile(ghdlTool(r), 'utf8'), MINE, 'Verify never writes');
        await r.ctl.repair(r.ui);
        const clean = await r.ctl.verify();
        assert.equal(clean.ok, true);
        assert.equal(clean.modified, undefined);
    });

    it('explicit Repair asks first, restores the supported file and hash, and the state returns to verified', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        await r.ctl.install(r.ui);
        const tool = ghdlTool(r);
        const original = await readFile(tool, 'utf8');
        const treeBefore = (await inventoryDirectory(r.layout.unit('ghdl'))).treeSha256;
        await tamper(tool, MINE);
        assert.notEqual((await inventoryDirectory(r.layout.unit('ghdl'))).treeSha256, treeBefore);

        r.ui.questions.length = 0;
        const out = await r.ctl.repair(r.ui);
        assert.equal(out.outcome, 'complete', `${out.message} ${r.ui.logs.join(' | ')}`);
        assert.deepEqual(r.ui.questions, ['confirm'], 'the user is asked first');
        assert.equal(r.ui.summaries.at(-1)!.replacesChanges, true, 'the dialog says changed files will be replaced');
        assert.equal(await readFile(tool, 'utf8'), original);
        assert.equal((await inventoryDirectory(r.layout.unit('ghdl'))).treeSha256, treeBefore);
        assert.equal(boardWord(out.view, 'de10-lite'), 'Installed');
        assert.equal(out.view.headline, 'Ready');
        assert.equal(out.view.allReady, true);
        assert.equal(await r.ctl.isBoardModified('de10-lite'), false);
        r.ui.questions.length = 0;
        assert.equal((await r.ctl.repair(r.ui)).message, 'Everything is already set up.');
        assert.deepEqual(r.ui.questions, []);
        assert.deepEqual(r.helper.events, [], 'Repair of a managed tool never needs Windows permission');
    });

    it("declining the Repair dialog leaves the user's file in place", async (t) => {
        const r = await rig(t, { quartusPresent: true });
        await r.ctl.install(r.ui);
        await tamper(ghdlTool(r), MINE);
        r.ui.confirm = false;
        const out = await r.ctl.repair(r.ui);
        assert.equal(out.outcome, 'stopped');
        assert.equal(await readFile(ghdlTool(r), 'utf8'), MINE);
        assert.equal(boardWord(out.view, 'de10-lite'), 'Installed (modified)');
    });

    it('a missing file or a missing tool stays a repair case, not "modified"', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        await r.ctl.install(r.ui);
        await makeWritable(r.layout.unit('ghdl'));
        await rm(ghdlTool(r));
        let { view } = await r.ctl.status();
        assert.equal(boardWord(view, 'de10-lite'), 'Needs repair');
        assert.equal(word(view, 'vhdl-tools'), 'Needs repair');
        assert.equal(await r.ctl.isBoardReady('de10-lite'), false, 'incomplete support is still offered for install/repair');
        assert.equal(await r.ctl.isBoardModified('de10-lite'), false);
        await makeWritable(r.layout.toolchainDir);
        await rm(r.layout.unit('yosys'), { recursive: true, force: true });
        view = (await r.ctl.status()).view;
        assert.notEqual(boardWord(view, 'de10-lite'), 'Installed (modified)');
        assert.notEqual(boardWord(view, 'de10-lite'), 'Installed');
        const v = await r.ctl.verify();
        assert.equal(v.ok, false);
        assert.equal(v.modified, undefined);
        const out = await r.ctl.repair(r.ui);
        assert.equal(out.outcome, 'complete', `${out.message} ${r.ui.logs.join(' | ')}`);
        assert.equal(boardWord(out.view, 'de10-lite'), 'Installed');
        assert.equal(await exists(ghdlTool(r)), true);
    });

    it('a missing file next to a modified one is repaired as damaged; Repair restores both', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        await r.ctl.install(r.ui);
        await tamper(ghdlTool(r), MINE);
        await makeWritable(r.layout.toolchainDir);
        await rm(r.layout.unit('yosys'), { recursive: true, force: true });
        const { view } = await r.ctl.status();
        assert.notEqual(boardWord(view, 'de10-lite'), 'Installed (modified)', 'a missing tool is more than a modification');
        const out = await r.ctl.repair(r.ui);
        assert.equal(out.outcome, 'complete', `${out.message} ${r.ui.logs.join(' | ')}`);
        assert.equal(boardWord(out.view, 'de10-lite'), 'Installed');
    });
});

describe('Windows: the same rules for the Nexys A7 tools, and the two boards stay independent', { skip: ONLY_WINDOWS }, () => {
    const victim = (r: Rig) => join(nexysDir(r), 'apio', 'packages', 'definitions', 'boards.jsonc');

    it('Nexys A7: a changed file is modified and usable; Repair restores the supported tree', async (t) => {
        const r = await rig(t);
        r.ui.boards = ['nexys-a7-100t'];
        await r.ctl.install(r.ui);
        await tamper(victim(r), '{ "my": "own board list" }');

        const v = await r.ctl.verify();
        assert.equal(v.ok, true, JSON.stringify(v.steps.filter((s) => !s.ok)));
        assert.equal(v.modified, true);
        assert.equal(await r.ctl.isBoardReady('nexys-a7-100t'), true);
        assert.equal(await readFile(victim(r), 'utf8'), '{ "my": "own board list" }', 'nothing was restored');

        const out = await r.ctl.repair(r.ui, undefined, ['nexys-a7-100t']);
        assert.equal(out.outcome, 'complete', `${out.message} ${r.ui.logs.join(' | ')}`);
        assert.equal((await inventoryDirectory(nexysDir(r), { exclude: ['.nexysvhdl-installed.json'] })).treeSha256, r.nexysRequirement.targets['win32-x64']!.treeSha256);
        assert.equal(await r.ctl.isBoardModified('nexys-a7-100t'), false);
        assert.equal((await r.ctl.verify()).modified, undefined);
    });

    it('Nexys A7: declining Repair changes nothing', async (t) => {
        const r = await rig(t);
        r.ui.boards = ['nexys-a7-100t'];
        await r.ctl.install(r.ui);
        await tamper(victim(r), '{ "my": "own board list" }');
        r.ui.confirm = false;
        const out = await r.ctl.repair(r.ui, undefined, ['nexys-a7-100t']);
        assert.equal(out.outcome, 'stopped');
        assert.equal(await readFile(victim(r), 'utf8'), '{ "my": "own board list" }');
    });

    it('Nexys A7: a removed executable is damaged (repair), not modified', async (t) => {
        const r = await rig(t);
        r.ui.boards = ['nexys-a7-100t'];
        await r.ctl.install(r.ui);
        const exe = join(nexysDir(r), 'ghdl', 'bin', 'ghdl.exe');
        await makeWritable(nexysDir(r));
        await rm(exe);
        const v = await r.ctl.verify();
        assert.equal(v.ok, false);
        assert.equal(v.modified, undefined);
        assert.equal(await r.ctl.isBoardModified('nexys-a7-100t'), false);
        const out = await r.ctl.repair(r.ui, undefined, ['nexys-a7-100t']);
        assert.equal(out.outcome, 'complete', `${out.message} ${r.ui.logs.join(' | ')}`);
        assert.equal(await exists(exe), true);
        assert.equal((await r.ctl.verify()).ok, true);
    });

    it("a modification on one board does not change the other board's state", async (t) => {
        const r = await rig(t, { quartusPresent: true });
        r.ui.boards = ['nexys-a7-100t', 'de10-lite'];
        await r.ctl.install(r.ui);
        await tamper(ghdlTool(r), MINE);
        const { view } = await r.ctl.status();
        assert.deepEqual(view.boards.map((b) => b.word), ['Installed', 'Installed (modified)']);
        assert.equal(await r.ctl.isBoardReady('nexys-a7-100t'), true);
        assert.equal(await r.ctl.isBoardReady('de10-lite'), true);
        const nexysBefore = (await inventoryDirectory(nexysDir(r))).treeSha256;
        const out = await r.ctl.repair(r.ui, undefined, ['de10-lite']);
        assert.equal(out.outcome, 'complete', `${out.message} ${r.ui.logs.join(' | ')}`);
        assert.deepEqual(out.view.boards.map((b) => b.word), ['Installed', 'Installed']);
        assert.equal((await inventoryDirectory(nexysDir(r))).treeSha256, nexysBefore);
    });
});
