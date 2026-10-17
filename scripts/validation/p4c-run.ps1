# Runs one Phase 4C validation scenario in a real VS Code Extension Development Host (development mode) against an ISOLATED MIX-FPGA root.
#   powershell -File scripts\validation\p4c-run.ps1 -Suite phase4b -Scenario add-de10 -MfHome D:\MFW\r1 -Workspace D:\MFW\ws0 -Out D:\MFW\report.json
# Never touches %LOCALAPPDATA%\MIX-FPGA: MIXFPGA_HOME is required and must not be that folder. A private user-data folder keeps the
# developer's VS Code profile, settings and extensions out of it. A process watcher records where every tool process ran from.
param(
    [Parameter(Mandatory)] [string]$Suite,
    [Parameter(Mandatory)] [string]$MfHome,
    [Parameter(Mandatory)] [string]$Workspace,
    [Parameter(Mandatory)] [string]$Out,
    [string]$Scenario = '',
    [string]$Stage = '',
    [string]$UserData = 'D:\MFW\ud-default',
    [string]$Work = 'D:\MFW\work',
    [string]$Payloads = '',
    [string]$AlteraDir = '',
    [switch]$NexysBuild,
    [switch]$Program,
    [int]$TimeoutSec = 1500,
    [switch]$NoWatch
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($MfHome -match '\\AppData\\Local\\MIX-FPGA$') { throw 'refusing to run against the real MIX-FPGA root' }
$code = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
$saved = @{}
function Set-Env($k, $v) { if (-not $saved.ContainsKey($k)) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }; [Environment]::SetEnvironmentVariable($k, $v, 'Process') }
try {
    Set-Env 'NEXYS_P6_SUITE' $Suite
    Set-Env 'MIXFPGA_HOME' $MfHome
    Set-Env 'NEXYS_P6_USER_DATA' $UserData
    Set-Env 'P4B_SCENARIO' $Scenario
    Set-Env 'MIXFPGA_STAGE' $Stage
    Set-Env 'P4B_WORK' $Work
    Set-Env 'MIXFPGA_DEV_PAYLOAD' $Payloads
    Set-Env 'P4B_ALTERA_DIR' $AlteraDir
    if ($NexysBuild) { Set-Env 'MIXFPGA_NEXYS_BUILD' '1' }
    if ($Program) { Set-Env 'MIXFPGA_PROGRAM' '1' }
    $stop = "$Out.stop"
    Remove-Item $Out, $stop, "$Out.roots.json" -ErrorAction SilentlyContinue
    $watcher = $null
    if (-not $NoWatch) { $watcher = Start-Process powershell -ArgumentList '-NoProfile', '-File', "$repo\scripts\validation\watch-roots-windows.ps1", "$Out.roots.json", $stop -PassThru -WindowStyle Hidden; Start-Sleep 2 }
    $t = Get-Date
    $p = Start-Process node -ArgumentList "$repo\dist\tests\integration\run-phase6.js", "`"$code`"", "`"$Workspace`"", "`"$Out`"" -PassThru -RedirectStandardOutput "$Out.out" -RedirectStandardError "$Out.err" -WorkingDirectory $repo
    if (-not $p.WaitForExit($TimeoutSec * 1000)) { Write-Output 'TIMEOUT'; Stop-Process -Id $p.Id -Force }
    if ($watcher) { New-Item $stop -ItemType File -Force | Out-Null; $null = $watcher.WaitForExit(30000) }
    Write-Output ("finished in {0}s" -f [int]((Get-Date) - $t).TotalSeconds)
} finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
}
if (Test-Path $Out) {
    $j = Get-Content $Out -Raw | ConvertFrom-Json
    foreach ($e in $j.log) {
        $s = [regex]::Replace(($e | ConvertTo-Json -Compress -Depth 8), '[^\u0020-\u007E]', '')
        if ($s.Length -gt 700) { $s = $s.Substring(0, 700) }
        Write-Output $s
    }
}
if (Test-Path "$Out.roots.json") {
    Write-Output '--- processes by place'
    (Get-Content "$Out.roots.json" -Raw | ConvertFrom-Json) | Group-Object group | ForEach-Object { Write-Output ("{0}: {1}" -f $_.Name, $_.Count); $_.Group | Select-Object -First 5 | ForEach-Object { Write-Output ("    " + $_.path) } }
}
