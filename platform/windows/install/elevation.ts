import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import type { ToolRunner } from '../../../core/process/tool-runner';
import { writeFileAtomic } from '../../../core/util/atomic-write';

/**
 * Altera's Windows installer refuses to start without administrator rights, even to show its licence. MIX-FPGA therefore asks
 * Windows for permission ONCE and runs one small helper with those rights for the whole Quartus installation. MIX-FPGA itself,
 * and everything it does afterwards (Check, Simulate, Build, Program), stays unelevated, and MIX-FPGA never sees or handles an
 * administrator password: the permission prompt is Windows' own.
 *
 * The helper can do exactly two things, both on the two Altera files MIX-FPGA verified: ask the installer for its licence files
 * (`--mode win32 --install_lic`; unattended mode does not write them, measured in Phase 4C; nothing is installed), and run the
 * installer unattended. The second is refused unless the student's recorded acceptance of that exact licence is present.
 * `--accept_eula` appears only there. Phase 5H security review of what runs with administrator rights:
 *  - The script is not a file. It travels inside the (encoded) command line of the elevated process, so nothing a normal process can
 *    write to can change it between Windows' prompt and its execution; the pinned names, SHA-256 values, install folder and
 *    component list are part of that script, and the script refuses anything that does not have the expected shape.
 *  - The Altera files are copied by the helper itself into a new folder that only SYSTEM and Administrators can write to
 *    (random name under the Windows temp folder), hashed THERE, and run from THERE. The student-writable copies are only a source:
 *    swapping them after their hash was checked cannot make the helper run anything else.
 *  - Requests are tiny files in a folder only this installation uses. The helper accepts three operations, ignores everything
 *    else, and takes the only part of a request that reaches a file name (`id`) through a strict pattern, so a request cannot
 *    steer a write elsewhere. The helper writes only into its own staging folder and that control folder, and refuses a control
 *    folder that is a junction or link.
 *  - It logs only operation names, exit codes and short hash prefixes. No credentials exist in it and none are logged.
 * It ends when MIX-FPGA ends and removes its staging folder every time it ends.
 */
export interface HelperPins {
    readonly installerName: string;
    readonly installerSha256: string;
    readonly packageName: string;
    readonly packageSha256: string;
    readonly installDir: string;
    readonly disabledComponents: string;
    readonly licenseSha256: string;
}

/** A PowerShell single-quoted string literal. */
export const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** The helper script for one installation: the pins are literals inside it. Only ASCII, and no back-tick or dollar-brace (PowerShell 5.1). */
export function helperScript(pins: HelperPins, run: { readonly control: string; readonly installers: string; readonly parentPid: number; readonly stageRoot?: string }): string {
    return String.raw`$ErrorActionPreference = 'Stop'
$Control = ${psQuote(run.control)}
$Installers = ${psQuote(run.installers)}
$ParentPid = ${Math.trunc(run.parentPid)}
$StageRoot = ${run.stageRoot ? psQuote(run.stageRoot) : "(Join-Path $env:SystemRoot 'Temp')"}
$TestStage = ${run.stageRoot ? '$true' : '$false'}
$InstallerName = ${psQuote(pins.installerName)}
$InstallerSha256 = ${psQuote(pins.installerSha256)}
$PackageName = ${psQuote(pins.packageName)}
$PackageSha256 = ${psQuote(pins.packageSha256)}
$LicenseSha256 = ${psQuote(pins.licenseSha256)}
$InstallDir = ${psQuote(pins.installDir)}
$Disabled = ${psQuote(pins.disabledComponents)}
$log = Join-Path $Control 'helper.log'
function Log($m) { try { Add-Content -LiteralPath $log -Value ('{0:o} {1}' -f (Get-Date), $m) } catch { } }
foreach ($n in @($InstallerName, $PackageName)) { if ($n -notmatch '^[A-Za-z0-9._-]+$') { exit 92 } }
foreach ($h in @($InstallerSha256, $PackageSha256, $LicenseSha256)) { if ($h -notmatch '^[0-9a-f]{64}$') { exit 92 } }
if ($InstallDir -notmatch '^[A-Za-z]:\\[A-Za-z0-9 ._-]+(\\[A-Za-z0-9 ._-]+)*$' -or $InstallDir -match '\.\.') { exit 92 }
if ($Disabled -notmatch '^[A-Za-z0-9_,.-]*$') { exit 92 }
if ((Get-Item -LiteralPath $Control -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 91 }
$Stage = Join-Path $StageRoot ('MIX-FPGA-' + [guid]::NewGuid().ToString('N'))
$staged = $false
function Respond($id, $ok, $code, $message) {
  $json = [ordered]@{ id = $id; ok = $ok; exitCode = $code; message = $message } | ConvertTo-Json -Compress
  $tmp = Join-Path $Control ('response-' + $id + '.tmp')
  Set-Content -LiteralPath $tmp -Value $json -Encoding ASCII
  Move-Item -Force -LiteralPath $tmp -Destination (Join-Path $Control ('response-' + $id + '.json'))
}
function Clean-Stage { if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue }; $script:staged = $false }
function Stop-Tree($id) {
  Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $id) -ErrorAction SilentlyContinue | ForEach-Object { Stop-Tree $_.ProcessId }
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}
function Stage-Files {
  if ($script:staged) { return $null }
  New-Item -ItemType Directory -Path $Stage | Out-Null
  $grant = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
  if ($TestStage) { $grant += ($env:USERNAME + ':(OI)(CI)F') }
  & icacls.exe $Stage /inheritance:r /grant:r $grant | Out-Null
  if ($LASTEXITCODE -ne 0) { return 'the staging folder could not be protected' }
  foreach ($f in @(@($InstallerName, $InstallerSha256), @($PackageName, $PackageSha256))) {
    $src = Join-Path $Installers $f[0]
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { return ('missing ' + $f[0]) }
    $dst = Join-Path $Stage $f[0]
    Copy-Item -LiteralPath $src -Destination $dst
    if ((Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash.ToLowerInvariant() -ne $f[1]) { return ('changed ' + $f[0]) }
  }
  $script:staged = $true
  return $null
}
Set-Content -LiteralPath (Join-Path $Control 'ready') -Value ([string]$PID) -Encoding ASCII
Log 'ready'
try {
  while ($true) {
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { Log 'parent ended'; break }
    $req = Get-ChildItem -LiteralPath $Control -Filter 'request-*.json' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
    if (-not $req) { Start-Sleep -Milliseconds 250; continue }
    $r = $null
    try { $r = Get-Content -LiteralPath $req.FullName -Raw | ConvertFrom-Json } catch { }
    Remove-Item -LiteralPath $req.FullName -Force -ErrorAction SilentlyContinue
    if (-not $r -or [string]$r.id -notmatch '^\d{3}-[0-9a-f]{6}$') { Log 'ignored a malformed request'; continue }
    $id = [string]$r.id
    try {
      if ($r.op -eq 'quit') { Respond $id $true 0 'bye'; Log 'quit'; break }
      elseif ($r.op -eq 'license') {
        $bad = Stage-Files
        if ($bad) { Respond $id $false 3 $bad; continue }
        $out = Join-Path $Stage 'license-out'
        New-Item -ItemType Directory -Path $out -Force | Out-Null
        $exe = Join-Path $Stage $InstallerName
        $p = Start-Process -FilePath $exe -ArgumentList @('--mode', 'win32', '--install_lic', ('"' + $out + '"')) -PassThru -WindowStyle Hidden -WorkingDirectory $Stage
        $lic = Join-Path $out 'licenses\license.txt'
        $deadline = (Get-Date).AddSeconds(150)
        while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $lic) -and -not $p.HasExited) { Start-Sleep -Milliseconds 400 }
        Start-Sleep -Seconds 1
        if (-not $p.HasExited) { Stop-Tree $p.Id }
        if (Test-Path -LiteralPath $lic) {
          $tmp = Join-Path $Control 'license.tmp'
          [IO.File]::WriteAllBytes($tmp, [IO.File]::ReadAllBytes($lic))
          Move-Item -Force -LiteralPath $tmp -Destination (Join-Path $Control 'license.txt')
          Respond $id $true 0 'licence written'
        } else { Respond $id $false 4 'the installer did not write its licence' }
      }
      elseif ($r.op -eq 'install') {
        $acc = Join-Path $Control 'accepted.json'
        if (-not (Test-Path -LiteralPath $acc)) { Respond $id $false 5 'no recorded acceptance'; continue }
        $a = Get-Content -LiteralPath $acc -Raw | ConvertFrom-Json
        if ($a.accepted -ne $true -or $a.licenseSha256 -ne $LicenseSha256 -or $a.installerSha256 -ne $InstallerSha256) { Respond $id $false 5 'the recorded acceptance is not for this licence'; continue }
        $bad = Stage-Files
        if ($bad) { Respond $id $false 3 $bad; continue }
        $exe = Join-Path $Stage $InstallerName
        Log 'installing'
        $p = Start-Process -FilePath $exe -ArgumentList @('--mode', 'unattended', '--unattendedmodeui', 'none', '--accept_eula', '1', '--installdir', ('"' + $InstallDir + '"'), '--create_desktop_shortcuts', '0', '--disable-components', $Disabled) -PassThru -Wait -WindowStyle Hidden -WorkingDirectory $Stage
        Log ('installer exit ' + $p.ExitCode)
        Respond $id ($p.ExitCode -eq 0) $p.ExitCode ('installer exit ' + $p.ExitCode)
        Clean-Stage
      }
      else { Respond $id $false 2 'unknown request' }
    } catch { Log ('error: ' + $_.Exception.Message); Respond $id $false 1 $_.Exception.Message }
  }
} finally { Clean-Stage }
`;
}

export const helperScriptSha256 = (script: string): string => createHash('sha256').update(script).digest('hex');

export interface HelperParameters extends HelperPins {
    /** Folder holding the two verified (student-writable) copies the helper copies from. */
    readonly installers: string;
}

export interface HelperResponse {
    readonly id: string;
    readonly ok: boolean;
    readonly exitCode: number;
    readonly message: string;
}

export type HelperFailure = { readonly ok: false; readonly code: 'ELEVATION_DECLINED' | 'ELEVATION_FAILED' | 'HELPER_TIMEOUT' | 'CANCELLED'; readonly message: string };

export interface HelperDeps {
    readonly runner: ToolRunner;
    /** The helper's control folder (private to this installation). */
    readonly dir: string;
    readonly params: HelperParameters;
    /** Process id the helper watches; it ends when that process ends. */
    readonly parentPid?: number;
    /** How long to wait for the student to answer Windows' permission prompt. */
    readonly readyTimeoutMs?: number;
    readonly pollMs?: number;
    /** TEST SEAM: where the protected staging folder is made (default: the Windows temp folder, under which only SYSTEM and Administrators may write). */
    readonly stageRoot?: string;
}

/**
 * MIX-FPGA's side of the helper protocol. `start()` shows Windows' own permission prompt once; `request()` sends one of the two
 * operations and waits for the answer; `stop()` ends the helper. All waiting honours cancellation.
 */
export class ElevatedHelper {
    private started = false;
    private counter = 0;

    constructor(private readonly deps: HelperDeps) {}

    get running(): boolean {
        return this.started;
    }

    /** The script this installation runs with administrator rights (never written to disk). */
    script(): string {
        const p = this.deps.params;
        return helperScript(p, { control: this.deps.dir, installers: p.installers, parentPid: this.deps.parentPid ?? process.pid, ...(this.deps.stageRoot ? { stageRoot: this.deps.stageRoot } : {}) });
    }

    /** The command line that asks Windows for permission and starts the helper (exposed for tests; nothing here runs it). */
    launchCommand(): { executable: string; args: string[] } {
        const encoded = Buffer.from(this.script(), 'utf16le').toString('base64');
        return {
            executable: 'powershell.exe',
            args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}')`],
        };
    }

    async start(signal?: AbortSignal): Promise<{ ok: true } | HelperFailure> {
        if (this.started) return { ok: true };
        const { dir } = this.deps;
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
        const cmd = this.launchCommand();
        // Windows' prompt waits for the student, so the launch may take as long as they need (bounded by the same limit as the wait below).
        const launched = await this.deps.runner.run({ ...cmd, timeoutMs: this.deps.readyTimeoutMs ?? 300_000, ...(signal ? { signal } : {}) });
        if (launched.outcome === 'cancelled') return { ok: false, code: 'CANCELLED', message: 'Cancelled.' };
        if (launched.outcome !== 'exited' || launched.exitCode !== 0) {
            const text = `${launched.stderr}${launched.stdout}`;
            const declined = /canceled by the user|cancelled by the user|operation was canceled/i.test(text);
            return { ok: false, code: declined ? 'ELEVATION_DECLINED' : 'ELEVATION_FAILED', message: declined ? 'Windows did not give permission to install.' : launched.outcome === 'timed-out' ? 'Windows asked for permission but nobody answered in time.' : `Windows could not start the installer helper (${launched.outcome === 'exited' ? `exit ${launched.exitCode}` : launched.outcome}).` };
        }
        // The prompt is answered; the helper writes `ready` as soon as it runs.
        const deadline = Date.now() + (this.deps.readyTimeoutMs ?? 300_000);
        while (Date.now() < deadline) {
            if (signal?.aborted) return { ok: false, code: 'CANCELLED', message: 'Cancelled.' };
            if (await stat(win32.join(dir, 'ready')).then(() => true, () => false)) {
                this.started = true;
                return { ok: true };
            }
            await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 250));
        }
        return { ok: false, code: 'HELPER_TIMEOUT', message: 'The installer helper did not start.' };
    }

    /** Sends `op` and waits for its answer (`timeoutMs` bounds the wait; the installer itself can take many minutes). */
    async request(op: 'license' | 'install' | 'quit', timeoutMs: number, signal?: AbortSignal): Promise<HelperResponse | HelperFailure> {
        const id = `${String(++this.counter).padStart(3, '0')}-${randomBytes(3).toString('hex')}`;
        await writeFileAtomic(win32.join(this.deps.dir, `request-${id}.json`), JSON.stringify({ id, op }));
        const response = win32.join(this.deps.dir, `response-${id}.json`);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (signal?.aborted) return { ok: false, code: 'CANCELLED', message: 'Cancelled.' };
            const text = await readFile(response, 'utf8').catch(() => undefined);
            if (text !== undefined) {
                try {
                    return JSON.parse(text.replace(/^﻿/, '')) as HelperResponse;
                } catch {
                    /* partial write: read again */
                }
            }
            await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 250));
        }
        return { ok: false, code: 'HELPER_TIMEOUT', message: 'The installer helper did not answer.' };
    }

    /** The student's acceptance, written where the helper reads it, before it may be asked to install. */
    async recordAcceptance(acceptance: { licenseSha256: string; installerSha256: string; acceptedAt: string }): Promise<void> {
        await writeFileAtomic(win32.join(this.deps.dir, 'accepted.json'), JSON.stringify({ accepted: true, ...acceptance }));
    }

    /** Where the helper leaves the licence file it was asked for (a copy; the original stays in its protected staging folder until it is removed). */
    get licenseFile(): string {
        return win32.join(this.deps.dir, 'license.txt');
    }

    async stop(): Promise<void> {
        if (this.started) await this.request('quit', 10_000).catch(() => undefined);
        this.started = false;
        const files = await readdir(this.deps.dir).catch(() => [] as string[]);
        void files;
        await rm(this.deps.dir, { recursive: true, force: true }).catch(() => undefined);
    }
}
