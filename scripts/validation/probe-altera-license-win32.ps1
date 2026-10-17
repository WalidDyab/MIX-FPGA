# One controlled, licence-only probe of Altera's real Windows installer in `--mode win32` with `--install_lic`.
#   powershell -File scripts\validation\probe-altera-license-win32.ps1 -Altera D:\Software\Intel-Altera\25.1 -Work D:\MFW\probe-win32
# Windows shows ONE permission prompt (answered by a person). The elevated part runs the installer with ONLY these options:
#   --mode win32 --install_lic <isolated folder>   (+ --debugtrace/--errortrace <log files>, which only write logs)
# It never passes --accept_eula, installation or component options. It watches for the licence file, copies and hashes it, closes the
# installer, and kills the installer's whole process tree if anything looks like an installation or nothing appears in time.
# Snapshots of everything an installer could change are taken before and after (see probe-altera-license.ps1).
param(
    [Parameter(Mandatory)] [string]$Altera,
    [Parameter(Mandatory)] [string]$Work,
    [int]$ObservationSeconds = 150
)
$ErrorActionPreference = 'Stop'
$installerName = 'QuartusLiteSetup-25.1std.0.1129-windows.exe'
$installerSha = '97a82c195ee1a42799cd2b376446500e1ebd305bf55b5b1fb845baf7e65c24cc'
New-Item -ItemType Directory -Force $Work | Out-Null

$elevated = @'
param([string]$Installer, [string]$InstallerSha, [string]$Out, [string]$Work, [int]$Seconds)
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ startedAt = (Get-Date).ToString('o'); mode = 'win32'; options = @('--mode','win32','--install_lic','<out>','--debugtrace','<log>','--errortrace','<log>') }
function Save { $result | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $Work 'elevated-result.json') -Encoding ASCII }
try {
    if ((Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $InstallerSha) { throw 'installer hash differs from the validated one' }
    $result.installerHashVerified = $true
    if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Recurse -Force }
    New-Item -ItemType Directory -Path $Out | Out-Null
    $trace = Join-Path $Work 'installer-debug.log'
    $errlog = Join-Path $Work 'installer-error.log'
    $so = Join-Path $Work 'installer-stdout.txt'
    $se = Join-Path $Work 'installer-stderr.txt'
    $args = @('--mode', 'win32', '--install_lic', ('"' + $Out + '"'), '--debugtrace', ('"' + $trace + '"'), '--errortrace', ('"' + $errlog + '"'))
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $Installer -ArgumentList $args -PassThru -RedirectStandardOutput $so -RedirectStandardError $se -WorkingDirectory (Split-Path $Installer)
    $result.pid = $p.Id
    $lic = Join-Path $Out 'licenses\license.txt'
    $windows = @{}
    $badChild = 'vcredist|msiexec|pnputil|dpinst|netsh|sc\.exe|reg\.exe|certutil|devcon|InstallHinf|jtagserver|quartus_'
    $aborted = $null
    function Tree($rootPid) {
        $all = Get-CimInstance Win32_Process
        $ids = New-Object System.Collections.Generic.List[int]; $ids.Add($rootPid)
        for ($i = 0; $i -lt $ids.Count; $i++) { foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $ids[$i] }) { $ids.Add([int]$c.ProcessId) } }
        return ,$ids
    }
    while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
        if (Test-Path -LiteralPath $lic) { $result.licenseAppearedAfterSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 2); break }
        $ids = Tree $p.Id
        foreach ($id in $ids) {
            $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
            if ($proc -and $proc.MainWindowHandle -ne 0 -and $proc.MainWindowTitle) { $windows["$($proc.ProcessName)|$($proc.MainWindowTitle)"] = [math]::Round($sw.Elapsed.TotalSeconds, 2) }
        }
        foreach ($c in Get-CimInstance Win32_Process | Where-Object { $ids -contains [int]$_.ProcessId -and $_.ProcessId -ne $p.Id }) {
            if ($c.Name -match $badChild -or $c.CommandLine -match 'accept_eula|installdir') { $aborted = "child process looks like an installation: $($c.Name) $($c.CommandLine)"; break }
        }
        if ($aborted) { break }
        if ($p.HasExited) { $result.exitedBeforeLicense = $true; break }
        Start-Sleep -Milliseconds 100
    }
    $result.windowsSeen = @($windows.GetEnumerator() | ForEach-Object { [ordered]@{ window = $_.Key; firstSeenAtSeconds = $_.Value } })
    if ($aborted) { $result.abortedBecause = $aborted }
    $result.licenseFileFound = (Test-Path -LiteralPath $lic)
    if ($result.licenseFileFound) {
        Copy-Item -LiteralPath $lic -Destination (Join-Path $Work 'license-copy.txt') -Force
        $result.licenseCopyBytes = (Get-Item (Join-Path $Work 'license-copy.txt')).Length
    }
    # Close the installer: politely first, then the whole tree.
    $result.exitedByItselfBeforeClose = $p.HasExited
    if (-not $p.HasExited) { [void]$p.CloseMainWindow(); Start-Sleep -Seconds 3 }
    if (-not $p.HasExited) { foreach ($id in (Tree $p.Id | Sort-Object -Descending)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }; $result.treeKilled = $true; Start-Sleep -Seconds 1 }
    if ($p.HasExited) { $result.installerExitCode = $p.ExitCode }
    $result.totalSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    $result.filesInOut = @(Get-ChildItem -LiteralPath $Out -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($Out.Length) })
} catch { $result.error = $_.Exception.Message }
$result.finishedAt = (Get-Date).ToString('o')
Save
'@
$script = Join-Path $Work 'elevated-probe.ps1'
Set-Content -Path $script -Value $elevated -Encoding ASCII
$scriptSha = (Get-FileHash -LiteralPath $script -Algorithm SHA256).Hash.ToLowerInvariant()

function Snapshot {
    $uninstall = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
    [ordered]@{
        uninstallKeys = @($uninstall | ForEach-Object { Get-ChildItem $_ -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName } } | Sort-Object)
        quartusFolders = @(Get-ChildItem C:\intelFPGA_lite, C:\altera_lite -Directory -ErrorAction SilentlyContinue | ForEach-Object { "$($_.FullName)|$((Get-ChildItem $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object).Count)" } | Sort-Object)
        firewallRules = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -match 'intelFPGA|altera|quartus|jtag' } | ForEach-Object { $_.Program } | Sort-Object)
        driverStore = @(pnputil /enum-drivers | Select-String 'Published Name|Original Name' | ForEach-Object { $_.Line.Trim() })
        services = @(Get-Service | ForEach-Object { $_.Name } | Sort-Object)
        userEnv = @([Environment]::GetEnvironmentVariables('User').GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" } | Sort-Object)
        machineEnv = @([Environment]::GetEnvironmentVariables('Machine').GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" } | Sort-Object)
        programFiles = @(Get-ChildItem 'C:\Program Files', 'C:\Program Files (x86)' -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } | Sort-Object)
        startMenuAndShortcuts = @(Get-ChildItem "$env:ProgramData\Microsoft\Windows\Start Menu\Programs" -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } | Sort-Object)
    }
}
$before = Snapshot
$before | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 "$Work\snapshot-before.json"
Remove-Item "$Work\elevated-result.json" -ErrorAction SilentlyContinue

$out = Join-Path $Work 'license-out'
function Quote($s) { "'" + $s.Replace("'", "''") + "'" }
$inner = "& { `$h = (Get-FileHash -Algorithm SHA256 -LiteralPath $(Quote $script)).Hash.ToLowerInvariant(); if (`$h -ne $(Quote $scriptSha)) { exit 90 }; & $(Quote $script) -Installer $(Quote (Join-Path $Altera $installerName)) -InstallerSha $(Quote $installerSha) -Out $(Quote $out) -Work $(Quote $Work) -Seconds $ObservationSeconds }"
Write-Output ("PERMISSION PROMPT NOW ({0}). Click Yes once." -f (Get-Date -Format T))
Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner)
$deadline = (Get-Date).AddSeconds(300 + $ObservationSeconds + 60)
while (-not (Test-Path "$Work\elevated-result.json") -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
Start-Sleep -Seconds 3

$after = Snapshot
$after | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 "$Work\snapshot-after.json"
$diff = [ordered]@{}
foreach ($k in $before.Keys) { $diff[$k] = @(Compare-Object @($before[$k]) @($after[$k]) | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" }) }
$diff | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 "$Work\snapshot-diff.json"

$res = if (Test-Path "$Work\elevated-result.json") { Get-Content "$Work\elevated-result.json" -Raw | ConvertFrom-Json } else { $null }
$summary = [ordered]@{ result = $res }
if ($res -and (Test-Path "$Work\license-copy.txt")) {
    $raw = [IO.File]::ReadAllBytes("$Work\license-copy.txt")
    $text = [Text.Encoding]::UTF8.GetString($raw).Replace("`r`n", "`n")
    $sha = [Security.Cryptography.SHA256]::Create()
    $summary.license = [ordered]@{
        rawBytes = $raw.Length
        rawSha256 = ([BitConverter]::ToString($sha.ComputeHash($raw)) -replace '-', '').ToLower()
        normalizedBytes = [Text.Encoding]::UTF8.GetByteCount($text)
        normalizedSha256 = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))) -replace '-', '').ToLower()
        pinnedNormalized = '0b1173f88d318001f865ae71d8fb46ad3cb08fc36598fff52325d1f10ddc62ab'
        pinnedRaw = '3cf19164cfc099dfecdd98c07f5a7e2a50241fdc99c9c00205afa3925496b63b'
    }
}
$summary.systemChanges = $diff
$summary | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 "$Work\summary.json"
Remove-Item "$Work\license-out" -Recurse -Force -ErrorAction SilentlyContinue
Get-Content "$Work\summary.json" -Raw
foreach ($f in 'installer-stdout.txt', 'installer-stderr.txt', 'installer-debug.log', 'installer-error.log') { if (Test-Path "$Work\$f") { Write-Output ("--- {0} ({1} bytes)" -f $f, (Get-Item "$Work\$f").Length); Get-Content "$Work\$f" -TotalCount 25 } }
