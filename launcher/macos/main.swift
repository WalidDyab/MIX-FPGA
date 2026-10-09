import AppKit

// NexysVHDL.app: the application a student starts from the Dock, Launchpad or Finder.
//   (no arguments)             the launcher window
//   double-click Project.nvproj  macOS sends the file to the running/starting app (Apple "open documents" event)
//   Project.nvproj             open the project of a project file (also accepted as a command-line argument)
//   --open "path"              open a project directly: a project folder or a .nvproj file (tests)
//   --new-project              ask NexysVHDL to create a project
//   --status-report "file"     write what was detected as JSON and exit (tests)
// Test hook: NEXYSVHDL_LAUNCHER_MESSAGE_FILE=file writes a problem message there instead of showing a dialog.

let bundleVsix: String? = Bundle.main.resourcePath.map { $0 + "/nexysvhdl.vsix" }
let service = LauncherService(platform: MacPlatform(), bundledVsix: bundleVsix)

func writeReport(_ file: String) {
    let s = service.getStatus()
    var d: [String: Any] = [
        "vscodeFound": s.vsCodeFound,
        "extensionFound": s.extensionFound,
        "extensionOutdated": s.extensionOutdated,
        "toolchainInstalled": s.toolchain.installed,
        "toolchainVersion": s.toolchain.version,
    ]
    d["vscodeExecutable"] = s.vsCode?.executable ?? NSNull()
    d["vscodeVersion"] = s.vsCode?.version ?? NSNull()
    d["vscodeScope"] = s.vsCode?.scope ?? NSNull()
    d["vscodeCli"] = s.vsCode?.cliScript ?? NSNull()
    d["extensionVersion"] = s.extensionInfo?.version ?? NSNull()
    if let data = try? JSONSerialization.data(withJSONObject: d, options: [.prettyPrinted, .sortedKeys]) {
        try? (String(data: data, encoding: .utf8)! + "\n").write(toFile: file, atomically: true, encoding: .utf8)
    }
}

/// Reports a problem the way the Windows launcher does: a normal message box, or (tests) a file.
func report(_ r: OpenResult) {
    if let f = ProcessInfo.processInfo.environment["NEXYSVHDL_LAUNCHER_MESSAGE_FILE"], !f.isEmpty {
        try? r.message.write(toFile: f, atomically: true, encoding: .utf8)
        return
    }
    let a = NSAlert()
    a.messageText = "NexysVHDL"
    a.informativeText = r.message
    a.alertStyle = r.outcome == .notAProject ? .informational : .warning
    a.addButton(withTitle: "OK")
    NSApp.activate(ignoringOtherApps: true)
    a.runModal()
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var controller: LauncherWindowController?
    var handledDocument = false

    /// Finder double-click on a .nvproj (or a folder dropped on the icon): validate, open in VS Code, no window.
    func application(_ application: NSApplication, open urls: [URL]) {
        handledDocument = true
        var last: OpenResult?
        for url in urls.prefix(1) {
            let r = service.openTarget(url.path)
            if !r.ok { report(r) }
            last = r
        }
        // The launcher has done its job; only stay if a problem left the window up.
        if last?.ok ?? true, controller?.window.isVisible != true { NSApp.terminate(nil) }
        else if controller?.window.isVisible != true { NSApp.terminate(nil) }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = makeMenu()
        // The "open documents" event arrives before this; wait one turn of the run loop to be sure, then show the window.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [self] in
            if !handledDocument { showWindow() }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { handledDocument ? false : true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        for r in service.recent.list().prefix(5) where r.exists {
            let item = NSMenuItem(title: r.name, action: #selector(openRecent(_:)), keyEquivalent: "")
            item.representedObject = r.path
            item.target = self
            menu.addItem(item)
        }
        return menu.items.isEmpty ? nil : menu
    }

    @objc func openRecent(_ sender: NSMenuItem) {
        guard let p = sender.representedObject as? String else { return }
        let r = service.openProject(p)
        if !r.ok { report(r) }
    }

    func showWindow() {
        if controller == nil {
            controller = LauncherWindowController(service: service, vsixPath: bundleVsix ?? "")
            controller?.onFinished = { NSApp.terminate(nil) }
        }
        controller?.show()
    }

    @objc func menuNew() { showWindow(); controller?.doNew() }
    @objc func menuOpen() { showWindow(); controller?.doOpen() }

    func makeMenu() -> NSMenu {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu(); appItem.submenu = app
        app.addItem(withTitle: "About NexysVHDL", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide NexysVHDL", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit NexysVHDL", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let fileItem = NSMenuItem(); main.addItem(fileItem)
        let file = NSMenu(title: "File"); fileItem.submenu = file
        let n = file.addItem(withTitle: "New Project", action: #selector(menuNew), keyEquivalent: "n"); n.target = self
        let o = file.addItem(withTitle: "Open Project…", action: #selector(menuOpen), keyEquivalent: "o"); o.target = self
        file.addItem(.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        return main
    }
}

// Command-line forms (tests, and `NexysVHDL "Project.nvproj"` from a shell). LaunchServices passes none of these.
let args = Array(CommandLine.arguments.dropFirst()).filter { !$0.hasPrefix("-psn_") }
var i = 0
while i < args.count {
    let a = args[i]
    if a == "--status-report", i + 1 < args.count { writeReport(args[i + 1]); exit(0) }
    var target: String?
    var isNew = false
    if a == "--open", i + 1 < args.count { target = args[i + 1] }
    else if a == "--new-project" { isNew = true }
    else if !a.hasPrefix("-"), ProjectCheck.isProjectFile(a) { target = a }
    if target != nil || isNew {
        let r = isNew ? service.newProject() : service.openTarget(target!)
        if !r.ok {
            _ = NSApplication.shared
            report(r)
            exit(1)
        }
        exit(0)
    }
    i += 1
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = AppDelegate()
application.delegate = delegate
application.run()
