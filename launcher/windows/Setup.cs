using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

namespace NexysVhdl.Launcher
{
    /// <summary>
    /// NexysVHDL-Setup.exe: a small per-user installer (no administrator rights).
    /// Installs NexysVHDL.exe, the NexysVHDL VS Code extension file and the icon
    /// into %LOCALAPPDATA%\Programs\NexysVHDL, adds a Start Menu entry (and
    /// optionally a Desktop shortcut) and an "Apps &amp; features" entry, and
    /// optionally installs the extension into VS Code. It does not contain, copy or
    /// change the FPGA toolchain, and never touches VS Code's settings or other extensions.
    ///   /S               silent (no window)         /desktop   Desktop shortcut
    ///   /noextension     do not install the VS Code extension
    ///   /nolaunch        do not start NexysVHDL afterwards
    ///   /dir=PATH        install folder             /uninstall remove NexysVHDL (also: Uninstall.exe)
    /// </summary>
    public sealed class SetupForm : Form
    {
        const string AppName = "NexysVHDL";
        const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\NexysVHDL";

        readonly CheckBox desktop = new CheckBox();
        readonly CheckBox extension = new CheckBox();
        readonly CheckBox launch = new CheckBox();
        readonly Button install = new Button();
        readonly Label status = new Label();
        readonly Label where = new Label();
        readonly string dir;
        readonly bool vsCodeFound;

        public SetupForm(string installDir)
        {
            dir = installDir;
            Text = "NexysVHDL Setup";
            Font = new Font("Segoe UI", 9.5f);
            ClientSize = new Size(480, 330);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.White;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
            Panel header = new Panel();
            header.BackColor = Color.FromArgb(15, 27, 45);
            header.SetBounds(0, 0, 480, 70);
            Label t = new Label();
            t.Text = "Install NexysVHDL";
            t.Font = new Font("Segoe UI Semibold", 16f);
            t.ForeColor = Color.White;
            t.AutoSize = true;
            t.Location = new Point(20, 16);
            header.Controls.Add(t);
            Controls.Add(header);
            Panel accent = new Panel();
            accent.BackColor = Color.FromArgb(242, 140, 40);
            accent.SetBounds(0, 70, 480, 3);
            Controls.Add(accent);

            WindowsPlatform p = new WindowsPlatform();
            vsCodeFound = p.FindVsCode() != null;
            where.Text = "Installs for your Windows account only (no administrator needed) into:\n" + dir;
            where.SetBounds(20, 90, 440, 40);
            Controls.Add(where);
            Check(desktop, "Create a Desktop shortcut", 138, true, false);
            Check(extension, vsCodeFound ? "Add the NexysVHDL extension to Visual Studio Code" : "Add the NexysVHDL extension to VS Code (VS Code not found: you can do this later)", 164, vsCodeFound, vsCodeFound);
            extension.Enabled = vsCodeFound;
            Check(launch, "Start NexysVHDL when finished", 190, true, true);
            status.SetBounds(20, 224, 440, 22);
            status.ForeColor = Color.FromArgb(110, 120, 135);
            Controls.Add(status);
            install.Text = "Install";
            install.FlatStyle = FlatStyle.Flat;
            install.BackColor = Color.FromArgb(242, 140, 40);
            install.ForeColor = Color.FromArgb(15, 27, 45);
            install.FlatAppearance.BorderSize = 0;
            install.Font = new Font("Segoe UI Semibold", 10f);
            install.SetBounds(330, 270, 130, 38);
            install.Click += delegate { RunInstall(); };
            Controls.Add(install);
        }

        void Check(CheckBox c, string text, int y, bool on, bool enabled)
        {
            c.Text = text;
            c.Checked = on;
            c.AutoSize = false;
            c.SetBounds(20, y, 440, 24);
            Controls.Add(c);
        }

        void RunInstall()
        {
            install.Enabled = false;
            status.Text = "Installing…";
            Application.DoEvents();
            string error = Installer.Install(dir, desktop.Checked, extension.Checked && vsCodeFound, false);
            if (error != null)
            {
                MessageBox.Show(this, error, "NexysVHDL Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                status.Text = "";
                install.Enabled = true;
                return;
            }
            if (launch.Checked) Installer.Launch(dir);
            Close();
        }
    }

    public static class Installer
    {
        const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\NexysVHDL";

        public static string DefaultDirectory()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\NexysVHDL");
        }

        static string StartMenuShortcut()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "NexysVHDL.lnk");
        }

        static string DesktopShortcut()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "NexysVHDL.lnk");
        }

        static void Extract(string resource, string target)
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource))
            {
                if (s == null) throw new InvalidOperationException("The setup file is damaged (missing " + resource + ").");
                using (FileStream f = new FileStream(target, FileMode.Create, FileAccess.Write))
                {
                    s.CopyTo(f);
                }
            }
        }

        static void MakeShortcut(string path, string target, string icon, string description)
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(t);
            object link = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
            Type lt = link.GetType();
            lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { target });
            lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { Path.GetDirectoryName(target) });
            lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, link, new object[] { icon });
            lt.InvokeMember("Description", BindingFlags.SetProperty, null, link, new object[] { description });
            lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
        }

        /// <summary>Returns null on success, or a student-readable problem.</summary>
        public static string Install(string dir, bool desktopShortcut, bool installExtension, bool silent)
        {
            try
            {
                Directory.CreateDirectory(dir);
                string exe = Path.Combine(dir, "NexysVHDL.exe");
                string vsix = Path.Combine(dir, "nexysvhdl.vsix");
                string ico = Path.Combine(dir, "NexysVHDL.ico");
                string uninstall = Path.Combine(dir, "Uninstall.exe");
                try
                {
                    Extract("payload.NexysVHDL.exe", exe);
                }
                catch (IOException)
                {
                    return "NexysVHDL is open. Close it and run Setup again.";
                }
                Extract("payload.nexysvhdl.vsix", vsix);
                Extract("payload.NexysVHDL.ico", ico);
                string version;
                using (StreamReader r = new StreamReader(Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.version.txt")))
                {
                    version = r.ReadToEnd().Trim();
                }
                if (!string.Equals(Path.GetFullPath(Application.ExecutablePath), Path.GetFullPath(uninstall), StringComparison.OrdinalIgnoreCase))
                    File.Copy(Application.ExecutablePath, uninstall, true);

                MakeShortcut(StartMenuShortcut(), exe, ico, "NexysVHDL: VHDL for the Nexys A7 FPGA");
                if (desktopShortcut) MakeShortcut(DesktopShortcut(), exe, ico, "NexysVHDL: VHDL for the Nexys A7 FPGA");

                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(UninstallKey))
                {
                    k.SetValue("DisplayName", "NexysVHDL");
                    k.SetValue("DisplayVersion", version);
                    k.SetValue("Publisher", "EMXplore");
                    k.SetValue("DisplayIcon", ico);
                    k.SetValue("InstallLocation", dir);
                    k.SetValue("UninstallString", "\"" + uninstall + "\" /uninstall");
                    k.SetValue("QuietUninstallString", "\"" + uninstall + "\" /uninstall /S");
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                }

                if (installExtension)
                {
                    LauncherService svc = new LauncherService(new WindowsPlatform(), vsix);
                    OpenResult r = svc.InstallExtension(vsix);
                    if (!r.Ok) return "NexysVHDL was installed, but its Visual Studio Code extension could not be added.\n\n" + r.Message + "\n\nYou can add it later from the NexysVHDL window (Install NexysVHDL).";
                }
                return null;
            }
            catch (UnauthorizedAccessException e)
            {
                return "NexysVHDL could not write to " + dir + ": " + e.Message;
            }
            catch (IOException e)
            {
                return "NexysVHDL could not be installed: " + e.Message;
            }
        }

        public static void Launch(string dir)
        {
            ProcessStartInfo p = new ProcessStartInfo(Path.Combine(dir, "NexysVHDL.exe"));
            p.UseShellExecute = false;
            Process.Start(p);
        }

        /// <summary>Removes NexysVHDL.exe, shortcuts and the Apps entry. The VS Code extension, the toolchain, projects and recent-project list are left alone.</summary>
        public static void Uninstall(string dir)
        {
            foreach (string f in new string[] { StartMenuShortcut(), DesktopShortcut() })
            {
                try { if (File.Exists(f)) File.Delete(f); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
            try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch (Exception) { }
            // This program lives in the folder being removed: finish the deletion after it exits, with no visible window.
            ProcessStartInfo p = new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 >nul & rd /s /q \"" + dir + "\"");
            p.CreateNoWindow = true;
            p.UseShellExecute = false;
            p.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(p);
        }
    }

    public static class SetupProgram
    {
        [STAThread]
        public static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            bool silent = false, desktop = false, noExt = false, noLaunch = false, uninstall = false;
            string dir = Installer.DefaultDirectory();
            foreach (string a in args)
            {
                if (a.Equals("/S", StringComparison.OrdinalIgnoreCase)) silent = true;
                else if (a.Equals("/desktop", StringComparison.OrdinalIgnoreCase)) desktop = true;
                else if (a.Equals("/noextension", StringComparison.OrdinalIgnoreCase)) noExt = true;
                else if (a.Equals("/nolaunch", StringComparison.OrdinalIgnoreCase)) noLaunch = true;
                else if (a.Equals("/uninstall", StringComparison.OrdinalIgnoreCase)) uninstall = true;
                else if (a.StartsWith("/dir=", StringComparison.OrdinalIgnoreCase)) dir = a.Substring(5).Trim('"');
            }
            if (uninstall)
            {
                if (!silent && MessageBox.Show("Remove NexysVHDL from this computer?\n\nYour projects, the NexysVHDL extension in Visual Studio Code and the FPGA toolchain are not removed.", "NexysVHDL", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return 1;
                string installed = Path.GetDirectoryName(Application.ExecutablePath);
                Installer.Uninstall(installed);
                return 0;
            }
            if (silent)
            {
                string error = Installer.Install(dir, desktop, !noExt, true);
                if (error == null && !noLaunch) Installer.Launch(dir);
                return error == null ? 0 : 1;
            }
            Application.Run(new SetupForm(dir));
            return 0;
        }
    }
}
