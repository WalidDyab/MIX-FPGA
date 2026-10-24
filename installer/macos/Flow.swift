import Foundation

struct Outcome {
    var ok: Bool
    var title: String
    var details: [String]
    var needsAltera: Bool = false
}

extension Installer {
    /// The whole installation, in the order the student sees it. Nothing that already works is removed: the extension is installed over the
    /// old one (no uninstall), the NexysVHDL Toolchain 1.0 store is never touched, and a failure before the extension step changes nothing.
    func perform(app: String, mode: InstallMode, boards: [String], report: @escaping (String) -> Void) -> Outcome {
        do {
            var files = [vsixName]
            if boards.contains("nexys") { files.append(nexysArchive) }
            if boards.contains("de10") { files.append(de10Archive) }
            try verifyFiles(files, report: report)
            try installExtension(app: app, report: report)
            report("MIX-FPGA \(productVersion) is installed in Visual Studio Code.")
            report("Installing the board support (this checks every file and can take several minutes)…")
            let r = try runBridge(app: app, boards: boards, verify: false, report: report)
            if r.action == "error" { return Outcome(ok: false, title: "Board support was not installed", details: [r.message ?? "Unknown problem.", "MIX-FPGA is installed. Nothing that was already working was removed. Press Retry, or choose Install Support from MIX-FPGA Setup in Visual Studio Code."]) }
            var details = r.boards
            let altera = boards.contains("de10")
            switch r.outcome ?? "" {
            case "complete":
                if boards == ["nexys"] {
                    report("Verifying the installed tools…")
                    let v = try runBridge(app: app, boards: boards, verify: true, report: report)
                    details.append(v.ok == true ? "Verify: every installed file checked: OK." : "Verify reported a problem: open MIX-FPGA Setup in Visual Studio Code and choose Repair.")
                    if v.ok != true { return Outcome(ok: false, title: "Installed, but Verify found a problem", details: details) }
                }
                return Outcome(ok: true, title: "MIX-FPGA is ready", details: details, needsAltera: false)
            case "stopped" where altera && (r.stoppedFor == "altera" || r.stoppedFor == "rosetta"):
                if r.stoppedFor == "rosetta" { details.append("DE10-Lite: Apple's Rosetta is needed. Open MIX-FPGA Setup in Visual Studio Code and choose Install DE10-Lite Support; it will open Apple's installer for you.") }
                else { details.append("DE10-Lite: the MIX-FPGA part is installed. The last step needs Altera's free Quartus files and their licence; it continues in MIX-FPGA Setup in Visual Studio Code.") }
                return Outcome(ok: true, title: "MIX-FPGA is installed. One step is left for the DE10-Lite", details: details, needsAltera: true)
            default:
                return Outcome(ok: false, title: "Board support did not finish", details: [r.message ?? "Setup stopped.", "Nothing that was already working was removed. Press Retry."] + details)
            }
        } catch InstallError.message(let m) {
            return Outcome(ok: false, title: "Nothing was changed", details: [m])
        } catch {
            return Outcome(ok: false, title: "Nothing was changed", details: ["\(error)"])
        }
    }
}
