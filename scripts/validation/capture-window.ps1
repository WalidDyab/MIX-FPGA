param([string]$Shots, [string]$OutDir, [int]$TimeoutSec = 600, [string]$TitleMatch = 'Extension Development Host')
# Captures only the rectangle of the VS Code window under test (never the whole desktop) each time a validation suite drops a <name>.shot marker.
# Only a window whose title matches -TitleMatch is captured (validation passes the sandbox project's own name, so no other VS Code window is ever captured).
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[W]::SetProcessDPIAware() | Out-Null
New-Item -ItemType Directory -Force $OutDir | Out-Null
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    foreach ($m in Get-ChildItem $Shots -Filter *.shot -ErrorAction SilentlyContinue) {
        $name = [IO.Path]::GetFileNameWithoutExtension($m.Name)
        $done = Join-Path $Shots "$name.done"
        if (Test-Path $done) { continue }
        Start-Sleep -Milliseconds 700
        $p = $null
        for ($i = 0; $i -lt 10 -and -not $p; $i++) {
            $p = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match $TitleMatch } | Select-Object -First 1
            if (-not $p) { Start-Sleep -Milliseconds 400 }
        }
        if ($p) {
            [W]::ShowWindow($p.MainWindowHandle, 3) | Out-Null
            [W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
            Start-Sleep -Milliseconds 600
            $r = New-Object W+RECT
            [W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
            $dpi = (Get-ItemProperty "HKCU:\Control Panel\Desktop\WindowMetrics" -ErrorAction SilentlyContinue).AppliedDPI; if (-not $dpi) { $dpi = 96 }; $k = $dpi / 96.0; $w = [int](($r.R - $r.L) * $k); $h = [int](($r.B - $r.T) * $k)
            $bmp = New-Object Drawing.Bitmap $w, $h
            $g = [Drawing.Graphics]::FromImage($bmp)
            $hdc = $g.GetHdc(); [W]::PrintWindow($p.MainWindowHandle, $hdc, 2) | Out-Null; $g.ReleaseHdc($hdc)
            $bmp.Save((Join-Path $OutDir "$name.png"), [Drawing.Imaging.ImageFormat]::Png)
            $g.Dispose(); $bmp.Dispose()
            Write-Output "captured $name ${w}x${h}"
        } else { Write-Output "no EDH window for $name" }
        New-Item -ItemType File $done -Force | Out-Null
    }
    if (Test-Path (Join-Path $Shots 'finished')) { break }
    Start-Sleep -Milliseconds 400
}


