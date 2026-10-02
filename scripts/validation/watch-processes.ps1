# Records which FPGA-tool processes run while a validation phase is active:
# executable path and command line of every ghdl/apio/yosys/nextpnr/python/
# openXC7 process, sampled every 200 ms until <stop file> exists.
#   powershell -File scripts/validation/watch-processes.ps1 <out.json> <stop file>
param([string]$Out, [string]$Stop)
$names = @('ghdl', 'apio', 'yosys', 'nextpnr-xilinx', 'python', 'python3', 'python3.11', 'xc7frames2bit', 'bitread', 'djtgcfg', 'openFPGALoader', 'iverilog', 'vivado')
$seen = @{}
while (-not (Test-Path $Stop)) {
    foreach ($p in Get-CimInstance Win32_Process) {
        $base = [System.IO.Path]::GetFileNameWithoutExtension($p.Name)
        if ($names -contains $base) {
            $key = "$($p.ExecutablePath)|$($p.CommandLine)"
            if (-not $seen.ContainsKey($key)) { $seen[$key] = [ordered]@{ name = $p.Name; path = $p.ExecutablePath; commandLine = $p.CommandLine } }
        }
    }
    Start-Sleep -Milliseconds 200
}
$seen.Values | ConvertTo-Json -Depth 3 | Out-File -Encoding utf8 $Out
