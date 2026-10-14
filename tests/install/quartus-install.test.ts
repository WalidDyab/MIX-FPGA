import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { type ComponentDefinition, InstallStateStore, SetupEngine, type ToolInvocation, type ToolRunResult, type ToolRunner } from '../../core';
import { resolveRuntimeLayout, type RuntimeLayout } from '../../platform/macos/install/layout';
import { installedDe10Paths } from '../../platform/macos/install/paths';
import { ACCEPT_STATEMENT, acceptanceFor, checkAlteraFile, installerCommand, type LicenseOffer, QUARTUS_SPEC, QuartusInstaller, type QuartusInput, type QuartusSpec } from '../../platform/macos/install/quartus-install';

const BANNER = 'Quartus Prime Shell\nVersion 25.1std.0 Build 1129 10/21/2025 SC Lite Edition\n';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** The engine as the Quartus installer sees it. */
class FakeEngine implements ToolRunner {
    readonly calls: string[][] = [];
    readonly guest: string[] = [];
    vm: 'Running' | 'Stopped' = 'Running';
    installed = false;
    installFails = false;
    installedBanner = BANNER;
    cleaned = 0;
    installs = 0;
    licenseRuns = 0;
    missingTools: string[] = [];
    family = true;
    device = true;
    smokeFails = false;
    licenseText = 'QUARTUS PRIME AND INTEL FPGA IP LICENSE AGREEMENT (test text)\n';
    licenseMissing = false;
    constructor(private readonly limactl: string, private readonly installersDir: string, private readonly shareDir: string) {}

    async run(inv: ToolInvocation): Promise<ToolRunResult> {
        const base: ToolRunResult = { invocation: inv, outcome: 'exited', exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
        if (inv.executable !== this.limactl) return { ...base, outcome: 'spawn-failed', exitCode: null };
        const a = [...inv.args];
        this.calls.push(a);
        if (a[0] === 'list') return { ...base, stdout: `${this.vm}\n` };
        if (a[0] === 'start') return ((this.vm = 'Running'), base);
        if (a[0] === 'stop') return ((this.vm = 'Stopped'), base);
        if (a[0] !== 'shell') return { ...base, exitCode: 2 };
        const s = a[a.length - 1]!;
        this.guest.push(s);
        if (s === 'mixfpga-q quartus_sh --version') return this.installed ? { ...base, stdout: this.installedBanner } : { ...base, exitCode: 127, stderr: 'mixfpga-q: Quartus not found' };
        if (s.includes('--install_lic')) {
            if (this.licenseMissing) return { ...base, exitCode: 1 };
            this.licenseRuns++;
            await mkdir(join(this.shareDir, 'provision', 'license-out', 'licenses'), { recursive: true });
            await writeFile(join(this.shareDir, 'provision', 'license-out', 'licenses', 'license.txt'), this.licenseText);
            return { ...base, stdout: 'MIXFPGA_LICENSE_OK\n' };
        }
        if (s.includes('rm -rf "$d"')) return (this.cleaned++, (this.installed = false), base);
        if (s.includes('--accept_eula')) {
            this.installs++;
            const names = await readdir(this.installersDir).catch(() => [] as string[]);
            if (names.length < 2) return { ...base, exitCode: 1, stderr: 'installer files not found' };
            if (this.installFails) return { ...base, exitCode: 1, stderr: 'installer: out of space' };
            this.installed = true;
            return base;
        }
        if (s.includes('test -x') && s.includes('MISSING_')) return { ...base, stdout: this.missingTools.map((t) => `MISSING_${t}\n`).join('') };
        if (s.includes('verify-device.tcl')) return { ...base, stdout: `MIXFPGA_FAMILY=${this.family ? 1 : 0}\nMIXFPGA_DEVICE=${this.device ? 1 : 0}\n` };
        if (s.includes('MIXFPGA_SMOKE_OK')) return this.smokeFails ? { ...base, exitCode: 1, stderr: 'Error (12006): Node instance cannot be resolved' } : { ...base, stdout: 'MIXFPGA_SMOKE_OK\n' };
        return base;
    }
}

interface Rig {
    layout: RuntimeLayout;
    q: FakeEngine;
    inst: QuartusInstaller;
    engine: SetupEngine;
    spec: QuartusSpec;
    downloads: string;
    input: QuartusInput;
    offer: LicenseOffer;
    free: number;
    hook?: (p: string) => void;
}

async function rig(t: TestContext, prepared = true): Promise<Rig> {
    const dir = await mkdtemp(join('/tmp', 'mfq '));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const layout = resolveRuntimeLayout({ env: { MIXFPGA_HOME: join(dir, 'MIX-FPGA') } });
    await mkdir(layout.stateDir, { recursive: true });
    await mkdir(layout.shareDir, { recursive: true });
    const downloads = join(dir, 'Downloads');
    await mkdir(downloads);
    const installerBytes = Buffer.from('#!/bin/sh\nfake quartus installer'.repeat(50));
    const pkgBytes = Buffer.from('fake max10 package'.repeat(80));
    await writeFile(join(downloads, QUARTUS_SPEC.installer.name), installerBytes);
    await writeFile(join(downloads, QUARTUS_SPEC.devicePackage.name), pkgBytes);
    const licenseBytes = Buffer.from('QUARTUS PRIME AND INTEL FPGA IP LICENSE AGREEMENT (test text)\n');
    const spec: QuartusSpec = { ...QUARTUS_SPEC, license: { ...QUARTUS_SPEC.license, sha256: sha(licenseBytes), bytes: licenseBytes.length }, installer: { name: QUARTUS_SPEC.installer.name, sha256: sha(installerBytes), bytes: installerBytes.length }, devicePackage: { name: QUARTUS_SPEC.devicePackage.name, sha256: sha(pkgBytes), bytes: pkgBytes.length } };
    const q = new FakeEngine(installedDe10Paths(layout).limactl, layout.installersDir, layout.shareDir);
    const offer: LicenseOffer = { product: spec.product, version: spec.banner, title: spec.license.title, text: licenseBytes.toString(), sha256: sha(licenseBytes), bytes: licenseBytes.length, source: spec.license.source, installerSha256: spec.installer.sha256, references: spec.license.references, statement: ACCEPT_STATEMENT };
    const files = { installerPath: join(downloads, spec.installer.name), devicePackagePath: join(downloads, spec.devicePackage.name) };
    const r: Rig = { layout, q, spec, downloads, free: 1e12, offer, input: { ...files, eula: acceptanceFor(offer, new Date('2026-10-14T12:00:00.000Z')) }, inst: undefined as never, engine: undefined as never };
    const inst = new QuartusInstaller({ layout, runner: q, freeBytes: async () => r.free, spec, hook: (p) => r.hook?.(p) });
    // By default the licence has already been offered on this Mac (tests of the offer itself pass `prepared: false`).
    if (prepared) await inst.record.merge({ licenseOffered: { sha256: offer.sha256, installerSha256: spec.installer.sha256, offeredAt: 'earlier' } });
    const stub = (id: string): ComponentDefinition => ({ id, label: id, inspect: async () => ({ state: 'ready', ownership: 'managed' }) });
    return Object.assign(r, { inst, engine: new SetupEngine([stub('linux-vm'), ...inst.definitions()], new InstallStateStore(layout.installStateFile, layout.lockFile)) });
}

const states = async (r: Rig) => Object.fromEntries((await r.engine.inspectAll()).map((s) => [s.id, s.state]));
const hashDir = async (d: string) => Object.fromEntries(await Promise.all((await readdir(d)).map(async (n) => [n, [sha(await readFile(join(d, n))), (await stat(join(d, n))).mtimeMs]])));

describe('guided Quartus / MAX 10 installation', () => {
    it('is not installed on a fresh engine, and reads only its record (never starts the engine)', async (t) => {
        const r = await rig(t);
        r.q.vm = 'Stopped';
        assert.deepEqual(await states(r), { 'linux-vm': 'ready', quartus: 'not-installed', max10: 'not-installed' });
        assert.deepEqual(r.q.calls, []);
    });

    it('waits for the student: no files and no acceptance means nothing runs', async (t) => {
        const r = await rig(t);
        const run = await r.engine.run();
        assert.deepEqual(run.steps, [{ id: 'quartus', outcome: 'awaiting-input', needs: 'files' }]);
        assert.deepEqual(r.q.calls, []);
    });

    it('requires an explicit acceptance: without it the installer is never told to accept Altera\'s licence', async (t) => {
        const r = await rig(t);
        const e = r.input.eula;
        const variants = [{ ...r.input, eula: { ...e, accepted: false } }, { ...r.input, eula: { ...e, statement: 'I agree' } }, { ...r.input, eula: { ...e, licenseSha256: '0'.repeat(64) } }, { ...r.input, eula: { ...e, installerSha256: '0'.repeat(64) } }, { ...r.input, eula: { ...e, product: 'Something else' } }, { installerPath: r.input.installerPath }];
        for (const bad of variants) {
            const out = await r.inst.install({ input: bad, progress: () => undefined });
            assert.equal(out.ok === false && out.code, 'INPUT_REQUIRED');
        }
        assert.deepEqual(r.q.guest.filter((s) => s.includes('accept_eula')), []);
        assert.deepEqual(r.q.calls, []);
    });

    it('rejects wrong, swapped, damaged and missing files before copying anything, and never alters the downloads', async (t) => {
        const r = await rig(t);
        const before = await hashDir(r.downloads);
        const code = async (input: QuartusInput) => {
            const o = await r.inst.install({ input, progress: () => undefined });
            return o.ok ? 'ok' : o.code;
        };
        assert.equal(await code({ ...r.input, installerPath: r.input.devicePackagePath, devicePackagePath: r.input.installerPath }), 'FILES_SWAPPED');
        await writeFile(join(r.downloads, 'other.run'), 'something else entirely');
        assert.equal(await code({ ...r.input, installerPath: join(r.downloads, 'other.run') }), 'WRONG_FILE');
        const damaged = Buffer.from(await readFile(r.input.installerPath));
        damaged[10] ^= 0xff;
        await writeFile(join(r.downloads, 'damaged.run'), damaged);
        assert.equal(await code({ ...r.input, installerPath: join(r.downloads, 'damaged.run') }), 'FILE_HASH_MISMATCH');
        assert.equal(await code({ ...r.input, devicePackagePath: join(r.downloads, 'nope.qdz') }), 'FILE_NOT_FOUND');
        assert.equal(await stat(r.layout.installersDir).then(() => true, () => false), false, 'nothing copied');
        assert.deepEqual(r.q.guest, []);
        const after = await hashDir(r.downloads);
        for (const [n, v] of Object.entries(before)) assert.deepEqual(after[n], v, `${n} untouched`);
    });

    it('a file with the right name but the wrong content is not accepted; the name alone proves nothing', async (t) => {
        const r = await rig(t);
        const fake = join(r.downloads, 'sub');
        await mkdir(fake);
        await writeFile(join(fake, r.spec.installer.name), 'x'.repeat(r.spec.installer.bytes));
        const c = await checkAlteraFile(join(fake, r.spec.installer.name), 'installer', r.spec);
        assert.equal(c.ok === false && c.code, 'FILE_HASH_MISMATCH');
        await writeFile(join(fake, r.spec.installer.name), 'short');
        assert.equal((await checkAlteraFile(join(fake, r.spec.installer.name), 'installer', r.spec) as { code: string }).code, 'FILE_DIFFERENT_VERSION');
    });

    it('installs: records the acceptance first, then runs the exact unattended command, verifies, removes only its own copies', async (t) => {
        const r = await rig(t);
        r.q.vm = 'Stopped';
        const order: string[] = [];
        r.hook = async (p) => {
            if (p === 'before-install') order.push(`acceptance recorded: ${(await r.inst.record.read()).eula?.accepted === true}`);
        };
        const before = await hashDir(r.downloads);
        const run = await r.engine.run({ inputs: { quartus: r.input } });
        assert.equal(run.outcome, 'complete', JSON.stringify(run.steps));
        assert.deepEqual(order, ['acceptance recorded: true']);
        const accept = r.q.guest.filter((s) => s.includes('--accept_eula'));
        assert.equal(accept.length, 1);
        assert.equal(accept[0], installerCommand(r.spec));
        assert.match(accept[0]!, /--mode unattended --unattendedmodeui minimal --accept_eula 1 --installdir \/opt\/mixfpga\/quartus\/25\.1std --disable-components quartus_help,arria_lite,cyclone,cyclone10lp,cyclonev,max,quartus_update,riscfree,questa_fse,questa_fe --create_desktop_shortcuts 0$/);
        assert.doesNotMatch(r.q.guest.join('\n'), /quartus --gui|quartus_gui|\bquartus\b\s*&/i);
        assert.deepEqual(await states(r), { 'linux-vm': 'ready', quartus: 'ready', max10: 'ready' });
        assert.equal(r.q.vm, 'Stopped', 'engine returned to the state it was in');
        assert.deepEqual(await readdir(r.layout.installersDir), [], 'temporary copies removed');
        assert.deepEqual(await hashDir(r.downloads), before, 'the downloads are exactly as they were');
        const rec = await r.inst.record.read();
        assert.equal(rec.eula?.statement, ACCEPT_STATEMENT);
        assert.deepEqual([rec.eula?.product, rec.eula?.version, rec.eula?.installerSha256, rec.eula?.licenseSha256], [r.spec.product, r.spec.banner, r.spec.installer.sha256, r.offer.sha256]);
        assert.match(rec.eula?.licenseSource ?? '', /--install_lic/);
        assert.equal(rec.eula?.referenceUrls[0], 'https://www.altera.com/support/support-resources/licensing/q-and-a');
        assert.equal(rec.eula?.acceptedAt, '2026-10-14T12:00:00.000Z');
        assert.equal(rec.device, '10M50DAF484C7G');
        assert.ok((await r.inst.vmRecord.read()).quartusInstalledAt);
    });

    it('verifies the build, the tools, the MAX 10 package, the device and a real design before calling it ready', async (t) => {
        const cases: [string, (q: FakeEngine) => void][] = [
            ['VERSION_MISMATCH', (q) => (q.installedBanner = 'Version 24.1std.0 Build 1000\n')],
            ['TOOLS_MISSING', (q) => (q.missingTools = ['quartus_fit', 'quartus_cpf'])],
            ['MAX10_MISSING', (q) => (q.family = false)],
            ['DEVICE_MISSING', (q) => (q.device = false)],
            ['SMOKE_TEST_FAILED', (q) => (q.smokeFails = true)],
        ];
        for (const [code, tweak] of cases) {
            const r = await rig(t);
            tweak(r.q);
            const run = await r.engine.run({ inputs: { quartus: r.input } });
            assert.equal(run.steps[0]!.code, code);
            assert.notEqual((await states(r)).quartus, 'ready', code);
            assert.equal((await r.inst.record.read()).verifiedAt, undefined);
        }
    });

    it('the smoke test targets the DE10-Lite device and uses the Quartus command-line tools only', async (t) => {
        const r = await rig(t);
        await r.engine.run({ inputs: { quartus: r.input } });
        const smoke = r.q.guest.find((s) => s.includes('MIXFPGA_SMOKE_OK'))!;
        assert.match(smoke, /DEVICE 10M50DAF484C7G/);
        assert.match(smoke, /mixfpga-q quartus_map smoke.*mixfpga-q quartus_fit smoke.*mixfpga-q quartus_asm smoke/);
        assert.match(smoke, /rm -rf \$HOME\/\.mixfpga-smoke/);
        const dev = r.q.guest.find((g) => g.includes('verify-device.tcl'))!;
        assert.match(dev, /get_part_list/);
        assert.equal(await stat(join(r.layout.shareDir, 'provision', 'verify-device.tcl')).then(() => true, () => false), false, 'nothing is written to the shared folder for the device check');
    });

    it('an interrupted install is reported as partial, and the next run cleans it, reuses the verified copies and finishes', async (t) => {
        const r = await rig(t);
        r.q.installFails = true;
        const first = await r.engine.run({ inputs: { quartus: r.input } });
        assert.equal(first.steps[0]!.code, 'QUARTUS_INSTALL_FAILED');
        assert.equal((await states(r)).quartus, 'failed');
        assert.equal((await readdir(r.layout.installersDir)).length, 2, 'copies kept for the retry');
        r.q.installFails = false;
        const second = await r.engine.run({ inputs: { quartus: r.input } });
        assert.equal(second.outcome, 'complete');
        assert.equal(r.q.cleaned, 1, 'the unfinished install folder was removed once, before retrying');
        assert.equal(r.q.installs, 2);
        assert.deepEqual(await readdir(r.layout.installersDir), []);
    });

    it('a crash mid-install leaves a partial record: repairable, not "installed"', async (t) => {
        const r = await rig(t);
        r.hook = (p) => {
            if (p === 'after-install') throw new Error('power cut');
        };
        const run = await r.engine.run({ inputs: { quartus: r.input } });
        assert.equal(run.steps[0]!.code, 'UNEXPECTED_ERROR');
        const rec = await r.inst.record.read();
        assert.ok(rec.installAttemptAt && !rec.verifiedAt);
        const s = (await r.engine.inspectAll()).find((x) => x.id === 'quartus')!;
        assert.notEqual(s.state, 'ready');
    });

    it('never reinstalls over a working Quartus of the right build: it only verifies it', async (t) => {
        const r = await rig(t);
        r.q.installed = true;
        const run = await r.engine.run({ inputs: { quartus: r.input } });
        assert.equal(run.outcome, 'complete');
        assert.equal(r.q.installs, 0);
        assert.equal(r.q.cleaned, 0);
        assert.equal((await states(r)).quartus, 'ready');
    });

    it('checks disk space first and reports it plainly', async (t) => {
        const r = await rig(t);
        r.free = 3e9;
        const run = await r.engine.run({ inputs: { quartus: r.input } });
        assert.equal(run.steps[0]!.code, 'INSUFFICIENT_DISK');
        assert.match(run.steps[0]!.message!, /14 GB free/);
        assert.equal(await stat(r.layout.installersDir).then(() => true, () => false), false);
    });

    it('stays ready after the student deletes the Altera files, and Setup reopened does nothing', async (t) => {
        const r = await rig(t);
        await r.engine.run({ inputs: { quartus: r.input } });
        await rm(r.downloads, { recursive: true });
        r.q.calls.length = 0;
        const again = await r.engine.run();
        assert.deepEqual([again.outcome, again.steps], ['complete', []]);
        assert.deepEqual(r.q.calls, []);
    });

    it('needs no internet: nothing in the Quartus installer touches the network', async () => {
        const src = await readFile(join(__dirname, '..', '..', 'platform', 'macos', 'install', 'quartus-install.js'), 'utf8');
        assert.doesNotMatch(src, /fetch\(|node:https?|node:net|downloader/);
    });

    it('the pinned hashes are those of Altera\'s real files (checked read-only, only if present on this Mac)', async (t) => {
        const real = join(homedir(), 'Library', 'MIX-FPGA', 'staging', 'vendor');
        const have = await Promise.all([QUARTUS_SPEC.installer.name, QUARTUS_SPEC.devicePackage.name].map((n) => stat(join(real, n)).then(() => true, () => false)));
        if (!have.every(Boolean)) return t.skip('Altera files not present');
        assert.deepEqual(await checkAlteraFile(join(real, QUARTUS_SPEC.installer.name), 'installer'), { ok: true });
        assert.deepEqual(await checkAlteraFile(join(real, QUARTUS_SPEC.devicePackage.name), 'devicePackage'), { ok: true });
        const wrong = await checkAlteraFile(join(real, QUARTUS_SPEC.installer.name), 'devicePackage');
        assert.equal(wrong.ok === false && wrong.code, 'FILES_SWAPPED');
    });
});

describe('the Altera licence: shown from the vendor\'s own file, accepted explicitly', () => {
    const files = (r: Rig) => ({ installerPath: r.input.installerPath, devicePackagePath: r.input.devicePackagePath });

    it('asks the installer for its own licence files, installs nothing, and offers the unchanged text with its hash', async (t) => {
        const r = await rig(t, false);
        r.q.vm = 'Stopped';
        const out = await r.inst.prepareLicense(files(r));
        assert.equal(out.ok, true, JSON.stringify(out));
        if (!out.ok) return;
        assert.equal(out.offer.text, r.q.licenseText);
        assert.equal(out.offer.sha256, r.spec.license.sha256);
        assert.equal(out.offer.statement, 'I have reviewed and accept the Altera Quartus Prime Software License Agreement.');
        assert.equal(out.offer.references[0]!.url, 'https://www.altera.com/support/support-resources/licensing/q-and-a');
        const lic = r.q.guest.find((g) => g.includes('--install_lic'))!;
        assert.match(lic, /--mode text --install_lic "\$d"/);
        assert.doesNotMatch(lic, /accept_eula|--mode unattended/);
        assert.equal(r.q.installs, 0);
        assert.equal(r.q.vm, 'Stopped', 'the engine is put back as it was');
        assert.equal((await r.inst.record.read()).licenseOffered?.sha256, r.spec.license.sha256);
        assert.equal(await readFile(join(r.layout.stateDir, 'quartus-license.txt'), 'utf8'), r.q.licenseText);
        assert.equal(await stat(join(r.layout.shareDir, 'provision', 'license-out')).then(() => true, () => false), false, 'scratch output removed');
    });

    it('stops rather than guessing when the installer\'s licence is not the one verified for this build', async (t) => {
        const r = await rig(t, false);
        r.q.licenseText = 'A DIFFERENT AGREEMENT\n';
        const out = await r.inst.prepareLicense(files(r));
        assert.equal(out.ok === false && out.code, 'LICENSE_UNVERIFIED');
        assert.equal((await r.inst.record.read()).licenseOffered, undefined);
        // And nothing can then be accepted or installed.
        const run = await r.inst.install({ input: r.input, progress: () => undefined });
        assert.equal(run.ok === false && run.code, 'LICENSE_NOT_SHOWN');
        assert.deepEqual(r.q.guest.filter((g) => g.includes('--accept_eula')), []);
    });

    it('stops when the installer provides no licence at all', async (t) => {
        const r = await rig(t, false);
        r.q.licenseMissing = true;
        const out = await r.inst.prepareLicense(files(r));
        assert.equal(out.ok === false && out.code, 'LICENSE_NOT_AVAILABLE');
        assert.equal(r.q.installs, 0);
    });

    it('does not even look for a licence in a file that is not Altera\'s', async (t) => {
        const r = await rig(t, false);
        await writeFile(join(r.downloads, 'other.run'), 'not the installer');
        const out = await r.inst.prepareLicense({ ...files(r), installerPath: join(r.downloads, 'other.run') });
        assert.equal(out.ok === false && out.code, 'WRONG_FILE');
        assert.deepEqual(r.q.guest, []);
    });

    it('an acceptance cannot be used before the licence was shown on this computer, nor for a different licence', async (t) => {
        const r = await rig(t, false);
        const early = await r.inst.install({ input: r.input, progress: () => undefined });
        assert.equal(early.ok === false && early.code, 'LICENSE_NOT_SHOWN');
        await r.inst.record.merge({ licenseOffered: { sha256: '1'.repeat(64), installerSha256: r.spec.installer.sha256, offeredAt: 'x' } });
        const other = await r.inst.install({ input: r.input, progress: () => undefined });
        assert.equal(other.ok === false && other.code, 'LICENSE_NOT_SHOWN');
        assert.deepEqual(r.q.guest.filter((g) => g.includes('--accept_eula')), []);
    });

    it('full path: offer, tick the box, install; the record says exactly what was accepted and when, before the command ran', async (t) => {
        const r = await rig(t, false);
        const out = await r.inst.prepareLicense(files(r));
        assert.ok(out.ok);
        if (!out.ok) return;
        const input: QuartusInput = { ...files(r), eula: acceptanceFor(out.offer, new Date('2026-10-14T15:30:00.000Z')) };
        let atCommand: string | undefined;
        r.hook = async (p) => {
            if (p === 'before-install') atCommand = JSON.stringify((await r.inst.record.read()).eula);
        };
        const run = await r.engine.run({ inputs: { quartus: input } });
        assert.equal(run.outcome, 'complete', JSON.stringify(run.steps));
        const eula = JSON.parse(atCommand!) as Record<string, unknown>;
        const { referenceUrls, ...recorded } = eula;
        assert.deepEqual(referenceUrls, ['https://www.altera.com/support/support-resources/licensing/q-and-a']);
        assert.deepEqual(
            recorded,
            { accepted: true, acceptedAt: '2026-10-14T15:30:00.000Z', statement: ACCEPT_STATEMENT, product: 'Quartus Prime Lite Edition', version: '25.1std.0 Build 1129', installerSha256: r.spec.installer.sha256, licenseSource: r.spec.license.source, licenseSha256: r.spec.license.sha256 },
        );
        assert.equal(r.q.guest.filter((g) => g.includes('--accept_eula 1')).length, 1);
        assert.deepEqual(await readdir(r.layout.installersDir), []);
    });
});
