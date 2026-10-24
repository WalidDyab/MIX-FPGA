import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ONLY_WINDOWS } from '../platform';
import { describe, it } from 'node:test';
import { inventoryTree, makeWritable, treeDigest } from '../../core/install/tree';
import { buildSetupView } from '../../platform/macos/install/setup-view';
import { TECHNICAL_TERMS_WINDOWS, WINDOWS_VIEW_PROFILE } from '../../platform/windows/install/boards';
import { boardWord, rig, word } from './rig';

const gone = (p: string) => stat(p).then(() => false, () => true);
const textOf = (v: ReturnType<typeof buildSetupView>) => JSON.stringify({ headline: v.headline, boards: v.boards, rows: v.rows, actions: v.actions });

describe('Windows Setup: fresh installation, Nexys / DE10 / both', { skip: ONLY_WINDOWS }, () => {
    it('opening Setup on a fresh computer runs no installation, shows both boards as not installed and no technical words', async (t) => {
        const r = await rig(t);
        const { view } = await r.ctl.status();
        assert.equal(view.fresh, true);
        assert.equal(view.headline, 'Setup required');
        assert.deepEqual(view.boards.map((b) => [b.name, b.word]), [['Nexys A7-100T', 'Not installed'], ['DE10-Lite', 'Not installed']]);
        assert.ok(view.actions.some((a) => a.id === 'install' && !a.board));
        assert.doesNotMatch(textOf(view), TECHNICAL_TERMS_WINDOWS);
        assert.deepEqual(r.helper.events, [], 'no administrator prompt just by looking');
        assert.equal(await gone(r.layout.root), true, 'nothing was created');
    });

    it('Case 1, Nexys only: the Nexys A7 tools are installed from the pinned archive, and nothing of the DE10-Lite is touched', async (t) => {
        const r = await rig(t);
        r.ui.boards = ['nexys-a7-100t'];
        const res = await r.ctl.install(r.ui);
        assert.equal(res.outcome, 'complete', res.message + r.ui.logs.join('|'));
        assert.deepEqual(r.ui.questions, ['boards', 'confirm']);
        assert.equal(boardWord(res.view, 'nexys-a7-100t'), 'Installed');
        assert.equal(boardWord(res.view, 'de10-lite'), 'Not installed');
        assert.equal(await gone(r.layout.toolchainDir), true, 'no DE10 tools');
        assert.equal(await gone(r.layout.helperDir), true);
        assert.deepEqual(r.helper.events, [], 'no administrator prompt for the Nexys A7');
        assert.ok(!r.runner.calls.some((c) => /quartus/.test(c.executable)), 'Quartus was never run');
        assert.ok((await stat(join(r.nexysRoot, 'toolchains', 'win32-x64', '1.0', '.nexysvhdl-installed.json'))).isFile());
        // The view of a Nexys-only computer has no FPGA Engine row.
        assert.deepEqual(res.view.rows.map((x) => x.id), ['vhdl-tools', 'programmer', 'hardware']);
        assert.doesNotMatch(textOf(res.view), TECHNICAL_TERMS_WINDOWS);
    });

    it('Case 2, DE10 only, Quartus already on the computer: installs the managed tools only and never reinstalls or elevates', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        const res = await r.ctl.install(r.ui);
        assert.equal(res.outcome, 'complete', res.message + r.ui.logs.join('|'));
        assert.deepEqual(r.ui.questions, ['boards', 'confirm'], 'no Altera files, no licence');
        assert.equal(r.ui.summaries[0]?.askedForAltera, false);
        assert.equal(r.ui.summaries[0]?.needsAdministrator, false);
        assert.deepEqual(r.helper.events, []);
        assert.equal(await gone(join(r.layout.nexysRoot)), true, 'no Nexys tools');
        assert.equal(boardWord(res.view, 'de10-lite'), 'Installed');
        assert.deepEqual(res.view.rows.map((x) => x.id), ['vhdl-tools', 'fpga-engine', 'programmer', 'hardware']);
        assert.equal(word(res.view, 'fpga-engine'), 'Ready');
        // Every installed file is the recorded one.
        for (const u of r.expected.toolchain.units) assert.equal(treeDigest(await inventoryTree(r.layout.unit(u.path))), u.treeSha256, u.id);
        assert.doesNotMatch(textOf(res.view), TECHNICAL_TERMS_WINDOWS);
    });

    it('Case 2b, DE10 only on a fresh computer: asks for the two Altera files, shows the vendor licence, and only then installs', async (t) => {
        const r = await rig(t);
        const res = await r.ctl.install(r.ui);
        assert.equal(res.outcome, 'complete', res.message + r.ui.logs.join('|'));
        assert.deepEqual(r.ui.questions, ['boards', 'confirm', 'files', 'license']);
        assert.equal(r.ui.summaries[0]?.askedForAltera, true);
        assert.equal(r.ui.summaries[0]?.needsAdministrator, true, 'the student is told Windows will ask once');
        // One permission prompt for the whole installation, licence before install, acceptance recorded before the installer may accept.
        assert.deepEqual(r.helper.events, ['start', 'license', 'accepted', 'install', 'stop'], 'one permission prompt for the whole installation, the licence before the install');
        assert.equal(boardWord(res.view, 'de10-lite'), 'Installed');
        // The licence is the vendor's text with the exact checkbox words.
        const offer = r.ui.offers[0]!;
        assert.equal(offer.text, 'QUARTUS PRIME AND INTEL FPGA IP LICENSE AGREEMENT (test text)\nLine two\n');
        assert.equal(offer.statement, 'I have reviewed and accept the Altera Quartus Prime Software License Agreement.');
        const rec = JSON.parse(await readFile(join(r.layout.stateDir, 'quartus.json'), 'utf8'));
        assert.equal(rec.eula.accepted, true);
        assert.equal(rec.eula.statement, offer.statement);
        assert.ok(rec.licenseOffered && rec.verifiedAt && rec.installedAt);
        // The temporary copies of Altera's files are gone and the student's downloads are untouched.
        assert.equal(await gone(join(r.layout.installersDir, r.spec.installer.name)), true);
        assert.ok((await stat(join(r.downloads, r.spec.installer.name))).isFile());
    });

    it('Case 3, both boards at once: each board\'s support once', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        r.ui.boards = ['nexys-a7-100t', 'de10-lite'];
        const res = await r.ctl.install(r.ui);
        assert.equal(res.outcome, 'complete', res.message + r.ui.logs.join('|'));
        assert.equal(boardWord(res.view, 'nexys-a7-100t'), 'Installed');
        assert.equal(boardWord(res.view, 'de10-lite'), 'Installed');
        assert.equal(res.view.allReady, true);
        assert.equal(res.view.headline, 'Ready');
    });

    it('a board can be added later: Nexys first, then DE10 installs only the DE10 parts', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        r.ui.boards = ['nexys-a7-100t'];
        assert.equal((await r.ctl.install(r.ui)).outcome, 'complete');
        const nexysTree = treeDigest(await inventoryTree(join(r.nexysRoot, 'toolchains', 'win32-x64', '1.0')));
        r.ui.boards = ['de10-lite'];
        r.ui.questions.length = 0;
        const res = await r.ctl.install(r.ui, undefined, ['de10-lite']);
        assert.equal(res.outcome, 'complete', res.message);
        assert.equal(treeDigest(await inventoryTree(join(r.nexysRoot, 'toolchains', 'win32-x64', '1.0'))), nexysTree, 'the Nexys tools were not touched');
        assert.deepEqual(r.copied.sort(), [], 'the DE10 tools came from the pinned archive, not the development folder');
        assert.equal(res.view.allReady, true);
    });

    it('…and DE10 first, then Nexys installs only the Nexys tools', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        assert.equal((await r.ctl.install(r.ui)).outcome, 'complete');
        const toolchain = treeDigest(await inventoryTree(r.layout.toolchainDir));
        const res = await r.ctl.install(r.ui, undefined, ['nexys-a7-100t']);
        assert.equal(res.outcome, 'complete', res.message);
        assert.equal(treeDigest(await inventoryTree(r.layout.toolchainDir)), toolchain, 'the DE10 tools were not touched');
        assert.equal(res.view.allReady, true);
    });
});

describe('Windows Setup: Altera Quartus, licence and administrator rights', { skip: ONLY_WINDOWS }, () => {
    it('declining the licence installs nothing from Altera, never asks the installer to accept, and ends the helper', async (t) => {
        const r = await rig(t);
        r.ui.accept = false;
        const res = await r.ctl.install(r.ui);
        assert.equal(res.outcome, 'stopped');
        assert.match(res.message, /licence was not accepted/);
        assert.ok(!r.helper.events.includes('install'), 'the installer was never told to install');
        assert.ok(!r.helper.events.includes('accepted'), 'no acceptance was recorded');
        assert.equal(r.helper.events.at(-1), 'stop', 'administrator rights end');
        assert.equal(r.quartusInstalled, false);
        assert.equal(await gone(join(r.layout.installersDir, r.spec.installer.name)), true, 'temporary copies removed');
        const rec = JSON.parse(await readFile(join(r.layout.stateDir, 'quartus.json'), 'utf8'));
        assert.equal(rec.eula, undefined);
    });

    it('refusing Windows\' permission prompt installs nothing and says so in student words', async (t) => {
        const r = await rig(t);
        r.helper.declinePrompt = true;
        const res = await r.ctl.install(r.ui);
        assert.equal(res.outcome, 'failed');
        assert.match(res.message, /Windows did not give permission/);
        assert.doesNotMatch(res.message, TECHNICAL_TERMS_WINDOWS);
        assert.equal(r.quartusInstalled, false);
        assert.ok(!r.ui.questions.includes('license'), 'a licence is not offered when the installer could not be asked for it');
    });

    it('a wrong Altera file is rejected in student words before anything runs', async (t) => {
        const r = await rig(t);
        await writeFile(join(r.downloads, r.spec.devicePackage.name), 'not the device package');
        const res = await r.ctl.install(r.ui);
        assert.equal(res.outcome, 'failed');
        assert.equal(res.message, 'The file you chose is not the one Setup needs. Download it again from Altera.');
        assert.deepEqual(r.helper.events, [], 'no administrator prompt for a wrong file');
        assert.equal(r.quartusInstalled, false);
    });

    it('swapped files are told apart', async (t) => {
        const r = await rig(t);
        r.ui.files = { installerPath: join(r.downloads, r.spec.devicePackage.name), devicePackagePath: join(r.downloads, r.spec.installer.name) };
        const res = await r.ctl.install(r.ui);
        assert.equal(res.outcome, 'failed');
        assert.ok(r.ui.logs.some((l) => /FILES_SWAPPED/.test(l)));
    });

    it('a licence that is not the one verified for this build is never offered, nothing is installed, and administrator rights end', async (t) => {
        const r = await rig(t);
        r.helper.licenseOverride = Buffer.from('some other licence text');
        const res = await r.ctl.install(r.ui);
        assert.equal(res.outcome, 'failed');
        assert.match(res.message, /licence could not be shown/);
        assert.ok(!r.ui.questions.includes('license'), 'it was never offered');
        assert.ok(!r.helper.events.includes('install') && !r.helper.events.includes('accepted'));
        assert.equal(r.helper.events.at(-1), 'stop');
        assert.equal(r.quartusInstalled, false);
    });

    it('an installer that wrote no licence stops the installation', async (t) => {
        const r = await rig(t);
        r.helper.licenseMissing = true;
        const res = await r.ctl.install(r.ui);
        assert.equal(res.outcome, 'failed');
        assert.ok(!r.ui.questions.includes('license'));
        assert.ok(!r.helper.events.includes('install'));
    });

    it('a failing Altera installer is reported, administrator rights end, and the copies go', async (t) => {
        const r = await rig(t);
        r.helper.installExit = 1603;
        const res = await r.ctl.install(r.ui);
        assert.equal(res.outcome, 'failed');
        assert.match(res.message, /installer did not finish/);
        assert.equal(r.helper.events.at(-1), 'stop');
        assert.equal(r.quartusInstalled, false);
    });

    it('Quartus that is installed but without the MAX 10 part is reported as not usable and is left alone: no reinstall, no administrator prompt', async (t) => {
        const r = await rig(t, { quartusPresent: true, parts: 'no-max10' });
        assert.equal((await r.ctl.status()).statuses.find((s) => s.id === 'max10')?.state, 'not-installed', 'it cannot be asked before the MIX-FPGA tools are there');
        r.ui.boards = ['de10-lite'];
        await r.ctl.install(r.ui);
        r.helper.events.length = 0;
        const { statuses } = await r.ctl.status();
        assert.equal(statuses.find((s) => s.id === 'quartus')?.state, 'ready');
        const max10 = statuses.find((s) => s.id === 'max10')!;
        assert.equal(max10.state, 'incompatible');
        assert.equal(max10.code, 'MAX10_MISSING');
        assert.equal(max10.ownership, 'external');
        const res = await r.ctl.install(r.ui);
        assert.deepEqual(r.helper.events, [], 'MIX-FPGA does not reinstall or patch Altera\'s software');
        assert.equal(boardWord(res.view, 'de10-lite'), 'Not supported');
    });
});

describe('Windows Setup: upgrade from NexysVHDL 0.6.0', { skip: ONLY_WINDOWS }, () => {
    it('the existing validated NexysVHDL tools are Ready (reused read-only) with nothing installed; DE10-Lite is offered', async (t) => {
        const r = await rig(t, { legacyNexys: true });
        const before = treeDigest(await inventoryTree(r.legacyRoot));
        const { statuses, view } = await r.ctl.status();
        assert.equal(statuses.find((s) => s.id === 'nexys-toolchain')?.state, 'ready');
        assert.equal(statuses.find((s) => s.id === 'nexys-toolchain')?.code, 'REUSED_FROM_NEXYSVHDL');
        assert.equal(boardWord(view, 'nexys-a7-100t'), 'Installed');
        assert.equal(boardWord(view, 'de10-lite'), 'Not installed');
        assert.ok(view.actions.some((a) => a.id === 'install' && a.board === 'de10-lite'), 'DE10-Lite offered as optional support');
        assert.equal(await gone(r.layout.nexysRoot), true, 'nothing copied');
        assert.equal(treeDigest(await inventoryTree(r.legacyRoot)), before, 'NexysVHDL untouched');
    });

    it('adding DE10-Lite does not reinstall or touch the Nexys tools or the NexysVHDL folder', async (t) => {
        const r = await rig(t, { legacyNexys: true, quartusPresent: true });
        const before = treeDigest(await inventoryTree(r.legacyRoot));
        const res = await r.ctl.install(r.ui, undefined, ['de10-lite']);
        assert.equal(res.outcome, 'complete', res.message);
        assert.equal(treeDigest(await inventoryTree(r.legacyRoot)), before);
        assert.equal(await gone(r.layout.nexysRoot), true, 'Nexys still runs from the NexysVHDL folder');
        assert.equal(boardWord(res.view, 'nexys-a7-100t'), 'Installed');
        assert.equal(boardWord(res.view, 'de10-lite'), 'Installed');
    });

    it('take-over: dry run reports size and extra disk; the real run copies and verifies every file; NexysVHDL is never modified', async (t) => {
        const r = await rig(t, { legacyNexys: true });
        const before = treeDigest(await inventoryTree(r.legacyRoot));
        const dry = await r.ctl.adoptNexysVhdl({ dryRun: true });
        assert.equal(dry.plan.status, 'adoptable');
        assert.equal(dry.plan.extraBytes, dry.plan.bytes, 'NTFS shares nothing: the copy needs the whole size');
        assert.ok((dry.plan.files ?? 0) > 0);
        assert.equal(dry.result, undefined);
        assert.equal(await gone(r.layout.nexysRoot), true, 'a dry run copies nothing');
        const done = await r.ctl.adoptNexysVhdl({ dryRun: false });
        assert.equal(done.result?.ok, true, done.result?.message);
        const mine = join(r.nexysRoot, 'toolchains', 'win32-x64', '1.0');
        const marker = JSON.parse(await readFile(join(mine, '.nexysvhdl-installed.json'), 'utf8'));
        assert.match(marker.source, /adopted from NexysVHDL/);
        assert.equal(treeDigest(await inventoryTree(r.legacyRoot)), before, 'NexysVHDL untouched');
        // A copy, not a link: changing the copy cannot reach the original.
        await writeFile(join(mine, 'toolchain-manifest.json'), 'changed');
        assert.equal(treeDigest(await inventoryTree(r.legacyRoot)), before);
        const { statuses } = await r.ctl.status();
        assert.equal(statuses.find((s) => s.id === 'nexys-toolchain')?.code, undefined, 'it now runs from the MIX-FPGA copy, not from NexysVHDL');
    });

    it('take-over refuses a NexysVHDL folder whose files were changed, and says why', async (t) => {
        const r = await rig(t, { legacyNexys: true });
        await writeFile(join(r.legacyRoot, 'toolchains', 'win32-x64', '1.0', 'toolchain-manifest.json'), 'tampered');
        const dry = await r.ctl.adoptNexysVhdl({ dryRun: true });
        assert.equal(dry.plan.status, 'blocked');
        assert.match(dry.plan.reasons.join(' '), /differ from the validated toolchain/);
        assert.equal(await gone(r.layout.nexysRoot), true);
    });

    it('take-over needs room for the whole copy and refuses cleanly without it', async (t) => {
        const r = await rig(t, { legacyNexys: true });
        r.free = 10;
        const done = await r.ctl.adoptNexysVhdl({ dryRun: false });
        assert.equal(done.result?.ok, false);
        assert.match(done.result?.message ?? '', /needs a copy of about/);
        assert.equal(await gone(r.layout.nexysRoot), true);
    });
});

describe('Windows Setup: Repair, Verify, interruption, cancellation', { skip: ONLY_WINDOWS }, () => {
    it('Repair puts back a damaged DE10 tool without asking for Altera again', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        r.ui.boards = ['nexys-a7-100t', 'de10-lite'];
        assert.equal((await r.ctl.install(r.ui)).outcome, 'complete');
        const dll = join(r.layout.unit('ghdl'), 'bin', 'libgcc_s_seh-1.dll');
        await makeWritable(r.layout.toolchainDir);
        // Same size, different bytes: invisible to the quick check, found by a full one.
        await writeFile(dll, Buffer.alloc((await stat(dll)).size, 0x41));
        const before = await r.ctl.status();
        assert.equal(before.statuses.find((s) => s.id === 'ghdl')?.state, 'ready', 'the quick check cannot see a changed DLL');
        r.ui.questions.length = 0;
        const res = await r.ctl.repair(r.ui);
        assert.equal(res.outcome, 'complete', res.message + r.ui.logs.join('|'));
        assert.ok(!r.ui.questions.includes('files') && !r.ui.questions.includes('license'));
        assert.deepEqual(r.helper.events, []);
        assert.notEqual((await readFile(dll)).subarray(0, 4).toString(), 'AAAA');
        for (const u of r.expected.toolchain.units) assert.equal(treeDigest(await inventoryTree(r.layout.unit(u.path))), u.treeSha256, u.id);
    });

    it('Repair replaces a damaged MIX-FPGA copy of the Nexys tools and leaves everything else alone', async (t) => {
        const r = await rig(t);
        r.ui.boards = ['nexys-a7-100t'];
        assert.equal((await r.ctl.install(r.ui)).outcome, 'complete');
        const mine = join(r.nexysRoot, 'toolchains', 'win32-x64', '1.0');
        await writeFile(join(mine, 'toolchain-manifest.json'), 'damaged');
        const res = await r.ctl.repair(r.ui);
        assert.equal(res.outcome, 'complete', res.message + r.ui.logs.join('|'));
        assert.notEqual(await readFile(join(mine, 'toolchain-manifest.json'), 'utf8'), 'damaged');
    });

    it('Verify Environment checks every file and the Quartus test design for the installed boards, and ignores boards nobody installed', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        r.ui.boards = ['de10-lite'];
        assert.equal((await r.ctl.install(r.ui)).outcome, 'complete');
        const v = await r.ctl.verify();
        assert.equal(v.ok, true, JSON.stringify(v.steps));
        assert.ok(v.steps.some((s) => s.label === 'Quartus and a test design'));
        assert.ok(!v.steps.some((s) => /Nexys/.test(s.label)), 'a board nobody installed is not a failure');
    });

    it('Verify finds a changed file that the quick check cannot see, and reports it as modified (usable), not as a failure', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        assert.equal((await r.ctl.install(r.ui)).outcome, 'complete');
        await makeWritable(r.layout.toolchainDir);
        const file = join(r.layout.unit('yosys'), 'share', 'deep', 'data.txt');
        await writeFile(file, 'changed');
        const v = await r.ctl.verify();
        assert.equal(v.ok, true, JSON.stringify(v.steps.filter((s) => !s.ok)));
        assert.equal(v.modified, true);
        assert.ok(v.steps.some((s) => /modified/.test(s.detail ?? '')));
        assert.equal(await readFile(file, 'utf8'), 'changed', 'Verify never writes');
        // A missing file is still a failure.
        await rm(file);
        const missing = await r.ctl.verify();
        assert.equal(missing.ok, false);
        assert.ok(missing.steps.some((s) => !s.ok));
    });

    it('a cancelled install stops cleanly and can be continued', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        const ac = new AbortController();
        ac.abort();
        const res = await r.ctl.install(r.ui, ac.signal);
        assert.equal(res.outcome, 'cancelled');
        assert.match(res.message, /cancelled/i);
        const again = await r.ctl.install(r.ui);
        assert.equal(again.outcome, 'complete', again.message);
    });

    it('declining the confirmation changes nothing', async (t) => {
        const r = await rig(t);
        r.ui.confirm = false;
        const res = await r.ctl.install(r.ui);
        assert.equal(res.outcome, 'stopped');
        assert.equal(await gone(r.layout.root), true);
    });

    it('New Project asks for support only when the board\'s support is missing', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        assert.equal(await r.ctl.isBoardReady('de10-lite'), false);
        assert.equal(await r.ctl.isBoardReady('nexys-a7-100t'), false);
        r.ui.boards = ['de10-lite'];
        await r.ctl.install(r.ui);
        assert.equal(await r.ctl.isBoardReady('de10-lite'), true);
        assert.equal(await r.ctl.isBoardReady('nexys-a7-100t'), false);
        assert.equal(await r.ctl.isBoardReady('something-else'), true);
    });
});

describe('Windows Setup: path-length preflight', { skip: ONLY_WINDOWS }, () => {
    const deep = 'C:\\' + 'folder-name-that-is-long\\'.repeat(6) + 'MIX-FPGA';

    it('a root that is too deep for the path limit stops before anything is installed, names the problem in Details, and changes nothing', async (t) => {
        const r = await rig(t, { home: deep });
        r.longPaths = false;
        r.ui.boards = ['nexys-a7-100t'];
        const res = await r.ctl.install(r.ui);
        assert.equal(res.outcome, 'failed');
        assert.match(res.message, /too deeply nested for Windows/);
        assert.ok(r.ui.logs.some((l) => /PATH_TOO_LONG/.test(l) && /Nexys A7 tools/.test(l)));
        assert.ok(!r.ui.questions.includes('confirm'), 'nothing was offered');
        assert.equal(await gone(deep), true, 'no folder was created');
    });

    it('long paths enabled lifts the limit', async (t) => {
        const r = await rig(t, { home: deep });
        r.longPaths = true;
        assert.deepEqual((await r.ctl.pathPreflight(['nexys-a7-100t', 'de10-lite'])).problems, []);
    });

    it('an unreadable setting counts as off, and the normal root of this account fits', async (t) => {
        const r = await rig(t);
        r.longPaths = undefined;
        const short = await (await rig(t, { home: 'C:\\MF' })).ctl.pathPreflight(['nexys-a7-100t', 'de10-lite']);
        assert.deepEqual(short.problems, [], 'a short root fits even with long paths off');
        const deepRig = await rig(t, { home: deep });
        deepRig.longPaths = false;
        const bad = await deepRig.ctl.pathPreflight(['de10-lite']);
        assert.equal(bad.ok, false);
    });
});

describe('Windows Setup: the student never sees Windows internals', { skip: ONLY_WINDOWS }, () => {
    it('no view of any state contains a driver name, a Quartus command, a path or PowerShell', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        const words: string[] = [textOf((await r.ctl.status()).view)];
        r.ui.boards = ['nexys-a7-100t', 'de10-lite'];
        const res = await r.ctl.install(r.ui);
        words.push(textOf(res.view), res.message);
        for (const w of words) assert.doesNotMatch(w, TECHNICAL_TERMS_WINDOWS);
        assert.ok((await readdir(r.layout.stateDir)).includes('board-support.json'));
    });

    it('the view profile is the Windows one: components are owned by MIX-FPGA, the student (Altera/Digilent) or Windows', async (t) => {
        const r = await rig(t, { quartusPresent: true });
        const { statuses } = await r.ctl.status();
        const view = buildSetupView(statuses, { state: 'ready', word: 'DE10-Lite' }, ['de10-lite'], WINDOWS_VIEW_PROFILE);
        const owner = (label: string) => view.details.find((d) => d.label === label)?.owner;
        assert.equal(owner('Quartus Prime Lite'), 'Supplied by you (Altera, Digilent)');
        assert.equal(owner('GHDL'), 'Installed by MIX-FPGA');
        assert.equal(owner('Altera USB-Blaster driver'), 'Provided by Windows');
    });
});
