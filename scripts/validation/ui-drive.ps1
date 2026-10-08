<#
Drives ONE VS Code window like a person would (keyboard only): command palette, paste into the native file dialog, keys,
screenshots. The window is found by its command line (the validation sandbox), so no other VS Code window is touched.

  powershell -File scripts\validation\ui-drive.ps1 -CmdMatch <regex> -Steps 'palette:NexysVHDL: Check VHDL','wait:8','shot:C:\x\a.png'

Steps: palette:<text> (F1, type, Enter) | type:<text> | paste:<text> (clipboard + Ctrl+V) | keys:<SendKeys> | wait:<seconds> | shot:<png path>
#>
param([Parameter(Mandatory)] [string]$CmdMatch, [Parameter(Mandatory)] [string[]]$Steps, [int]$WaitSec = 30)
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class UD {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[UD]::SetProcessDPIAware() | Out-Null
function Find-Window {
    $deadline = (Get-Date).AddSeconds($WaitSec)
    while ((Get-Date) -lt $deadline) {
        $ids = Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -match $CmdMatch -and $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId
        foreach ($id in $ids) { $q = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($q -and $q.MainWindowHandle -ne 0) { return $q } }
        Start-Sleep -Milliseconds 500
    }
    return $null
}
# SendKeys treats + ^ % ~ ( ) { } [ ] specially: send them literally.
function ConvertTo-SendKeys([string]$t) { ($t.ToCharArray() | ForEach-Object { if ('+^%~(){}[]'.Contains([string]$_)) { '{' + $_ + '}' } else { [string]$_ } }) -join '' }
function Focus($p) { [UD]::ShowWindow($p.MainWindowHandle, 3) | Out-Null; [UD]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Start-Sleep -Milliseconds 700 }
function Shot($p, $path) {
    $p.Refresh()
    $r = New-Object UD+RECT; [UD]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
    $dpi = (Get-ItemProperty "HKCU:\Control Panel\Desktop\WindowMetrics" -ErrorAction SilentlyContinue).AppliedDPI; if (-not $dpi) { $dpi = 96 }; $k = $dpi / 96.0
    $w = [int](($r.R - $r.L) * $k); $h = [int](($r.B - $r.T) * $k)
    $bmp = New-Object Drawing.Bitmap $w, $h; $g = [Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc(); [UD]::PrintWindow($p.MainWindowHandle, $hdc, 2) | Out-Null; $g.ReleaseHdc($hdc)
    $bmp.Save($path, [Drawing.Imaging.ImageFormat]::Png)
    Write-Output "shot '$($p.MainWindowTitle)' -> $path"
}
$p = Find-Window
if (-not $p) { Write-Output "no window for '$CmdMatch'"; exit 1 }
foreach ($step in $Steps) {
    $kind, $arg = $step -split ':', 2
    $p = Find-Window
    if (-not $p) { Write-Output "window gone before '$step'"; exit 2 }
    switch ($kind) {
        'palette' { Focus $p; [System.Windows.Forms.SendKeys]::SendWait('{ESC}'); Start-Sleep -Milliseconds 400; [System.Windows.Forms.SendKeys]::SendWait('{F1}'); Start-Sleep -Milliseconds 1500; [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-SendKeys $arg)); Start-Sleep -Milliseconds 1200; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); Start-Sleep -Milliseconds 900 }
        'type' { Focus $p; [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-SendKeys $arg)); Start-Sleep -Milliseconds 500 }
        'paste' { Focus $p; Set-Clipboard -Value $arg; [System.Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 600 }
        'keys' { Focus $p; [System.Windows.Forms.SendKeys]::SendWait($arg); Start-Sleep -Milliseconds 700 }
        'wait' { Start-Sleep -Seconds ([int]$arg) }
        'shot' { Shot $p $arg }
    }
}
