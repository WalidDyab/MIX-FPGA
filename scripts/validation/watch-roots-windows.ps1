# Records which tool processes run while a validation session is active, grouped by WHERE they run from:
#   powershell -File scripts/validation/watch-roots-windows.ps1 <out.json> <stop file>
# Sampled every 150 ms until <stop file> exists. A process is recorded when its executable path or command line mentions one of the
# folders that matter for the Windows installation proof: the MIX-FPGA root under test, the old NexysVHDL store, the repository's
# development tool folder, any repository path, Altera's Quartus, openFPGALoader, Lima, Digilent's programmer.
param([string]$Out, [string]$Stop)
$patterns = [ordered]@{
    'mixfpga-root-under-test' = [regex]::Escape($env:MIXFPGA_HOME)
    'nexysvhdl-store'         = 'AppData\\Local\\NexysVHDL'
    'repo-experimental'       = 'toolchains\\experimental'
    'repo'                    = 'WSClaude\\MIX-FPGA'
    'quartus'                 = 'intelFPGA_lite\\25\.1std|quartus_(sh|map|fit|sta|asm|cpf|pgm)|jtagconfig|jtagserver'
    'openfpgaloader'          = 'openFPGALoader'
    'lima'                    = 'limactl|\\lima'
    'digilent'                = 'djtgcfg|AdeptUtilities'
}
$seen = @{}
$me = $PID
while (-not (Test-Path $Stop)) {
    foreach ($p in Get-CimInstance Win32_Process) {
        if ($p.ProcessId -eq $me -or $p.Name -match '^(Code|node|powershell|pwsh|conhost|cmd|WmiPrvSE)\.exe$') { continue }
        $hay = "$($p.ExecutablePath) $($p.CommandLine)"
        foreach ($k in $patterns.Keys) {
            if ($patterns[$k] -and $hay -match $patterns[$k]) {
                $key = "$k|$($p.ExecutablePath)|$($p.CommandLine)"
                if (-not $seen.ContainsKey($key)) { $seen[$key] = [ordered]@{ group = $k; name = $p.Name; path = $p.ExecutablePath; commandLine = $p.CommandLine } }
            }
        }
    }
    Start-Sleep -Milliseconds 150
}
$seen.Values | ConvertTo-Json -Depth 3 | Out-File -Encoding utf8 $Out
