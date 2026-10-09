import AppKit
import CryptoKit
import Foundation

/// The macOS side of the launcher: finds VS Code without PATH (standard Applications folders, then LaunchServices),
/// starts it through LaunchServices so it is its own application (its own folder-access permissions, its own Dock
/// icon), and reads the per-user locations. No Terminal is ever involved.
/// Test hooks (environment variables, used only by the automated tests):
///   NEXYSVHDL_LAUNCHER_STATE_DIR       launcher state folder
///   NEXYSVHDL_LAUNCHER_FORCE_NO_VSCODE=1   behave as if VS Code were not installed
///   NEXYSVHDL_VSCODE_PATH              use this VS Code (the .app, or a stand-in executable)
///   NEXYSVHDL_VSCODE_EXTENSIONS_DIR / NEXYSVHDL_VSCODE_USER_DATA_DIR
///                                      private VS Code folders (passed as --extensions-dir / --user-data-dir)
///   NEXYSVHDL_LAUNCHER_DATA_ROOT       NexysVHDL toolchain data root (default ~/Library/NexysVHDL)
struct MacPlatform: Platform {
    static let extensionId = "emxplore.nexysvhdl"
    static let vscodeBundleId = "com.microsoft.VSCode"
    static let installTimeout: TimeInterval = 180

    private static func env(_ name: String) -> String? {
        guard let v = ProcessInfo.processInfo.environment[name], !v.isEmpty else { return nil }
        return v
    }

    private var home: String { NSHomeDirectory() }

    var stateDirectory: String {
        MacPlatform.env("NEXYSVHDL_LAUNCHER_STATE_DIR") ?? "\(home)/Library/Application Support/NexysVHDL/Launcher"
    }

    // MARK: VS Code

    private func plistString(_ bundle: String, _ key: String) -> String? {
        let plist = bundle + "/Contents/Info.plist"
        guard let d = NSDictionary(contentsOfFile: plist) else { return nil }
        return d[key] as? String
    }

    /// Describes a VS Code application bundle, or nil if it is not a usable stable VS Code.
    private func describe(app: String, scope: String) -> VsCodeInfo? {
        guard ProjectCheck.isDirectory(app) else { return nil }
        guard let exeName = plistString(app, "CFBundleExecutable") else { return nil }
        let exe = app + "/Contents/MacOS/" + exeName
        guard FileManager.default.isExecutableFile(atPath: exe) else { return nil }
        // VS Code Insiders is not used.
        if let id = plistString(app, "CFBundleIdentifier"), id.lowercased().contains("insiders") { return nil }
        let cli = app + "/Contents/Resources/app/out/cli.js"
        return VsCodeInfo(executable: exe, installDirectory: app, version: plistString(app, "CFBundleShortVersionString"),
                          cliScript: ProjectCheck.isFile(cli) ? cli : nil, scope: scope, appBundle: app)
    }

    func findVsCode() -> VsCodeInfo? {
        if MacPlatform.env("NEXYSVHDL_LAUNCHER_FORCE_NO_VSCODE") == "1" { return nil }
        if let override = MacPlatform.env("NEXYSVHDL_VSCODE_PATH") {
            if override.hasSuffix(".app") { if let i = describe(app: override, scope: "override") { return i } }
            else if FileManager.default.isExecutableFile(atPath: override) {
                // A stand-in or unpacked executable: <...>/<name>, with VS Code's CLI script searched beside it.
                let dir = (override as NSString).deletingLastPathComponent
                for rel in ["../Resources/app/out/cli.js", "resources/app/out/cli.js", "abc123/resources/app/out/cli.js"] {
                    let cli = ProjectCheck.fullPath(dir + "/" + rel)
                    if ProjectCheck.isFile(cli) {
                        return VsCodeInfo(executable: override, installDirectory: dir, version: nil, cliScript: cli, scope: "override", appBundle: nil)
                    }
                }
                return VsCodeInfo(executable: override, installDirectory: dir, version: nil, cliScript: nil, scope: "override", appBundle: nil)
            }
        }
        // Standard places first (per-user wins over system, as on Windows), then wherever LaunchServices knows it.
        let name = "Visual Studio Code.app"
        let candidates: [(String, String)] = [("\(home)/Applications/\(name)", "user"), ("/Applications/\(name)", "system")]
        for (app, scope) in candidates { if let i = describe(app: app, scope: scope) { return i } }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: MacPlatform.vscodeBundleId) {
            let scope = url.path.hasPrefix(home + "/") ? "user" : "system"
            if let i = describe(app: url.path, scope: scope) { return i }
        }
        return nil
    }

    // MARK: Extension

    private var extensionsDirectory: String {
        MacPlatform.env("NEXYSVHDL_VSCODE_EXTENSIONS_DIR") ?? "\(home)/.vscode/extensions"
    }

    private static func parseVersion(_ text: String) -> [Int]? {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count >= 2, parts.count <= 4 else { return nil }
        var out: [Int] = []
        for p in parts { guard let n = Int(p), n >= 0 else { return nil }; out.append(n) }
        return out
    }

    private static func isNewer(_ a: [Int], than b: [Int]) -> Bool {
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0, y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    func findExtension(_ vscode: VsCodeInfo) -> ExtensionInfo? {
        let root = extensionsDirectory
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: root) else { return nil }
        var obsolete = Set<String>()
        if let d = FileManager.default.contents(atPath: root + "/.obsolete"), let o = ProjectCheck.parseJSON(d) as? [String: Any] {
            for k in o.keys { obsolete.insert(k.lowercased()) }
        }
        var best: ExtensionInfo?
        var bestVersion: [Int]?
        let prefix = MacPlatform.extensionId + "-"
        for name in names where name.lowercased().hasPrefix(prefix) {
            if obsolete.contains(name.lowercased()) { continue }
            guard ProjectCheck.isDirectory(root + "/" + name) else { continue }
            let rest = String(name.dropFirst(prefix.count))
            let text = rest.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? rest
            guard let v = MacPlatform.parseVersion(text) else { continue }
            if bestVersion == nil || MacPlatform.isNewer(v, than: bestVersion!) {
                bestVersion = v
                best = ExtensionInfo(id: MacPlatform.extensionId, version: text, folder: root + "/" + name)
            }
        }
        return best
    }

    private static func sha256(of path: String) -> String? {
        guard let h = try? FileHandle(forReadingFrom: URL(fileURLWithPath: path)) else { return nil }
        defer { try? h.close() }
        var hasher = SHA256()
        while let chunk = try? h.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Compares every compiled file of the extension (dist/) with the bundled VSIX, byte for byte. Any problem reading
    /// counts as "matches": the launcher never nags on doubt.
    func extensionMatches(_ installed: ExtensionInfo, vsixPath: String) -> Bool {
        let distDir = installed.folder + "/dist"
        guard ProjectCheck.isDirectory(distDir) else { return true }
        let tmp = NSTemporaryDirectory() + "nexysvhdl-vsix-" + UUID().uuidString
        defer { try? FileManager.default.removeItem(atPath: tmp) }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        p.arguments = ["-q", "-o", vsixPath, "extension/dist/*", "-d", tmp]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return true }
        p.waitUntilExit()
        let extracted = tmp + "/extension/dist"
        guard p.terminationStatus == 0, ProjectCheck.isDirectory(extracted),
              let en = FileManager.default.enumerator(atPath: extracted) else { return true }
        for case let rel as String in en {
            let a = extracted + "/" + rel
            if ProjectCheck.isDirectory(a) { continue }
            let b = distDir + "/" + rel
            guard ProjectCheck.isFile(b) else { return false }
            let sa = (try? FileManager.default.attributesOfItem(atPath: a)[.size] as? NSNumber)?.intValue
            let sb = (try? FileManager.default.attributesOfItem(atPath: b)[.size] as? NSNumber)?.intValue
            if sa != sb { return false }
            guard let ha = MacPlatform.sha256(of: a), let hb = MacPlatform.sha256(of: b) else { return true }
            if ha != hb { return false }
        }
        return true
    }

    // MARK: Toolchain

    func findToolchain() -> ToolchainInfo {
        let root = MacPlatform.env("NEXYSVHDL_LAUNCHER_DATA_ROOT") ?? "\(home)/Library/NexysVHDL"
        let marker = root + "/toolchains/darwin-arm64/1.0/.nexysvhdl-installed.json"
        if let d = FileManager.default.contents(atPath: marker), let m = ProjectCheck.parseJSON(d) as? [String: Any],
           (m["bundleVersion"] as? String) == "1.0" {
            return ToolchainInfo(installed: true, version: "1.0", detail: "Installed")
        }
        return ToolchainInfo(installed: false, version: "1.0", detail: "Not installed")
    }

    // MARK: Processes

    /// Arguments that point VS Code at private folders (tests only).
    private static func privateFolderArgs() -> [String] {
        var a: [String] = []
        if let e = env("NEXYSVHDL_VSCODE_EXTENSIONS_DIR") { a += ["--extensions-dir", e] }
        if let d = env("NEXYSVHDL_VSCODE_USER_DATA_DIR") { a += ["--user-data-dir", d] }
        return a
    }

    /// A launcher started from a developer shell must not turn VS Code into a Node process.
    private static func cleanEnvironment() -> [String: String] {
        var e = ProcessInfo.processInfo.environment
        e.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
        e.removeValue(forKey: "VSCODE_DEV")
        return e
    }

    private static func spawn(_ exe: String, _ args: [String], env: [String: String]? = nil) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.environment = env ?? cleanEnvironment()
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
    }

    /// Normal case: ask LaunchServices (/usr/bin/open) to hand the folder or link to the VS Code application, so VS Code is
    /// its own app (single instance, own permissions). With private folders or a bare stand-in executable (tests), start the
    /// executable itself with the same arguments Windows uses.
    private func hand(_ vscode: VsCodeInfo, to target: String, isUri: Bool) throws {
        let priv = MacPlatform.privateFolderArgs()
        if let app = vscode.appBundle, priv.isEmpty {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            p.arguments = ["-a", app, target]
            p.standardInput = FileHandle.nullDevice
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try p.run()
            p.waitUntilExit()
            if p.terminationStatus != 0 { throw NSError(domain: "NexysVHDL", code: Int(p.terminationStatus), userInfo: [NSLocalizedDescriptionKey: "macOS could not open \(app) (status \(p.terminationStatus))."]) }
            return
        }
        try MacPlatform.spawn(vscode.executable, isUri ? ["--open-url"] + priv + ["--", target] : [target] + priv)
    }

    func openFolder(_ vscode: VsCodeInfo, folder: String) throws { try hand(vscode, to: folder, isUri: false) }
    func openUri(_ vscode: VsCodeInfo, uri: String) throws { try hand(vscode, to: uri, isUri: true) }

    func installExtension(_ vscode: VsCodeInfo, vsixPath: String) -> ProcessOutcome {
        guard let cli = vscode.cliScript else {
            return ProcessOutcome(ok: false, exitCode: 0, output: "Visual Studio Code's command-line support was not found in its installation folder.")
        }
        // Same as VS Code's own `code` command, started directly (ELECTRON_RUN_AS_NODE) so no Terminal ever appears.
        var e = MacPlatform.cleanEnvironment()
        e["ELECTRON_RUN_AS_NODE"] = "1"
        e["VSCODE_DEV"] = ""
        let p = Process()
        p.executableURL = URL(fileURLWithPath: vscode.executable)
        p.arguments = [cli, "--install-extension", vsixPath, "--force"] + MacPlatform.privateFolderArgs()
        p.environment = e
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return ProcessOutcome(ok: false, exitCode: 0, output: error.localizedDescription) }
        var collected = Data()
        let reader = DispatchQueue(label: "nexysvhdl.install.read")
        let done = DispatchSemaphore(value: 0)
        reader.async { collected = pipe.fileHandleForReading.readDataToEndOfFile(); done.signal() }
        let deadline = Date().addingTimeInterval(MacPlatform.installTimeout)
        while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        if p.isRunning {
            p.terminate()
            return ProcessOutcome(ok: false, exitCode: 0, output: "Installing took too long and was stopped.")
        }
        _ = done.wait(timeout: .now() + 5)
        let out = String(data: collected, encoding: .utf8) ?? ""
        return ProcessOutcome(ok: p.terminationStatus == 0, exitCode: p.terminationStatus, output: out)
    }

    func openWebPage(_ url: String) {
        if let u = URL(string: url) { NSWorkspace.shared.open(u) }
    }
}
