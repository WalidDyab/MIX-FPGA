import AppKit

// The NexysVHDL launcher window: New Project, Open Project, Recent Projects and what is ready. Same screens and wording
// as the Windows launcher (launcher/windows/MainForm.cs).

enum Palette {
    static let navy = NSColor(srgbRed: 15 / 255, green: 27 / 255, blue: 45 / 255, alpha: 1)
    static let navyLight = NSColor(srgbRed: 22 / 255, green: 38 / 255, blue: 63 / 255, alpha: 1)
    static let orange = NSColor(srgbRed: 242 / 255, green: 140 / 255, blue: 40 / 255, alpha: 1)
    static let green = NSColor(srgbRed: 46 / 255, green: 139 / 255, blue: 87 / 255, alpha: 1)
    static let red = NSColor(srgbRed: 200 / 255, green: 60 / 255, blue: 50 / 255, alpha: 1)
    static let amber = NSColor(srgbRed: 190 / 255, green: 120 / 255, blue: 20 / 255, alpha: 1)
    static let grey = NSColor(srgbRed: 110 / 255, green: 120 / 255, blue: 135 / 255, alpha: 1)
    static let disabled = NSColor(srgbRed: 150 / 255, green: 158 / 255, blue: 170 / 255, alpha: 1)
}

/// A flat, colored button (the system bezel cannot take the NexysVHDL colors).
final class FlatButton: NSButton {
    var fill: NSColor = Palette.navy { didSet { needsDisplay = true } }
    var hoverFill: NSColor? = Palette.navyLight
    var textColor: NSColor = .white { didSet { needsDisplay = true } }
    var titleFont: NSFont = .systemFont(ofSize: 13, weight: .semibold)
    var subtitle: String?
    private var hovering = false

    override var isEnabled: Bool { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for a in trackingAreas { removeTrackingArea(a) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }

    override func draw(_ dirtyRect: NSRect) {
        let color = isEnabled ? (hovering ? (hoverFill ?? fill) : fill) : Palette.disabled
        color.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
        let para = NSMutableParagraphStyle()
        para.alignment = subtitle == nil ? .center : .left
        let titleAttrs: [NSAttributedString.Key: Any] = [.font: titleFont, .foregroundColor: textColor, .paragraphStyle: para]
        if let sub = subtitle {
            (title as NSString).draw(at: NSPoint(x: 14, y: 18), withAttributes: titleAttrs)
            (sub as NSString).draw(at: NSPoint(x: 14, y: 42), withAttributes: [.font: NSFont.systemFont(ofSize: 11.5), .foregroundColor: textColor.withAlphaComponent(0.75)])
        } else {
            let size = (title as NSString).size(withAttributes: titleAttrs)
            (title as NSString).draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: titleAttrs)
        }
    }
}

final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

final class LauncherWindowController: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSWindowDelegate {
    let service: LauncherService
    let vsixPath: String
    let window: NSWindow
    var status: LauncherStatus?
    var shown: [RecentProject] = []
    var onFinished: (() -> Void)?

    let newButton = FlatButton()
    let openButton = FlatButton()
    let table = NSTableView()
    let vsLabel = NSTextField(labelWithString: "")
    let extLabel = NSTextField(labelWithString: "")
    let tcLabel = NSTextField(labelWithString: "")
    let hint = NSTextField(wrappingLabelWithString: "")
    let actionButton = FlatButton()
    let recheck = NSButton(title: "Check again", target: nil, action: nil)
    let busy = NSTextField(labelWithString: "")
    var actionKind = ""

    init(service: LauncherService, vsixPath: String) {
        self.service = service
        self.vsixPath = vsixPath
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 560), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        super.init()
        window.title = "NexysVHDL"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        build()
    }

    private func place(_ v: NSView, _ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, in parent: NSView) {
        v.frame = NSRect(x: x, y: y, width: w, height: h)
        parent.addSubview(v)
    }

    private func build() {
        let root = FlippedView(frame: NSRect(x: 0, y: 0, width: 600, height: 560))
        window.contentView = root

        let header = FlippedView()
        header.wantsLayer = true
        header.layer?.backgroundColor = Palette.navy.cgColor
        place(header, 0, 0, 600, 96, in: root)
        let title = NSTextField(labelWithString: "NexysVHDL")
        title.font = .systemFont(ofSize: 26, weight: .semibold)
        title.textColor = .white
        place(title, 24, 14, 400, 36, in: header)
        let sub = NSTextField(labelWithString: "Design VHDL for the Digilent Nexys A7 FPGA")
        sub.font = .systemFont(ofSize: 13)
        sub.textColor = NSColor(srgbRed: 170 / 255, green: 185 / 255, blue: 210 / 255, alpha: 1)
        place(sub, 26, 56, 500, 20, in: header)
        let accent = NSView()
        accent.wantsLayer = true
        accent.layer?.backgroundColor = Palette.orange.cgColor
        place(accent, 0, 92, 600, 4, in: header)

        newButton.title = "New Project"; newButton.subtitle = "Create a project from a starter"
        openButton.title = "Open Project"; openButton.subtitle = "Choose a project file or folder"
        for b in [newButton, openButton] { b.isBordered = false; b.setButtonType(.momentaryChange); b.titleFont = .systemFont(ofSize: 14, weight: .semibold) }
        place(newButton, 24, 118, 264, 80, in: root)
        place(openButton, 312, 118, 264, 80, in: root)
        newButton.target = self; newButton.action = #selector(doNew)
        openButton.target = self; openButton.action = #selector(doOpen)

        let recentTitle = NSTextField(labelWithString: "Recent Projects")
        recentTitle.font = .systemFont(ofSize: 14, weight: .semibold)
        place(recentTitle, 24, 216, 300, 22, in: root)

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .lineBorder
        for (id, w, name) in [("name", 150.0, "Project"), ("path", 300.0, "Folder"), ("when", 80.0, "Opened")] {
            let c = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
            c.width = w; c.title = name
            table.addTableColumn(c)
        }
        table.headerView = nil
        table.dataSource = self
        table.delegate = self
        table.allowsMultipleSelection = false
        table.rowHeight = 22
        table.target = self
        table.doubleAction = #selector(openSelected)
        let menu = NSMenu()
        menu.addItem(withTitle: "Open", action: #selector(openSelected), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Remove from this list", action: #selector(forgetSelected), keyEquivalent: "").target = self
        table.menu = menu
        scroll.documentView = table
        place(scroll, 24, 244, 552, 150, in: root)

        let line = NSView()
        line.wantsLayer = true
        line.layer?.backgroundColor = NSColor(srgbRed: 225 / 255, green: 229 / 255, blue: 236 / 255, alpha: 1).cgColor
        place(line, 24, 410, 552, 1, in: root)

        for (l, y) in [(vsLabel, 420.0), (extLabel, 442.0), (tcLabel, 464.0)] {
            l.font = .systemFont(ofSize: 13)
            place(l, 24, y, 372, 20, in: root)
        }
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = Palette.grey
        place(hint, 24, 492, 372, 52, in: root)

        actionButton.fill = Palette.orange; actionButton.hoverFill = Palette.orange.blended(withFraction: 0.12, of: .white)
        actionButton.textColor = Palette.navy; actionButton.isBordered = false
        actionButton.isHidden = true
        actionButton.target = self; actionButton.action = #selector(doAction)
        place(actionButton, 404, 422, 172, 36, in: root)

        recheck.isBordered = false
        recheck.attributedTitle = NSAttributedString(string: "Check again", attributes: [.foregroundColor: NSColor(srgbRed: 40 / 255, green: 100 / 255, blue: 190 / 255, alpha: 1), .font: NSFont.systemFont(ofSize: 13)])
        recheck.isHidden = true
        recheck.target = self; recheck.action = #selector(refreshAll)
        place(recheck, 404, 464, 172, 24, in: root)

        busy.font = .systemFont(ofSize: 13, weight: .semibold)
        busy.textColor = Palette.navy
        busy.alignment = .center
        busy.isHidden = true
        place(busy, 404, 430, 172, 22, in: root)
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        refreshAll()
    }

    func windowDidBecomeKey(_ notification: Notification) { refreshAll() }

    private func setStatus(_ l: NSTextField, ok: Bool, _ text: String) {
        l.stringValue = (ok ? "✓  " : "✗  ") + text
        l.textColor = ok ? Palette.green : Palette.red
    }

    @objc func refreshAll() {
        let s = service.getStatus()
        status = s
        setStatus(vsLabel, ok: s.vsCodeFound, s.vsCodeFound ? "VS Code" + (s.vsCode?.version.map { "  " + $0 } ?? "") : "VS Code not found")
        if !s.vsCodeFound { extLabel.stringValue = "–  NexysVHDL extension"; extLabel.textColor = Palette.grey }
        else if let ext = s.extensionInfo, s.extensionOutdated {
            setStatus(extLabel, ok: false, "NexysVHDL extension \(ext.version) is an older build")
            extLabel.textColor = Palette.amber
        } else {
            setStatus(extLabel, ok: s.extensionFound, s.extensionInfo.map { "NexysVHDL extension  " + $0.version } ?? "NexysVHDL extension not installed")
        }
        setStatus(tcLabel, ok: s.toolchain.installed, s.toolchain.installed ? "Toolchain \(s.toolchain.version)" : "Toolchain \(s.toolchain.version) not installed")
        if !s.toolchain.installed { tcLabel.textColor = Palette.amber }

        recheck.isHidden = s.vsCodeFound
        let idle = busy.isHidden
        if !s.vsCodeFound {
            actionButton.title = "Get Visual Studio Code"; actionKind = "getvscode"; actionButton.isHidden = !idle
            hint.stringValue = "NexysVHDL runs inside Visual Studio Code, which is free. Install it, then click Check again."
        } else if !s.extensionFound {
            actionButton.title = "Install NexysVHDL"; actionKind = "installext"; actionButton.isHidden = !idle
            hint.stringValue = "One click adds the NexysVHDL extension to Visual Studio Code. Your other extensions and settings are not changed."
        } else if s.extensionOutdated {
            actionButton.title = "Update NexysVHDL"; actionKind = "installext"; actionButton.isHidden = !idle
            hint.stringValue = "The NexysVHDL extension in Visual Studio Code is older than the one in this installation. One click updates it; your other extensions and settings are not changed."
        } else {
            actionButton.isHidden = true
            hint.stringValue = s.toolchain.installed ? "" : "The FPGA toolchain is installed from inside NexysVHDL: it will offer to do it the first time you open a project."
        }
        let ready = s.canOpen && idle
        newButton.isEnabled = ready
        openButton.isEnabled = ready
        fillRecent()
    }

    func fillRecent() {
        shown = service.recent.list()
        table.reloadData()
    }

    // MARK: table

    func numberOfRows(in tableView: NSTableView) -> Int { max(shown.count, 1) }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let id = tableColumn?.identifier.rawValue ?? ""
        let f = NSTextField(labelWithString: "")
        f.lineBreakMode = .byTruncatingMiddle
        f.font = .systemFont(ofSize: 12.5)
        if shown.isEmpty {
            f.stringValue = id == "name" ? "No recent projects yet" : ""
            f.textColor = Palette.grey
            return f
        }
        let r = shown[row]
        switch id {
        case "name": f.stringValue = r.name
        case "path": f.stringValue = (r.path as NSString).abbreviatingWithTildeInPath
        default:
            let df = DateFormatter(); df.dateFormat = "d MMM"
            f.stringValue = r.exists ? df.string(from: r.lastOpenedUtc) : "missing"
        }
        f.textColor = r.exists ? .labelColor : Palette.grey
        return f
    }

    func selectedRecent() -> RecentProject? {
        let row = table.selectedRow
        return row >= 0 && row < shown.count ? shown[row] : nil
    }

    @objc func openSelected() {
        guard let r = selectedRecent() else { return }
        if !r.exists {
            alert("\"\(r.name)\" is no longer at\n\(r.path)\n\nIt may have been moved or deleted. It was removed from the list.", warn: false)
            service.recent.remove(r.path)
            fillRecent()
            return
        }
        finish(service.openProject(r.path))
    }

    @objc func forgetSelected() {
        guard let r = selectedRecent() else { return }
        service.recent.remove(r.path)
        fillRecent()
    }

    // MARK: actions

    @objc func doNew() { finish(service.newProject()) }

    /// One native panel takes both a project file (.nvproj) and a project folder.
    @objc func doOpen() {
        let p = NSOpenPanel()
        p.title = "Open Project"
        p.message = "Choose a NexysVHDL project file (.nvproj) or a project folder (it contains nexysvhdl.json)"
        p.canChooseFiles = true
        p.canChooseDirectories = true
        p.allowsMultipleSelection = false
        p.treatsFilePackagesAsDirectories = false
        p.begin { [weak self] response in
            guard response == .OK, let url = p.url, let self = self else { return }
            self.finish(self.service.openTarget(url.path))
        }
    }

    func alert(_ text: String, warn: Bool) {
        let a = NSAlert()
        a.messageText = "NexysVHDL"
        a.informativeText = text
        a.alertStyle = warn ? .warning : .informational
        a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window, completionHandler: nil)
    }

    /// Shows a friendly message for anything that did not open; closes the launcher when VS Code took over.
    func finish(_ r: OpenResult) {
        if r.ok { window.close(); onFinished?(); return }
        let a = NSAlert()
        a.messageText = "NexysVHDL"
        a.informativeText = r.message
        a.alertStyle = r.outcome == .notAProject ? .informational : .warning
        a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { [weak self] _ in self?.refreshAll() }
    }

    @objc func doAction() {
        if actionKind == "getvscode" { service.openWebPage(); return }
        guard actionKind == "installext" else { return }
        actionButton.isHidden = true
        busy.stringValue = "Installing…"
        busy.isHidden = false
        newButton.isEnabled = false
        openButton.isEnabled = false
        let vsix = vsixPath
        DispatchQueue.global().async { [weak self] in
            guard let self = self else { return }
            let r = self.service.installExtension(vsix)
            DispatchQueue.main.async {
                self.busy.isHidden = true
                if !r.ok { self.alert(r.message, warn: true) }
                self.refreshAll()
            }
        }
    }

    func windowWillClose(_ notification: Notification) { onFinished?() }
}
