using System;
using System.IO;

// A stand-in for Code.exe in tests: records how the launcher started it (one argument per line) in the file named by
// NEXYS_FAKECODE_OUT, then exits. Built by tests/launcher.test.ts; never shipped.
public static class FakeCode
{
    public static int Main(string[] args)
    {
        string output = Environment.GetEnvironmentVariable("NEXYS_FAKECODE_OUT");
        if (!string.IsNullOrEmpty(output)) File.WriteAllText(output, string.Join("\n", args) + "\nRAW:" + Environment.CommandLine + "\n");
        return 0;
    }
}
