using System;
using System.Diagnostics;
using System.Threading;
// Compiled as "DeepSeek Harness.exe": stands in for the desktop main process with two Electron-style children, and runs the
// Host (Node with scripts/native-fixture.ts) as its child, like the real desktop does.
class DesktopFixture {
    static string Q(string s) { return "\"" + s.Replace("\"", "\\\"") + "\""; }
    static Process Start(string executable, string arguments, bool capture) {
        return Process.Start(new ProcessStartInfo(executable, arguments) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = capture, RedirectStandardError = capture });
    }
    static int Main(string[] args) {
        if (args[0] == "--child") { Thread.Sleep(120000); return 0; }
        Process renderer = null, gpu = null, host = null;
        try {
            string self = Process.GetCurrentProcess().MainModule.FileName;
            renderer = Start(self, "--child --type=renderer", false); gpu = Start(self, "--child --type=gpu-process", false);
            host = Start(args[0], "--import tsx " + Q(args[1]) + " " + Q(args[2]) + " " + Process.GetCurrentProcess().Id + " " + renderer.Id + " " + gpu.Id + " " + args[3], true);
            string output = host.StandardOutput.ReadToEnd(), errors = host.StandardError.ReadToEnd();
            host.WaitForExit(); Console.Write(output); Console.Error.Write(errors); return host.ExitCode;
        } finally {
            foreach (var p in new [] { host, renderer, gpu }) if (p != null) { if (!p.HasExited) p.Kill(); p.Dispose(); }
        }
    }
}
