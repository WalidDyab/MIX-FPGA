import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import type { ToolRunner } from '../../../core/process/tool-runner';
import { writeFileAtomic } from '../../../core/util/atomic-write';

/**
 * Altera's Windows installer refuses to start without administrator rights, even to show its licence. MIX-FPGA therefore asks
 * Windows for permission ONCE and runs one small helper with those rights for the whole Quartus installation. MIX-FPGA itself,
 * and everything it does afterwards (Check, Simulate, Build, Program), stays unelevated, and MIX-FPGA never sees or handles an
 * administrator password: the permission prompt is Windows' own.
 *
 * The helper can do exactly two things, both on the two Altera files MIX-FPGA verified (it checks their SHA-256 again before
 * every run): ask the installer for its licence files (`--mode win32 --install_lic`; unattended mode does not write them, measured in Phase 4C; nothing is installed), and run the installer unattended. The second is
 * refused unless the student's recorded acceptance of that exact licence is present. `--accept_eula` appears only there.
 * It talks to MIX-FPGA through small files in a folder only this installation uses, and ends when MIX-FPGA ends.
 */
export const HELPER_SCRIPT = String.raw`param(
  [Parameter(Mandatory)][string]$Control,
  [Parameter(Mandatory)][string]$Installers,
  [Parameter(Mandatory)][string]$InstallerName,
  [Parameter(Mandatory)][string]$InstallerSha256,
  [Parameter(Mandatory)][string]$PackageName,
  [Parameter(Mandatory)][string]$PackageSha256,
  [Parameter(Mandatory)][string]$InstallDir,
  [Parameter(Mandatory)][string]$Disabled,
  [Parameter(Mandatory)][string]$LicenseSha256,
  [int]$ParentPid = 0
)
$ErrorActionPreference = 'Stop'
$log = Join-Path $Control 'helper.log'
function Log($m) { Add-Content -Path $log -Value ('{0:o} {1}' -f (Get-Date), $m) }
function Respond($id, $ok, $code, $message) {
  $json = [ordered]@{ id = $id; ok = $ok; exitCode = $code; message = $message } | ConvertTo-Json -Compress
  $tmp = Join-Path $Control ('response-' + $id + '.tmp')
  Set-Content -Path $tmp -Value $json -Encoding ASCII
  Move-Item -Force -Path $tmp -Destination (Join-Path $Control ('response-' + $id + '.json'))
}
function Check-Files {
  foreach ($f in @(@($InstallerName, $InstallerSha256), @($PackageName, $PackageSha256))) {
    $p = Join-Path $Installers $f[0]
    if (-not (Test-Path -LiteralPath $p)) { return ('missing ' + $f[0]) }
    if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -ne $f[1]) { return ('changed ' + $f[0]) }
  }
  return $null
}
function Stop-Tree($proc) {
  Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $proc.Id) -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
Set-Content -Path (Join-Path $Control 'ready') -Value ([string]$PID) -Encoding ASCII
Log 'ready'
while ($true) {
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { Log 'parent ended'; break }
  $req = Get-ChildItem -LiteralPath $Control -Filter 'request-*.json' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
  if (-not $req) { Start-Sleep -Milliseconds 250; continue }
  $r = Get-Content -LiteralPath $req.FullName -Raw | ConvertFrom-Json
  Remove-Item -LiteralPath $req.FullName -Force
  try {
    if ($r.op -eq 'quit') { Respond $r.id $true 0 'bye'; Log 'quit'; exit 0 }
    elseif ($r.op -eq 'license') {
      $bad = Check-Files
      if ($bad) { Respond $r.id $false 3 $bad; continue }
      $out = Join-Path $Control 'license-out'
      if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Recurse -Force }
      New-Item -ItemType Directory -Path $out | Out-Null
      $exe = Join-Path $Installers $InstallerName
      $p = Start-Process -FilePath $exe -ArgumentList @('--mode', 'win32', '--install_lic', ('"' + $out + '"')) -PassThru -WindowStyle Hidden -WorkingDirectory $Installers
      $lic = Join-Path $out 'licenses\license.txt'
      $deadline = (Get-Date).AddSeconds(150)
      while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $lic) -and -not $p.HasExited) { Start-Sleep -Milliseconds 400 }
      Start-Sleep -Seconds 1
      if (-not $p.HasExited) { Stop-Tree $p }
      if (Test-Path -LiteralPath $lic) { Respond $r.id $true 0 'licence written' } else { Respond $r.id $false 4 'the installer did not write its licence' }
    }
    elseif ($r.op -eq 'install') {
      $acc = Join-Path $Control 'accepted.json'
      if (-not (Test-Path -LiteralPath $acc)) { Respond $r.id $false 5 'no recorded acceptance'; continue }
      $a = Get-Content -LiteralPath $acc -Raw | ConvertFrom-Json
      if ($a.accepted -ne $true -or $a.licenseSha256 -ne $LicenseSha256 -or $a.installerSha256 -ne $InstallerSha256) { Respond $r.id $false 5 'the recorded acceptance is not for this licence'; continue }
      $bad = Check-Files
      if ($bad) { Respond $r.id $false 3 $bad; continue }
      $exe = Join-Path $Installers $InstallerName
      Log 'installing'
      $p = Start-Process -FilePath $exe -ArgumentList @('--mode', 'unattended', '--unattendedmodeui', 'none', '--accept_eula', '1', '--installdir', ('"' + $InstallDir + '"'), '--create_desktop_shortcuts', '0', '--disable-components', $Disabled) -PassThru -Wait -WindowStyle Hidden -WorkingDirectory $Installers
      Respond $r.id ($p.ExitCode -eq 0) $p.ExitCode ('installer exit ' + $p.ExitCode)
    }
    else { Respond $r.id $false 2 'unknown request' }
  } catch { Log ('error: ' + $_.Exception.Message); Respond $r.id $false 1 $_.Exception.Message }
}
`;

export const helperScriptSha256 = (): string => createHash('sha256').update(HELPER_SCRIPT).digest('hex');

/** A PowerShell single-quoted string literal. */
export const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export interface HelperParameters {
    readonly installers: string;
    readonly installerName: string;
    readonly installerSha256: string;
    readonly packageName: string;
    readonly packageSha256: string;
    readonly installDir: string;
    readonly disabledComponents: string;
    readonly licenseSha256: string;
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
    /** The helper's working folder (private to this installation). */
    readonly dir: string;
    readonly params: HelperParameters;
    /** Process id the helper watches; it ends when that process ends. */
    readonly parentPid?: number;
    /** How long to wait for the student to answer Windows' permission prompt. */
    readonly readyTimeoutMs?: number;
    readonly pollMs?: number;
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

    get scriptPath(): string {
        return win32.join(this.deps.dir, 'helper.ps1');
    }

    /** The command line that asks Windows for permission and starts the helper (exposed for tests; nothing here runs it). */
    launchCommand(): { executable: string; args: string[] } {
        const p = this.deps.params;
        const hash = helperScriptSha256();
        const inner =
            `& { $h = (Get-FileHash -Algorithm SHA256 -LiteralPath ${psQuote(this.scriptPath)}).Hash.ToLowerInvariant(); if ($h -ne ${psQuote(hash)}) { exit 90 }; ` +
            `& ${psQuote(this.scriptPath)} -Control ${psQuote(this.deps.dir)} -Installers ${psQuote(p.installers)} -InstallerName ${psQuote(p.installerName)} -InstallerSha256 ${psQuote(p.installerSha256)} ` +
            `-PackageName ${psQuote(p.packageName)} -PackageSha256 ${psQuote(p.packageSha256)} -InstallDir ${psQuote(p.installDir)} -Disabled ${psQuote(p.disabledComponents)} -LicenseSha256 ${psQuote(p.licenseSha256)} -ParentPid ${this.deps.parentPid ?? process.pid} }`;
        return {
            executable: 'powershell.exe',
            args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-Command',${psQuote(inner)})`],
        };
    }

    async start(signal?: AbortSignal): Promise<{ ok: true } | HelperFailure> {
        if (this.started) return { ok: true };
        const { dir } = this.deps;
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
        await writeFile(this.scriptPath, HELPER_SCRIPT, 'ascii');
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

    /** Where the helper leaves the licence files it was asked for. */
    get licenseFile(): string {
        return win32.join(this.deps.dir, 'license-out', 'licenses', 'license.txt');
    }

    async stop(): Promise<void> {
        if (this.started) await this.request('quit', 10_000).catch(() => undefined);
        this.started = false;
        const files = await readdir(this.deps.dir).catch(() => [] as string[]);
        void files;
        await rm(this.deps.dir, { recursive: true, force: true }).catch(() => undefined);
    }
}
