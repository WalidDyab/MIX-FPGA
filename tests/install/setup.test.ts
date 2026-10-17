import assert from 'node:assert/strict';
import { chmod, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ComponentState, ComponentStatus } from '../../core';
import { MACOS_CATALOG } from '../../platform/macos/install/catalog';
import { SetupController } from '../../platform/macos/install/setup-controller';
import { buildSetupView, type HardwareView, studentFailure, TECHNICAL_TERMS } from '../../platform/macos/install/setup-view';
import { expectedFor } from './fixtures';
import { DirectoryPayload } from '../../platform/macos/install/payload';
import { rig, word } from './setup-rig';
import { ONLY_MACOS } from '../platform';

const DE10: HardwareView = { state: 'ready', word: 'DE10-Lite' };

describe('Setup page model', () => {
    it('on a fresh machine shows both boards not installed, no environment rows yet, and Install FPGA Toolchain', async (t) => {
        const r = await rig(t);
        const { view } = await r.ctl.status();
        assert.deepEqual(view.boards.map((b) => [b.name, b.word]), [['Nexys A7-100T', 'Not installed'], ['DE10-Lite', 'Not installed']]);
        assert.equal(view.fresh, true);
        assert.deepEqual(view.rows.map((x) => [x.label, x.word]), [['Hardware', 'DE10-Lite']]);
        assert.equal(view.headline, 'Setup required');
        assert.deepEqual(view.actions.filter((a) => !a.board).map((a) => [a.id, a.label, a.primary]), [['install', 'Install FPGA Toolchain', true]]);
        assert.deepEqual(r.m.calls.length, 0, 'nothing touches Lima before Lima is installed');
    });

    it('never uses technical words in the student view, whatever the states', () => {
        const states: ComponentState[] = ['ready', 'not-installed', 'installing', 'repairable', 'incompatible', 'failed'];
        const texts: string[] = [];
        for (const a of states) for (const b of states) {
            const statuses: ComponentStatus[] = MACOS_CATALOG.map((c, i) => ({ id: c.id, state: i % 2 ? a : b, ownership: c.ownership, detail: 'Lima raw detail /opt/x' }));
            const v = buildSetupView(statuses, { state: 'not-connected', word: 'Not connected', hint: 'Connect the board by USB and turn it on.' });
            texts.push(v.headline, ...v.rows.flatMap((x) => [x.label, x.word, x.hint ?? '']), ...v.actions.flatMap((x) => [x.label, x.detail]));
        }
        for (const code of ['INSUFFICIENT_DISK', 'GUEST_NETWORK', 'FILES_SWAPPED', 'LICENSE_UNVERIFIED', 'SMOKE_TEST_FAILED', 'CANCELLED', 'ANYTHING_ELSE', 'LIMA_SOCKET_PATH_TOO_LONG']) texts.push(studentFailure(code));
        for (const x of texts) assert.doesNotMatch(x, TECHNICAL_TERMS, x);
        const details = buildSetupView(MACOS_CATALOG.map((c) => ({ id: c.id, state: 'ready' as const, ownership: c.ownership })), DE10).details;
        assert.ok(details.some((d) => d.label === 'Lima'), 'technical names are available under Details');
    });

    it('the actions follow the states: Install, Repair, Verify', () => {
        const mk = (over: Record<string, ComponentState>): ComponentStatus[] => MACOS_CATALOG.map((c) => ({ id: c.id, state: over[c.id] ?? 'ready', ownership: c.ownership }));
        const ids = (s: ComponentStatus[]) => buildSetupView(s, DE10).actions.map((a) => a.id);
        assert.deepEqual(ids(mk({})), ['repair', 'verify'], 'Repair checks every file, so it is always offered once a board is installed');
        assert.deepEqual(ids(mk({ quartus: 'not-installed', max10: 'not-installed' })), ['install', 'repair', 'verify']);
        assert.deepEqual(ids(mk({ ghdl: 'repairable', toolchain: 'repairable' })), ['repair', 'repair', 'verify']);
        assert.deepEqual(ids(mk({ 'linux-vm': 'failed' })), ['repair', 'repair', 'verify']);
        assert.deepEqual(ids(mk({ 'linux-vm': 'incompatible' })), ['repair', 'verify'], 'no Install or board-Repair button for an unusable engine; the global Repair only checks files');
        assert.equal(buildSetupView(mk({ 'linux-vm': 'incompatible' }), DE10).headline, 'Needs attention');
    });

    it('shows the hardware state without making it a setup problem', () => {
        const ready = MACOS_CATALOG.map((c) => ({ id: c.id, state: 'ready' as const, ownership: c.ownership }));
        const v = buildSetupView(ready, { state: 'not-connected', word: 'Not connected', hint: 'Connect the board by USB.' });
        assert.equal(v.allReady, true);
        assert.equal(v.headline, 'Ready');
        assert.equal(word(v, 'hardware'), 'Not connected');
    });
});

describe('Setup flows on an isolated root', () => {
    it('a fresh student: Install FPGA Toolchain asks only what it must, in order, and everything ends Ready', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        const out = await r.ctl.install(r.ui);
        assert.equal(out.outcome, 'complete', `${out.message} ${r.ui.logs.join(' | ')}`);
        assert.deepEqual(r.ui.questions, ['boards', 'confirm', 'rosetta', 'files', 'license']);
        assert.deepEqual(out.view.rows.map((x) => x.word), ['Ready', 'Ready', 'Ready', 'DE10-Lite']);
        assert.deepEqual(out.view.actions.map((a) => `${a.id}:${a.board ?? ''}`), ['install:nexys-a7-100t', 'repair:', 'verify:'], 'the other board can be added later');
        assert.equal(r.ui.summaries[0]!.askedForAltera, true);
        assert.equal(r.ui.summaries[0]!.needsInternet, true);
        assert.equal(r.ui.summaries[0]!.storageGB < 15 && r.ui.summaries[0]!.requiredFreeGB === 20, true);
        for (const phrase of ['Installing VHDL tools…', 'Preparing the FPGA engine…', 'Installing Quartus…', 'Adding MAX 10 support…', 'Verifying installation…']) assert.ok(r.ui.messages.includes(phrase), phrase);
        for (const m of r.ui.messages) assert.doesNotMatch(m, TECHNICAL_TERMS, m);
        assert.equal(r.m.instance!.status, 'Stopped', 'the engine is left stopped');
        assert.equal(r.m.rosettaCommands.length, 1);
        assert.ok(!r.m.rosettaCommands[0]!.args.includes('--agree-to-license'));
        assert.equal(r.m.quartusInstalls, 1);
        assert.deepEqual(await readdir(r.layout.installersDir), [], 'temporary Altera copies removed');
    });

    it('the licence the student is shown is the vendor\'s text, with the exact checkbox words and reference link', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await r.ctl.install(r.ui);
        const o = r.ui.offers[0]!;
        assert.equal(o.text, r.m.licenseText);
        assert.equal(o.statement, 'I have reviewed and accept the Altera Quartus Prime Software License Agreement.');
        assert.match(o.references[0]!.url, /^https:\/\/www\.altera\.com\//);
    });

    it('opening Setup (status) never starts the engine; Setup opened again after success asks nothing', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await r.ctl.install(r.ui);
        r.m.calls.length = 0;
        const { view } = await r.ctl.status();
        assert.equal(view.allReady, true);
        assert.ok(r.m.calls.every((c) => c[0] === 'list'));
        r.ui.questions.length = 0;
        const again = await r.ctl.install(r.ui);
        assert.deepEqual([again.outcome, again.message, r.ui.questions], ['complete', 'Everything is already set up.', []]);
    });

    it('declining at the start changes nothing', async (t) => {
        const r = await rig(t);
        r.ui.confirm = false;
        const out = await r.ctl.install(r.ui);
        assert.deepEqual([out.outcome, out.message], ['stopped', 'Nothing was changed.']);
        assert.equal(await stat(r.layout.toolchainDir).then(() => true, () => false), false);
    });

    it('declining Rosetta stops at that point with a clear message; the next run does not repeat finished work', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        r.ui.rosetta = undefined;
        const out = await r.ctl.install(r.ui);
        assert.equal(out.outcome, 'stopped');
        assert.match(out.message, /Rosetta was not installed/);
        assert.equal(word(out.view, 'vhdl-tools'), 'Ready', 'the VHDL tools were installed before the question');
        assert.equal(r.m.rosettaCommands.length, 0);
        r.ui.rosetta = { method: 'apple-prompt' };
        r.ui.questions.length = 0;
        const next = await r.ctl.install(r.ui);
        assert.equal(next.outcome, 'complete');
        assert.deepEqual(r.ui.questions, ['confirm', 'rosetta', 'files', 'license']);
        assert.equal(r.ui.summaries[1]!.items.some((i) => /VHDL/.test(i)), false, 'the finished VHDL tools are not on the second plan');
    });

    it('not accepting Altera\'s licence installs nothing from Altera and never passes --accept_eula', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        r.ui.accept = false;
        const out = await r.ctl.install(r.ui);
        assert.equal(out.outcome, 'stopped');
        assert.match(out.message, /licence was not accepted/);
        assert.equal(r.m.guest.some((g) => g.includes('--accept_eula')), false);
        assert.equal(r.m.quartusInstalls, 0);
        assert.equal(word(out.view, 'fpga-engine'), 'Not installed');
    });

    it('a wrong Altera file is rejected in student words and nothing is installed', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await writeFile(join(r.downloads, 'other.run'), 'something else');
        r.ui.files = { installerPath: join(r.downloads, 'other.run'), devicePackagePath: r.ui.files!.devicePackagePath };
        const out = await r.ctl.install(r.ui);
        assert.equal(out.outcome, 'failed');
        assert.equal(out.message, studentFailure('WRONG_FILE'));
        assert.doesNotMatch(out.message, TECHNICAL_TERMS);
        assert.equal(r.ui.questions.includes('license'), false);
    });

    it('an interrupted install is resumed by Install or Repair without starting over', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        r.crashToolchainOnce = true;
        const first = await r.ctl.install(r.ui);
        assert.equal(first.outcome, 'failed');
        assert.equal(first.message, studentFailure('UNEXPECTED_ERROR'));
        assert.match(first.message, /Repair/);
        assert.deepEqual(first.view.actions.map((a) => a.id).includes('install'), true);
        const second = await r.ctl.install(r.ui);
        assert.equal(second.outcome, 'complete', second.message);
    });

    it('Repair puts back a damaged tool without asking for Apple or Altera again', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await r.ctl.install(r.ui);
        const tool = join(r.layout.unit('ghdl'), 'bin', 'ghdl');
        await chmod(r.layout.unit('ghdl'), 0o755);
        await chmod(join(r.layout.unit('ghdl'), 'bin'), 0o755);
        await chmod(tool, 0o755);
        await writeFile(tool, '#!/bin/sh\necho tampered\n');
        const { view } = await r.ctl.status();
        assert.equal(word(view, 'vhdl-tools'), 'Needs repair');
        assert.deepEqual(view.actions.map((a) => `${a.id}:${a.board ?? ''}`), ['install:nexys-a7-100t', 'repair:de10-lite']);
        r.ui.questions.length = 0;
        const out = await r.ctl.repair(r.ui);
        assert.equal(out.outcome, 'complete', out.message);
        assert.deepEqual(r.ui.questions, ['confirm']);
        assert.equal(word(out.view, 'vhdl-tools'), 'Ready');
    });

    it('Verify Environment checks every file, proves Quartus in the engine, and stops the engine again', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        await r.ctl.install(r.ui);
        const v = await r.ctl.verify();
        assert.equal(v.ok, true, JSON.stringify(v.steps.filter((s) => !s.ok)));
        assert.ok(v.steps.some((s) => s.label === 'FPGA engine and Quartus' && s.ok));
        assert.equal(r.m.instance!.status, 'Stopped');
        r.m.smokeFails = true;
        const bad = await r.ctl.verify();
        assert.equal(bad.ok, false);
        assert.equal(r.m.instance!.status, 'Stopped');
    });

    it('lack of disk space for the engine is reported in student words before anything is created', async (t) => {
        const r = await rig(t);
        r.free = 2e9;
        const out = await r.ctl.install(r.ui);
        assert.equal(out.outcome, 'failed');
        assert.equal(out.message, studentFailure('INSUFFICIENT_DISK'));
        assert.equal(r.m.instance, undefined, 'no engine was created');
        assert.equal(r.m.count('create'), 0);
    });

    it('a cancelled install stops cleanly and can be continued', { skip: ONLY_MACOS }, async (t) => {
        const r = await rig(t);
        const ctl = new AbortController();
        ctl.abort();
        const out = await r.ctl.install(r.ui, ctl.signal);
        assert.equal(out.outcome, 'cancelled');
        assert.match(out.message, /cancelled/);
        const next = await r.ctl.install(r.ui);
        assert.equal(next.outcome, 'complete');
    });

    it('without the installation source nothing is claimed installed', async (t) => {
        const r = await rig(t);
        const missing = new SetupController({ ...(r.ctl as unknown as { deps: ConstructorParameters<typeof SetupController>[0] }).deps, payload: undefined });
        const out = await missing.install(r.ui);
        assert.equal(out.outcome, 'failed');
        assert.equal(await stat(r.layout.toolchainMarker).then(() => true, () => false), false);
        void expectedFor;
        void DirectoryPayload;
    });
});
