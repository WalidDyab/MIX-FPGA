using System;
using System.Collections.Generic;
using System.IO;

namespace NexysVhdl.Launcher
{
    /// <summary>The outcome of reading a .nvproj project file.</summary>
    public sealed class ProjectFileResolution
    {
        public bool Ok;
        /// <summary>The project folder (the one holding nexysvhdl.json) when Ok.</summary>
        public string Root;
        /// <summary>A student-readable explanation when not Ok.</summary>
        public string Message;
        public static ProjectFileResolution Fail(string message)
        {
            ProjectFileResolution r = new ProjectFileResolution();
            r.Message = message;
            return r;
        }
    }

    /// <summary>
    /// What makes a folder a NexysVHDL project: it contains nexysvhdl.json. A project may also have a
    /// .nvproj file, a small versioned launch descriptor { "format": "nexysvhdl-project", "version": 1,
    /// "config": "nexysvhdl.json" } that points (relatively) at the settings file. The rules below are
    /// the same as core/project/nvproj.ts in the extension; tests/nvproj.test.ts keeps them in step.
    /// </summary>
    public static class ProjectCheck
    {
        public const string ProjectFile = "nexysvhdl.json";
        public const string ProjectFileExtension = ".nvproj";
        public const string ProjectFileFormat = "nexysvhdl-project";
        public const int SupportedProjectFileVersion = 1;

        public static bool IsProject(string folder)
        {
            try { return !string.IsNullOrEmpty(folder) && File.Exists(Path.Combine(folder, ProjectFile)); }
            catch (ArgumentException) { return false; }
        }

        /// <summary>True for a path that names a .nvproj project file.</summary>
        public static bool IsProjectFile(string path)
        {
            return !string.IsNullOrEmpty(path) && path.TrimEnd().EndsWith(ProjectFileExtension, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>A safe relative path to nexysvhdl.json (forward slashes), or null.</summary>
        public static string NormalizeConfigPath(object value)
        {
            string s = value as string;
            if (s == null || s.Trim().Length == 0 || s.IndexOf('\0') >= 0) return null;
            string path = s.Replace('\\', '/');
            if (path.StartsWith("/") || (path.Length >= 2 && char.IsLetter(path[0]) && path[1] == ':')) return null;
            string[] parts = path.Split('/');
            foreach (string part in parts) if (part.Length == 0 || part == "." || part == "..") return null;
            if (!string.Equals(parts[parts.Length - 1], ProjectFile, StringComparison.OrdinalIgnoreCase)) return null;
            return string.Join("/", parts);
        }

        /// <summary>Reads a .nvproj, validates it and finds the project folder it launches.</summary>
        public static ProjectFileResolution ResolveProjectFile(string file)
        {
            string name;
            string text;
            string full;
            try
            {
                full = Path.GetFullPath(file);
                name = Path.GetFileName(full);
                if (!File.Exists(full)) return ProjectFileResolution.Fail("The project file " + name + " does not exist any more.");
                text = File.ReadAllText(full);
            }
            catch (Exception e)
            {
                return ProjectFileResolution.Fail("The project file could not be read: " + e.Message);
            }
            object parsed = Json.TryParse(text.TrimStart('﻿'));
            Dictionary<string, object> d = parsed as Dictionary<string, object>;
            if (d == null) return ProjectFileResolution.Fail("This NexysVHDL project file is damaged: it is not valid JSON.");
            if (!(d.ContainsKey("format") && ProjectFileFormat.Equals(d["format"] as string)))
                return ProjectFileResolution.Fail("This is not a NexysVHDL project file (its \"format\" is not \"" + ProjectFileFormat + "\").");
            double version = d.ContainsKey("version") && d["version"] is double ? (double)d["version"] : -1;
            if (version < 1 || Math.Floor(version) != version) return ProjectFileResolution.Fail("This NexysVHDL project file has an invalid \"version\".");
            if (version > SupportedProjectFileVersion)
                return ProjectFileResolution.Fail("This project file was made by a newer NexysVHDL (file version " + version + "; this one understands " + SupportedProjectFileVersion + "). Update NexysVHDL to open it.");
            string config = NormalizeConfigPath(d.ContainsKey("config") ? d["config"] : null);
            if (config == null)
                return ProjectFileResolution.Fail("This NexysVHDL project file points at an unusable settings file. \"config\" must be a relative path inside the project folder that ends in " + ProjectFile + ".");
            string configFile = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(full), config.Replace('/', Path.DirectorySeparatorChar)));
            if (!File.Exists(configFile))
                return ProjectFileResolution.Fail(name + " points at " + config + ", which was not found next to it. Was the project folder copied without it?");
            ProjectFileResolution ok = new ProjectFileResolution();
            ok.Ok = true;
            ok.Root = Path.GetDirectoryName(configFile);
            return ok;
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

        /// <summary>
        /// Opens whatever the student double-clicked or chose: a .nvproj project file or a project folder.
        /// A project file is validated first; its folder then goes through the normal OpenProject path
        /// (same VS Code start, same recent list), never a vscode:// link.
        /// </summary>
        public OpenResult OpenTarget(string path)
        {
            if (ProjectCheck.IsProjectFile(path))
            {
                ProjectFileResolution r = ProjectCheck.ResolveProjectFile(path);
                if (!r.Ok) return OpenResult.Make(OpenOutcome.NotAProject, r.Message);
                return OpenProject(r.Root);
            }
            return OpenProject(path);
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
