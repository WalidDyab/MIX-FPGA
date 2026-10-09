// Draws the NexysVHDL application icon (navy tile, white chip outline, orange core, pins) into an .iconset folder of PNGs.
// The same drawing as make-icon.ps1 (Windows .ico), on the same 256-unit grid.
//   swiftc make-icon.swift -o make-icon && ./make-icon <out.iconset>
import AppKit

func draw(_ n: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: n, pixelsHigh: n, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    ctx.setShouldAntialias(true)
    let u = CGFloat(n) / 256.0
    // y is flipped to match the 256-unit drawing (top-left origin)
    ctx.translateBy(x: 0, y: CGFloat(n)); ctx.scaleBy(x: 1, y: -1)
    let navy = NSColor(srgbRed: 15 / 255, green: 27 / 255, blue: 45 / 255, alpha: 1)
    let orange = NSColor(srgbRed: 242 / 255, green: 140 / 255, blue: 40 / 255, alpha: 1)
    let pinColor = NSColor(srgbRed: 170 / 255, green: 185 / 255, blue: 210 / 255, alpha: 1)
    navy.setFill()
    NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: CGFloat(n), height: CGFloat(n)), xRadius: 52 * u, yRadius: 52 * u).fill()
    let c0 = 72 * u, c1 = 184 * u
    ctx.setLineCap(.butt)
    ctx.setStrokeColor(pinColor.cgColor)
    ctx.setLineWidth(max(1, 9 * u))
    for k in [96.0, 128.0, 160.0] {
        let p = CGFloat(k) * u
        ctx.move(to: CGPoint(x: p, y: 40 * u)); ctx.addLine(to: CGPoint(x: p, y: c0))
        ctx.move(to: CGPoint(x: p, y: c1)); ctx.addLine(to: CGPoint(x: p, y: 216 * u))
        ctx.move(to: CGPoint(x: 40 * u, y: p)); ctx.addLine(to: CGPoint(x: c0, y: p))
        ctx.move(to: CGPoint(x: c1, y: p)); ctx.addLine(to: CGPoint(x: 216 * u, y: p))
    }
    ctx.strokePath()
    ctx.setStrokeColor(NSColor.white.cgColor)
    ctx.setLineWidth(max(1.2, 10 * u))
    ctx.stroke(CGRect(x: c0, y: c0, width: c1 - c0, height: c1 - c0))
    ctx.setFillColor(orange.cgColor)
    ctx.fill(CGRect(x: 104 * u, y: 104 * u, width: 48 * u, height: 48 * u))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "NexysVHDL.iconset"
try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    try draw(base).write(to: URL(fileURLWithPath: "\(out)/icon_\(base)x\(base).png"))
    try draw(base * 2).write(to: URL(fileURLWithPath: "\(out)/icon_\(base)x\(base)@2x.png"))
}
