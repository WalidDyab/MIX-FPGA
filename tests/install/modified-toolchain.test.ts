import assert from 'node:assert/strict';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { makeWritable } from '../../core/install/tree';
import { inventoryDirectory } from '../../core/toolchain/tar';
import { MODIFIED_HINT } from '../../platform/macos/install/setup-view';
import { ONLY_MACOS } from '../platform';
import { boardWord, rig, type Rig, word } from './setup-rig';

/**
 * A user who changes a file of the installed toolchain (for example replaces a library, as the LGPL/GPL notices allow) keeps a
 * working installation: it is reported as modified, never as absent, nothing is restored unless the user chooses Repair, and a
 * missing or broken part is still a repair case.
 */
const nexysDir = (r: Rig) => join(r.nexysRoot, 'toolchains', 'darwin-arm64', '1.0');
const exists = (p: string) => stat(p).then(() => true, () => false);

async function tamper(path: string, content: string): Promise<void> {
    await makeWritable(path);
    await writeFile(path, content);
}

const ghdlTool = (r: Rig) => join(r.layout.unit('ghdl'), 'bin', 'ghdl');

describe('a modified toolchain is installed but modified, not absent', () => {
    it('DE10-Lite: reported as modified, still usable, New Project not blocked, nothing restored by looking', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await r.ctl.install(r.ui);
        const tool = ghdlTool(r);
        const original = await readFile(tool, 'utf8');
        await tamper(tool, '#!/bin/sh\necho my own build\n');

        const { view } = await r.ctl.status();
        assert.equal(boardWord(view, 'de10-lite'), 'Installed (modified)');
        assert.equal(view.boards.find((b) => b.id === 'de10-lite')!.state, 'modified');
        assert.equal(word(view, 'vhdl-tools'), 'Modified');
        assert.equal(view.headline, 'Ready (modified toolchain)');
        assert.equal(view.allReady, false, 'it is not the verified configuration');
        // New Project: the board is usable, so it is never offered an install.
        assert.equal(await r.ctl.isBoardReady('de10-lite'), true);
        assert.equal(await r.ctl.isBoardModified('de10-lite'), true);
        assert.equal(await r.ctl.isBoardModified('nexys-a7-100t'), false);
        // Repair is offered, with the honest wording, but is not the primary action and is not run.
        const repair = view.actions.find((a) => a.id === 'repair' && a.board === 'de10-lite')!;
        assert.equal(repair.primary, false);
        assert.equal(repair.detail, MODIFIED_HINT);
        assert.match(MODIFIED_HINT, /no longer the verified MIX-FPGA configuration/);
        assert.match(MODIFIED_HINT, /continue using it, or choose Repair/);
        assert.equal(view.actions.some((a) => a.id === 'install' && a.board === 'de10-lite'), false, 'no "install" for something that is installed');
        assert.equal(await readFile(tool, 'utf8'), '#!/bin/sh\necho my own build\n', 'status did not touch the file');

        // Install on the same board does not restore either: the user's file stays.
        r.ui.questions.length = 0;
        const again = await r.ctl.install(r.ui, undefined, ['de10-lite']);
        assert.equal(again.outcome, 'complete', again.message);
        assert.deepEqual(r.ui.questions, [], 'no prompt, no copy');
        assert.equal(await readFile(tool, 'utf8'), '#!/bin/sh\necho my own build\n');
        assert.notEqual(original, '#!/bin/sh\necho my own build\n');
    });

    it('Verify Environment reports the modification, passes, and does not restore anything', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await r.ctl.install(r.ui);
        await tamper(ghdlTool(r), '#!/bin/sh\necho my own build\n');
        const v = await r.ctl.verify();
        assert.equal(v.ok, true, JSON.stringify(v.steps.filter((s) => !s.ok)));
        assert.equal(v.modified, true);
        assert.ok(v.steps.some((s) => /modified/.test(s.detail ?? '') && /no longer the verified MIX-FPGA configuration/.test(s.detail ?? '')));
        assert.equal(await readFile(ghdlTool(r), 'utf8'), '#!/bin/sh\necho my own build\n', 'Verify never writes');
        // An unmodified installation still verifies without the flag.
        await r.ctl.repair(r.ui);
        const clean = await r.ctl.verify();
        assert.equal(clean.ok, true);
        assert.equal(clean.modified, undefined);
    });

    it('explicit Repair restores the supported file and hash, and the state returns to verified', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await r.ctl.install(r.ui);
        const tool = ghdlTool(r);
        const original = await readFile(tool, 'utf8');
        const treeBefore = (await inventoryDirectory(r.layout.unit('ghdl'))).treeSha256;
        await tamper(tool, '#!/bin/sh\necho my own build\n');
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
        // Repairing again has nothing left to do.
        r.ui.questions.length = 0;
        assert.equal((await r.ctl.repair(r.ui)).message, 'Everything is already set up.');
        assert.deepEqual(r.ui.questions, []);
    });

    it('declining the Repair dialog leaves the user\'s file in place', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await r.ctl.install(r.ui);
        await tamper(ghdlTool(r), '#!/bin/sh\necho my own build\n');
        r.ui.confirm = false;
        const out = await r.ctl.repair(r.ui);
        assert.equal(out.outcome, 'stopped');
        assert.equal(await readFile(ghdlTool(r), 'utf8'), '#!/bin/sh\necho my own build\n');
        assert.equal(boardWord(out.view, 'de10-lite'), 'Installed (modified)');
    });

    it('a missing file or a missing tool stays a repair case, not "modified"', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await r.ctl.install(r.ui);
        // One file gone inside a tool.
        await makeWritable(r.layout.unit('ghdl'));
        await rm(ghdlTool(r));
        let { view } = await r.ctl.status();
        assert.equal(boardWord(view, 'de10-lite'), 'Needs repair');
        assert.equal(word(view, 'vhdl-tools'), 'Needs repair');
        assert.equal(await r.ctl.isBoardReady('de10-lite'), false, 'incomplete support is still offered for install/repair');
        assert.equal(await r.ctl.isBoardModified('de10-lite'), false);
        // A whole tool gone.
        await makeWritable(r.layout.toolchainDir);
        await rm(r.layout.unit('yosys'), { recursive: true, force: true });
        view = (await r.ctl.status()).view;
        assert.notEqual(boardWord(view, 'de10-lite'), 'Installed (modified)');
        assert.notEqual(boardWord(view, 'de10-lite'), 'Installed');
        const v = await r.ctl.verify();
        assert.equal(v.ok, false);
        assert.equal(v.modified, undefined);
        // Repair brings both back.
        const out = await r.ctl.repair(r.ui);
        assert.equal(out.outcome, 'complete', out.message);
        assert.equal(boardWord(out.view, 'de10-lite'), 'Installed');
        assert.equal(await exists(ghdlTool(r)), true);
    });

    it('a missing file next to a modified one is repaired as damaged; Repair restores both', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await r.ctl.install(r.ui);
        await tamper(ghdlTool(r), '#!/bin/sh\necho my own build\n');
        await makeWritable(r.layout.toolchainDir);
        await rm(r.layout.unit('yosys'), { recursive: true, force: true });
        const { view } = await r.ctl.status();
        assert.notEqual(boardWord(view, 'de10-lite'), 'Installed (modified)', 'a missing tool is more than a modification');
        const out = await r.ctl.repair(r.ui);
        assert.equal(out.outcome, 'complete', out.message);
        assert.equal(boardWord(out.view, 'de10-lite'), 'Installed');
    });
});

describe('the same rules for the Nexys A7 tools, and the two boards stay independent', () => {
    it('Nexys A7: a changed file is modified and usable; Repair restores the supported tree', async (t) => {
        const r = await rig(t);
        r.ui.boards = ['nexys-a7-100t'];
        await r.ctl.install(r.ui);
        const victim = join(nexysDir(r), 'apio', 'packages', 'oss-cad-suite', 'bin', 'openFPGALoader');
        await tamper(victim, 'my own openFPGALoader build');

        const v = await r.ctl.verify();
        assert.equal(v.ok, true, JSON.stringify(v.steps.filter((s) => !s.ok)));
        assert.equal(v.modified, true);
        assert.equal(await r.ctl.isBoardReady('nexys-a7-100t'), true);
        // The page's quick look does not hash every file of the Nexys tools: it stays ready; Verify and Repair (full) see the change.
        assert.equal(await readFile(victim, 'utf8'), 'my own openFPGALoader build', 'nothing was restored');

        const out = await r.ctl.repair(r.ui, undefined, ['nexys-a7-100t']);
        assert.equal(out.outcome, 'complete', `${out.message} ${r.ui.logs.join(' | ')}`);
        assert.equal((await inventoryDirectory(nexysDir(r), { exclude: ['.nexysvhdl-installed.json'] })).treeSha256, r.nexysRequirement.targets['darwin-arm64']!.treeSha256);
        assert.equal(await r.ctl.isBoardModified('nexys-a7-100t'), false);
        assert.equal((await r.ctl.verify()).modified, undefined);
    });

    it('Nexys A7: a removed executable or manifest is damaged (repair), not modified', async (t) => {
        const r = await rig(t);
        r.ui.boards = ['nexys-a7-100t'];
        await r.ctl.install(r.ui);
        const exe = join(nexysDir(r), 'ghdl', 'bin', 'ghdl');
        await makeWritable(nexysDir(r));
        await rm(exe);
        const v = await r.ctl.verify();
        assert.equal(v.ok, false);
        assert.equal(v.modified, undefined);
        assert.equal(await r.ctl.isBoardModified('nexys-a7-100t'), false);
        const out = await r.ctl.repair(r.ui, undefined, ['nexys-a7-100t']);
        assert.equal(out.outcome, 'complete', out.message);
        assert.equal(await exists(exe), true);
        assert.equal((await r.ctl.verify()).ok, true);
    });

    it('a modification on one board does not change the other board\'s state', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        r.ui.boards = ['nexys-a7-100t', 'de10-lite'];
        await r.ctl.install(r.ui);
        await tamper(ghdlTool(r), '#!/bin/sh\necho my own build\n');
        const { view } = await r.ctl.status();
        assert.deepEqual(view.boards.map((b) => b.word), ['Installed', 'Installed (modified)']);
        assert.equal(await r.ctl.isBoardReady('nexys-a7-100t'), true);
        assert.equal(await r.ctl.isBoardReady('de10-lite'), true);
        // Repairing the modified board names it; the Nexys tools are not touched.
        const nexysBefore = (await inventoryDirectory(nexysDir(r))).treeSha256;
        const out = await r.ctl.repair(r.ui, undefined, ['de10-lite']);
        assert.equal(out.outcome, 'complete', out.message);
        assert.deepEqual(out.view.boards.map((b) => b.word), ['Installed', 'Installed']);
        assert.equal((await inventoryDirectory(nexysDir(r))).treeSha256, nexysBefore);
    });
});
