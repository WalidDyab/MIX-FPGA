using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace MixFpga.Setup
{
    static class Program
    {
        [DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);

        static string logFile;
        static readonly object logGate = new object();

        public static void Log(string line)
        {
            if (logFile == null) return;
            try { lock (logGate) File.AppendAllText(logFile, DateTime.Now.ToString("HH:mm:ss") + " " + line + Environment.NewLine, Encoding.UTF8); } catch (Exception) { }
        }

        [STAThread]
        static int Main(string[] args)
        {
            Options o = Options.Parse(args);
            logFile = o.LogFile ?? Path.Combine(Path.GetTempPath(), "MIX-FPGA-Setup.log");
            Log("MIX-FPGA " + Pins.Version + " Setup started " + string.Join(" ", args));
            if (o.Auto) return Headless(o);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm(o));
            return 0;
        }

        /// <summary>No window: the same steps, written to the console (when started from one) and to the log file. Used for tests and by instructors.</summary>
        static int Headless(Options o)
        {
            AttachConsole(-1);
            Action<string> say = delegate (string s) { Console.WriteLine(s); Log(s); };
            Installer installer = new Installer(o);
            Detection d = installer.Detect();
            say("support folder: " + installer.SupportDir);
            say("Visual Studio Code: " + (d.CodeCmd == null ? "NOT FOUND" : d.CodeRoot + " (" + d.CodeVersion + ")"));
            say("MIX-FPGA extension: " + (d.ExtensionVersion ?? "not installed") + " => mode " + d.Mode);
            say("NexysVHDL Toolchain 1.0 store: " + (d.LegacyStore ? "present (left untouched)" : "absent"));
            if (d.Problem != null) say("PROBLEM: " + d.Problem);
            if (o.DryRun) return d.Problem == null ? 0 : 3;
            if (d.Problem != null) return 3;
            List<string> boards = new List<string>();
            foreach (string b in o.Boards.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries)) boards.Add(b.Trim());
            if (boards.Count == 0) { say("--boards nexys,de10 is required"); return 2; }
            if (o.Verify)
            {
                // verify only: the Setup code of the installed extension, no installation
                Outcome v = installer.VerifyOnly(d, boards, say);
                say(v.Title);
                foreach (string line in v.Details) say("  " + line);
                return v.Ok ? 0 : 1;
            }
            Outcome r = installer.Perform(d, boards, say);
            say((r.Ok ? "RESULT OK: " : "RESULT FAILED: ") + r.Title);
            foreach (string line in r.Details) say("  " + line);
            if (r.Ok && o.OpenSetup) installer.OpenSetup(d);
            return r.Ok ? 0 : 1;
        }
    }
}
