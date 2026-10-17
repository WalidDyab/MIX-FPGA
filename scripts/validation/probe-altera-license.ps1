# Wraps probe-altera-license.mjs with before/after snapshots of everything an installer could change beyond a licence file:
# uninstall records, Quartus folders, firewall rules, the driver store, services, user environment variables, and the processes
# the installer starts while it runs.
#   powershell -File scripts\validation\probe-altera-license.ps1 -Altera D:\Software\Intel-Altera\25.1 -Work D:\MFW\probe
param([Parameter(Mandatory)] [string]$Altera, [Parameter(Mandatory)] [string]$Work)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
New-Item -ItemType Directory -Force $Work | Out-Null

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
    }
}

$before = Snapshot
$before | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 "$Work\snapshot-before.json"

# Record every process that runs while the probe is active, with its parent, and flag anything an installer should not do for a licence.
$stop = "$Work\stop"
Remove-Item $stop -ErrorAction SilentlyContinue
$watch = Start-Job -ArgumentList $Work, $stop -ScriptBlock {
    param($Work, $stop)
    $seen = @{}
    $bad = 'vcredist|pnputil|dpinst|netsh|msiexec|sc\.exe|reg\.exe|certutil|DriverStore|InstallHinf|devcon'
    while (-not (Test-Path $stop)) {
        foreach ($p in Get-CimInstance Win32_Process) {
            if ($p.Name -match 'QuartusLite|Quartus|installbuilder|vcredist|pnputil|dpinst|netsh|msiexec|sc.exe|reg.exe|certutil|devcon|jtag|quartus_' -or $p.CommandLine -match 'install_lic|intelFPGA|QuartusLite') {
                $k = "$($p.ProcessId)"
                if (-not $seen.ContainsKey($k)) { $seen[$k] = [ordered]@{ pid = $p.ProcessId; ppid = $p.ParentProcessId; name = $p.Name; command = $p.CommandLine; flagged = [bool]($p.Name -match $bad -or $p.CommandLine -match $bad); at = (Get-Date).ToString('HH:mm:ss.fff') } }
            }
        }
        Start-Sleep -Milliseconds 100
    }
    $seen.Values | ConvertTo-Json -Depth 3 | Out-File -Encoding utf8 "$Work\processes.json"
}
Start-Sleep 2
Write-Output 'Starting the probe. Windows will show ONE permission prompt now.'
& node "$repo\scripts\validation\probe-altera-license.mjs" $Altera "$Work\scratch" "$Work\result.json"
New-Item $stop -ItemType File -Force | Out-Null
Wait-Job $watch -Timeout 30 | Out-Null
Receive-Job $watch | Out-Null
Remove-Job $watch -Force
Start-Sleep 3

$after = Snapshot
$after | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 "$Work\snapshot-after.json"
$diff = [ordered]@{}
foreach ($k in $before.Keys) {
    $d = Compare-Object @($before[$k]) @($after[$k])
    $diff[$k] = @($d | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" })
}
$diff | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 "$Work\snapshot-diff.json"
Write-Output '--- system changes (empty lists mean none)'
foreach ($k in $diff.Keys) { Write-Output ("{0}: {1}" -f $k, $(if ($diff[$k].Count -eq 0) { 'no change' } else { ($diff[$k] -join '; ') })) }
Write-Output '--- processes seen'
if (Test-Path "$Work\processes.json") { (Get-Content "$Work\processes.json" -Raw | ConvertFrom-Json) | ForEach-Object { Write-Output ("{0} pid={1} ppid={2} flagged={3} {4}" -f $_.at, $_.pid, $_.ppid, $_.flagged, $_.name) } }
