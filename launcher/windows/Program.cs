using System;
using System.Collections.Generic;
using System.IO;
using System.Windows.Forms;

namespace NexysVhdl.Launcher
{
    /// <summary>
    /// NexysVHDL.exe: the application a student starts from the Start Menu.
    /// A Windows-subsystem program, so no console window can ever appear.
    ///   (no arguments)             the launcher window
    ///   "Project.nvproj"           open the project of a project file (what a double-click passes)
    ///   --open "folder"            open a project directly: a project folder or a .nvproj file (shortcuts and tests)
    ///   --new-project              ask NexysVHDL to create a project
    ///   --status-report "file"     write what was detected as JSON and exit (tests)
    /// Test hook: NEXYSVHDL_LAUNCHER_MESSAGE_FILE=file writes a problem message there instead of showing a dialog.
    /// </summary>
    public static class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string vsix = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "nexysvhdl.vsix");
            LauncherService service = new LauncherService(new WindowsPlatform(), vsix);

            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--status-report" && i + 1 < args.Length)
                {
                    WriteReport(service, args[i + 1]);
                    return 0;
                }
                if (a == "--open" && i + 1 < args.Length) return Headless(service.OpenTarget(args[i + 1]));
                if (a == "--new-project") return Headless(service.NewProject());
                // Windows starts the program as: NexysVHDL.exe "C:\path with spaces\MyProject.nvproj"
                if (!a.StartsWith("--") && ProjectCheck.IsProjectFile(a)) return Headless(service.OpenTarget(a));
            }
            Application.Run(new MainForm(service, vsix));
            return 0;
        }

        /// <summary>Opens without the launcher window; a problem is explained in a normal message box.</summary>
        static int Headless(OpenResult r)
        {
            if (r.Ok) return 0;
            // Test hook: write the message to a file instead of showing a (blocking) dialog.
            string messageFile = Environment.GetEnvironmentVariable("NEXYSVHDL_LAUNCHER_MESSAGE_FILE");
            if (!string.IsNullOrEmpty(messageFile))
            {
                File.WriteAllText(messageFile, r.Message);
                return 1;
            }
            MessageBox.Show(r.Message, "NexysVHDL", MessageBoxButtons.OK, r.Outcome == OpenOutcome.NotAProject ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            return 1;
        }

        static void WriteReport(LauncherService service, string file)
        {
            LauncherStatus s = service.GetStatus();
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["vscodeFound"] = s.VsCodeFound;
            d["vscodeExecutable"] = s.VsCode == null ? null : s.VsCode.Executable;
            d["vscodeVersion"] = s.VsCode == null ? null : s.VsCode.Version;
            d["vscodeScope"] = s.VsCode == null ? null : s.VsCode.Scope;
            d["vscodeCli"] = s.VsCode == null ? null : s.VsCode.CliScript;
            d["extensionFound"] = s.ExtensionFound;
            d["extensionOutdated"] = s.ExtensionOutdated;
            d["extensionVersion"] = s.Extension == null ? null : s.Extension.Version;
            d["toolchainInstalled"] = s.Toolchain.Installed;
            d["toolchainVersion"] = s.Toolchain.Version;
            File.WriteAllText(file, Json.Write(d) + "\n");
        }
    }
}
