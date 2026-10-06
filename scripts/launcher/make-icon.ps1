param([Parameter(Mandatory = $true)][string]$Out)
# Draws the NexysVHDL application icon (navy tile, white chip outline, orange core, pins) at several sizes into one .ico.
Add-Type -AssemblyName System.Drawing
function Draw([int]$n) {
    $bmp = New-Object Drawing.Bitmap $n, $n
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([Drawing.Color]::Transparent)
    $u = $n / 256.0
    $navy = [Drawing.Color]::FromArgb(255, 15, 27, 45)
    $orange = [Drawing.Color]::FromArgb(255, 242, 140, 40)
    $path = New-Object Drawing.Drawing2D.GraphicsPath
    $r = 52 * $u
    $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90); $path.AddArc($n - 2 * $r - 1, 0, 2 * $r, 2 * $r, 270, 90)
    $path.AddArc($n - 2 * $r - 1, $n - 2 * $r - 1, 2 * $r, 2 * $r, 0, 90); $path.AddArc(0, $n - 2 * $r - 1, 2 * $r, 2 * $r, 90, 90)
    $path.CloseFigure()
    $g.FillPath((New-Object Drawing.SolidBrush $navy), $path)
    $pen = New-Object Drawing.Pen ([Drawing.Color]::White), ([single]([Math]::Max(1.2, 10 * $u)))
    $pin = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(255, 170, 185, 210)), ([single]([Math]::Max(1, 9 * $u)))
    $c0 = 72 * $u; $c1 = 184 * $u
    foreach ($k in 96, 128, 160) {
        $p = $k * $u
        $g.DrawLine($pin, $p, 40 * $u, $p, $c0); $g.DrawLine($pin, $p, $c1, $p, 216 * $u)
        $g.DrawLine($pin, 40 * $u, $p, $c0, $p); $g.DrawLine($pin, $c1, $p, 216 * $u, $p)
    }
    $g.DrawRectangle($pen, $c0, $c0, $c1 - $c0, $c1 - $c0)
    $g.FillRectangle((New-Object Drawing.SolidBrush $orange), 104 * $u, 104 * $u, 48 * $u, 48 * $u)
    $g.Dispose()
    $ms = New-Object IO.MemoryStream
    $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return , $ms.ToArray()
}
$sizes = 16, 24, 32, 48, 64, 128, 256
$images = foreach ($s in $sizes) { , (Draw $s) }
$fs = [IO.File]::Create($Out)
$w = New-Object IO.BinaryWriter $fs
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $bytes = $images[$i]
    $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$bytes.Length); $w.Write([uint32]$offset)
    $offset += $bytes.Length
}
foreach ($b in $images) { $w.Write($b) }
$w.Close(); $fs.Close()
