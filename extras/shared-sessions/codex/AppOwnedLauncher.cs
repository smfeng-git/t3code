using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Threading.Tasks;

// A real executable is required because Desktop spawns its CLI without a shell.
class AppOwnedLauncher {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr info, uint size);
    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    static string Quote(string arg) {
        // Windows CommandLineToArgvW quoting, including trailing backslashes.
        var result = new System.Text.StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }
    static async Task Pump(Stream source, Stream destination, bool closeDestination) {
        try {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = await source.ReadAsync(buffer, 0, buffer.Length)) > 0) {
                await destination.WriteAsync(buffer, 0, count);
                await destination.FlushAsync();
            }
        }
        catch (IOException) { }
        finally { if (closeDestination) destination.Close(); }
    }
    static int Main(string[] args) {
        try {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string file = Environment.GetEnvironmentVariable("T3_SHARED_CODEX_CONFIG") ?? Path.Combine(root, "config.json");
            var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
            // Put this adapter and every descendant in our own kill-on-close job.
            // If Desktop terminates the adapter, Windows also cleans up its backend.
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Exception("Cannot create adapter process job.");
            var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
            int size = Marshal.SizeOf(limits);
            IntPtr info = Marshal.AllocHGlobal(size);
            try {
                Marshal.StructureToPtr(limits, info, false);
                if (!SetInformationJobObject(job, 9, info, (uint)size) ||
                    !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle))
                    throw new Exception("Cannot establish adapter process ownership.");
            } finally { Marshal.FreeHGlobal(info); }
            string command = Quote(Path.Combine(root, "app-owned.cjs"));
            foreach (string arg in args) command += " " + Quote(arg);
            var start = new ProcessStartInfo((string)config["node"], command);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            var child = Process.Start(start);
            Task input = Task.Run(() => Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream, true));
            Task output = Task.Run(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false));
            Task errors = Task.Run(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError(), false));
            child.WaitForExit();
            Task.WaitAll(output, errors);
            // OS closes the job handle on exit; no background descendants survive.
            return child.ExitCode;
        } catch (Exception error) {
            Console.Error.WriteLine("App-owned Codex: " + error.Message);
            return 1;
        }
    }
}
