using System;
using Microsoft.Win32;
using NexysVhdl.Launcher;

// Tests of the per-user .nvproj file association (windows/Setup.cs, FileAssociation) against a SCRATCH registry key, so the
// real file associations of the machine running the tests are never touched. Built with /main:AssociationTests by tests/launcher.test.ts.
public static class AssociationTests
{
    static int failures;

    static void Test(string name, Action body)
    {
        try { body(); Console.WriteLine("ok " + name); }
        catch (Exception e) { failures++; Console.WriteLine("FAIL " + name + ": " + e.Message); }
    }

    static void True(bool value, string what)
    {
        if (!value) throw new Exception(what);
    }

    static object Get(string classes, string key, string name)
    {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(classes + @"\" + key))
            return k == null ? null : k.GetValue(name);
    }

    static bool Exists(string classes, string key)
    {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(classes + @"\" + key)) return k != null;
    }

    public static int Main()
    {
        string scratch = @"Software\NexysVHDL-Tests\Classes-" + Guid.NewGuid().ToString("N");
        string exe = @"C:\Users\Some Student\AppData\Local\Programs\NexysVHDL\NexysVHDL.exe";
        string ico = @"C:\Users\Some Student\AppData\Local\Programs\NexysVHDL\NexysVHDL.ico";
        try
        {
            Test("register: .nvproj opens with NexysVHDL.exe and the path with spaces is quoted, followed by the file", delegate ()
            {
                FileAssociation.Register(exe, ico, scratch);
                True("NexysVHDL.Project".Equals(Get(scratch, ".nvproj", "")), ".nvproj maps to the NexysVHDL.Project document type");
                Object command = Get(scratch, @"NexysVHDL.Project\shell\open\command", "");
                True(("\"" + exe + "\" \"%1\"").Equals(command), "open command was <" + command + ">");
                True(("\"" + ico + "\"").Equals(Get(scratch, @"NexysVHDL.Project\DefaultIcon", "")), ".nvproj uses the NexysVHDL icon");
                True("NexysVHDL Project".Equals(Get(scratch, "NexysVHDL.Project", "")), "friendly document name");
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(scratch + @"\.nvproj\OpenWithProgids"))
                    True(k != null && Array.IndexOf(k.GetValueNames(), "NexysVHDL.Project") >= 0, "listed under Open with");
            });

            Test("register again (an update) changes nothing but the paths", delegate ()
            {
                string exe2 = @"D:\Other Place\NexysVHDL.exe";
                FileAssociation.Register(exe2, ico, scratch);
                True(("\"" + exe2 + "\" \"%1\"").Equals(Get(scratch, @"NexysVHDL.Project\shell\open\command", "")), "updated command");
                True("NexysVHDL.Project".Equals(Get(scratch, ".nvproj", "")), "still ours");
            });

            Test("remove: deletes the NexysVHDL association completely and leaves an unrelated one alone", delegate ()
            {
                using (RegistryKey other = Registry.CurrentUser.CreateSubKey(scratch + @"\.txt")) other.SetValue("", "txtfile");
                using (RegistryKey other = Registry.CurrentUser.CreateSubKey(scratch + @"\SomeApp.Document\shell\open\command")) other.SetValue("", "\"C:\\SomeApp.exe\" \"%1\"");
                FileAssociation.Remove(scratch);
                True(!Exists(scratch, ".nvproj"), ".nvproj is gone");
                True(!Exists(scratch, "NexysVHDL.Project"), "the document type is gone");
                True("txtfile".Equals(Get(scratch, ".txt", "")), "an unrelated association survives");
                True(Exists(scratch, @"SomeApp.Document\shell\open\command"), "another application's document type survives");
            });

            Test("a .nvproj that another program already owns is not taken over, and is not deleted on remove", delegate ()
            {
                using (RegistryKey ext = Registry.CurrentUser.CreateSubKey(scratch + @"\.nvproj")) ext.SetValue("", "Other.Program");
                FileAssociation.Register(exe, ico, scratch);
                True("Other.Program".Equals(Get(scratch, ".nvproj", "")), "the other owner keeps the default");
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(scratch + @"\.nvproj\OpenWithProgids"))
                    True(k != null && Array.IndexOf(k.GetValueNames(), "NexysVHDL.Project") >= 0, "but NexysVHDL is offered under Open with");
                FileAssociation.Remove(scratch);
                True("Other.Program".Equals(Get(scratch, ".nvproj", "")), "the other owner is untouched after removal");
                True(!Exists(scratch, "NexysVHDL.Project"), "our document type is removed");
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(scratch + @"\.nvproj\OpenWithProgids"))
                    True(k == null || Array.IndexOf(k.GetValueNames(), "NexysVHDL.Project") < 0, "our Open with entry is removed");
            });

            Test("remove with nothing registered is harmless", delegate ()
            {
                FileAssociation.Remove(@"Software\NexysVHDL-Tests\NeverExisted-" + Guid.NewGuid().ToString("N"));
            });
        }
        finally
        {
            try { Registry.CurrentUser.DeleteSubKeyTree(scratch, false); } catch (Exception) { }
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\NexysVHDL-Tests"))
                    if (k != null && k.SubKeyCount == 0 && k.ValueCount == 0) { k.Close(); Registry.CurrentUser.DeleteSubKey(@"Software\NexysVHDL-Tests", false); }
            }
            catch (Exception) { }
        }
        Console.WriteLine(failures == 0 ? "ALL OK" : failures + " FAILED");
        return failures == 0 ? 0 : 1;
    }
}
