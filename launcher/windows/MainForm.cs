using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace NexysVhdl.Launcher
{
    /// <summary>The NexysVHDL launcher window: New Project, Open Project, Recent Projects and what is ready.</summary>
    public sealed class MainForm : Form
    {
        static readonly Color Navy = Color.FromArgb(15, 27, 45);
        static readonly Color NavyLight = Color.FromArgb(22, 38, 63);
        static readonly Color Orange = Color.FromArgb(242, 140, 40);
        static readonly Color Green = Color.FromArgb(46, 139, 87);
        static readonly Color Red = Color.FromArgb(200, 60, 50);
        static readonly Color Grey = Color.FromArgb(110, 120, 135);

        readonly LauncherService service;
        readonly string vsixPath;
        LauncherStatus status;

        readonly Button newButton = new Button();
        readonly Button openButton = new Button();
        readonly ListView recentList = new ListView();
        readonly Label vsLabel = new Label();
        readonly Label extLabel = new Label();
        readonly Label tcLabel = new Label();
        readonly Label hint = new Label();
        readonly Button actionButton = new Button();
        readonly Button recheckLink = new Button();
        readonly Label busy = new Label();
        List<RecentProject> shown = new List<RecentProject>();

        public MainForm(LauncherService service, string vsixPath)
        {
            this.service = service;
            this.vsixPath = vsixPath;
            Text = "NexysVHDL";
            Font = new Font("Segoe UI", 9.5f);
            ClientSize = new Size(600, 560);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.White;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
            Build();
            Activated += delegate { RefreshAll(); };
            Shown += delegate { RefreshAll(); };
        }

        void Build()
        {
            Panel header = new Panel();
            header.BackColor = Navy;
            header.SetBounds(0, 0, 600, 96);
            Label title = new Label();
            title.Text = "NexysVHDL";
            title.Font = new Font("Segoe UI Semibold", 22f);
            title.ForeColor = Color.White;
            title.AutoSize = true;
            title.Location = new Point(24, 14);
            Label sub = new Label();
            sub.Text = "Design VHDL for the Digilent Nexys A7 FPGA";
            sub.ForeColor = Color.FromArgb(170, 185, 210);
            sub.AutoSize = true;
            sub.Location = new Point(28, 58);
            Panel accent = new Panel();
            accent.BackColor = Orange;
            accent.SetBounds(0, 92, 600, 4);
            header.Controls.Add(title);
            header.Controls.Add(sub);
            header.Controls.Add(accent);
            Controls.Add(header);

            StyleBig(newButton, "New Project", "Create a project from a starter", 24);
            StyleBig(openButton, "Open Project", "Choose a project folder", 312);
            newButton.Click += delegate { DoNew(); };
            openButton.Click += delegate { DoPick(); };
            Controls.Add(newButton);
            Controls.Add(openButton);

            Label recentTitle = new Label();
            recentTitle.Text = "Recent Projects";
            recentTitle.Font = new Font("Segoe UI Semibold", 11f);
            recentTitle.AutoSize = true;
            recentTitle.Location = new Point(24, 218);
            Controls.Add(recentTitle);

            recentList.View = View.Details;
            recentList.FullRowSelect = true;
            recentList.HideSelection = false;
            recentList.MultiSelect = false;
            recentList.BorderStyle = BorderStyle.FixedSingle;
            recentList.HeaderStyle = ColumnHeaderStyle.None;
            recentList.Columns.Add("Project", 150);
            recentList.Columns.Add("Folder", 320);
            recentList.Columns.Add("Opened", 80);
            recentList.SetBounds(24, 246, 552, 150);
            recentList.DoubleClick += delegate { OpenSelected(); };
            recentList.KeyDown += delegate (object s, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Enter) OpenSelected();
                else if (e.KeyCode == Keys.Delete) ForgetSelected();
            };
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("Open", null, delegate { OpenSelected(); });
            menu.Items.Add("Remove from this list", null, delegate { ForgetSelected(); });
            recentList.ContextMenuStrip = menu;
            Controls.Add(recentList);

            Panel line = new Panel();
            line.BackColor = Color.FromArgb(225, 229, 236);
            line.SetBounds(24, 412, 552, 1);
            Controls.Add(line);

            StyleStatus(vsLabel, 422);
            StyleStatus(extLabel, 444);
            StyleStatus(tcLabel, 466);

            hint.ForeColor = Grey;
            hint.SetBounds(24, 492, 400, 40);
            Controls.Add(hint);

            actionButton.Visible = false;
            actionButton.FlatStyle = FlatStyle.Flat;
            actionButton.BackColor = Orange;
            actionButton.ForeColor = Navy;
            actionButton.FlatAppearance.BorderSize = 0;
            actionButton.Font = new Font("Segoe UI Semibold", 9.5f);
            actionButton.SetBounds(404, 424, 172, 36);
            actionButton.Click += delegate { DoAction(); };
            Controls.Add(actionButton);

            recheckLink.Text = "Check again";
            recheckLink.FlatStyle = FlatStyle.Flat;
            recheckLink.FlatAppearance.BorderSize = 0;
            recheckLink.ForeColor = Color.FromArgb(40, 100, 190);
            recheckLink.Cursor = Cursors.Hand;
            recheckLink.Visible = false;
            recheckLink.SetBounds(404, 464, 172, 26);
            recheckLink.Click += delegate { RefreshAll(); };
            Controls.Add(recheckLink);

            busy.ForeColor = Navy;
            busy.Font = new Font("Segoe UI Semibold", 9.5f);
            busy.Visible = false;
            busy.SetBounds(404, 424, 172, 36);
            busy.TextAlign = ContentAlignment.MiddleCenter;
            Controls.Add(busy);
        }

        static void StyleBig(Button b, string text, string sub, int x)
        {
            b.Text = text + "\n" + sub;
            b.Font = new Font("Segoe UI Semibold", 11f);
            b.TextAlign = ContentAlignment.MiddleLeft;
            b.Padding = new Padding(12, 0, 0, 0);
            b.FlatStyle = FlatStyle.Flat;
            b.BackColor = Navy;
            b.ForeColor = Color.White;
            b.FlatAppearance.BorderSize = 0;
            b.FlatAppearance.MouseOverBackColor = NavyLight;
            b.Cursor = Cursors.Hand;
            b.SetBounds(x, 118, 264, 80);
        }

        void StyleStatus(Label l, int y)
        {
            l.AutoSize = false;
            l.SetBounds(24, y, 372, 22);
            Controls.Add(l);
        }

        static void SetStatus(Label l, bool ok, string text)
        {
            l.Text = (ok ? "✓  " : "✗  ") + text;
            l.ForeColor = ok ? Green : Red;
        }

        void RefreshAll()
        {
            status = service.GetStatus();
            SetStatus(vsLabel, status.VsCodeFound, status.VsCodeFound ? "VS Code" + (status.VsCode.Version != null ? "  " + status.VsCode.Version : "") : "VS Code not found");
            if (!status.VsCodeFound) { extLabel.Text = "–  NexysVHDL extension"; extLabel.ForeColor = Grey; }
            else if (status.ExtensionFound && status.ExtensionOutdated)
            {
                SetStatus(extLabel, false, "NexysVHDL extension " + status.Extension.Version + " is an older build");
                extLabel.ForeColor = Color.FromArgb(190, 120, 20);
            }
            else SetStatus(extLabel, status.ExtensionFound, status.ExtensionFound ? "NexysVHDL extension  " + status.Extension.Version : "NexysVHDL extension not installed");
            SetStatus(tcLabel, status.Toolchain.Installed, status.Toolchain.Installed ? "Toolchain " + status.Toolchain.Version : "Toolchain " + status.Toolchain.Version + " not installed");
            if (!status.Toolchain.Installed) tcLabel.ForeColor = Color.FromArgb(190, 120, 20);

            recheckLink.Visible = !status.VsCodeFound;
            if (!status.VsCodeFound)
            {
                actionButton.Text = "Get Visual Studio Code";
                actionButton.Tag = "getvscode";
                actionButton.Visible = busy.Visible == false;
                hint.Text = "NexysVHDL runs inside Visual Studio Code, which is free. Install it, then click Check again.";
            }
            else if (!status.ExtensionFound)
            {
                actionButton.Text = "Install NexysVHDL";
                actionButton.Tag = "installext";
                actionButton.Visible = busy.Visible == false;
                hint.Text = "One click adds the NexysVHDL extension to Visual Studio Code. Your other extensions and settings are not changed.";
            }
            else if (status.ExtensionOutdated)
            {
                actionButton.Text = "Update NexysVHDL";
                actionButton.Tag = "installext";
                actionButton.Visible = busy.Visible == false;
                hint.Text = "The NexysVHDL extension in Visual Studio Code is older than the one in this installation. One click updates it; your other extensions and settings are not changed.";
            }
            else
            {
                actionButton.Visible = false;
                hint.Text = status.Toolchain.Installed ? "" : "The FPGA toolchain is installed from inside NexysVHDL: it will offer to do it the first time you open a project.";
            }
            bool ready = status.CanOpen;
            newButton.Enabled = ready;
            openButton.Enabled = ready;
            newButton.BackColor = ready ? Navy : Color.FromArgb(150, 158, 170);
            openButton.BackColor = ready ? Navy : Color.FromArgb(150, 158, 170);
            FillRecent();
        }

        void FillRecent()
        {
            shown = service.Recent.List();
            recentList.Items.Clear();
            if (shown.Count == 0)
            {
                ListViewItem none = new ListViewItem("No recent projects yet");
                none.ForeColor = Grey;
                none.Tag = null;
                recentList.Items.Add(none);
                return;
            }
            foreach (RecentProject r in shown)
            {
                ListViewItem item = new ListViewItem(r.Name);
                item.SubItems.Add(r.Path);
                item.SubItems.Add(r.Exists ? r.LastOpenedUtc.ToLocalTime().ToString("d MMM") : "missing");
                item.Tag = r;
                if (!r.Exists) item.ForeColor = Grey;
                recentList.Items.Add(item);
            }
        }

        RecentProject Selected()
        {
            if (recentList.SelectedItems.Count == 0) return null;
            return recentList.SelectedItems[0].Tag as RecentProject;
        }

        void OpenSelected()
        {
            RecentProject r = Selected();
            if (r == null) return;
            if (!r.Exists)
            {
                MessageBox.Show(this, "\"" + r.Name + "\" is no longer at\n" + r.Path + "\n\nIt may have been moved or deleted. It was removed from the list.", "NexysVHDL", MessageBoxButtons.OK, MessageBoxIcon.Information);
                service.Recent.Remove(r.Path);
                FillRecent();
                return;
            }
            Finish(service.OpenProject(r.Path));
        }

        void ForgetSelected()
        {
            RecentProject r = Selected();
            if (r == null) return;
            service.Recent.Remove(r.Path);
            FillRecent();
        }

        void DoPick()
        {
            string folder = FolderPicker.Pick(Handle, "Choose a NexysVHDL project folder (it contains nexysvhdl.json)");
            if (folder == null) return;
            Finish(service.OpenProject(folder));
        }

        void DoNew()
        {
            Finish(service.NewProject());
        }

        /// <summary>Shows a friendly message for anything that did not open; closes the launcher when VS Code took over.</summary>
        void Finish(OpenResult r)
        {
            if (r.Ok) { Close(); return; }
            MessageBox.Show(this, r.Message, "NexysVHDL", MessageBoxButtons.OK, r.Outcome == OpenOutcome.NotAProject ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            RefreshAll();
        }

        void DoAction()
        {
            string what = actionButton.Tag as string;
            if (what == "getvscode")
            {
                service.OpenWebPage();
                return;
            }
            if (what != "installext") return;
            actionButton.Visible = false;
            busy.Text = "Installing…";
            busy.Visible = true;
            newButton.Enabled = false;
            openButton.Enabled = false;
            Thread t = new Thread(delegate ()
            {
                OpenResult r = service.InstallExtension(vsixPath);
                BeginInvoke((MethodInvoker)delegate
                {
                    busy.Visible = false;
                    if (!r.Ok) MessageBox.Show(this, r.Message, "NexysVHDL", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    RefreshAll();
                });
            });
            t.IsBackground = true;
            t.Start();
        }
    }
}
