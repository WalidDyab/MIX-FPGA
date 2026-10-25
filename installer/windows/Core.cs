using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace MixFpga.Setup
{
    /// <summary>What the installer finds on this computer.</summary>
    public enum Mode { Fresh, Upgrade, Reinstall }

    public sealed class Detection
    {
        public string CodeRoot;        // folder with Code.exe
        public string CodeCmd;         // bin\code.cmd
        public string CodeExe;         // Code.exe
        public string CodeVersion;
        public string ExtensionVersion; // emxplore.nexysvhdl, any version
        public Mode Mode;
        public bool LegacyStore;       // %LOCALAPPDATA%\NexysVHDL\toolchains (Toolchain 1.0 of NexysVHDL), left untouched
        public string Problem;
    }

    /// <summary>Command-line options. Students use none; they exist so the installer can be tested in an isolated profile.</summary>
    public sealed class Options
    {
        public bool Auto;               // no window: install with --boards and exit
        public bool DryRun;             // only detect and print
        public bool Verify;             // only run the bridge's verify
        public bool OpenSetup;          // open MIX-FPGA Setup at the end (automatic mode)
        public string Boards = "";      // nexys,de10
        public string Support;          // folder with the release files
        public string Code;             // Code.exe to use instead of searching
        public string UserDataDir;      // VS Code --user-data-dir (isolated profile)
        public string ExtensionsDir;    // VS Code --extensions-dir (isolated profile)
        public string LogFile;

        public static Options Parse(string[] args)
        {
            Options o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                string next = i + 1 < args.Length ? args[i + 1] : null;
                switch (a)
                {
                    case "--auto": o.Auto = true; break;
                    case "--dry-run": o.DryRun = true; o.Auto = true; break;
                    case "--verify": o.Verify = true; o.Auto = true; break;
                    case "--open": o.OpenSetup = true; break;
                    case "--boards": o.Boards = next ?? ""; i++; break;
                    case "--support": o.Support = next; i++; break;
                    case "--code": o.Code = next; i++; break;
                    case "--user-data-dir": o.UserDataDir = next; i++; break;
                    case "--extensions-dir": o.ExtensionsDir = next; i++; break;
                    case "--log": o.LogFile = next; i++; break;
                }
            }
            return o;
        }
    }

    public sealed class BridgeResult
    {
        public string Action;
        public string Outcome;
        public string Message;
        public string StoppedFor;
        public bool? Ok;
        public bool? Modified;
        public List<string> Boards = new List<string>();
    }

    public sealed class Outcome
    {
        public bool Ok;
        public string Title;
        public List<string> Details = new List<string>();
        public bool NeedsAltera;
        public bool Changed;            // did the installer change anything on this computer?
    }

    public sealed class InstallError : Exception
    {
        public InstallError(string message) : base(message) { }
    }

    /// <summary>
    /// Installs MIX-FPGA 0.7.0 the way a student would by hand, with the same checks: detects Visual Studio Code and the installed
    /// emxplore.nexysvhdl extension, checks every release file, installs the VSIX over whatever is there (nothing is uninstalled first),
    /// then runs the Setup code that ships INSIDE the installed extension (so installer and extension install the support the same way,
    /// with the same pinned hashes) under VS Code's own Node. It never touches Altera, drivers, VS Code settings or other extensions, and
    /// never deletes a project, a setting or the old NexysVHDL Toolchain 1.0.
    /// </summary>
    public sealed class Installer
    {
        public readonly Options Opt;
        public readonly string SupportDir;
        Process bridge;
        readonly object gate = new object();
        public volatile bool Cancelled;

        public Installer(Options opt)
        {
            Opt = opt;
            SupportDir = ResolveSupport(opt.Support);
        }

        // ------------------------------------------------------------ files

        static string ExeDir()
        {
            return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        }

        /// <summary>Where the release files are: --support, else next to the installer, else a Support folder next to it.</summary>
        static string ResolveSupport(string given)
        {
            if (!string.IsNullOrEmpty(given)) return Path.GetFullPath(given);
            string here = ExeDir();
            if (File.Exists(Path.Combine(here, Pins.Vsix))) return here;
            string sub = Path.Combine(here, "Support");
            if (File.Exists(Path.Combine(sub, Pins.Vsix))) return sub;
            return here;
        }

        public static string Sha256(string path, Action<long> progress)
        {
            using (SHA256 h = SHA256.Create())
            using (FileStream f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20))
            {
                byte[] buf = new byte[4 << 20];
                long done = 0;
                int n;
                while ((n = f.Read(buf, 0, buf.Length)) > 0)
                {
                    h.TransformBlock(buf, 0, n, null, 0);
                    done += n;
                    if (progress != null) progress(done);
                }
                h.TransformFinalBlock(new byte[0], 0, 0);
                StringBuilder sb = new StringBuilder();
                foreach (byte b in h.Hash) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        /// <summary>
        /// Every release file the installer is about to use must be exactly the one this installer was built for (size and SHA-256 are
        /// built into the installer) and must agree with SHA256SUMS next to it. Nothing is changed before this passes.
        /// </summary>
        public void VerifyFiles(IList<string> names, Action<string> report)
        {
            Dictionary<string, string> sums = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            string sumsFile = Path.Combine(SupportDir, "SHA256SUMS");
            if (File.Exists(sumsFile))
            {
                foreach (string line in File.ReadAllLines(sumsFile))
                {
                    string[] p = line.Trim().Split(new[] { ' ', '*' }, StringSplitOptions.RemoveEmptyEntries);
                    if (p.Length == 2) sums[p[1]] = p[0].ToLowerInvariant();
                }
            }
            foreach (string name in names)
            {
                string path = Path.Combine(SupportDir, name);
                if (!File.Exists(path)) throw new InstallError("The file " + name + " is not next to the installer (" + SupportDir + "). Keep the installer together with the other MIX-FPGA files, or download the MIX-FPGA folder again.");
                PinInfo pin = Pins.Lookup(name);
                if (pin == null) throw new InstallError(name + " is not a file of this release.");
                FileInfo fi = new FileInfo(path);
                report("Checking " + name + "…");
                if (fi.Length != pin.Bytes) throw new InstallError(name + " is damaged or is not the file of this release (its size is " + fi.Length.ToString("N0") + " bytes, expected " + pin.Bytes.ToString("N0") + "). Nothing was changed. Download it again.");
                string got = Sha256(path, null);
                if (got != pin.Sha256) throw new InstallError(name + " is damaged or is not the file of this release (its checksum does not match). Nothing was changed. Download it again.");
                string listed;
                if (sums.TryGetValue(name, out listed) && listed != got) throw new InstallError(name + " does not match the checksum list SHA256SUMS. Nothing was changed. Download the MIX-FPGA folder again.");
            }
        }

        // ------------------------------------------------------------ processes

        public sealed class RunResult { public int Status; public string Output; }

        static string Quote(string a)
        {
            if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
            return "\"" + a.Replace("\"", "\\\"") + "\"";
        }

        public RunResult Run(string exe, IList<string> args, IDictionary<string, string> env, Action<string> line)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = exe;
            StringBuilder sb = new StringBuilder();
            foreach (string a in args) { if (sb.Length > 0) sb.Append(' '); sb.Append(Quote(a)); }
            psi.Arguments = sb.ToString();
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            if (env != null) foreach (KeyValuePair<string, string> kv in env) psi.EnvironmentVariables[kv.Key] = kv.Value;
            StringBuilder output = new StringBuilder();
            using (Process p = new Process())
            {
                p.StartInfo = psi;
                DataReceivedEventHandler h = delegate (object s, DataReceivedEventArgs e)
                {
                    if (e.Data == null) return;
                    lock (output) output.AppendLine(e.Data);
                    if (line != null) line(e.Data);
                };
                p.OutputDataReceived += h;
                p.ErrorDataReceived += h;
                try { p.Start(); }
                catch (Exception ex) { return new RunResult { Status = 127, Output = ex.Message }; }
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                lock (gate) bridge = line != null ? p : bridge;
                p.WaitForExit();
                p.WaitForExit();
                lock (gate) if (bridge == p) bridge = null;
                return new RunResult { Status = p.ExitCode, Output = output.ToString() };
            }
        }

        public void Cancel()
        {
            Cancelled = true;
            Process p;
            lock (gate) p = bridge;
            if (p == null) return;
            try
            {
                // the bridge and everything it started
                ProcessStartInfo k = new ProcessStartInfo("taskkill.exe", "/PID " + p.Id + " /T /F");
                k.CreateNoWindow = true;
                k.UseShellExecute = false;
                Process.Start(k);
            }
            catch (Exception) { }
        }

        List<string> CodeFlags()
        {
            List<string> f = new List<string>();
            if (!string.IsNullOrEmpty(Opt.UserDataDir)) { f.Add("--user-data-dir"); f.Add(Opt.UserDataDir); }
            if (!string.IsNullOrEmpty(Opt.ExtensionsDir)) { f.Add("--extensions-dir"); f.Add(Opt.ExtensionsDir); }
            return f;
        }

        RunResult Code(Detection d, params string[] args)
        {
            List<string> a = CodeFlags();
            a.AddRange(args);
            return Run(d.CodeCmd, a, null, null);
        }

        // ------------------------------------------------------------ detection

        static string Env(string name) { return Environment.GetEnvironmentVariable(name) ?? ""; }

        IEnumerable<string> CodeCandidates()
        {
            if (!string.IsNullOrEmpty(Opt.Code)) { yield return Path.GetDirectoryName(Path.GetFullPath(Opt.Code)); yield break; }
            yield return Path.Combine(Env("LOCALAPPDATA"), "Programs", "Microsoft VS Code");
            yield return Path.Combine(Env("ProgramFiles"), "Microsoft VS Code");
            string x86 = Env("ProgramFiles(x86)");
            if (x86.Length > 0) yield return Path.Combine(x86, "Microsoft VS Code");
            foreach (RegistryKey hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
            {
                using (RegistryKey k = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall"))
                {
                    if (k == null) continue;
                    foreach (string sub in k.GetSubKeyNames())
                    {
                        using (RegistryKey s = k.OpenSubKey(sub))
                        {
                            string name = s == null ? null : s.GetValue("DisplayName") as string;
                            string loc = s == null ? null : s.GetValue("InstallLocation") as string;
                            if (name != null && loc != null && name.StartsWith("Microsoft Visual Studio Code") && name.IndexOf("Insiders", StringComparison.OrdinalIgnoreCase) < 0) yield return loc.TrimEnd('\\');
                        }
                    }
                }
            }
        }

        public Detection Detect()
        {
            Detection d = new Detection();
            foreach (string root in CodeCandidates())
            {
                string exe = Path.Combine(root, "Code.exe");
                string cmd = Path.Combine(root, "bin", "code.cmd");
                if (File.Exists(exe) && File.Exists(cmd)) { d.CodeRoot = root; d.CodeExe = exe; d.CodeCmd = cmd; break; }
            }
            d.LegacyStore = Directory.Exists(Path.Combine(Env("LOCALAPPDATA"), "NexysVHDL", "toolchains"));
            if (d.CodeCmd == null)
            {
                d.Problem = "Visual Studio Code was not found. Install it from https://code.visualstudio.com (the user installer is fine), then press Retry. Nothing is downloaded by this installer.";
                d.Mode = Mode.Fresh;
                return d;
            }
            RunResult v = Code(d, "--version");
            string first = (v.Output ?? "").Split('\n')[0].Trim();
            d.CodeVersion = first;
            if (!VersionAtLeast(first, 1, 120))
            {
                d.Problem = "Visual Studio Code " + (first.Length > 0 ? first : "(unknown version)") + " is older than 1.120. Update it (Help > Check for Updates), then press Retry.";
            }
            d.ExtensionVersion = InstalledExtensionVersion(d);
            d.Mode = d.ExtensionVersion == null ? Mode.Fresh : (d.ExtensionVersion == Pins.Version ? Mode.Reinstall : Mode.Upgrade);
            return d;
        }

        static bool VersionAtLeast(string v, int major, int minor)
        {
            string[] p = v.Split('.');
            int a, b;
            if (p.Length < 2 || !int.TryParse(p[0], out a) || !int.TryParse(p[1], out b)) return false;
            return a > major || (a == major && b >= minor);
        }

        string InstalledExtensionVersion(Detection d)
        {
            RunResult r = Code(d, "--list-extensions", "--show-versions");
            foreach (string line in (r.Output ?? "").Split('\n'))
            {
                string t = line.Trim();
                if (t.StartsWith(Pins.ExtensionId + "@", StringComparison.OrdinalIgnoreCase)) return t.Substring(Pins.ExtensionId.Length + 1).Trim();
            }
            return null;
        }

        // ------------------------------------------------------------ steps

        /// <summary>The installed extension's folder for this version (it holds the Setup code the bridge runs).</summary>
        string InstalledExtensionFolder()
        {
            string dir = !string.IsNullOrEmpty(Opt.ExtensionsDir) ? Opt.ExtensionsDir : Path.Combine(Env("USERPROFILE"), ".vscode", "extensions");
            if (!Directory.Exists(dir)) return null;
            string best = null;
            foreach (string f in Directory.GetDirectories(dir))
            {
                string n = Path.GetFileName(f);
                if (!n.StartsWith(Pins.ExtensionId + "-", StringComparison.OrdinalIgnoreCase)) continue;
                string pj = Path.Combine(f, "package.json");
                if (!File.Exists(pj)) continue;
                string text = File.ReadAllText(pj);
                if (text.IndexOf("\"version\": \"" + Pins.Version + "\"", StringComparison.Ordinal) >= 0 && File.Exists(Path.Combine(f, "dist", "runtime", "setup.js"))) best = f;
            }
            return best;
        }

        void InstallExtension(Detection d, Action<string> report)
        {
            report("Installing MIX-FPGA " + Pins.Version + " in Visual Studio Code…");
            RunResult r = Code(d, "--install-extension", Path.Combine(SupportDir, Pins.Vsix), "--force");
            if (r.Status != 0) throw new InstallError("Visual Studio Code could not install the extension: " + (r.Output ?? "").Trim());
            if (InstalledExtensionVersion(d) != Pins.Version) throw new InstallError("The extension was not found after installing it. Open Visual Studio Code once and press Retry.");
        }

        static string ExtractBridge()
        {
            string dir = Path.Combine(Path.GetTempPath(), "MIX-FPGA-Setup-" + Process.GetCurrentProcess().Id);
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, "bridge.js");
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("bridge.js"))
            using (FileStream o = File.Create(file)) s.CopyTo(o);
            return file;
        }

        BridgeResult RunBridge(Detection d, IList<string> boards, bool verify, Action<string> report)
        {
            string ext = InstalledExtensionFolder();
            if (ext == null) throw new InstallError("The installed MIX-FPGA extension could not be found.");
            string js = ExtractBridge();
            List<string> args = new List<string>();
            args.Add(js); args.Add("--ext"); args.Add(ext); args.Add("--support"); args.Add(SupportDir); args.Add("--boards"); args.Add(string.Join(",", boards));
            if (verify) args.Add("--verify");
            Dictionary<string, string> env = new Dictionary<string, string>();
            env["ELECTRON_RUN_AS_NODE"] = "1";
            BridgeResult result = null;
            Run(d.CodeExe, args, env, delegate (string line)
            {
                if (!line.StartsWith("{")) return;
                string type = Json.Str(line, "type");
                if (type == "progress") report(Json.Str(line, "message"));
                else if (type == "log") report("  " + Json.Str(line, "line"));
                else if (type == "result")
                {
                    BridgeResult r = new BridgeResult();
                    r.Action = Json.Str(line, "action");
                    r.Outcome = Json.Str(line, "outcome");
                    r.Message = Json.Str(line, "message");
                    r.StoppedFor = Json.Str(line, "stoppedFor");
                    r.Ok = Json.Bool(line, "ok");
                    r.Modified = Json.Bool(line, "modified");
                    r.Boards = Json.BoardLines(line);
                    result = r;
                }
            });
            try { Directory.Delete(Path.GetDirectoryName(js), true); } catch (Exception) { }
            if (Cancelled) throw new InstallError("The installation was cancelled. What was already installed still works; run the installer again to finish.");
            if (result == null) throw new InstallError("The setup step stopped unexpectedly. Nothing that was already working was removed. Press Retry.");
            return result;
        }

        /// <summary>The whole installation, in the order the student sees it. A failure before the extension step changes nothing.</summary>
        public Outcome Perform(Detection d, IList<string> boards, Action<string> report)
        {
            Outcome o = new Outcome();
            try
            {
                List<string> files = new List<string>();
                files.Add(Pins.Vsix);
                if (boards.Contains("nexys")) files.Add(Pins.Nexys);
                if (boards.Contains("de10")) files.Add(Pins.De10);
                VerifyFiles(files, report);
                InstallExtension(d, report);
                o.Changed = true;
                report("MIX-FPGA " + Pins.Version + " is installed in Visual Studio Code.");
                report("Installing the board support (this checks every file and can take several minutes)…");
                BridgeResult r = RunBridge(d, boards, false, report);
                if (r.Action == "error")
                {
                    o.Ok = false;
                    o.Title = "Board support was not installed";
                    o.Details.Add(r.Message ?? "Unknown problem.");
                    o.Details.Add("MIX-FPGA is installed. Nothing that was already working was removed. Press Retry, or choose Install Support from MIX-FPGA Setup in Visual Studio Code.");
                    return o;
                }
                o.Details.AddRange(r.Boards);
                bool altera = boards.Contains("de10");
                string outcome = r.Outcome ?? "";
                if (outcome == "complete")
                {
                    // Every installed file is checked, for every board (the DE10-Lite check also builds a tiny test design in Quartus).
                    report("Verifying the installed tools…");
                    BridgeResult v = RunBridge(d, boards, true, report);
                    if (v.Ok != true)
                    {
                        o.Details.Add("Verify reported a problem: open MIX-FPGA Setup in Visual Studio Code and choose Repair. Nothing was changed or removed.");
                        o.Ok = false;
                        o.Title = "Installed, but Verify found a problem";
                        return o;
                    }
                    if (v.Modified == true) o.Details.Add("Verify: everything is there and usable, but you have changed a file of the installed tools, so it is no longer the verified MIX-FPGA configuration. Nothing was replaced. Choose Repair in MIX-FPGA Setup if you want the supported copy back.");
                    else o.Details.Add("Verify: every installed file checked: OK.");
                    o.Ok = true;
                    o.Title = v.Modified == true ? "MIX-FPGA is ready (modified tools kept)" : "MIX-FPGA is ready";
                    return o;
                }
                if (outcome == "stopped" && altera && r.StoppedFor == "altera")
                {
                    o.Details.Add("DE10-Lite: the MIX-FPGA part is installed. The last step needs Altera's free Quartus files and their licence; it continues in MIX-FPGA Setup in Visual Studio Code (Windows will ask for your permission once, to install Quartus).");
                    o.Ok = true;
                    o.NeedsAltera = true;
                    o.Title = "MIX-FPGA is installed. One step is left for the DE10-Lite";
                    return o;
                }
                o.Ok = false;
                o.Title = "Board support did not finish";
                List<string> more = new List<string>(o.Details);
                o.Details.Clear();
                o.Details.Add(r.Message ?? "Setup stopped.");
                o.Details.Add("Nothing that was already working was removed. Press Retry.");
                o.Details.AddRange(more);
                return o;
            }
            catch (InstallError e)
            {
                o.Ok = false;
                o.Title = o.Changed ? "The installation did not finish" : "Nothing was changed";
                o.Details.Add(e.Message);
                return o;
            }
        }

        /// <summary>Verify only: the Setup code of the installed extension checks every installed file; nothing is installed or changed.</summary>
        public Outcome VerifyOnly(Detection d, IList<string> boards, Action<string> report)
        {
            Outcome o = new Outcome();
            try
            {
                BridgeResult v = RunBridge(d, boards, true, report);
                o.Ok = v.Ok == true;
                o.Title = o.Ok ? (v.Modified == true ? "Verify: OK (the toolchain has been modified by you; it is usable)" : "Verify: every installed file checked: OK") : "Verify found a problem";
            }
            catch (InstallError e)
            {
                o.Ok = false;
                o.Title = "Verify could not run";
                o.Details.Add(e.Message);
            }
            return o;
        }

        /// <summary>Opens MIX-FPGA's Setup page in Visual Studio Code (the extension's own link; no other command can be reached this way).</summary>
        public void OpenSetup(Detection d)
        {
            List<string> a = CodeFlags();
            a.Add("--open-url");
            a.Add("vscode://emxplore.nexysvhdl/showenvironment");
            Run(d.CodeCmd, a, null, null);
        }
    }

    /// <summary>The few JSON fields the bridge reports (one object per line, flat except for the board list).</summary>
    static class Json
    {
        public static string Str(string json, string key)
        {
            int i = json.IndexOf("\"" + key + "\":", StringComparison.Ordinal);
            if (i < 0) return null;
            i += key.Length + 3;
            while (i < json.Length && json[i] == ' ') i++;
            if (i >= json.Length || json[i] != '"') return null;
            StringBuilder sb = new StringBuilder();
            for (i++; i < json.Length && json[i] != '"'; i++)
            {
                if (json[i] == '\\' && i + 1 < json.Length)
                {
                    i++;
                    char c = json[i];
                    if (c == 'n') sb.Append('\n');
                    else if (c == 't') sb.Append('\t');
                    else if (c == 'u' && i + 4 < json.Length) { sb.Append((char)Convert.ToInt32(json.Substring(i + 1, 4), 16)); i += 4; }
                    else sb.Append(c);
                }
                else sb.Append(json[i]);
            }
            return sb.ToString();
        }

        public static bool? Bool(string json, string key)
        {
            int i = json.IndexOf("\"" + key + "\":", StringComparison.Ordinal);
            if (i < 0) return null;
            i += key.Length + 3;
            if (string.CompareOrdinal(json, i, "true", 0, 4) == 0) return true;
            if (string.CompareOrdinal(json, i, "false", 0, 5) == 0) return false;
            return null;
        }

        /// <summary>"Name — word" for each entry of the "boards" array.</summary>
        public static List<string> BoardLines(string json)
        {
            List<string> list = new List<string>();
            int i = json.IndexOf("\"boards\":[", StringComparison.Ordinal);
            if (i < 0) return list;
            int end = json.IndexOf("]", i, StringComparison.Ordinal);
            string arr = json.Substring(i, end - i);
            int at = 0;
            while (true)
            {
                int o = arr.IndexOf("{", at, StringComparison.Ordinal);
                if (o < 0) break;
                int c = arr.IndexOf("}", o, StringComparison.Ordinal);
                string item = arr.Substring(o, c - o + 1);
                list.Add(Str(item, "name") + " — " + Str(item, "word"));
                at = c + 1;
            }
            return list;
        }
    }
}
