using System;
using System.Collections.Generic;
using System.IO;

namespace NexysVhdl.Launcher
{
    public sealed class RecentProject
    {
        public string Path;
        public string Name;
        public DateTime LastOpenedUtc;
        /// <summary>False when the folder or its nexysvhdl.json no longer exists.</summary>
        public bool Exists;
    }

    /// <summary>
    /// Recently opened NexysVHDL projects, kept per user in the launcher's own
    /// state folder (never inside a project): recent-projects.json,
    /// { "version": 1, "projects": [ { "path", "name", "lastOpenedUtc" } ] }, newest first.
    /// A missing, empty or damaged file is an empty list; the file is never fatal.
    /// </summary>
    public sealed class RecentProjects
    {
        public const int MaxEntries = 10;
        public const string FileName = "recent-projects.json";
        readonly string file;

        public RecentProjects(string stateDirectory)
        {
            file = System.IO.Path.Combine(stateDirectory, FileName);
        }

        public string FilePath { get { return file; } }

        /// <summary>Same folder on Windows and macOS file systems: compare case-insensitively, ignoring a trailing separator.</summary>
        public static string Key(string path)
        {
            string p = path;
            try { p = System.IO.Path.GetFullPath(path); } catch (ArgumentException) { }
            return p.TrimEnd('\\', '/').ToLowerInvariant();
        }

        List<RecentProject> Load()
        {
            List<RecentProject> list = new List<RecentProject>();
            try
            {
                if (!File.Exists(file)) return list;
                Dictionary<string, object> root = Json.TryParse(File.ReadAllText(file)) as Dictionary<string, object>;
                if (root == null || !root.ContainsKey("projects")) return list;
                List<object> items = root["projects"] as List<object>;
                if (items == null) return list;
                foreach (object o in items)
                {
                    Dictionary<string, object> d = o as Dictionary<string, object>;
                    if (d == null || !(d.ContainsKey("path") && d["path"] is string)) continue;
                    RecentProject r = new RecentProject();
                    r.Path = (string)d["path"];
                    r.Name = d.ContainsKey("name") && d["name"] is string ? (string)d["name"] : System.IO.Path.GetFileName(r.Path.TrimEnd('\\', '/'));
                    DateTime t;
                    r.LastOpenedUtc = d.ContainsKey("lastOpenedUtc") && d["lastOpenedUtc"] is string && DateTime.TryParse((string)d["lastOpenedUtc"], null, System.Globalization.DateTimeStyles.RoundtripKind, out t) ? t : DateTime.MinValue;
                    list.Add(r);
                }
            }
            catch (IOException) { list.Clear(); }
            catch (UnauthorizedAccessException) { list.Clear(); }
            return list;
        }

        void Save(List<RecentProject> list)
        {
            List<object> items = new List<object>();
            foreach (RecentProject r in list)
            {
                Dictionary<string, object> d = new Dictionary<string, object>();
                d["path"] = r.Path;
                d["name"] = r.Name;
                d["lastOpenedUtc"] = r.LastOpenedUtc.ToString("o");
                items.Add(d);
            }
            Dictionary<string, object> root = new Dictionary<string, object>();
            root["version"] = 1;
            root["projects"] = items;
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file));
            // Write then replace, so a crash never leaves half a file.
            string tmp = file + ".tmp";
            File.WriteAllText(tmp, Json.Write(root) + "\n");
            if (File.Exists(file)) File.Delete(file);
            File.Move(tmp, file);
        }

        /// <summary>Records that a project was opened (moves it to the top).</summary>
        public void Add(string folder, DateTime nowUtc)
        {
            try
            {
                string full = System.IO.Path.GetFullPath(folder);
                List<RecentProject> list = Load();
                list.RemoveAll(delegate (RecentProject r) { return Key(r.Path) == Key(full); });
                RecentProject added = new RecentProject();
                added.Path = full;
                added.Name = System.IO.Path.GetFileName(full.TrimEnd('\\', '/'));
                added.LastOpenedUtc = nowUtc;
                list.Insert(0, added);
                if (list.Count > MaxEntries) list.RemoveRange(MaxEntries, list.Count - MaxEntries);
                Save(list);
            }
            catch (IOException) { /* remembering is a convenience; never block opening a project */ }
            catch (UnauthorizedAccessException) { }
        }

        /// <summary>The list, newest first, each marked with whether the project is still there.</summary>
        public List<RecentProject> List()
        {
            List<RecentProject> list = Load();
            foreach (RecentProject r in list) r.Exists = ProjectCheck.IsProject(r.Path);
            return list;
        }

        /// <summary>Forgets one project (for a folder that was deleted).</summary>
        public void Remove(string folder)
        {
            try
            {
                List<RecentProject> list = Load();
                list.RemoveAll(delegate (RecentProject r) { return Key(r.Path) == Key(folder); });
                Save(list);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        public void Clear()
        {
            try { Save(new List<RecentProject>()); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
