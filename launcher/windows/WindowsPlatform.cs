using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using Microsoft.Win32;

namespace NexysVhdl.Launcher
{
    /// <summary>
    /// The Windows side of the launcher: finds VS Code without PATH, starts
    /// processes with no console window, reads the per-user locations.
    /// Test hooks (environment variables, used only by the automated tests):
    ///   NEXYSVHDL_LAUNCHER_STATE_DIR       launcher state folder
    ///   NEXYSVHDL_LAUNCHER_FORCE_NO_VSCODE=1   behave as if VS Code were not installed
    ///   NEXYSVHDL_VSCODE_PATH              use this Code.exe
    ///   NEXYSVHDL_VSCODE_EXTENSIONS_DIR / NEXYSVHDL_VSCODE_USER_DATA_DIR
    ///                                      private VS Code folders (passed as --extensions-dir / --user-data-dir)
    ///   NEXYSVHDL_LAUNCHER_DATA_ROOT       NexysVHDL toolchain data root (default %LOCALAPPDATA%\NexysVHDL)
    /// </summary>
    public sealed class WindowsPlatform : IPlatform
    {
        public const string ExtensionId = "emxplore.nexysvhdl";
        const int InstallTimeoutMs = 180000;

        static string Env(string name)
        {
            string v = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrEmpty(v) ? null : v;
        }

        public string StateDirectory
        {
            get
            {
                return Env("NEXYSVHDL_LAUNCHER_STATE_DIR") ??
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "NexysVHDL", "Launcher");
            }
        }

        // ------------------------------------------------------------ VS Code

        static void AddCandidate(List<KeyValuePair<string, string>> list, string exe, string scope)
        {
            if (!string.IsNullOrEmpty(exe)) list.Add(new KeyValuePair<string, string>(exe, scope));
        }

        static void FromUninstallKeys(List<KeyValuePair<string, string>> list)
        {
            RegistryHive[] hives = { RegistryHive.CurrentUser, RegistryHive.LocalMachine };
            RegistryView[] views = { RegistryView.Registry64, RegistryView.Registry32 };
            foreach (RegistryHive hive in hives)
            {
                foreach (RegistryView view in views)
                {
                    try
                    {
                        using (RegistryKey b = RegistryKey.OpenBaseKey(hive, view))
                        using (RegistryKey u = b.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall"))
                        {
                            if (u == null) continue;
                            foreach (string name in u.GetSubKeyNames())
                            {
                                using (RegistryKey k = u.OpenSubKey(name))
                                {
                                    string display = k == null ? null : k.GetValue("DisplayName") as string;
                                    if (display == null || !display.StartsWith("Microsoft Visual Studio Code", StringComparison.OrdinalIgnoreCase)) continue;
                                    if (display.IndexOf("Insiders", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                                    string dir = k.GetValue("InstallLocation") as string;
                                    if (!string.IsNullOrEmpty(dir)) AddCandidate(list, Path.Combine(dir, "Code.exe"), hive == RegistryHive.CurrentUser ? "user" : "system");
                                }
                            }
                        }
                    }
                    catch (Exception) { /* an unreadable key is just not a candidate */ }
                }
            }
            foreach (RegistryHive hive in hives)
            {
                try
                {
                    using (RegistryKey b = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64))
                    using (RegistryKey k = b.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\Code.exe"))
                    {
                        string exe = k == null ? null : k.GetValue(null) as string;
                        AddCandidate(list, exe, hive == RegistryHive.CurrentUser ? "user" : "system");
                    }
                }
                catch (Exception) { }
            }
        }

        public VsCodeInfo FindVsCode()
        {
            if (Env("NEXYSVHDL_LAUNCHER_FORCE_NO_VSCODE") == "1") return null;
            List<KeyValuePair<string, string>> candidates = new List<KeyValuePair<string, string>>();
            AddCandidate(candidates, Env("NEXYSVHDL_VSCODE_PATH"), "override");
            string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (local != null) AddCandidate(candidates, Path.Combine(local, @"Programs\Microsoft VS Code\Code.exe"), "user");
            foreach (string v in new string[] { "ProgramFiles", "ProgramW6432", "ProgramFiles(x86)" })
            {
                string pf = Environment.GetEnvironmentVariable(v);
                if (pf != null) AddCandidate(candidates, Path.Combine(pf, @"Microsoft VS Code\Code.exe"), "system");
            }
            FromUninstallKeys(candidates);
            foreach (KeyValuePair<string, string> c in candidates)
            {
                if (!File.Exists(c.Key)) continue;
                VsCodeInfo info = new VsCodeInfo();
                info.Executable = c.Key;
                info.InstallDirectory = Path.GetDirectoryName(c.Key);
                info.Scope = c.Value;
                try { info.Version = FileVersionInfo.GetVersionInfo(c.Key).ProductVersion; } catch (Exception) { }
                info.CliScript = FindCli(info.InstallDirectory);
                return info;
            }
            return null;
        }

        /// <summary>VS Code's command-line script: resources\app\out\cli.js, directly or inside the versioned update folder (newest first).</summary>
        static string FindCli(string installDir)
        {
            const string rel = @"resources\app\out\cli.js";
            try
            {
                List<string> dirs = new List<string>(Directory.GetDirectories(installDir));
                dirs.Sort(delegate (string a, string b) { return Directory.GetLastWriteTimeUtc(b).CompareTo(Directory.GetLastWriteTimeUtc(a)); });
                foreach (string d in dirs)
                {
                    string p = Path.Combine(d, rel);
                    if (File.Exists(p)) return p;
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            string direct = Path.Combine(installDir, rel);
            return File.Exists(direct) ? direct : null;
        }

        // ---------------------------------------------------------- extension

        string ExtensionsDirectory
        {
            get
            {
                return Env("NEXYSVHDL_VSCODE_EXTENSIONS_DIR") ??
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), @".vscode\extensions");
            }
        }

        public ExtensionInfo FindExtension(VsCodeInfo vscode)
        {
            string root = ExtensionsDirectory;
            if (!Directory.Exists(root)) return null;
            HashSet<string> obsolete = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                string f = Path.Combine(root, ".obsolete");
                Dictionary<string, object> o = File.Exists(f) ? Json.TryParse(File.ReadAllText(f)) as Dictionary<string, object> : null;
                if (o != null) foreach (string k in o.Keys) obsolete.Add(k);
            }
            catch (IOException) { }
            ExtensionInfo best = null;
            Version bestVersion = null;
            foreach (string dir in Directory.GetDirectories(root, ExtensionId + "-*"))
            {
                string name = Path.GetFileName(dir);
                if (obsolete.Contains(name)) continue;
                string rest = name.Substring(ExtensionId.Length + 1);
                int dash = rest.IndexOf('-');
                string text = dash < 0 ? rest : rest.Substring(0, dash);
                Version v;
                if (!Version.TryParse(text, out v)) continue;
                if (bestVersion == null || v > bestVersion)
                {
                    bestVersion = v;
                    best = new ExtensionInfo();
                    best.Id = ExtensionId;
                    best.Version = text;
                    best.Folder = dir;
                }
            }
            return best;
        }

        /// <summary>Compares the extension's main script, byte for byte, with the one inside the bundled VSIX. Any problem reading counts as "matches": the launcher never nags on doubt.</summary>
        public bool ExtensionMatches(ExtensionInfo installed, string vsixPath)
        {
            try
            {
                string onDisk = Path.Combine(installed.Folder, @"dist\extension\extension.js");
                if (!File.Exists(onDisk)) return true;
                using (System.IO.Compression.ZipArchive zip = System.IO.Compression.ZipFile.OpenRead(vsixPath))
                {
                    System.IO.Compression.ZipArchiveEntry entry = zip.GetEntry("extension/dist/extension/extension.js");
                    if (entry == null) return true;
                    using (System.Security.Cryptography.SHA256 sha = System.Security.Cryptography.SHA256.Create())
                    {
                        byte[] a;
                        using (Stream s = entry.Open()) a = sha.ComputeHash(s);
                        byte[] b;
                        using (Stream s = File.OpenRead(onDisk)) b = sha.ComputeHash(s);
                        return Convert.ToBase64String(a) == Convert.ToBase64String(b);
                    }
                }
            }
            catch (Exception) { return true; }
        }

        // ---------------------------------------------------------- toolchain

        public ToolchainInfo FindToolchain()
        {
            ToolchainInfo t = new ToolchainInfo();
            string root = Env("NEXYSVHDL_LAUNCHER_DATA_ROOT") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NexysVHDL");
            t.Version = "1.0";
            string marker = Path.Combine(root, @"toolchains\win32-x64\1.0\.nexysvhdl-installed.json");
            try
            {
                Dictionary<string, object> m = File.Exists(marker) ? Json.TryParse(File.ReadAllText(marker)) as Dictionary<string, object> : null;
                if (m != null && m.ContainsKey("bundleVersion") && "1.0".Equals(m["bundleVersion"] as string))
                {
                    t.Installed = true;
                    t.Detail = "Installed";
                    return t;
                }
            }
            catch (IOException) { }
            t.Detail = "Not installed";
            return t;
        }

        // ---------------------------------------------------------- processes

        /// <summary>Arguments that point VS Code at private folders (tests only).</summary>
        static string PrivateFolderArgs()
        {
            StringBuilder b = new StringBuilder();
            string ext = Env("NEXYSVHDL_VSCODE_EXTENSIONS_DIR");
            string data = Env("NEXYSVHDL_VSCODE_USER_DATA_DIR");
            if (ext != null) b.Append(" --extensions-dir ").Append(Quote(ext));
            if (data != null) b.Append(" --user-data-dir ").Append(Quote(data));
            return b.ToString();
        }

        static string Quote(string s)
        {
            return "\"" + s.Replace("\"", "\\\"") + "\"";
        }

        static ProcessStartInfo Hidden(string exe, string args)
        {
            ProcessStartInfo p = new ProcessStartInfo(exe, args);
            p.UseShellExecute = false;
            p.CreateNoWindow = true;
            p.WindowStyle = ProcessWindowStyle.Hidden;
            // A launcher started from a developer shell must not turn VS Code into a Node process.
            p.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            p.EnvironmentVariables.Remove("VSCODE_DEV");
            return p;
        }

        public void OpenFolder(VsCodeInfo vscode, string folder)
        {
            Process.Start(Hidden(vscode.Executable, Quote(folder) + PrivateFolderArgs()));
        }

        public void OpenUri(VsCodeInfo vscode, string uri)
        {
            Process.Start(Hidden(vscode.Executable, "--open-url" + PrivateFolderArgs() + " -- " + Quote(uri)));
        }

        public ProcessOutcome InstallExtension(VsCodeInfo vscode, string vsixPath)
        {
            ProcessOutcome r = new ProcessOutcome();
            if (vscode.CliScript == null)
            {
                r.Output = "Visual Studio Code's command-line support was not found in its installation folder.";
                return r;
            }
            // Same as VS Code's own code.cmd, started directly so no console window ever appears.
            ProcessStartInfo p = Hidden(vscode.Executable, Quote(vscode.CliScript) + " --install-extension " + Quote(vsixPath) + " --force" + PrivateFolderArgs());
            p.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            p.EnvironmentVariables["VSCODE_DEV"] = "";
            p.RedirectStandardOutput = true;
            p.RedirectStandardError = true;
            using (Process proc = Process.Start(p))
            {
                StringBuilder output = new StringBuilder();
                proc.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) output.AppendLine(e.Data); };
                proc.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) output.AppendLine(e.Data); };
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                if (!proc.WaitForExit(InstallTimeoutMs))
                {
                    try { proc.Kill(); } catch (InvalidOperationException) { }
                    r.Output = "Installing took too long and was stopped.";
                    return r;
                }
                proc.WaitForExit();
                r.ExitCode = proc.ExitCode;
                r.Output = output.ToString();
                r.Ok = proc.ExitCode == 0;
            }
            return r;
        }

        public void OpenWebPage(string url)
        {
            ProcessStartInfo p = new ProcessStartInfo(url);
            p.UseShellExecute = true; // the default browser; no console involved
            Process.Start(p);
        }
    }
}
