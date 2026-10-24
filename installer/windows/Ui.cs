using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace MixFpga.Setup
{
    /// <summary>The installer window: what was found, which boards, progress, and what to do next.</summary>
    public sealed class SetupForm : Form
    {
        readonly Options opt;
        readonly Installer installer;
        Detection det;
        Outcome outcome;
        Thread worker;

        readonly Panel head = new Panel();
        readonly Label title = new Label();
        readonly Label sub = new Label();
        readonly Panel pageChoose = new Panel();
        readonly Panel pageRun = new Panel();
        readonly Panel pageDone = new Panel();
        readonly Label found = new Label();
        readonly Label mode = new Label();
        readonly RadioButton rNexys = new RadioButton();
        readonly RadioButton rDe10 = new RadioButton();
        readonly RadioButton rBoth = new RadioButton();
        readonly Label need = new Label();
        readonly Button install = new Button();
        readonly Button retry = new Button();
        readonly Button closeA = new Button();
        readonly TextBox log = new TextBox();
        readonly ProgressBar bar = new ProgressBar();
        readonly Button cancel = new Button();
        readonly Label doneTitle = new Label();
        readonly TextBox doneText = new TextBox();
        readonly Button openSetup = new Button();
        readonly Button again = new Button();
        readonly Button closeB = new Button();

        public SetupForm(Options o)
        {
            opt = o;
            installer = new Installer(o);
            Text = "MIX-FPGA " + Pins.Version + " Setup";
            Font = new Font("Segoe UI", 9.5f);
            ClientSize = new Size(620, 470);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.White;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }

            head.Dock = DockStyle.Top; head.Height = 78; head.BackColor = Color.FromArgb(24, 54, 94);
            title.Text = "MIX-FPGA " + Pins.Version; title.ForeColor = Color.White; title.Font = new Font("Segoe UI Semibold", 17f); title.AutoSize = true; title.Location = new Point(20, 10);
            sub.Text = "FPGA design for the Nexys A7 and the DE10-Lite in Visual Studio Code"; sub.ForeColor = Color.FromArgb(215, 225, 240); sub.AutoSize = true; sub.Location = new Point(22, 48);
            head.Controls.Add(title); head.Controls.Add(sub);
            Controls.Add(head);

            foreach (Panel p in new[] { pageChoose, pageRun, pageDone }) { p.Location = new Point(0, head.Height); p.Size = new Size(ClientSize.Width, ClientSize.Height - head.Height); p.BackColor = Color.White; Controls.Add(p); }

            // ---- choose
            found.Location = new Point(24, 14); found.Size = new Size(570, 60);
            mode.Location = new Point(24, 78); mode.Size = new Size(570, 78);
            Label which = new Label(); which.Text = "Which board will you use?"; which.Font = new Font("Segoe UI Semibold", 10.5f); which.Location = new Point(24, 160); which.AutoSize = true;
            rNexys.Text = "Nexys A7-100T"; rDe10.Text = "DE10-Lite"; rBoth.Text = "Both boards";
            int y = 186;
            foreach (RadioButton r in new[] { rNexys, rDe10, rBoth }) { r.Location = new Point(40, y); r.AutoSize = true; y += 26; r.CheckedChanged += delegate { UpdateButtons(); }; }
            need.Location = new Point(24, 270); need.Size = new Size(570, 70); need.ForeColor = Color.FromArgb(70, 70, 70);
            install.Text = "Install"; install.Location = new Point(24, 350); install.Size = new Size(130, 34); install.Click += delegate { Start(); };
            retry.Text = "Check again"; retry.Location = new Point(164, 350); retry.Size = new Size(130, 34); retry.Click += delegate { Refresh2(); };
            closeA.Text = "Close"; closeA.Location = new Point(464, 350); closeA.Size = new Size(130, 34); closeA.Click += delegate { Close(); };
            pageChoose.Controls.AddRange(new Control[] { found, mode, which, rNexys, rDe10, rBoth, need, install, retry, closeA });

            // ---- run
            log.Multiline = true; log.ReadOnly = true; log.ScrollBars = ScrollBars.Vertical; log.Location = new Point(24, 18); log.Size = new Size(570, 250); log.BackColor = Color.FromArgb(248, 248, 248); log.Font = new Font("Consolas", 9f);
            bar.Style = ProgressBarStyle.Marquee; bar.Location = new Point(24, 282); bar.Size = new Size(570, 14);
            Label keep = new Label(); keep.Text = "Keep this window open until it says the work is done."; keep.Location = new Point(24, 304); keep.AutoSize = true; keep.ForeColor = Color.FromArgb(70, 70, 70);
            cancel.Text = "Cancel"; cancel.Location = new Point(464, 340); cancel.Size = new Size(130, 34); cancel.Click += delegate { Cancel(); };
            pageRun.Controls.AddRange(new Control[] { log, bar, keep, cancel });

            // ---- done
            doneTitle.Font = new Font("Segoe UI Semibold", 13f); doneTitle.Location = new Point(24, 16); doneTitle.Size = new Size(570, 30);
            doneText.Multiline = true; doneText.ReadOnly = true; doneText.ScrollBars = ScrollBars.Vertical; doneText.BorderStyle = BorderStyle.None; doneText.BackColor = Color.White; doneText.Location = new Point(24, 54); doneText.Size = new Size(570, 270);
            openSetup.Text = "Open MIX-FPGA Setup"; openSetup.Location = new Point(24, 340); openSetup.Size = new Size(190, 34); openSetup.Click += delegate { installer.OpenSetup(det); };
            again.Text = "Retry"; again.Location = new Point(224, 340); again.Size = new Size(130, 34); again.Click += delegate { ShowChoose(); };
            closeB.Text = "Close"; closeB.Location = new Point(464, 340); closeB.Size = new Size(130, 34); closeB.Click += delegate { Close(); };
            pageDone.Controls.AddRange(new Control[] { doneTitle, doneText, openSetup, again, closeB });

            Load += delegate { Refresh2(); };
            FormClosing += delegate (object s, FormClosingEventArgs e)
            {
                if (worker != null && worker.IsAlive) { e.Cancel = true; Cancel(); }
            };
        }

        static void Show1(Panel show, params Panel[] others) { show.Visible = true; show.BringToFront(); foreach (Panel o in others) o.Visible = false; }

        void ShowChoose() { Refresh2(); Show1(pageChoose, pageRun, pageDone); }

        void Refresh2()
        {
            det = installer.Detect();
            if (det.CodeCmd == null) found.Text = "Visual Studio Code: not found.\r\n" + det.Problem;
            else found.Text = "Visual Studio Code " + det.CodeVersion + ": found." + (det.Problem != null ? "\r\n" + det.Problem : "");
            switch (det.Mode)
            {
                case Mode.Upgrade:
                    mode.Text = "Upgrade from NexysVHDL " + det.ExtensionVersion + ".\r\nMIX-FPGA is installed over it: your projects and settings are kept, nothing is uninstalled first, and the old tools (Toolchain 1.0) are left where they are. MIX-FPGA " + Pins.Version + " uses Toolchain 1.1, which is added next to them.";
                    break;
                case Mode.Reinstall:
                    mode.Text = "MIX-FPGA " + Pins.Version + " is already installed.\r\nThis checks it and puts back anything that is missing (Repair/Reinstall). Your projects and settings are not touched.";
                    break;
                default:
                    mode.Text = "Fresh install." + (det.LegacyStore ? "\r\nNexysVHDL tools were found on this computer; they are left untouched." : "");
                    break;
            }
            if (det.Mode == Mode.Upgrade && !rNexys.Checked && !rDe10.Checked && !rBoth.Checked) rNexys.Checked = true;
            UpdateButtons();
            Show1(pageChoose, pageRun, pageDone);
        }

        void UpdateButtons()
        {
            bool ok = det != null && det.CodeCmd != null && (det.Problem == null) && (rNexys.Checked || rDe10.Checked || rBoth.Checked);
            install.Enabled = ok;
            install.Text = det != null && det.Mode == Mode.Reinstall ? "Repair / Reinstall" : "Install";
            string t = "";
            if (rNexys.Checked) t = "About 3 GB of disk space. The Nexys A7 is programmed with Digilent's free Adept software, which you install yourself if MIX-FPGA says it is missing (MIX-FPGA shows the link).";
            else if (rDe10.Checked) t = "About 0.2 GB now, plus about 9 GB for Altera's free Quartus Prime Lite, which MIX-FPGA installs afterwards from the two files you download from Altera (you read and accept Altera's licence, and Windows asks for your permission once).";
            else if (rBoth.Checked) t = "About 3.2 GB now, plus about 9 GB for Altera's Quartus Prime Lite (the DE10-Lite step continues inside Visual Studio Code).";
            need.Text = t;
        }

        List<string> SelectedBoards()
        {
            List<string> b = new List<string>();
            if (rNexys.Checked || rBoth.Checked) b.Add("nexys");
            if (rDe10.Checked || rBoth.Checked) b.Add("de10");
            return b;
        }

        void Append(string line)
        {
            if (InvokeRequired) { BeginInvoke(new Action<string>(Append), line); return; }
            log.AppendText(line + "\r\n");
            Program.Log(line);
        }

        void Start()
        {
            List<string> boards = SelectedBoards();
            log.Clear();
            Show1(pageRun, pageChoose, pageDone);
            bar.Style = ProgressBarStyle.Marquee;
            worker = new Thread(delegate ()
            {
                Outcome o = installer.Perform(det, boards, Append);
                BeginInvoke(new Action(delegate { Finish(o); }));
            });
            worker.IsBackground = true;
            worker.Start();
        }

        void Cancel()
        {
            Append("Cancelling…");
            installer.Cancel();
        }

        void Finish(Outcome o)
        {
            outcome = o;
            doneTitle.Text = o.Title;
            doneTitle.ForeColor = o.Ok ? Color.FromArgb(20, 110, 50) : Color.FromArgb(170, 40, 40);
            StringBuilder sb = new StringBuilder();
            foreach (string d in o.Details) sb.AppendLine(d).AppendLine();
            if (o.Ok)
            {
                sb.AppendLine("What to do now: open Visual Studio Code, click the MIX-FPGA icon and choose Show Environment" + (o.NeedsAltera ? ", then Install DE10-Lite Support to finish with Altera's files." : "."));
                sb.AppendLine();
                sb.AppendLine("To program the Nexys A7 you also need Digilent's free Adept Runtime and Adept Utilities (MIX-FPGA Setup shows the link if they are missing). The DE10-Lite needs nothing from Digilent.");
            }
            doneText.Text = sb.ToString();
            openSetup.Visible = o.Ok;
            again.Visible = !o.Ok;
            Show1(pageDone, pageChoose, pageRun);
            bar.Style = ProgressBarStyle.Blocks;
        }
    }
}
