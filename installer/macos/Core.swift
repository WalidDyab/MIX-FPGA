import Foundation
import CryptoKit

/// What the installer finds on this Mac.
enum InstallMode: Equatable {
    case fresh
    case upgrade(from: String)
    case reinstall
}

struct Detection {
    var codeApp: String?
    var extensionVersion: String?   // emxplore.nexysvhdl, any version
    var mode: InstallMode
    var legacyToolchainStore: Bool  // ~/Library/NexysVHDL (Toolchain 1.0 of NexysVHDL), left untouched
}

struct InstallerConfig {
    var home: String = NSHomeDirectory()
    var codeAppOverride: String?
    var supportDir: String
    var resourcesDir: String
}

let extensionId = "emxplore.nexysvhdl"
let productVersion = "0.7.0"
let vsixName = "nexysvhdl-0.7.0-darwin-arm64.vsix"
let nexysArchive = "nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz"
let de10Archive = "mixfpga-de10-lite-support-1.1-macos-arm64.tar.gz"

struct ProcessResult { var status: Int32; var output: String }

enum InstallError: Error { case message(String) }

final class Installer {
    let config: InstallerConfig
    private var bridge: Process?
    init(config: InstallerConfig) { self.config = config }

    // MARK: running things

    /// The environment for child processes: the real one, with HOME replaced only when a test asks for it.
    private func childEnvironment() -> [String: String] {
        var e = ProcessInfo.processInfo.environment
        e["HOME"] = config.home
        e.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
        return e
    }

    func run(_ exe: String, _ args: [String], env: [String: String]? = nil) -> ProcessResult {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.environment = env ?? childEnvironment()
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return ProcessResult(status: 127, output: "\(error)") }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return ProcessResult(status: p.terminationStatus, output: String(data: data, encoding: .utf8) ?? "")
    }

    // MARK: detection

    func findVSCode() -> String? {
        var candidates: [String] = []
        if let o = config.codeAppOverride { candidates.append(o) } else {
            candidates = ["/Applications/Visual Studio Code.app", config.home + "/Applications/Visual Studio Code.app"]
        }
        return candidates.first { FileManager.default.fileExists(atPath: $0 + "/Contents/Resources/app/bin/code") }
    }

    func codeCLI(_ app: String) -> String { app + "/Contents/Resources/app/bin/code" }

    func installedExtensionVersion(app: String) -> String? {
        let r = run(codeCLI(app), ["--list-extensions", "--show-versions"])
        for line in r.output.split(separator: "\n") where line.lowercased().hasPrefix(extensionId + "@") {
            return String(line.split(separator: "@", maxSplits: 1)[1]).trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    func detect() -> Detection {
        let app = findVSCode()
        let version = app.flatMap { installedExtensionVersion(app: $0) }
        let mode: InstallMode
        if let v = version { mode = v == productVersion ? .reinstall : .upgrade(from: v) } else { mode = .fresh }
        let legacy = FileManager.default.fileExists(atPath: config.home + "/Library/NexysVHDL/toolchains")
        return Detection(codeApp: app, extensionVersion: version, mode: mode, legacyToolchainStore: legacy)
    }

    // MARK: files

    /// Every file of the release the installer is about to use must match the SHA256SUMS next to it.
    func verifyFiles(_ names: [String], report: (String) -> Void) throws {
        let sums = config.supportDir + "/SHA256SUMS"
        guard let text = try? String(contentsOfFile: sums, encoding: .utf8) else { throw InstallError.message("The release checksum list is missing (\(sums)). Run the installer from the MIX-FPGA disk image.") }
        var expected: [String: String] = [:]
        for line in text.split(separator: "\n") {
            let parts = line.split(separator: " ", omittingEmptySubsequences: true)
            if parts.count == 2 { expected[String(parts[1])] = String(parts[0]) }
        }
        for n in names {
            let path = config.supportDir + "/" + n
            guard FileManager.default.fileExists(atPath: path) else { throw InstallError.message("The file \(n) is missing from the installer disk image. Download the MIX-FPGA disk image again.") }
            report("Checking \(n)…")
            guard let want = expected[n] else { throw InstallError.message("\(n) is not listed in the release checksums.") }
            let got = try sha256(path)
            if got != want { throw InstallError.message("\(n) is damaged (its checksum does not match). Nothing was changed. Download the MIX-FPGA disk image again.") }
        }
    }

    func sha256(_ path: String) throws -> String {
        guard let h = FileHandle(forReadingAtPath: path) else { throw InstallError.message("Cannot read \(path).") }
        defer { try? h.close() }
        var hasher = SHA256()
        while true {
            let chunk = h.readData(ofLength: 8 << 20)
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: steps

    func installExtension(app: String, report: (String) -> Void) throws {
        report("Installing MIX-FPGA \(productVersion) in Visual Studio Code…")
        let r = run(codeCLI(app), ["--install-extension", config.supportDir + "/" + vsixName, "--force"])
        if r.status != 0 { throw InstallError.message("Visual Studio Code could not install the extension: \(r.output.trimmingCharacters(in: .whitespacesAndNewlines))") }
        guard installedExtensionVersion(app: app) == productVersion else { throw InstallError.message("The extension was not found after installing it. Open Visual Studio Code once and press Retry.") }
    }

    func installedExtensionFolder() -> String? {
        let dir = config.home + "/.vscode/extensions"
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        for n in names.sorted().reversed() where n.hasPrefix(extensionId + "-") {
            let pj = dir + "/" + n + "/package.json"
            if let d = FileManager.default.contents(atPath: pj), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], j["version"] as? String == productVersion { return dir + "/" + n }
        }
        return nil
    }

    func executable(ofApp app: String) -> String? {
        Bundle(path: app)?.executablePath
    }

    struct BridgeResult { var action: String; var outcome: String?; var message: String?; var stoppedFor: String?; var ok: Bool?; var modified: Bool?; var boards: [String] }

    /// Runs bridge.js under Visual Studio Code's own Node and returns its final result.
    func runBridge(app: String, boards: [String], verify: Bool, report: @escaping (String) -> Void) throws -> BridgeResult {
        guard let ext = installedExtensionFolder() else { throw InstallError.message("The installed MIX-FPGA extension could not be found.") }
        guard let exe = executable(ofApp: app) else { throw InstallError.message("Visual Studio Code's program could not be found.") }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = [config.resourcesDir + "/bridge.js", "--ext", ext, "--support", config.supportDir, "--boards", boards.joined(separator: ",")] + (verify ? ["--verify"] : [])
        var env = childEnvironment()
        env["ELECTRON_RUN_AS_NODE"] = "1"
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        bridge = p
        try p.run()
        var result: BridgeResult?
        var buffer = Data()
        func handle(_ line: Data) {
            guard let o = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let type = o["type"] as? String else { return }
            if type == "progress", let m = o["message"] as? String { report(m) }
            if type == "log", let l = o["line"] as? String { report("  " + l) }
            if type == "result" {
                let bs = (o["boards"] as? [[String: Any]])?.map { "\($0["name"] ?? "") — \($0["word"] ?? "")" } ?? []
                result = BridgeResult(action: o["action"] as? String ?? "", outcome: o["outcome"] as? String, message: o["message"] as? String, stoppedFor: o["stoppedFor"] as? String, ok: o["ok"] as? Bool, modified: o["modified"] as? Bool, boards: bs)
            }
        }
        let h = pipe.fileHandleForReading
        while true {
            let d = h.availableData
            if d.isEmpty { break }
            buffer.append(d)
            while let nl = buffer.firstIndex(of: 10) {
                handle(buffer.subdata(in: buffer.startIndex..<nl))
                buffer.removeSubrange(buffer.startIndex...nl)
            }
        }
        p.waitUntilExit()
        bridge = nil
        guard let r = result else { throw InstallError.message("The setup step stopped unexpectedly. Nothing that was already working was removed. Press Retry.") }
        return r
    }

    func cancel() { bridge?.terminate() }
}
