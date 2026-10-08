<#
Answers the NATIVE Windows file/folder dialog that VS Code shows for NexysVHDL's Open Project (a separate top-level window of
the VS Code process) the way a person would: type the path into "File name" and press the default button. SendKeys is unreliable
inside that dialog, so the Win32 controls are used directly (edit id 1148 / 1152, OK button id 1). Only the sandbox's own VS Code
process is looked at (-CmdMatch).

  powershell -File scripts\validation\dialog-fill.ps1 -CmdMatch <regex> -Path C:\proj\X.nvproj [-TitleContains 'choose a project']
#>
param([Parameter(Mandatory)] [string]$CmdMatch, [Parameter(Mandatory)] [string]$Path, [string]$TitleContains = 'NexysVHDL: choose', [int]$WaitSec = 30)
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class DF { public delegate bool CB(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(CB cb, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, CB cb, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
 public static IntPtr Dialog(uint pid, string contains){ IntPtr f=IntPtr.Zero; EnumWindows((h,l)=>{ uint p; GetWindowThreadProcessId(h,out p); if(p==pid && IsWindowVisible(h)){ var sb=new StringBuilder(256); GetWindowText(h,sb,256); if(sb.ToString().Contains(contains)) f=h; } return true;}, IntPtr.Zero); return f; }
 public static IntPtr Child(IntPtr dlg, string cls, int id){ IntPtr f=IntPtr.Zero; EnumChildWindows(dlg,(h,l)=>{ var sb=new StringBuilder(64); GetClassName(h,sb,64); if(sb.ToString()==cls && GetDlgCtrlID(h)==id) f=h; return true;}, IntPtr.Zero); return f; } }
"@
$deadline = (Get-Date).AddSeconds($WaitSec)
$dlg = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and $dlg -eq [IntPtr]::Zero) {
    $ids = Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -match $CmdMatch -and $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId
    foreach ($id in $ids) { $d = [DF]::Dialog([uint32]$id, $TitleContains); if ($d -ne [IntPtr]::Zero) { $dlg = $d; break } }
    if ($dlg -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500 }
}
if ($dlg -eq [IntPtr]::Zero) { Write-Output 'no dialog'; exit 1 }
# the file dialog's name box is control 1148, the folder dialog's is 1152
$edit = [DF]::Child($dlg, 'Edit', 1148)
if ($edit -eq [IntPtr]::Zero) { $edit = [DF]::Child($dlg, 'Edit', 1152) }
$ok = [DF]::Child($dlg, 'Button', 1)
if ($edit -eq [IntPtr]::Zero -or $ok -eq [IntPtr]::Zero) { Write-Output 'dialog controls not found'; exit 2 }
[DF]::SendMessage($edit, 0x000C, [IntPtr]::Zero, $Path) | Out-Null   # WM_SETTEXT
Start-Sleep -Milliseconds 400
[DF]::SendMessage($ok, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null   # BM_CLICK
Write-Output "dialog answered: $Path"
