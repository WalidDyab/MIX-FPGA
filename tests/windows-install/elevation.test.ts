import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { NodeToolRunner } from '../../core/process/tool-runner';
import { ElevatedHelper, type HelperParameters, helperScript, psQuote } from '../../platform/windows/install/elevation';
import { ONLY_WINDOWS } from '../platform';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const LICENSE = 'FAKE ALTERA LICENCE\r\nline two\r\n';
const exists = (p: string) => stat(p).then(() => true, () => false);

const pins = (over: Partial<HelperParameters> = {}): HelperParameters => ({ installers: 'C:\\x\\inst', installerName: 'Q.exe', installerSha256: 'a'.repeat(64), packageName: 'p.qdz', packageSha256: 'b'.repeat(64), installDir: 'C:\\intelFPGA_lite\\25.1std', disabledComponents: 'x,y', licenseSha256: 'c'.repeat(64), ...over });
const scriptOf = (over: Partial<HelperParameters> = {}) => helperScript(pins(over), { control: 'C:\\Users\\O\'Brien\\MIX-FPGA\\state\\helper', installers: pins(over).installers, parentPid: 4242 });

describe('the one elevated helper: command line and script', () => {
    it('asks Windows for permission once, runs a script that is not a file, and passes no acceptance on the command line', () => {
        const h = new ElevatedHelper({ runner: new NodeToolRunner(), dir: "C:\\Users\\O'Brien\\MIX-FPGA\\state\\helper", params: pins(), parentPid: 4242 });
        const c = h.launchCommand();
        assert.equal(c.executable, 'powershell.exe');
        const text = c.args.join(' ');
        assert.match(text, /Start-Process -FilePath powershell\.exe -Verb RunAs -WindowStyle Hidden/);
        assert.match(text, /'-EncodedCommand','[A-Za-z0-9+/=]+'/, 'the code travels inside the elevated process\'s own command line');
        assert.doesNotMatch(text, /helper\.ps1|-File\b/i, 'no script file that a normal process could change between the prompt and its execution');
        assert.doesNotMatch(text, /accept_eula/i, 'acceptance never travels in clear on a command line');
        assert.ok(text.length < 30_000, `the command line (${text.length} characters) stays below the Windows limit`);
        const decoded = Buffer.from(/-EncodedCommand','([^']+)'/.exec(text)![1]!, 'base64').toString('utf16le');
        assert.equal(decoded, h.script());
        assert.match(decoded, /\$ParentPid = 4242/);
        assert.ok(decoded.includes("O''Brien"), 'an apostrophe in a user name is escaped, not left to end the string early');
        assert.ok(decoded.includes(`$InstallerSha256 = '${'a'.repeat(64)}'`), 'the pinned hash is part of the script');
        assert.doesNotMatch(decoded, /[^\x00-\x7f]/, 'PowerShell 5.1 safe: ASCII only');
        assert.doesNotMatch(decoded, /`|\$\{/, 'no back-tick or dollar-brace (they confuse the encoded text)');
    });

    it('--accept_eula appears only inside the install operation, behind the recorded-acceptance check and the staged-copy hash check', () => {
        const s = scriptOf();
        assert.equal(s.split('--accept_eula').length - 1, 1, 'one place in the whole script');
        const install = s.slice(s.indexOf("elseif ($r.op -eq 'install')"));
        assert.match(install, /'--accept_eula', '1'/);
        assert.ok(install.indexOf('accepted.json') < install.indexOf("'--accept_eula'"));
        assert.ok(install.indexOf('Stage-Files') < install.indexOf("'--accept_eula'"));
        const license = s.slice(s.indexOf("elseif ($r.op -eq 'license')"), s.indexOf("elseif ($r.op -eq 'install')"));
        assert.doesNotMatch(license, /accept_eula/);
        assert.match(license, /--install_lic/);
    });

    it('offers no operation other than license, install and quit, and never touches drivers, settings or the network', () => {
        const s = scriptOf();
        const ops = [...s.matchAll(/\$r\.op -eq '(\w+)'/g)].map((m) => m[1]);
        assert.deepEqual(ops, ['quit', 'license', 'install']);
        assert.doesNotMatch(s, /pnputil|devcon|Set-ItemProperty|reg add|reg\.exe|netsh|sc\.exe|Add-WindowsDriver|Invoke-WebRequest|DownloadFile|DownloadString|Start-BitsTransfer|Invoke-Expression|\biex\b|Invoke-Command|New-Service|schtasks|bcdedit|Set-ExecutionPolicy|Add-MpPreference|Set-MpPreference/i);
        // The only program the script starts is the installer from its own protected folder, plus icacls to protect that folder.
        assert.deepEqual([...s.matchAll(/Start-Process -FilePath (\$\w+)/g)].map((m) => m[1]), ['$exe', '$exe']);
        assert.deepEqual([...s.matchAll(/& (\w+\.exe)/g)].map((m) => m[1]), ['icacls.exe']);
    });

    it('stages the vendor files in a folder only SYSTEM and Administrators can write to, and hashes and runs them there', () => {
        const s = scriptOf();
        assert.match(s, /icacls\.exe \$Stage \/inheritance:r \/grant:r \$grant/);
        assert.match(s, /'\*S-1-5-18:\(OI\)\(CI\)F', '\*S-1-5-32-544:\(OI\)\(CI\)F'/, 'SYSTEM and Administrators by SID, not by (localised) name');
        assert.match(s, /\$StageRoot = \(Join-Path \$env:SystemRoot 'Temp'\)/, 'the staging root is not under the student\'s profile or ProgramData');
        assert.match(s, /\[guid\]::NewGuid\(\)/, 'unguessable folder name');
        const stage = s.slice(s.indexOf('function Stage-Files'), s.indexOf("Set-Content -LiteralPath (Join-Path $Control 'ready')"));
        assert.ok(stage.indexOf('Copy-Item') < stage.indexOf('Get-FileHash'), 'the copy is what gets hashed');
        assert.match(stage, /Get-FileHash -LiteralPath \$dst/);
        assert.doesNotMatch(s, /Start-Process -FilePath \(Join-Path \$Installers/);
        assert.doesNotMatch(s, /WorkingDirectory \$Installers/);
    });

    it('takes requests only through a strict pattern and checks its inputs and its control folder', () => {
        const s = scriptOf();
        assert.match(s, /\[string\]\$r\.id -notmatch '\^\\d\{3\}-\[0-9a-f\]\{6\}\$'/);
        assert.match(s, /ReparsePoint\) \{ exit 91 \}/);
        assert.match(s, /\$InstallDir -notmatch/);
        assert.match(s, /\$Disabled -notmatch/);
        assert.match(s, /finally \{ Clean-Stage \}/, 'the staging folder is removed however the helper ends');
    });

    it('psQuote doubles apostrophes', () => {
        assert.equal(psQuote("a'b"), "'a''b'");
    });
});

/**
 * A "Quartus installer" that records how it was called and behaves like Altera's for the two operations MIX-FPGA uses. It runs
 * from the helper's protected staging folder, so everything it reports goes to absolute paths in the test folder.
 */
async function fakeInstallerFolder(t: TestContext) {
    const dir = await mkdtemp(join(tmpdir(), 'mfe '));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const inst = join(dir, 'inst');
    await mkdir(inst);
    const out = join(dir, 'out');
    await mkdir(out);
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
        `echo !HERE! %ALLARGS% >> "${join(out, 'calls.txt')}"`,
        `if defined LICDIR (mkdir "!LICDIR!\\licenses" 2>nul & copy /y "${join(out, 'license-source.txt')}" "!LICDIR!\\licenses\\license.txt" >nul & exit /b 0)`,
        `if "!ACCEPT!"=="1" (echo installed> "${join(out, 'installed.marker')}" & exit /b 0)`,
        'echo refused: licence not accepted>&2',
        'exit /b 7',
        '',
    ].join('\r\n');
    await writeFile(join(inst, 'Q.cmd'), cmd);
    await writeFile(join(out, 'license-source.txt'), LICENSE);
    await writeFile(join(inst, 'p.qdz'), 'package bytes');
    return { dir, inst, out };
}

/** The real helper script, started WITHOUT elevation (the script is the same; only the prompt is skipped) through the real client. */
class UnelevatedHelper extends ElevatedHelper {
    override launchCommand(): { executable: string; args: string[] } {
        const c = super.launchCommand();
        return { ...c, args: c.args.map((a) => a.replace(' -Verb RunAs', '')) };
    }
}

describe('the real helper script, run for real (without the permission prompt)', () => {
    async function helperFor(t: TestContext, over: { installerSha?: string; installDir?: string; ready?: number } = {}) {
        const f = await fakeInstallerFolder(t);
        const stageRoot = join(f.dir, 'stage');
        await mkdir(stageRoot);
        const installerSha = over.installerSha ?? sha(await readFile(join(f.inst, 'Q.cmd')));
        const h = new UnelevatedHelper({
            runner: new NodeToolRunner(),
            dir: join(f.dir, 'ctl'),
            params: { installers: f.inst, installerName: 'Q.cmd', installerSha256: installerSha, packageName: 'p.qdz', packageSha256: sha('package bytes'), installDir: over.installDir ?? 'C:\\Fake Quartus\\25.1std', disabledComponents: 'a,b', licenseSha256: sha(LICENSE) },
            stageRoot,
            readyTimeoutMs: over.ready ?? 60_000,
            pollMs: 100,
        });
        t.after(async () => {
            await h.stop().catch(() => undefined);
        });
        return { ...f, h, stageRoot, installerSha };
    }

    it("starts, hands over the installer's licence without installing, and refuses to install before an acceptance is recorded", { skip: ONLY_WINDOWS }, async (t) => {
        const { h, out, stageRoot, inst } = await helperFor(t);
        const started = await h.start();
        assert.deepEqual(started, { ok: true });
        const lic = await h.request('license', 60_000);
        assert.ok('exitCode' in lic && lic.ok, JSON.stringify(lic));
        assert.equal(await readFile(h.licenseFile, 'utf8'), LICENSE, 'the vendor file, byte for byte');
        assert.equal(await exists(join(out, 'installed.marker')), false, 'asking for the licence installs nothing');
        const calls1 = await readFile(join(out, 'calls.txt'), 'utf8');
        assert.doesNotMatch(calls1, /accept_eula/);
        // The installer ran from the helper's own staging folder, not from the student-writable copy.
        assert.ok(calls1.toLowerCase().includes(stageRoot.toLowerCase()), calls1);
        assert.ok(!calls1.toLowerCase().includes(inst.toLowerCase()), calls1);
        // No acceptance on record: the install request is refused and the installer is not run again.
        const refused = await h.request('install', 60_000);
        assert.ok('exitCode' in refused && !refused.ok && refused.exitCode === 5, JSON.stringify(refused));
        assert.equal(await readFile(join(out, 'calls.txt'), 'utf8'), calls1);
        assert.equal(await exists(join(out, 'installed.marker')), false);
    });

    it('installs only after the acceptance of exactly this licence is recorded, and then passes --accept_eula 1; the staging folder is gone afterwards', { skip: ONLY_WINDOWS }, async (t) => {
        const { h, out, stageRoot, inst } = await helperFor(t);
        assert.deepEqual(await h.start(), { ok: true });
        await h.recordAcceptance({ licenseSha256: 'd'.repeat(64), installerSha256: 'e'.repeat(64), acceptedAt: new Date().toISOString() });
        const wrong = await h.request('install', 60_000);
        assert.ok('exitCode' in wrong && !wrong.ok && wrong.exitCode === 5, 'an acceptance of some other licence does not count');
        assert.equal(await exists(join(out, 'installed.marker')), false);
        await h.recordAcceptance({ licenseSha256: sha(LICENSE), installerSha256: sha(await readFile(join(inst, 'Q.cmd'))), acceptedAt: new Date().toISOString() });
        const ok = await h.request('install', 60_000);
        assert.ok('exitCode' in ok && ok.ok, JSON.stringify(ok));
        assert.ok((await stat(join(out, 'installed.marker'))).isFile());
        const calls = await readFile(join(out, 'calls.txt'), 'utf8');
        assert.match(calls, /--accept_eula 1/);
        assert.match(calls, /--installdir "C:\\Fake Quartus\\25\.1std"/);
        assert.match(calls, /--create_desktop_shortcuts 0/);
        assert.match(calls, /--disable-components a,b/);
        assert.deepEqual(await readdir(stageRoot), [], 'the protected copies are removed once the installer is done');
    });

    it('runs the verified staged copy: swapping the student-writable file after it was verified changes nothing', { skip: ONLY_WINDOWS }, async (t) => {
        const { h, inst, out } = await helperFor(t);
        assert.deepEqual(await h.start(), { ok: true });
        const lic = await h.request('license', 60_000);
        assert.ok('exitCode' in lic && lic.ok);
        const original = await readFile(join(inst, 'Q.cmd'));
        // A normal process replaces the source file with its own program between the licence and the installation.
        await writeFile(join(inst, 'Q.cmd'), `@echo off\r\necho EVIL> "${join(out, 'evil.marker')}"\r\nexit /b 0\r\n`);
        await h.recordAcceptance({ licenseSha256: sha(LICENSE), installerSha256: sha(original), acceptedAt: new Date().toISOString() });
        const r = await h.request('install', 60_000);
        assert.ok('exitCode' in r && r.ok, JSON.stringify(r));
        assert.equal(await exists(join(out, 'evil.marker')), false, 'the swapped file never ran');
        assert.ok((await stat(join(out, 'installed.marker'))).isFile(), 'the verified copy ran');
    });

    it('refuses to run an installer whose bytes differ from the pinned hash, and nothing is run', { skip: ONLY_WINDOWS }, async (t) => {
        const { h, out, stageRoot } = await helperFor(t, { installerSha: 'f'.repeat(64) });
        assert.deepEqual(await h.start(), { ok: true });
        const r = await h.request('license', 60_000);
        assert.ok('exitCode' in r && !r.ok && r.exitCode === 3 && /changed Q\.cmd/.test(r.message), JSON.stringify(r));
        assert.equal(await exists(join(out, 'calls.txt')), false, 'the installer was not run');
        await h.stop();
        assert.deepEqual(await readdir(stageRoot), [], 'the staging folder is removed when the helper ends');
    });

    it('ignores a request whose id could steer a file name, and still serves a good one', { skip: ONLY_WINDOWS }, async (t) => {
        const { h, dir, out } = await helperFor(t);
        assert.deepEqual(await h.start(), { ok: true });
        const escape = join(dir, 'escaped.json');
        await writeFile(join(dir, 'ctl', 'request-evil.json'), JSON.stringify({ id: '..\\escaped', op: 'license' }));
        await new Promise((r) => setTimeout(r, 1500));
        assert.equal(await exists(escape), false);
        assert.equal(await exists(join(dir, 'ctl', 'request-evil.json')), false, 'the malformed request was taken away');
        assert.equal(await exists(join(out, 'calls.txt')), false, 'nothing was run for it');
        const r = await h.request('license', 60_000);
        assert.ok('exitCode' in r && r.ok, JSON.stringify(r));
        const unknown = await h.request('format-c-drive' as unknown as 'quit', 8_000).catch(() => undefined);
        assert.ok(unknown && 'exitCode' in unknown && !unknown.ok && unknown.exitCode === 2, JSON.stringify(unknown));
    });

    it('does not start at all when a pinned value has the wrong shape (an install folder with a quote, a bad hash, a bad file name)', { skip: ONLY_WINDOWS }, async (t) => {
        for (const bad of [{ installDir: 'C:\\x" --evil' }, { installDir: 'C:\\a\\..\\b' }, { installDir: 'relative\\dir' }, { disabledComponents: 'a;calc' }, { installerSha256: 'zz' }, { installerName: '..\\Q.cmd' }]) {
            const f = await fakeInstallerFolder(t);
            const stageRoot = join(f.dir, 'stage');
            await mkdir(stageRoot);
            const h = new UnelevatedHelper({
                runner: new NodeToolRunner(),
                dir: join(f.dir, 'ctl'),
                params: { installers: f.inst, installerName: 'Q.cmd', installerSha256: sha(await readFile(join(f.inst, 'Q.cmd'))), packageName: 'p.qdz', packageSha256: sha('package bytes'), installDir: 'C:\\Fake\\25.1std', disabledComponents: 'a', licenseSha256: sha(LICENSE), ...bad },
                stageRoot,
                readyTimeoutMs: 6_000,
                pollMs: 100,
            });
            const r = await h.start();
            assert.ok(!r.ok && r.code === 'HELPER_TIMEOUT', `${JSON.stringify(bad)} -> ${JSON.stringify(r)}`);
            assert.equal(await exists(join(f.out, 'calls.txt')), false);
            await h.stop();
        }
    });

    it('the protected staging folder is already gone when the helper reports that it is quitting (no race), every time', { skip: ONLY_WINDOWS }, async (t) => {
        for (let i = 0; i < 4; i++) {
            const { h, stageRoot } = await helperFor(t);
            assert.deepEqual(await h.start(), { ok: true });
            const lic = await h.request('license', 60_000);
            assert.ok('exitCode' in lic && lic.ok, JSON.stringify(lic));
            assert.equal((await readdir(stageRoot)).length, 1, 'the files are staged while the helper works');
            const bye = await h.request('quit', 30_000);
            assert.ok('exitCode' in bye && bye.ok, JSON.stringify(bye));
            assert.deepEqual(await readdir(stageRoot), [], `round ${i}: gone before the answer was seen`);
        }
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
            let outText = '';
            p.stdout.on('data', (d) => (outText += d));
            p.on('close', () => resolve(outText.includes(String(pid))));
        });
        assert.equal(alive, false);
    });

    it('a refused permission prompt is reported as such (no helper, no files)', { skip: ONLY_WINDOWS }, async (t) => {
        const declined = { run: async () => ({ invocation: { executable: '', args: [] }, outcome: 'exited' as const, exitCode: 1, stdout: '', stderr: 'Start-Process : This command cannot be run due to the error: The operation was canceled by the user.', durationMs: 1 }) };
        const dir = await mkdtemp(join(tmpdir(), 'mfe '));
        t.after(() => rm(dir, { recursive: true, force: true }));
        const h = new ElevatedHelper({ runner: declined, dir: join(dir, 'ctl'), params: pins() });
        const r = await h.start();
        assert.ok(!r.ok && r.code === 'ELEVATION_DECLINED');
        assert.equal(h.running, false);
    });
});
