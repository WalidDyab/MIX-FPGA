import AppKit
import Foundation

func argValue(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

let bundle = Bundle.main
let resources = bundle.resourcePath ?? "."
let dmgRoot = bundle.bundleURL.deletingLastPathComponent().path
var config = InstallerConfig(supportDir: argValue("--support") ?? dmgRoot + "/Support", resourcesDir: resources)
if let h = argValue("--home") { config.home = h }
config.codeAppOverride = argValue("--code-app")
let installer = Installer(config: config)

if CommandLine.arguments.contains("--headless") {
    // Test and scripting mode: the same code as the window, no window. --detect only prints what was found.
    let d = installer.detect()
    print("vscode: \(d.codeApp ?? "MISSING")")
    print("extension: \(d.extensionVersion ?? "none")")
    switch d.mode { case .fresh: print("mode: Fresh Install"); case .upgrade(let v): print("mode: Upgrade from NexysVHDL \(v)"); case .reinstall: print("mode: Repair/Reinstall MIX-FPGA") }
    print("legacy toolchain store: \(d.legacyToolchainStore)")
    if CommandLine.arguments.contains("--detect") { exit(0) }
    guard let app = d.codeApp else { print("RESULT: Visual Studio Code is not installed"); exit(2) }
    let boards = (argValue("--boards") ?? "").split(separator: ",").map(String.init)
    if boards.isEmpty { print("no --boards"); exit(2) }
    let o = installer.perform(app: app, mode: d.mode, boards: boards) { print($0); fflush(stdout) }
    print("RESULT: \(o.ok ? "OK" : "FAILED") — \(o.title)")
    for l in o.details { print("  \(l)") }
    exit(o.ok ? 0 : 1)
}

let delegate = InstallerApp(installer: installer)
let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
