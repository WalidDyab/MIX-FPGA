import AppKit

final class InstallerApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let installer: Installer
    var window: NSWindow!
    var detection: Detection!
    var working = false

    let titleLabel = NSTextField(labelWithString: "MIX-FPGA 0.7.0")
    let subtitleLabel = NSTextField(labelWithString: "FPGA development for Nexys A7 and DE10-Lite")
    let body = NSTextField(wrappingLabelWithString: "")
    let nexysBox = NSButton(checkboxWithTitle: "Nexys A7", target: nil, action: nil)
    let de10Box = NSButton(checkboxWithTitle: "DE10-Lite", target: nil, action: nil)
    let progress = NSProgressIndicator()
    let logView = NSTextView()
    let logScroll = NSScrollView()
    let primary = NSButton(title: "Continue", target: nil, action: nil)
    let secondary = NSButton(title: "Quit", target: nil, action: nil)
    let footer = NSTextField(labelWithString: "MIX-FPGA is an EMXplore project. Copyright 2026 Walid Dyab.")
    var lastLog = ""
    var step = "welcome"
    var lastOutcome: Outcome?

    init(installer: Installer) { self.installer = installer }

    func applicationDidFinishLaunching(_ n: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 460), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "MIX-FPGA Installer"
        window.delegate = self
        window.center()
        let content = window.contentView!
        titleLabel.font = .boldSystemFont(ofSize: 26)
        subtitleLabel.font = .systemFont(ofSize: 14)
        subtitleLabel.textColor = .secondaryLabelColor
        body.font = .systemFont(ofSize: 13)
        footer.font = .systemFont(ofSize: 11)
        footer.textColor = .secondaryLabelColor
        nexysBox.state = .on
        progress.style = .bar
        progress.isIndeterminate = true
        logView.isEditable = false
        logView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        logScroll.documentView = logView
        logScroll.hasVerticalScroller = true
        logScroll.borderType = .bezelBorder
        primary.bezelStyle = .rounded
        primary.keyEquivalent = "\r"
        primary.target = self; primary.action = #selector(primaryClicked)
        secondary.bezelStyle = .rounded
        secondary.target = self; secondary.action = #selector(secondaryClicked)
        for v in [titleLabel, subtitleLabel, body, nexysBox, de10Box, progress, logScroll, primary, secondary, footer] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(v)
        }
        NSLayoutConstraint.activate([
            titleLabel.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            titleLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
            subtitleLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 2),
            subtitleLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            body.topAnchor.constraint(equalTo: subtitleLabel.bottomAnchor, constant: 20),
            body.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
            nexysBox.topAnchor.constraint(equalTo: body.bottomAnchor, constant: 14),
            nexysBox.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor, constant: 8),
            de10Box.topAnchor.constraint(equalTo: nexysBox.bottomAnchor, constant: 8),
            de10Box.leadingAnchor.constraint(equalTo: nexysBox.leadingAnchor),
            progress.topAnchor.constraint(equalTo: de10Box.bottomAnchor, constant: 14),
            progress.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: body.trailingAnchor),
            logScroll.topAnchor.constraint(equalTo: progress.bottomAnchor, constant: 10),
            logScroll.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            logScroll.trailingAnchor.constraint(equalTo: body.trailingAnchor),
            logScroll.bottomAnchor.constraint(equalTo: primary.topAnchor, constant: -12),
            primary.trailingAnchor.constraint(equalTo: body.trailingAnchor),
            primary.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -10),
            secondary.trailingAnchor.constraint(equalTo: primary.leadingAnchor, constant: -10),
            secondary.centerYAnchor.constraint(equalTo: primary.centerYAnchor),
            footer.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            footer.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -12),
        ])
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        detectAndShow()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if working { let a = NSAlert(); a.messageText = "Installation is running"; a.informativeText = "Wait until it finishes. Closing now could leave setup half done (it can be repaired, nothing you already had is removed)."; a.runModal(); return false }
        return true
    }

    func setLogVisible(_ v: Bool) { progress.isHidden = !v; logScroll.isHidden = !v }
    func setBoardsVisible(_ v: Bool) { nexysBox.isHidden = !v; de10Box.isHidden = !v }

    func detectAndShow() {
        step = "welcome"
        setLogVisible(false); setBoardsVisible(false)
        detection = installer.detect()
        guard detection.codeApp != nil else {
            body.stringValue = "Visual Studio Code is not installed.\n\nMIX-FPGA works inside Visual Studio Code. Install it from https://code.visualstudio.com (choose the Apple silicon download), move it to Applications, then press Retry. The installer does not download anything for you."
            primary.title = "Retry"; secondary.title = "Quit"; primary.isEnabled = true
            return
        }
        switch detection.mode {
        case .fresh:
            body.stringValue = "Fresh install.\n\nThis installs MIX-FPGA 0.7.0 in Visual Studio Code and the board support you choose. It needs no other software from you except, for the DE10-Lite, Altera's free Quartus files (a later step, with Altera's own licence)."
        case .upgrade(let v):
            body.stringValue = "Upgrade from NexysVHDL \(v).\n\nMIX-FPGA 0.7.0 is installed over NexysVHDL: your projects, settings and project files stay as they are, and nothing is uninstalled first. MIX-FPGA 0.7.0 uses Toolchain 1.1, so the Nexys A7 support from this disk image is installed again for it. Your old tools (Toolchain 1.0) are left untouched." + (detection.legacyToolchainStore ? "" : "")
        case .reinstall:
            body.stringValue = "MIX-FPGA 0.7.0 is already installed.\n\nRepair/Reinstall puts the extension back and checks the board support you choose. Board support that is already complete is left alone; your projects are not touched."
        }
        primary.title = "Continue"; secondary.title = "Quit"; primary.isEnabled = true
    }

    func showBoards() {
        step = "boards"
        body.stringValue = "Which board do you use? Tick one or both. You can add the other board later by running this installer again."
        setBoardsVisible(true)
        primary.title = detection.mode == .reinstall ? "Repair / Reinstall" : (detection.mode == .fresh ? "Install" : "Upgrade")
        secondary.title = "Back"
    }

    func startInstall() {
        var boards: [String] = []
        if nexysBox.state == .on { boards.append("nexys") }
        if de10Box.state == .on { boards.append("de10") }
        guard !boards.isEmpty, let app = detection.codeApp else { NSSound.beep(); return }
        step = "working"; working = true
        setBoardsVisible(false); setLogVisible(true)
        body.stringValue = "Installing. Please keep this window open."
        logView.string = ""
        progress.startAnimation(nil)
        primary.isEnabled = false; secondary.title = "Cancel installation"
        let mode = detection.mode
        DispatchQueue.global().async {
            let o = self.installer.perform(app: app, mode: mode, boards: boards) { m in DispatchQueue.main.async { self.log(m) } }
            DispatchQueue.main.async { self.finish(o) }
        }
    }

    func log(_ m: String) {
        if m == lastLog { return }
        lastLog = m
        logView.textStorage?.append(NSAttributedString(string: m + "\n", attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular), .foregroundColor: NSColor.labelColor]))
        logView.scrollToEndOfDocument(nil)
    }

    func finish(_ o: Outcome) {
        working = false; step = "done"; lastOutcome = o
        progress.stopAnimation(nil)
        body.stringValue = o.title + "\n\n" + o.details.joined(separator: "\n") + (o.ok ? "\n\nOpen Visual Studio Code, click the MIX-FPGA icon, and choose Show Environment." : "")
        primary.isEnabled = true
        if o.ok { primary.title = "Open Visual Studio Code"; secondary.title = "Quit" } else { primary.title = "Retry"; secondary.title = "Quit" }
    }

    @objc func primaryClicked() {
        switch step {
        case "welcome": if detection.codeApp == nil { detectAndShow() } else { showBoards() }
        case "boards": startInstall()
        case "done":
            if lastOutcome?.ok == true {
                if let app = detection.codeApp { NSWorkspace.shared.open(URL(fileURLWithPath: app)) }
                NSApp.terminate(nil)
            } else { detectAndShow() }
        default: break
        }
    }

    @objc func secondaryClicked() {
        switch step {
        case "boards": detectAndShow()
        case "working": installer.cancel()
        default: NSApp.terminate(nil)
        }
    }
}
