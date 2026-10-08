using System;
using System.Collections.Generic;
using System.IO;
using NexysVhdl.Launcher;

// Tests of the reusable launcher logic (launcher/core) against a fake platform.
// Built and run by tests/launcher.test.ts; prints "ok <name>" or "FAIL <name>: <why>".
public static class CoreTests
{
    static int failures;

    static void Test(string name, Action body)
    {
        try { body(); Console.WriteLine("ok " + name); }
        catch (Exception e) { failures++; Console.WriteLine("FAIL " + name + ": " + e.Message); }
    }

    static void Eq(object expected, object actual, string what)
    {
        if (!object.Equals(expected, actual)) throw new Exception(what + ": expected <" + expected + "> but was <" + actual + ">");
    }

    static void True(bool value, string what)
    {
        if (!value) throw new Exception(what);
    }

    sealed class FakePlatform : IPlatform
    {
        public string State;
        public VsCodeInfo VsCode = new VsCodeInfo { Executable = @"C:\fake\Code.exe", Version = "1.99.0" };
        public ExtensionInfo Extension = new ExtensionInfo { Id = "emxplore.nexysvhdl", Version = "0.5.0" };
        public ToolchainInfo Toolchain = new ToolchainInfo { Installed = true, Version = "1.0" };
        public List<string> Calls = new List<string>();
        public ProcessOutcome InstallResult = new ProcessOutcome { Ok = true };
        public bool ThrowOnOpen;
        public string StateDirectory { get { return State; } }
        public VsCodeInfo FindVsCode() { return VsCode; }
        public bool Matches = true;
        public bool ExtensionMatches(ExtensionInfo e, string vsix) { return Matches; }
        public ExtensionInfo FindExtension(VsCodeInfo v) { return Extension; }
        public ToolchainInfo FindToolchain() { return Toolchain; }
        public void OpenFolder(VsCodeInfo v, string folder) { if (ThrowOnOpen) throw new InvalidOperationException("boom"); Calls.Add("folder:" + folder); }
        public void OpenUri(VsCodeInfo v, string uri) { Calls.Add("uri:" + uri); }
        public ProcessOutcome InstallExtension(VsCodeInfo v, string vsix) { Calls.Add("install:" + vsix); return InstallResult; }
        public void OpenWebPage(string url) { Calls.Add("web:" + url); }
    }

    static string Temp()
    {
        string d = Path.Combine(Path.GetTempPath(), "nexys-launcher-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(d);
        return d;
    }

    static string MakeProject(string root, string name)
    {
        string p = Path.Combine(root, name);
        Directory.CreateDirectory(p);
        File.WriteAllText(Path.Combine(p, "nexysvhdl.json"), "{ \"name\": \"" + name + "\" }");
        return p;
    }

    public static int Main()
    {
        Test("Json round-trips objects, arrays, strings, escapes and numbers", delegate ()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["a"] = "x\"y\\z\n\u00e9";
            d["n"] = 3;
            d["t"] = true;
            d["l"] = new List<object> { "p", 1 };
            d["e"] = new Dictionary<string, object>();
            Dictionary<string, object> back = (Dictionary<string, object>)Json.Parse(Json.Write(d));
            Eq("x\"y\\z\n\u00e9", back["a"], "string");
            Eq(3.0, back["n"], "number");
            Eq(true, back["t"], "bool");
            Eq(2, ((List<object>)back["l"]).Count, "array");
            True(Json.TryParse("{ broken") == null, "damaged JSON is null, not an exception");
            True(Json.TryParse("") == null, "empty is null");
        });

        Test("a project is a folder containing nexysvhdl.json; the problem text is friendly", delegate ()
        {
            string t = Temp();
            string good = MakeProject(t, "Board_Test");
            string bad = Path.Combine(t, "Documents");
            Directory.CreateDirectory(bad);
            True(ProjectCheck.IsProject(good), "project");
            True(!ProjectCheck.IsProject(bad), "plain folder");
            Eq(null, ProjectCheck.Problem(good), "no problem");
            True(ProjectCheck.Problem(bad).Contains("not a NexysVHDL project"), "plain folder message");
            True(ProjectCheck.Problem(bad).Contains("nexysvhdl.json"), "names the file");
            True(ProjectCheck.Problem(Path.Combine(t, "gone")).Contains("does not exist"), "missing folder message");
            True(ProjectCheck.Problem("") != null, "empty");
            Directory.CreateDirectory(Path.Combine(bad, "nexysvhdl.json"));
            True(!ProjectCheck.IsProject(bad), "a folder named nexysvhdl.json is not a project file");
        });

        Test("recent projects: newest first, no duplicates (case-insensitive), capped, stored outside the project", delegate ()
        {
            string t = Temp();
            string state = Path.Combine(t, "state");
            RecentProjects r = new RecentProjects(state);
            string a = MakeProject(t, "A"), b = MakeProject(t, "B");
            r.Add(a, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
            r.Add(b, new DateTime(2026, 1, 2, 0, 0, 0, DateTimeKind.Utc));
            r.Add(a.ToUpperInvariant().Replace(t.ToUpperInvariant(), t) + "\\", new DateTime(2026, 1, 3, 0, 0, 0, DateTimeKind.Utc));
            List<RecentProject> list = r.List();
            Eq(2, list.Count, "deduplicated");
            Eq("A", list[0].Name, "most recent first");
            Eq("B", list[1].Name, "older second");
            True(File.Exists(Path.Combine(state, "recent-projects.json")), "state file in the state folder");
            True(!File.Exists(Path.Combine(a, "recent-projects.json")), "nothing written into the project");
            Eq(0, Directory.GetFiles(a).Length - 1, "the project folder only has its own nexysvhdl.json");
            for (int i = 0; i < 15; i++) r.Add(MakeProject(t, "P" + i), DateTime.UtcNow.AddMinutes(i));
            Eq(RecentProjects.MaxEntries, r.List().Count, "capped");
            Eq("P14", r.List()[0].Name, "newest kept");
        });

        Test("recent projects: deleted folders are flagged, a damaged or empty state file is just an empty list", delegate ()
        {
            string t = Temp();
            string state = Path.Combine(t, "state");
            RecentProjects r = new RecentProjects(state);
            string a = MakeProject(t, "A"), b = MakeProject(t, "B");
            r.Add(a, DateTime.UtcNow);
            r.Add(b, DateTime.UtcNow);
            Directory.Delete(a, true);
            List<RecentProject> list = r.List();
            Eq(2, list.Count, "still listed");
            True(list[0].Exists, "B exists");
            True(!list[1].Exists, "A is flagged missing");
            r.Remove(a);
            Eq(1, r.List().Count, "removed");
            File.WriteAllText(r.FilePath, "{ not json at all");
            Eq(0, r.List().Count, "damaged file");
            r.Add(b, DateTime.UtcNow);
            Eq(1, r.List().Count, "recovers by rewriting");
            File.WriteAllText(r.FilePath, "{\"version\":1,\"projects\":[1,\"x\",{\"nopath\":true},{\"path\":\"" + b.Replace("\\", "\\\\") + "\"}]}");
            Eq(1, r.List().Count, "bad entries are skipped");
            Eq(0, new RecentProjects(Path.Combine(t, "nowhere")).List().Count, "no file yet");
        });

        Test("Open Project: a valid project opens in VS Code by full path and is remembered", delegate ()
        {
            string t = Temp();
            FakePlatform p = new FakePlatform { State = Path.Combine(t, "s") };
            LauncherService s = new LauncherService(p, null);
            string proj = MakeProject(t, "DigitDisplay");
            OpenResult r = s.OpenProject(proj);
            True(r.Ok, "opened");
            Eq("folder:" + Path.GetFullPath(proj), p.Calls[0], "launch call");
            Eq(1, s.Recent.List().Count, "remembered");
        });

        Test("Open Project: a folder without nexysvhdl.json is refused cleanly and VS Code is not started", delegate ()
        {
            string t = Temp();
            FakePlatform p = new FakePlatform { State = Path.Combine(t, "s") };
            LauncherService s = new LauncherService(p, null);
            string plain = Path.Combine(t, "Photos");
            Directory.CreateDirectory(plain);
            OpenResult r = s.OpenProject(plain);
            Eq(OpenOutcome.NotAProject, r.Outcome, "outcome");
            True(r.Message.Contains("Photos"), "names the folder");
            Eq(0, p.Calls.Count, "nothing launched");
            Eq(0, s.Recent.List().Count, "not remembered");
        });

        Test("Open Project: a recent project that was deleted is refused and dropped from the list", delegate ()
        {
            string t = Temp();
            FakePlatform p = new FakePlatform { State = Path.Combine(t, "s") };
            LauncherService s = new LauncherService(p, null);
            string proj = MakeProject(t, "Old");
            s.OpenProject(proj);
            Directory.Delete(proj, true);
            OpenResult r = s.OpenProject(proj);
            Eq(OpenOutcome.NotAProject, r.Outcome, "outcome");
            Eq(0, s.Recent.List().Count, "removed from recents");
        });

        Test("missing VS Code: every action explains it instead of failing", delegate ()
        {
            string t = Temp();
            FakePlatform p = new FakePlatform { State = Path.Combine(t, "s"), VsCode = null };
            LauncherService s = new LauncherService(p, null);
            string proj = MakeProject(t, "P");
            Eq(OpenOutcome.NeedsVsCode, s.OpenProject(proj).Outcome, "open");
            Eq(OpenOutcome.NeedsVsCode, s.NewProject().Outcome, "new");
            Eq(OpenOutcome.NeedsVsCode, s.InstallExtension("x.vsix").Outcome, "install");
            Eq(0, p.Calls.Count, "nothing launched");
            True(!s.GetStatus().CanOpen, "cannot open");
            s.OpenWebPage();
            Eq("web:https://code.visualstudio.com/Download", p.Calls[0], "Get VS Code page");
        });

        Test("missing extension: opening asks for the install; installing runs through the platform", delegate ()
        {
            string t = Temp();
            FakePlatform p = new FakePlatform { State = Path.Combine(t, "s"), Extension = null };
            LauncherService s = new LauncherService(p, null);
            string proj = MakeProject(t, "P");
            Eq(OpenOutcome.NeedsExtension, s.OpenProject(proj).Outcome, "open");
            Eq(OpenOutcome.NeedsExtension, s.NewProject().Outcome, "new");
            Eq(0, p.Calls.Count, "nothing launched");
            string vsix = Path.Combine(t, "n.vsix");
            File.WriteAllText(vsix, "x");
            True(s.InstallExtension(vsix).Ok, "install ok");
            Eq("install:" + vsix, p.Calls[0], "install call");
            p.InstallResult = new ProcessOutcome { Ok = false, Output = "Error: nope" };
            OpenResult bad = s.InstallExtension(vsix);
            Eq(OpenOutcome.Failed, bad.Outcome, "failed");
            True(bad.Message.Contains("nope"), "reason shown");
            Eq(OpenOutcome.Failed, s.InstallExtension(Path.Combine(t, "missing.vsix")).Outcome, "missing vsix file");
        });

        Test("New Project asks the extension to run its own command; the launcher creates no files", delegate ()
        {
            string t = Temp();
            FakePlatform p = new FakePlatform { State = Path.Combine(t, "s") };
            LauncherService s = new LauncherService(p, null);
            True(s.NewProject().Ok, "ok");
            Eq("uri:vscode://emxplore.nexysvhdl/newProject", p.Calls[0], "link");
            True(!Directory.Exists(Path.Combine(t, "s")) || Directory.GetFiles(Path.Combine(t, "s")).Length == 0, "launcher wrote nothing");
        });

        Test("a failure to start VS Code is reported, not thrown, and not remembered", delegate ()
        {
            string t = Temp();
            FakePlatform p = new FakePlatform { State = Path.Combine(t, "s"), ThrowOnOpen = true };
            LauncherService s = new LauncherService(p, null);
            OpenResult r = s.OpenProject(MakeProject(t, "P"));
            Eq(OpenOutcome.Failed, r.Outcome, "outcome");
            Eq(0, s.Recent.List().Count, "not remembered");
        });

        Test("toolchain state is reported but never acted on by the launcher", delegate ()
        {
            string t = Temp();
            FakePlatform p = new FakePlatform { State = Path.Combine(t, "s"), Toolchain = new ToolchainInfo { Installed = false, Version = "1.0" } };
            LauncherService s = new LauncherService(p, null);
            True(!s.GetStatus().Toolchain.Installed, "reported");
            True(s.OpenProject(MakeProject(t, "P")).Ok, "opening is still allowed: the extension owns the toolchain install flow");
        });

        Test("an installed extension that is not the bundled build is reported as outdated (and can be updated by installing)", delegate ()
        {
            string t = Temp();
            string vsix = Path.Combine(t, "n.vsix");
            File.WriteAllText(vsix, "x");
            FakePlatform p = new FakePlatform { State = Path.Combine(t, "s"), Matches = false };
            LauncherService s = new LauncherService(p, vsix);
            True(s.GetStatus().ExtensionOutdated, "outdated");
            True(s.GetStatus().CanOpen, "still usable");
            p.Matches = true;
            True(!s.GetStatus().ExtensionOutdated, "current");
            p.Matches = false;
            True(!new LauncherService(p, null).GetStatus().ExtensionOutdated, "no bundled file: nothing to compare");
            p.Extension = null;
            True(!s.GetStatus().ExtensionOutdated, "not installed is not outdated");
        });

        Test(".nvproj: a valid project file opens its project folder by full path, through the normal open path, and the folder is remembered", delegate ()
        {
            string t = Temp();
            FakePlatform p = new FakePlatform { State = Path.Combine(t, "s") };
            LauncherService s = new LauncherService(p, null);
            string proj = MakeProject(t, "Counter Demo");
            string file = Path.Combine(proj, "Counter Demo.nvproj");
            File.WriteAllText(file, "{ \"format\": \"nexysvhdl-project\", \"version\": 1, \"config\": \"nexysvhdl.json\" }");
            OpenResult r = s.OpenTarget(file);
            True(r.Ok, "opened: " + r.Message);
            Eq(1, p.Calls.Count, "one launch");
            Eq("folder:" + Path.GetFullPath(proj), p.Calls[0], "launches the project FOLDER (path with a space), never a vscode:// link");
            Eq(1, s.Recent.List().Count, "remembered");
            Eq(Path.GetFullPath(proj).ToLowerInvariant(), Path.GetFullPath(s.Recent.List()[0].Path).ToLowerInvariant(), "recent entry is the folder");
        });

        Test(".nvproj: a moved or copied project folder still opens from its new place (no absolute paths)", delegate ()
        {
            string t = Temp();
            FakePlatform p = new FakePlatform { State = Path.Combine(t, "s") };
            LauncherService s = new LauncherService(p, null);
            string proj = MakeProject(t, "Moved");
            File.WriteAllText(Path.Combine(proj, "Moved.nvproj"), "{ \"format\": \"nexysvhdl-project\", \"version\": 1, \"config\": \"nexysvhdl.json\" }");
            string elsewhere = Path.Combine(t, "Elsewhere", "Deeper Folder");
            Directory.CreateDirectory(Path.GetDirectoryName(elsewhere));
            Directory.Move(proj, elsewhere);
            True(s.OpenTarget(Path.Combine(elsewhere, "Moved.nvproj")).Ok, "opens after a move");
            Eq("folder:" + Path.GetFullPath(elsewhere), p.Calls[0], "new location");
            True(!File.ReadAllText(Path.Combine(elsewhere, "Moved.nvproj")).Contains(":\\"), "the descriptor holds no machine path");
        });

        Test(".nvproj: a damaged, foreign, newer or unsafe project file is refused with a clear message and VS Code is not started", delegate ()
        {
            string t = Temp();
            FakePlatform p = new FakePlatform { State = Path.Combine(t, "s") };
            LauncherService s = new LauncherService(p, null);
            string proj = MakeProject(t, "P");
            string file = Path.Combine(proj, "P.nvproj");
            string[][] cases = new string[][]
            {
                new string[] { "{ broken", "damaged" },
                new string[] { "[1,2]", "damaged" },
                new string[] { "{ \"format\": \"something-else\", \"version\": 1, \"config\": \"nexysvhdl.json\" }", "not a NexysVHDL project file" },
                new string[] { "{ \"format\": \"nexysvhdl-project\", \"version\": 2, \"config\": \"nexysvhdl.json\" }", "newer NexysVHDL" },
                new string[] { "{ \"format\": \"nexysvhdl-project\", \"version\": 0, \"config\": \"nexysvhdl.json\" }", "invalid \"version\"" },
                new string[] { "{ \"format\": \"nexysvhdl-project\", \"version\": 1.5, \"config\": \"nexysvhdl.json\" }", "invalid \"version\"" },
                new string[] { "{ \"format\": \"nexysvhdl-project\", \"version\": \"1\", \"config\": \"nexysvhdl.json\" }", "invalid \"version\"" },
                new string[] { "{ \"format\": \"nexysvhdl-project\", \"version\": 1 }", "unusable settings file" },
                new string[] { "{ \"format\": \"nexysvhdl-project\", \"version\": 1, \"config\": \"C:\\\\Users\\\\x\\\\nexysvhdl.json\" }", "unusable settings file" },
                new string[] { "{ \"format\": \"nexysvhdl-project\", \"version\": 1, \"config\": \"/etc/nexysvhdl.json\" }", "unusable settings file" },
                new string[] { "{ \"format\": \"nexysvhdl-project\", \"version\": 1, \"config\": \"../nexysvhdl.json\" }", "unusable settings file" },
                new string[] { "{ \"format\": \"nexysvhdl-project\", \"version\": 1, \"config\": \"other.json\" }", "unusable settings file" },
                new string[] { "{ \"format\": \"nexysvhdl-project\", \"version\": 1, \"config\": \"sub/nexysvhdl.json\" }", "not found next to it" }
            };
            foreach (string[] c in cases)
            {
                File.WriteAllText(file, c[0]);
                OpenResult r = s.OpenTarget(file);
                Eq(OpenOutcome.NotAProject, r.Outcome, c[1] + " outcome");
                True(r.Message.Contains(c[1]), "message for " + c[0] + " should mention <" + c[1] + "> but was <" + r.Message + ">");
            }
            Eq(0, p.Calls.Count, "nothing launched");
            Eq(0, s.Recent.List().Count, "nothing remembered");
            File.Delete(Path.Combine(proj, "nexysvhdl.json"));
            File.WriteAllText(file, "{ \"format\": \"nexysvhdl-project\", \"version\": 1, \"config\": \"nexysvhdl.json\" }");
            OpenResult missing = s.OpenTarget(file);
            Eq(OpenOutcome.NotAProject, missing.Outcome, "missing nexysvhdl.json");
            True(missing.Message.Contains("not found next to it"), "explains the missing settings file: " + missing.Message);
            True(s.OpenTarget(Path.Combine(proj, "Gone.nvproj")).Message.Contains("does not exist"), "a project file that is gone");
        });

        Test(".nvproj: unknown extra fields are ignored and a nested config opens the folder that holds it", delegate ()
        {
            string t = Temp();
            FakePlatform p = new FakePlatform { State = Path.Combine(t, "s") };
            LauncherService s = new LauncherService(p, null);
            string outer = Path.Combine(t, "Outer");
            string inner = MakeProject(outer, "inner");
            string file = Path.Combine(outer, "Outer.nvproj");
            File.WriteAllText(file, "\uFEFF{ \"format\": \"nexysvhdl-project\", \"version\": 1, \"config\": \"inner\\\\nexysvhdl.json\", \"futureField\": { \"x\": 1 } }");
            True(s.OpenTarget(file).Ok, "opens");
            Eq("folder:" + Path.GetFullPath(inner), p.Calls[0], "the folder holding the config");
        });

        Test("a project folder without any .nvproj (an older project) still opens exactly as before", delegate ()
        {
            string t = Temp();
            FakePlatform p = new FakePlatform { State = Path.Combine(t, "s") };
            LauncherService s = new LauncherService(p, null);
            string legacy = MakeProject(t, "OldProject");
            True(s.OpenTarget(legacy).Ok, "opens by folder through OpenTarget");
            Eq("folder:" + Path.GetFullPath(legacy), p.Calls[0], "launch call");
            True(ProjectCheck.IsProjectFile("x\\Y.NVPROJ"), "extension check is case-insensitive");
            True(!ProjectCheck.IsProjectFile(legacy), "a folder is not a project file");
        });

        Console.WriteLine(failures == 0 ? "ALL OK" : failures + " FAILED");
        return failures == 0 ? 0 : 1;
    }
}
