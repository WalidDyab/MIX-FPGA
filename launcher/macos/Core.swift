import Foundation

// Reusable launcher logic: no AppKit, no process or LaunchServices calls. It is a line-for-line
// Swift port of launcher/core/*.cs (the Windows launcher is C# on the .NET Framework compiler that
// ships with Windows; macOS has no such compiler, so the same rules are repeated here and
// tests/launcher.test.ts keeps both in step: same messages, same contracts).
// The macOS-specific pieces (finding VS Code, starting processes, windows) are in MacPlatform.swift
// and UI.swift and implement the Platform protocol below.

struct VsCodeInfo {
    /// The Electron executable (Contents/MacOS/Code).
    var executable: String
    /// The application bundle (Visual Studio Code.app), or the executable's folder for an override.
    var installDirectory: String
    var version: String?
    /// Node entry point of VS Code's own command line (runs with ELECTRON_RUN_AS_NODE), used to install extensions without any visible window.
    var cliScript: String?
    /// "user", "system" or "override".
    var scope: String
    /// The .app bundle when there is one (opened through LaunchServices), nil for an override that is a bare executable.
    var appBundle: String?
}

struct ExtensionInfo {
    var id: String
    var version: String
    var folder: String
}

struct ToolchainInfo {
    var installed: Bool
    var version: String
    var detail: String
}

struct ProcessOutcome {
    var ok: Bool
    var exitCode: Int32
    var output: String
}

protocol Platform {
    /// Per-user folder for launcher state (never inside a project).
    var stateDirectory: String { get }
    func findVsCode() -> VsCodeInfo?
    func findExtension(_ vscode: VsCodeInfo) -> ExtensionInfo?
    /// True when the installed extension is the same build as the bundled VSIX (the version number alone cannot tell a development build from the release).
    func extensionMatches(_ installed: ExtensionInfo, vsixPath: String) -> Bool
    func findToolchain() -> ToolchainInfo
    func openFolder(_ vscode: VsCodeInfo, folder: String) throws
    func openUri(_ vscode: VsCodeInfo, uri: String) throws
    func installExtension(_ vscode: VsCodeInfo, vsixPath: String) -> ProcessOutcome
    func openWebPage(_ url: String)
}

struct LauncherStatus {
    var vsCode: VsCodeInfo?
    var extensionInfo: ExtensionInfo?
    var toolchain: ToolchainInfo
    /// The extension is installed but is not the build bundled with this launcher.
    var extensionOutdated = false
    var extensionId = "emxplore.nexysvhdl"

    var vsCodeFound: Bool { vsCode != nil }
    var extensionFound: Bool { extensionInfo != nil }
    var canOpen: Bool { vsCodeFound && extensionFound }
}

enum OpenOutcome {
    case opened
    /// The folder is not a NexysVHDL project (or does not exist).
    case notAProject
    case needsVsCode
    case needsExtension
    case failed
}

struct OpenResult {
    var outcome: OpenOutcome
    /// Student-readable text.
    var message: String
    var ok: Bool { outcome == .opened }
}

// MARK: - Project files

struct ProjectFileResolution {
    var ok: Bool
    /// The project folder (the one holding nexysvhdl.json) when ok.
    var root: String?
    /// A student-readable explanation when not ok.
    var message: String?
    static func fail(_ message: String) -> ProjectFileResolution { ProjectFileResolution(ok: false, root: nil, message: message) }
}

/// What makes a folder a NexysVHDL project: it contains nexysvhdl.json. A project may also have a .nvproj file, a small
/// versioned launch descriptor { "format": "nexysvhdl-project", "version": 1, "config": "nexysvhdl.json" } that points
/// (relatively) at the settings file. The rules are the same as core/project/nvproj.ts in the extension.
enum ProjectCheck {
    static let projectFile = "nexysvhdl.json"
    static let projectFileExtension = ".nvproj"
    static let projectFileFormat = "nexysvhdl-project"
    static let supportedProjectFileVersion = 1

    static func fullPath(_ path: String) -> String {
        URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardized.path
    }

    static func isFile(_ path: String) -> Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &dir) && !dir.boolValue
    }

    static func isDirectory(_ path: String) -> Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &dir) && dir.boolValue
    }

    static func isProject(_ folder: String?) -> Bool {
        guard let folder = folder, !folder.isEmpty else { return false }
        return isFile((folder as NSString).appendingPathComponent(projectFile))
    }

    /// True for a path that names a .nvproj project file.
    static func isProjectFile(_ path: String?) -> Bool {
        guard let path = path, !path.isEmpty else { return false }
        return path.trimmingCharacters(in: .whitespaces).lowercased().hasSuffix(projectFileExtension)
    }

    /// A safe relative path to nexysvhdl.json (forward slashes), or nil.
    static func normalizeConfigPath(_ value: Any?) -> String? {
        guard let s = value as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !s.contains("\0") else { return nil }
        let path = s.replacingOccurrences(of: "\\", with: "/")
        if path.hasPrefix("/") { return nil }
        let chars = Array(path)
        if chars.count >= 2, chars[0].isLetter, chars[1] == ":" { return nil }
        let parts = path.components(separatedBy: "/")
        for part in parts where part.isEmpty || part == "." || part == ".." { return nil }
        if parts.last!.lowercased() != projectFile { return nil }
        return parts.joined(separator: "/")
    }

    /// Parses JSON; a leading byte-order mark is ignored. nil when it is not valid JSON.
    static func parseJSON(_ data: Data) -> Any? {
        var d = data
        if d.starts(with: [0xEF, 0xBB, 0xBF]) { d = d.dropFirst(3) }
        return try? JSONSerialization.jsonObject(with: d, options: [.fragmentsAllowed])
    }

    /// Reads a .nvproj, validates it and finds the project folder it launches.
    static func resolveProjectFile(_ file: String) -> ProjectFileResolution {
        let full = fullPath(file)
        let name = (full as NSString).lastPathComponent
        if !isFile(full) { return .fail("The project file \(name) does not exist any more.") }
        guard let data = FileManager.default.contents(atPath: full) else { return .fail("The project file could not be read: \(name)") }
        guard let d = parseJSON(data) as? [String: Any] else { return .fail("This NexysVHDL project file is damaged: it is not valid JSON.") }
        guard let format = d["format"] as? String, format == projectFileFormat else {
            return .fail("This is not a NexysVHDL project file (its \"format\" is not \"\(projectFileFormat)\").")
        }
        var version = -1.0
        if let n = d["version"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { version = n.doubleValue }
        if version < 1 || version.rounded(.down) != version { return .fail("This NexysVHDL project file has an invalid \"version\".") }
        if version > Double(supportedProjectFileVersion) {
            return .fail("This project file was made by a newer NexysVHDL (file version \(Int(version)); this one understands \(supportedProjectFileVersion)). Update NexysVHDL to open it.")
        }
        guard let config = normalizeConfigPath(d["config"]) else {
            return .fail("This NexysVHDL project file points at an unusable settings file. \"config\" must be a relative path inside the project folder that ends in \(projectFile).")
        }
        let configFile = fullPath(((full as NSString).deletingLastPathComponent as NSString).appendingPathComponent(config))
        if !isFile(configFile) {
            return .fail("\(name) points at \(config), which was not found next to it. Was the project folder copied without it?")
        }
        return ProjectFileResolution(ok: true, root: (configFile as NSString).deletingLastPathComponent, message: nil)
    }

    /// A friendly explanation of why a folder is not usable, or nil if it is a project.
    static func problem(_ folder: String?) -> String? {
        guard let folder = folder, !folder.isEmpty else { return "No folder was chosen." }
        if !isDirectory(folder) { return "That folder does not exist any more." }
        if !isProject(folder) {
            let last = (folder as NSString).lastPathComponent
            let name = last.isEmpty ? folder : last
            return "\"\(name)\" is not a NexysVHDL project: it has no \(projectFile) file.\n\nChoose the project folder itself (the one that contains \(projectFile)), or use New Project to start a new one."
        }
        return nil
    }
}

// MARK: - Recent projects

struct RecentProject {
    var path: String
    var name: String
    var lastOpenedUtc: Date
    /// False when the folder or its nexysvhdl.json no longer exists.
    var exists = false
}

/// Recently opened NexysVHDL projects, kept per user in the launcher's own state folder (never inside a project):
/// recent-projects.json, { "version": 1, "projects": [ { "path", "name", "lastOpenedUtc" } ] }, newest first.
/// A missing, empty or damaged file is an empty list; the file is never fatal.
final class RecentProjects {
    static let maxEntries = 10
    static let fileName = "recent-projects.json"
    let filePath: String

    init(stateDirectory: String) {
        filePath = (stateDirectory as NSString).appendingPathComponent(RecentProjects.fileName)
    }

    /// Compare case-insensitively (the default macOS volume format), ignoring a trailing separator.
    static func key(_ path: String) -> String {
        var p = ProjectCheck.fullPath(path)
        while p.count > 1 && p.hasSuffix("/") { p.removeLast() }
        return p.lowercased()
    }

    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private func load() -> [RecentProject] {
        guard let data = FileManager.default.contents(atPath: filePath),
              let root = ProjectCheck.parseJSON(data) as? [String: Any],
              let items = root["projects"] as? [Any] else { return [] }
        var list: [RecentProject] = []
        for o in items {
            guard let d = o as? [String: Any], let path = d["path"] as? String else { continue }
            let name = (d["name"] as? String) ?? (path as NSString).lastPathComponent
            var date = Date.distantPast
            if let s = d["lastOpenedUtc"] as? String {
                date = RecentProjects.iso.date(from: s) ?? ISO8601DateFormatter().date(from: s) ?? Date.distantPast
            }
            list.append(RecentProject(path: path, name: name, lastOpenedUtc: date))
        }
        return list
    }

    private func save(_ list: [RecentProject]) throws {
        let items: [[String: Any]] = list.map { ["path": $0.path, "name": $0.name, "lastOpenedUtc": RecentProjects.iso.string(from: $0.lastOpenedUtc)] }
        let root: [String: Any] = ["version": 1, "projects": items]
        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        try FileManager.default.createDirectory(atPath: (filePath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        // Write then replace, so a crash never leaves half a file.
        try data.write(to: URL(fileURLWithPath: filePath), options: .atomic)
    }

    /// Records that a project was opened (moves it to the top).
    func add(_ folder: String, nowUtc: Date) {
        let full = ProjectCheck.fullPath(folder)
        var list = load().filter { RecentProjects.key($0.path) != RecentProjects.key(full) }
        list.insert(RecentProject(path: full, name: (full as NSString).lastPathComponent, lastOpenedUtc: nowUtc), at: 0)
        if list.count > RecentProjects.maxEntries { list.removeLast(list.count - RecentProjects.maxEntries) }
        try? save(list) // remembering is a convenience; never block opening a project
    }

    /// The list, newest first, each marked with whether the project is still there.
    func list() -> [RecentProject] {
        load().map { var r = $0; r.exists = ProjectCheck.isProject(r.path); return r }
    }

    /// Forgets one project (for a folder that was deleted).
    func remove(_ folder: String) {
        try? save(load().filter { RecentProjects.key($0.path) != RecentProjects.key(folder) })
    }

    func clear() { try? save([]) }
}

// MARK: - Behavior

/// The launcher's behavior, independent of any operating system: it decides what can be opened and what to tell the
/// student, and asks Platform to do the system-specific work. Project creation is NOT done here: New Project asks the
/// installed NexysVHDL extension to run its own command.
final class LauncherService {
    /// The extension's link that runs its existing "Create Project" command.
    static let newProjectUri = "vscode://emxplore.nexysvhdl/newProject"
    static let getVsCodeUrl = "https://code.visualstudio.com/Download"

    let platform: Platform
    let recent: RecentProjects
    let bundledVsix: String?

    /// - Parameter bundledVsix: The NexysVHDL extension file shipped with the launcher (nil if there is none).
    init(platform: Platform, bundledVsix: String?) {
        self.platform = platform
        self.bundledVsix = bundledVsix
        self.recent = RecentProjects(stateDirectory: platform.stateDirectory)
    }

    func getStatus() -> LauncherStatus {
        let vs = platform.findVsCode()
        let ext = vs.flatMap { platform.findExtension($0) }
        var s = LauncherStatus(vsCode: vs, extensionInfo: ext, toolchain: platform.findToolchain())
        if let ext = ext, let vsix = bundledVsix, ProjectCheck.isFile(vsix) {
            s.extensionOutdated = !platform.extensionMatches(ext, vsixPath: vsix)
        }
        return s
    }

    private func notReady(_ s: LauncherStatus) -> OpenResult? {
        if !s.vsCodeFound { return OpenResult(outcome: .needsVsCode, message: "Visual Studio Code is not installed. NexysVHDL runs inside VS Code, which is free.") }
        if !s.extensionFound { return OpenResult(outcome: .needsExtension, message: "The NexysVHDL extension is not installed in Visual Studio Code yet.") }
        return nil
    }

    /// Opens a project folder in VS Code (the extension activates by itself because the folder holds nexysvhdl.json).
    func openProject(_ folder: String) -> OpenResult {
        if let problem = ProjectCheck.problem(folder) {
            if !folder.isEmpty && !ProjectCheck.isDirectory(folder) { recent.remove(folder) }
            return OpenResult(outcome: .notAProject, message: problem)
        }
        let s = getStatus()
        if let n = notReady(s) { return n }
        do {
            try platform.openFolder(s.vsCode!, folder: ProjectCheck.fullPath(folder))
        } catch {
            return OpenResult(outcome: .failed, message: "Visual Studio Code could not be started: \(error.localizedDescription)")
        }
        recent.add(folder, nowUtc: Date())
        return OpenResult(outcome: .opened, message: "Opened in Visual Studio Code.")
    }

    /// Opens whatever the student double-clicked or chose: a .nvproj project file or a project folder. A project file is
    /// validated first; its folder then goes through the normal openProject path (same VS Code start, same recent list),
    /// never a vscode:// link.
    func openTarget(_ path: String) -> OpenResult {
        if ProjectCheck.isProjectFile(path) {
            let r = ProjectCheck.resolveProjectFile(path)
            if !r.ok { return OpenResult(outcome: .notAProject, message: r.message ?? "") }
            return openProject(r.root!)
        }
        return openProject(path)
    }

    /// New Project: the extension's own Create Project command does the work.
    func newProject() -> OpenResult {
        let s = getStatus()
        if let n = notReady(s) { return n }
        do {
            try platform.openUri(s.vsCode!, uri: LauncherService.newProjectUri)
        } catch {
            return OpenResult(outcome: .failed, message: "Visual Studio Code could not be started: \(error.localizedDescription)")
        }
        return OpenResult(outcome: .opened, message: "Continue in Visual Studio Code.")
    }

    func openWebPage() { platform.openWebPage(LauncherService.getVsCodeUrl) }

    /// Installs the bundled NexysVHDL VSIX (only when the student asks for it).
    func installExtension(_ vsixPath: String) -> OpenResult {
        let s = getStatus()
        if !s.vsCodeFound { return notReady(s)! }
        if !ProjectCheck.isFile(vsixPath) { return OpenResult(outcome: .failed, message: "The NexysVHDL extension file is missing from this installation. Download NexysVHDL again.") }
        let r = s.vsCode.map { platform.installExtension($0, vsixPath: vsixPath) }!
        if !r.ok {
            let out = r.output.trimmingCharacters(in: .whitespacesAndNewlines)
            return OpenResult(outcome: .failed, message: "The NexysVHDL extension could not be installed" + (out.isEmpty ? "." : ":\n" + out))
        }
        return OpenResult(outcome: .opened, message: "The NexysVHDL extension is installed.")
    }
}
