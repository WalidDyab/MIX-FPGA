using System;
using System.IO;

namespace NexysVhdl.Launcher
{
    /// <summary>What makes a folder a NexysVHDL project: it contains nexysvhdl.json.</summary>
    public static class ProjectCheck
    {
        public const string ProjectFile = "nexysvhdl.json";

        public static bool IsProject(string folder)
        {
            try { return !string.IsNullOrEmpty(folder) && File.Exists(Path.Combine(folder, ProjectFile)); }
            catch (ArgumentException) { return false; }
        }

        /// <summary>A friendly explanation of why a folder is not usable, or null if it is a project.</summary>
        public static string Problem(string folder)
        {
            if (string.IsNullOrEmpty(folder)) return "No folder was chosen.";
            if (!Directory.Exists(folder)) return "That folder does not exist any more.";
            if (!IsProject(folder))
            {
                string name = Path.GetFileName(folder.TrimEnd('\\', '/'));
                return "\"" + (name.Length == 0 ? folder : name) + "\" is not a NexysVHDL project: it has no " + ProjectFile + " file.\n\nChoose the project folder itself (the one that contains " + ProjectFile + "), or use New Project to start a new one.";
            }
            return null;
        }
    }

    /// <summary>
    /// The launcher's behavior, independent of any operating system: it decides
    /// what can be opened and what to tell the student, and asks IPlatform to do
    /// the system-specific work. Project creation is NOT done here: New Project
    /// asks the installed NexysVHDL extension to run its own command.
    /// </summary>
    public sealed class LauncherService
    {
        /// <summary>The extension's link that runs its existing "Create Project" command.</summary>
        public const string NewProjectUri = "vscode://emxplore.nexysvhdl/newProject";
        public const string GetVsCodeUrl = "https://code.visualstudio.com/Download";

        readonly IPlatform platform;
        readonly RecentProjects recent;

        readonly string bundledVsix;

        /// <param name="bundledVsix">The NexysVHDL extension file shipped with the launcher (null if there is none).</param>
        public LauncherService(IPlatform platform, string bundledVsix)
        {
            this.platform = platform;
            this.bundledVsix = bundledVsix;
            this.recent = new RecentProjects(platform.StateDirectory);
        }

        public RecentProjects Recent { get { return recent; } }

        public LauncherStatus GetStatus()
        {
            LauncherStatus s = new LauncherStatus();
            s.VsCode = platform.FindVsCode();
            s.Extension = s.VsCode == null ? null : platform.FindExtension(s.VsCode);
            s.Toolchain = platform.FindToolchain();
            s.ExtensionOutdated = s.Extension != null && bundledVsix != null && File.Exists(bundledVsix) && !platform.ExtensionMatches(s.Extension, bundledVsix);
            return s;
        }

        OpenResult NotReady(LauncherStatus s)
        {
            if (!s.VsCodeFound) return OpenResult.Make(OpenOutcome.NeedsVsCode, "Visual Studio Code is not installed. NexysVHDL runs inside VS Code, which is free.");
            if (!s.ExtensionFound) return OpenResult.Make(OpenOutcome.NeedsExtension, "The NexysVHDL extension is not installed in Visual Studio Code yet.");
            return null;
        }

        /// <summary>Opens a project folder in VS Code (the extension activates by itself because the folder holds nexysvhdl.json).</summary>
        public OpenResult OpenProject(string folder)
        {
            string problem = ProjectCheck.Problem(folder);
            if (problem != null)
            {
                if (!string.IsNullOrEmpty(folder) && !Directory.Exists(folder)) recent.Remove(folder);
                return OpenResult.Make(OpenOutcome.NotAProject, problem);
            }
            LauncherStatus s = GetStatus();
            OpenResult notReady = NotReady(s);
            if (notReady != null) return notReady;
            try
            {
                platform.OpenFolder(s.VsCode, Path.GetFullPath(folder));
            }
            catch (Exception e)
            {
                return OpenResult.Make(OpenOutcome.Failed, "Visual Studio Code could not be started: " + e.Message);
            }
            recent.Add(folder, DateTime.UtcNow);
            return OpenResult.Make(OpenOutcome.Opened, "Opened in Visual Studio Code.");
        }

        /// <summary>New Project: the extension's own Create Project command does the work.</summary>
        public OpenResult NewProject()
        {
            LauncherStatus s = GetStatus();
            OpenResult notReady = NotReady(s);
            if (notReady != null) return notReady;
            try
            {
                platform.OpenUri(s.VsCode, NewProjectUri);
            }
            catch (Exception e)
            {
                return OpenResult.Make(OpenOutcome.Failed, "Visual Studio Code could not be started: " + e.Message);
            }
            return OpenResult.Make(OpenOutcome.Opened, "Continue in Visual Studio Code.");
        }

        /// <summary>Opens the VS Code download page.</summary>
        public void OpenWebPage()
        {
            platform.OpenWebPage(GetVsCodeUrl);
        }

        /// <summary>Installs the bundled NexysVHDL VSIX (only when the student asks for it).</summary>
        public OpenResult InstallExtension(string vsixPath)
        {
            LauncherStatus s = GetStatus();
            if (!s.VsCodeFound) return NotReady(s);
            if (!File.Exists(vsixPath)) return OpenResult.Make(OpenOutcome.Failed, "The NexysVHDL extension file is missing from this installation. Run the NexysVHDL setup again.");
            ProcessOutcome r = platform.InstallExtension(s.VsCode, vsixPath);
            if (!r.Ok) return OpenResult.Make(OpenOutcome.Failed, "The NexysVHDL extension could not be installed" + (string.IsNullOrEmpty(r.Output) ? "." : ":\n" + r.Output.Trim()));
            return OpenResult.Make(OpenOutcome.Opened, "The NexysVHDL extension is installed.");
        }
    }
}
