import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { NodeToolRunner } from '../../core/process/tool-runner';
import { ElevatedHelper, HELPER_SCRIPT, helperScriptSha256, psQuote } from '../../platform/windows/install/elevation';
import { ONLY_WINDOWS } from '../platform';
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { TestContext } from 'node:test';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const LICENSE = 'FAKE ALTERA LICENCE\r\nline two\r\n';

describe('the one elevated helper: command line and script', () => {
    const params = (dir: string) => ({ installers: join(dir, 'inst'), installerName: 'Q.exe', installerSha256: 'a'.repeat(64), packageName: 'p.qdz', packageSha256: 'b'.repeat(64), installDir: "C:\\intelFPGA_lite\\25.1std", disabledComponents: 'x,y', licenseSha256: 'c'.repeat(64) });

    it('asks Windows for permission once, runs only the script whose hash it checked first, and passes no acceptance on the command line', () => {
        const h = new ElevatedHelper({ runner: new NodeToolRunner(), dir: "C:\\Users\\O'Brien\\MIX-FPGA\\state\\helper", params: params('C:\\x'), parentPid: 4242 });
        const c = h.launchCommand();
        assert.equal(c.executable, 'powershell.exe');
        const text = c.args.join(' ');
        assert.match(text, /Start-Process -FilePath powershell\.exe -Verb RunAs -WindowStyle Hidden/);
        assert.ok(text.includes(helperScriptSha256()), 'the script hash is checked before it runs');
        assert.match(text, /exit 90/);
        assert.doesNotMatch(text, /accept_eula/i, 'acceptance never travels on a command line');
        assert.match(text, /-ParentPid 4242/);
        // An apostrophe in a user name is escaped, not left to end the string early.
        assert.ok(text.includes("O''''Brien") || text.includes("O''Brien"), text);
    });

    it('--accept_eula appears only inside the install operation, behind the recorded-acceptance check', () => {
        const occurrences = HELPER_SCRIPT.split('--accept_eula').length - 1;
        assert.equal(occurrences, 1, 'one place in the whole script');
        const install = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf("elseif ($r.op -eq 'install')"));
        assert.match(install, /'--accept_eula', '1'/);
        assert.ok(install.indexOf("accepted.json") < install.indexOf("'--accept_eula'"));
        assert.ok(install.indexOf('Check-Files') < install.indexOf("'--accept_eula'"));
        const license = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf("elseif ($r.op -eq 'license')"), HELPER_SCRIPT.indexOf("elseif ($r.op -eq 'install')"));
        assert.doesNotMatch(license, /accept_eula/);
        assert.match(license, /--install_lic/);
    });

    it('offers no operation other than license, install and quit, and never touches drivers or settings', () => {
        const ops = [...HELPER_SCRIPT.matchAll(/\$r\.op -eq '(\w+)'/g)].map((m) => m[1]);
        assert.deepEqual(ops, ['quit', 'license', 'install']);
        assert.doesNotMatch(HELPER_SCRIPT, /pnputil|devcon|Set-ItemProperty|reg add|netsh|sc\.exe|Add-WindowsDriver|Invoke-WebRequest|DownloadFile|Start-BitsTransfer/i);
    });

    it('psQuote doubles apostrophes', () => {
        assert.equal(psQuote("a'b"), "'a''b'");
    });
});

/** A "Quartus installer" that records how it was called and behaves like Altera's for the two operations MIX-FPGA uses. */
async function fakeInstallerFolder(t: TestContext) {
    const dir = await mkdtemp(join(tmpdir(), 'mfe '));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const inst = join(dir, 'inst');
    await mkdir(inst);
    const cmd = [
        '@echo off',
        'setlocal EnableDelayedExpansion',
        'set HERE=%~dp0',
        'set ALLARGS=%*',
        'set LICDIR=',
        'set ACCEPT=',
        ':loop',
        'if "%~1"=="" goto done',
        'if "%~1"=="--install_lic" set LICDIR=%~2',
        'if "%~1"=="--accept_eula" set ACCEPT=%~2',
        'shift',
        'goto loop',
        ':done',
        'echo %ALLARGS% >> "!HERE!calls.txt"',
        'if defined LICDIR (mkdir "!LICDIR!\\licenses" 2>nul & copy /y "!HERE!license-source.txt" "!LICDIR!\\licenses\\license.txt" >nul & exit /b 0)',
        'if "!ACCEPT!"=="1" (echo installed> "!HERE!installed.marker" & exit /b 0)',
        'echo refused: licence not accepted>&2',
        'exit /b 7',
        '',
    ].join('\r\n');
    await writeFile(join(inst, 'Q.cmd'), cmd);
    await writeFile(join(inst, 'license-source.txt'), LICENSE);
    await writeFile(join(inst, 'p.qdz'), 'package bytes');
    return { dir, inst };
}

/** The real helper script, started WITHOUT elevation (the script is the same; only the prompt is skipped) through the real client. */
class UnelevatedHelper extends ElevatedHelper {
    override launchCommand(): { executable: string; args: string[] } {
        const c = super.launchCommand();
        return { ...c, args: c.args.map((a) => a.replace(' -Verb RunAs', '')) };
    }
}

describe('the real helper script, run for real (without the permission prompt)', () => {
    async function helperFor(t: TestContext, over: { installerSha?: string } = {}) {
        const f = await fakeInstallerFolder(t);
        const installerSha = over.installerSha ?? sha(await readFile(join(f.inst, 'Q.cmd')));
        const h = new UnelevatedHelper({
            runner: new NodeToolRunner(),
            dir: join(f.dir, 'ctl'),
            params: { installers: f.inst, installerName: 'Q.cmd', installerSha256: installerSha, packageName: 'p.qdz', packageSha256: sha('package bytes'), installDir: join(f.dir, 'quartus'), disabledComponents: 'a,b', licenseSha256: sha(LICENSE) },
            readyTimeoutMs: 60_000,
            pollMs: 100,
        });
        t.after(async () => {
            await h.stop().catch(() => undefined);
        });
        return { ...f, h };
    }

    it('starts, hands over the installer\'s licence without installing, and refuses to install before an acceptance is recorded', { skip: ONLY_WINDOWS }, async (t) => {
        const { h, inst } = await helperFor(t);
        const started = await h.start();
        assert.deepEqual(started, { ok: true });
        const lic = await h.request('license', 60_000);
        assert.ok('exitCode' in lic && lic.ok, JSON.stringify(lic));
        assert.equal((await readFile(h.licenseFile, 'utf8')), LICENSE, 'the vendor file, byte for byte');
        assert.equal(await stat(join(inst, 'installed.marker')).then(() => true, () => false), false, 'asking for the licence installs nothing');
        const calls1 = await readFile(join(inst, 'calls.txt'), 'utf8');
        assert.doesNotMatch(calls1, /accept_eula/);
        // No acceptance on record: the install request is refused and the installer is not run again.
        const refused = await h.request('install', 60_000);
        assert.ok('exitCode' in refused && !refused.ok && refused.exitCode === 5, JSON.stringify(refused));
        assert.equal((await readFile(join(inst, 'calls.txt'), 'utf8')), calls1);
        assert.equal(await stat(join(inst, 'installed.marker')).then(() => true, () => false), false);
    });

    it('installs only after the acceptance of exactly this licence is recorded, and then passes --accept_eula 1', { skip: ONLY_WINDOWS }, async (t) => {
        const { h, inst } = await helperFor(t);
        assert.deepEqual(await h.start(), { ok: true });
        await h.recordAcceptance({ licenseSha256: 'd'.repeat(64), installerSha256: 'e'.repeat(64), acceptedAt: new Date().toISOString() });
        const wrong = await h.request('install', 60_000);
        assert.ok('exitCode' in wrong && !wrong.ok && wrong.exitCode === 5, 'an acceptance of some other licence does not count');
        assert.equal(await stat(join(inst, 'installed.marker')).then(() => true, () => false), false);
        await h.recordAcceptance({ licenseSha256: sha(LICENSE), installerSha256: sha(await readFile(join(inst, 'Q.cmd'))), acceptedAt: new Date().toISOString() });
        const ok = await h.request('install', 60_000);
        assert.ok('exitCode' in ok && ok.ok, JSON.stringify(ok));
        assert.ok((await stat(join(inst, 'installed.marker'))).isFile());
        const calls = await readFile(join(inst, 'calls.txt'), 'utf8');
        assert.match(calls, /--accept_eula 1/);
        assert.match(calls, /--installdir/);
        assert.match(calls, /--create_desktop_shortcuts 0/);
        assert.match(calls, /--disable-components a,b/);
    });

    it('refuses to run an installer whose bytes changed after they were verified', { skip: ONLY_WINDOWS }, async (t) => {
        const { h, inst } = await helperFor(t, { installerSha: 'f'.repeat(64) });
        assert.deepEqual(await h.start(), { ok: true });
        const r = await h.request('license', 60_000);
        assert.ok('exitCode' in r && !r.ok && r.exitCode === 3 && /changed Q\.cmd/.test(r.message), JSON.stringify(r));
        assert.equal(await stat(join(inst, 'calls.txt')).then(() => true, () => false), false, 'the installer was not run');
    });

    it('ends when asked, and a stopped helper leaves nothing running', { skip: ONLY_WINDOWS }, async (t) => {
        const { h, dir } = await helperFor(t);
        assert.deepEqual(await h.start(), { ok: true });
        const pid = Number((await readFile(join(dir, 'ctl', 'ready'), 'utf8')).trim());
        assert.ok(pid > 0);
        await h.stop();
        await new Promise((r) => setTimeout(r, 1500));
        const alive = await new Promise<boolean>((resolve) => {
            const p = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/NH']);
            let out = '';
            p.stdout.on('data', (d) => (out += d));
            p.on('close', () => resolve(out.includes(String(pid))));
        });
        assert.equal(alive, false);
    });

    it('a refused permission prompt is reported as such (no helper, no files)', async (t) => {
        const declined = { run: async () => ({ invocation: { executable: '', args: [] }, outcome: 'exited' as const, exitCode: 1, stdout: '', stderr: 'Start-Process : This command cannot be run due to the error: The operation was canceled by the user.', durationMs: 1 }) };
        const dir = await mkdtemp(join(tmpdir(), 'mfe '));
        t.after(() => rm(dir, { recursive: true, force: true }));
        const h = new ElevatedHelper({ runner: declined, dir: join(dir, 'ctl'), params: { installers: '', installerName: '', installerSha256: '', packageName: '', packageSha256: '', installDir: '', disabledComponents: '', licenseSha256: '' } });
        const r = await h.start();
        assert.ok(!r.ok && r.code === 'ELEVATION_DECLINED');
        assert.equal(h.running, false);
    });
});
