<#
Phase 7 validation in a real VS Code, against the PACKAGED extension (not the source tree).

  powershell -File scripts\validation\phase7-validate.ps1 -Vsix .artifacts\phase8\nexysvhdl-0.6.0-phase8-test-win32-x64.vsix -Sandbox C:\temp\p7 -Stages a,b,r

Stages (see tests/integration/phase7-suite.ts):
  a  change every NexysVHDL-managed setting, close the window normally (the suite stretches the state write delay through the API object: only the exit flush can save it)
  b  second session on the same project: everything restored; then a window reload
  r  verifies the reload
  n  New Project (.nvproj), Open Project, legacy project, Create NexysVHDL Project File
  s  Design Schematic readability (100%, Fit Width, Fit All, zoom, pan, drill-down, breadcrumb, source beside, Maximize)
  c  NexysVHDL Console with the real toolchain (Check, Simulate, Build, Program without a board, an error, close and re-reveal)
  d  detailed Console output (raw tool lines streamed)
  v  re-hash the installed Toolchain 1.0 (slow)

Each stage group that needs a pristine project should be run after a fresh -Fresh sandbox. Needs: npm run build first, VS Code, the installed
FPGA toolchain, and a project folder to copy as the workspace (-Project, default: the DigitDisplay copy next to the sandbox, if given).
Nothing outside -Sandbox is read or written (private extensions and user-data folders); screenshots go to <Sandbox>\png.
#>
param(
    [Parameter(Mandatory)] [string]$Vsix,
    [Parameter(Mandatory)] [string]$Sandbox,
    [string[]]$Stages = @('a', 'b', 'r'),
    [string]$Project,
    [switch]$Fresh,
    [int]$TimeoutSec = 600
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$code = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
$codeCmd = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"

if ($Fresh -or -not (Test-Path $Sandbox)) {
    if (-not $Project) { throw 'A fresh sandbox needs -Project <folder to copy as the workspace>.' }
    if (Test-Path $Sandbox) { Remove-Item $Sandbox -Recurse -Force }
    New-Item -ItemType Directory -Force "$Sandbox\ext", "$Sandbox\user", "$Sandbox\host", "$Sandbox\scratch", "$Sandbox\shots", "$Sandbox\ws" | Out-Null
    Set-Content "$Sandbox\host\package.json" '{ "name": "p7host", "version": "0.0.0", "publisher": "p7", "engines": { "vscode": "*" } }'
    Copy-Item $Project "$Sandbox\ws\$(Split-Path $Project -Leaf)" -Recurse
    & $codeCmd --install-extension (Resolve-Path $Vsix).Path --extensions-dir "$Sandbox\ext" --user-data-dir "$Sandbox\user" --force | Out-Null
}
$workspace = (Get-ChildItem "$Sandbox\ws" -Directory | Select-Object -First 1).FullName

foreach ($stage in $Stages) {
    $env:NEXYS_P6_SUITE = 'phase7'
    $env:NEXYS_P7_STAGE = $stage
    $env:NEXYS_P7_SCRATCH = "$Sandbox\scratch"
    $env:NEXYS_P7_USERDATA = "$Sandbox\user"
    $env:NEXYS_P7_SHOTS = "$Sandbox\shots"
    $env:NEXYS_P6_USER_DATA = "$Sandbox\user"
    $env:NEXYSVHDL_P6_EXTENSIONS_DIR = "$Sandbox\ext"
    $env:NEXYSVHDL_P6_HOST_DIR = "$Sandbox\host"
    $env:NEXYS_EDH_REPORT = "$Sandbox\report-$stage.json"
    Remove-Item "$Sandbox\shots\finished" -ErrorAction SilentlyContinue
    $cap = Start-Process powershell -ArgumentList '-NoProfile', '-File', "$PSScriptRoot\capture-window.ps1", '-Shots', "$Sandbox\shots", '-OutDir', "$Sandbox\png", '-TimeoutSec', $TimeoutSec, '-TitleMatch', ('"\[Extension Development Host\].*' + [regex]::Escape((Split-Path $workspace -Leaf)) + '"') -PassThru -WindowStyle Hidden
    $run = Start-Process node -ArgumentList "$repo\dist\tests\integration\run-phase6.js", "`"$code`"", "`"$workspace`"", "`"$Sandbox\report-$stage.json`"" -PassThru -WindowStyle Hidden -RedirectStandardOutput "$Sandbox\run-$stage.out" -RedirectStandardError "$Sandbox\run-$stage.err"
    if (-not $run.WaitForExit($TimeoutSec * 1000)) { Write-Output "stage ${stage}: TIMEOUT"; Stop-Process -Id $run.Id -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType File "$Sandbox\shots\finished" -Force | Out-Null
    Start-Sleep -Seconds 2
    if (-not $cap.HasExited) { Stop-Process -Id $cap.Id -Force -ErrorAction SilentlyContinue }
    $result = if (Test-Path "$Sandbox\report-$stage.json") { (Get-Content "$Sandbox\report-$stage.json" -Raw | ConvertFrom-Json).report.result } else { 'no report' }
    Write-Output "stage ${stage}: $result"
}
