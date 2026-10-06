using System;
using System.Collections.Generic;

// Reusable launcher logic: no Windows API, no UI. The Windows-specific pieces
// (finding VS Code, starting processes hidden, shortcuts, windows) implement
// IPlatform in launcher/windows; a macOS launcher implements the same interface.
namespace NexysVhdl.Launcher
{
    /// <summary>A VS Code installation the launcher can start.</summary>
    public sealed class VsCodeInfo
    {
        /// <summary>The application executable (Code.exe).</summary>
        public string Executable;
        /// <summary>Its install folder.</summary>
        public string InstallDirectory;
        public string Version;
        /// <summary>Node entry point of VS Code's own command line (runs with ELECTRON_RUN_AS_NODE), used to install extensions without any visible window. Null if not found.</summary>
        public string CliScript;
        /// <summary>"user", "system" or "override".</summary>
        public string Scope;
    }

    public sealed class ExtensionInfo
    {
        public string Id;
        public string Version;
        public string Folder;
    }

    public sealed class ToolchainInfo
    {
        public bool Installed;
        public string Version;
        public string Detail;
    }

    public sealed class ProcessOutcome
    {
        public bool Ok;
        public int ExitCode;
        public string Output;
    }

    /// <summary>Everything the launcher needs from the operating system.</summary>
    public interface IPlatform
    {
        /// <summary>Per-user folder for launcher state (never inside a project).</summary>
        string StateDirectory { get; }
        /// <summary>Finds VS Code without relying on PATH; null if it is not installed.</summary>
        VsCodeInfo FindVsCode();
        /// <summary>The installed NexysVHDL extension, or null.</summary>
        ExtensionInfo FindExtension(VsCodeInfo vscode);
        /// <summary>True when the installed extension is the same build as the bundled VSIX (the version number alone cannot tell a development build from the release).</summary>
        bool ExtensionMatches(ExtensionInfo installed, string vsixPath);
        /// <summary>Whether NexysVHDL's FPGA toolchain is installed (a light check; the extension owns the real one).</summary>
        ToolchainInfo FindToolchain();
        /// <summary>Starts VS Code on a folder. No console window.</summary>
        void OpenFolder(VsCodeInfo vscode, string folder);
        /// <summary>Hands a vscode:// link to VS Code (starting it if needed). No console window.</summary>
        void OpenUri(VsCodeInfo vscode, string uri);
        /// <summary>Installs a VSIX into VS Code and waits. No console window.</summary>
        ProcessOutcome InstallExtension(VsCodeInfo vscode, string vsixPath);
        /// <summary>Opens a web page in the default browser.</summary>
        void OpenWebPage(string url);
    }

    public sealed class LauncherStatus
    {
        public VsCodeInfo VsCode;
        public ExtensionInfo Extension;
        public ToolchainInfo Toolchain;
        /// <summary>The extension is installed but is not the build bundled with this launcher.</summary>
        public bool ExtensionOutdated;
        public string ExtensionId = "emxplore.nexysvhdl";

        public bool VsCodeFound { get { return VsCode != null; } }
        public bool ExtensionFound { get { return Extension != null; } }
        public bool CanOpen { get { return VsCodeFound && ExtensionFound; } }
    }

    public enum OpenOutcome
    {
        Opened,
        /// <summary>The folder is not a NexysVHDL project (or does not exist).</summary>
        NotAProject,
        NeedsVsCode,
        NeedsExtension,
        Failed
    }

    public sealed class OpenResult
    {
        public OpenOutcome Outcome;
        /// <summary>Student-readable text.</summary>
        public string Message;
        public static OpenResult Make(OpenOutcome outcome, string message)
        {
            OpenResult r = new OpenResult();
            r.Outcome = outcome;
            r.Message = message;
            return r;
        }
        public bool Ok { get { return Outcome == OpenOutcome.Opened; } }
    }
}
