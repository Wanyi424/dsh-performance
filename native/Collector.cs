// Windows-only, read-only sampler. On each request it reads the machine totals and walks the current DSH process tree once: no WMI, polling loop,
// process control or disk logging. Build with the Windows .NET Framework C# compiler; runs on .NET Framework 4.x.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

class Collector {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Entry {
        public uint size, usage, pid; public UIntPtr heap; public uint module, threads, parent;
        public int priority; public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Memory {
        public uint cb, faults;
        public UIntPtr peakWorking, working, peakPaged, paged, peakNonpaged, nonpaged, pagefile, peakPagefile, privateUsage, privateWorking;
        public ulong sharedCommit;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct MemoryStatus {
        public uint length, load;
        public ulong totalPhys, availPhys, totalPageFile, availPageFile, totalVirtual, availVirtual, availExtendedVirtual;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder path, ref uint size);
    [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr handle, ref Memory memory, uint size);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, IntPtr buffer, int length, out int returned);
    [DllImport("kernel32.dll")] static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);

    class Row {
        public uint pid, parent, threads; public string role, name, type, subtype, command, image; public double created, cpuMs; public long? memory;
    }
    class Known { public double created; public string command, image; }

    const string Desktop = "DeepSeek Harness.exe";
    const uint QueryLimited = 0x1000;
    const int CommandLineInformation = 60;
    const long Epoch = 116444736000000000L;
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly uint Self = (uint)Process.GetCurrentProcess().Id;
    static readonly Regex TypeFlag = new Regex(@"--type=(\S+)"), SubtypeFlag = new Regex(@"--utility-sub-type=(\S+)");
    // Command lines are read once per process (PID plus creation time) and dropped when the process is gone.
    static Dictionary<uint, Known> known = new Dictionary<uint, Known>();

    static bool IsDesktop(Entry e) { return String.Equals(e.name, Desktop, StringComparison.OrdinalIgnoreCase); }
    static Dictionary<uint, Entry> Snapshot() {
        IntPtr handle = CreateToolhelp32Snapshot(2, 0);
        if (handle == new IntPtr(-1)) throw new Exception("无法读取进程列表。");
        try {
            var entries = new Dictionary<uint, Entry>(); var e = new Entry();
            e.size = (uint)Marshal.SizeOf(typeof(Entry));
            if (!Process32FirstW(handle, ref e)) throw new Exception("无法读取进程列表。");
            do { entries[e.pid] = e; } while (Process32NextW(handle, ref e));
            return entries;
        } finally { CloseHandle(handle); }
    }
    static string ReadCommand(IntPtr h) {
        int size;
        NtQueryInformationProcess(h, CommandLineInformation, IntPtr.Zero, 0, out size);
        if (size <= 0) return null;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            if (NtQueryInformationProcess(h, CommandLineInformation, buffer, size, out size) != 0) return null;
            // UNICODE_STRING on x64: USHORT Length, USHORT MaximumLength, padding, PWSTR Buffer.
            int length = (ushort)Marshal.ReadInt16(buffer);
            return Marshal.PtrToStringUni(Marshal.ReadIntPtr(buffer, IntPtr.Size), length / 2);
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static string ReadImage(IntPtr h) {
        var path = new StringBuilder(1024); uint size = (uint)path.Capacity;
        return QueryFullProcessImageNameW(h, 0, path, ref size) ? path.ToString() : null;
    }
    /** Times and memory of a running process; with `next`, also its command line and executable. Null when it cannot be opened or has exited. */
    static Row Read(Entry e, Dictionary<uint, Known> next, out string command, out string image) {
        command = null; image = null;
        IntPtr h = OpenProcess(QueryLimited, false, e.pid); if (h == IntPtr.Zero) return null;
        try {
            long created, exit, kernel, user;
            if (!GetProcessTimes(h, out created, out exit, out kernel, out user) || exit != 0) return null;
            var m = new Memory(); m.cb = (uint)Marshal.SizeOf(typeof(Memory));
            var row = new Row { pid = e.pid, parent = e.parent, threads = e.threads, name = e.name, created = (created - Epoch) / 10000.0,
                cpuMs = (kernel + user) / 10000.0, memory = GetProcessMemoryInfo(h, ref m, m.cb) ? (long?)m.privateWorking.ToUInt64() : null };
            if (next != null) {
                Known k;
                if (!known.TryGetValue(e.pid, out k) || k.created != row.created) k = new Known { created = row.created, command = ReadCommand(h), image = ReadImage(h) };
                next[e.pid] = k; command = k.command; image = k.image;
            }
            return row;
        } finally { CloseHandle(h); }
    }
    static Row Read(Entry e) { string command, image; return Read(e, null, out command, out image); }
    /** The desktop main process is the topmost DeepSeek Harness.exe ancestor: the Host runs the same executable in Node mode. */
    static Row FindRoot(Dictionary<uint, Entry> all, uint host) {
        Entry e; Row current, root = null;
        if (!all.TryGetValue(host, out e) || (current = Read(e)) == null) throw new Exception("无法读取 DSH 后台进程。");
        if (IsDesktop(e)) root = current;
        for (int depth = 0; depth < 32 && all.TryGetValue(current.parent, out e) && IsDesktop(e); depth++) {
            var parent = Read(e);
            // A parent PID can outlive its process and be reused; a real parent never starts after its child.
            if (parent == null || parent.created > current.created) break;
            root = current = parent;
        }
        if (root == null) throw new Exception("无法识别本地 DSH 桌面进程。此插件仅支持 Windows 本地桌面版。");
        return root;
    }
    /** Whole-machine CPU times (idle is part of kernel time) and physical memory, for the share DSH takes of the machine. */
    static object Machine() {
        long idle, kernel, user; var status = new MemoryStatus(); status.length = (uint)Marshal.SizeOf(typeof(MemoryStatus));
        if (!GetSystemTimes(out idle, out kernel, out user) || !GlobalMemoryStatusEx(ref status)) return null;
        return new { idleMs = idle / 10000.0, kernelMs = kernel / 10000.0, userMs = user / 10000.0, memoryTotal = (long)status.totalPhys, memoryAvailable = (long)status.availPhys };
    }
    static object Sample(uint host, uint fixedRoot) {
        double start = Clock.Elapsed.TotalMilliseconds;
        var all = Snapshot();
        var children = new Dictionary<uint, List<Entry>>();
        foreach (var e in all.Values) {
            List<Entry> list;
            if (!children.TryGetValue(e.parent, out list)) children[e.parent] = list = new List<Entry>();
            list.Add(e);
        }
        Row root; Entry rootEntry;
        if (fixedRoot == 0) root = FindRoot(all, host);
        else if (!all.TryGetValue(fixedRoot, out rootEntry) || !IsDesktop(rootEntry) || (root = Read(rootEntry)) == null) throw new Exception("DSH 桌面已退出。");
        root.role = "main";
        var next = new Dictionary<uint, Known>();
        var rows = new List<Row> { root }; var queue = new Queue<Row>(); queue.Enqueue(root);
        int unavailable = 0;
        while (queue.Count > 0) {
            var parent = queue.Dequeue(); List<Entry> list;
            if (!children.TryGetValue(parent.pid, out list)) continue;
            bool inside = parent.role == "host" || parent.role == "tool";
            foreach (var e in list) {
                if (e.pid == Self || e.pid == parent.pid) continue;
                string command, image;
                var row = Read(e, inside || IsDesktop(e) ? next : null, out command, out image);
                if (row == null) { unavailable++; continue; }
                if (row.created < parent.created) continue;
                // A tool's executable tells which plugin, if any, it belongs to: plugins ship their helpers in their own folder.
                if (inside) { row.role = "tool"; row.image = image; row.command = command != null && command.Length > 1024 ? command.Substring(0, 1024) : command; }
                else if (e.pid == host || command != null && command.Contains("dsh-desktop-host")) row.role = "host";
                else {
                    row.role = "app";
                    if (command != null) {
                        var type = TypeFlag.Match(command); var subtype = SubtypeFlag.Match(command);
                        if (type.Success) row.type = type.Groups[1].Value;
                        if (subtype.Success) row.subtype = subtype.Groups[1].Value;
                    }
                }
                rows.Add(row); queue.Enqueue(row);
            }
        }
        known = next;
        Entry self; Row collector = all.TryGetValue(Self, out self) ? Read(self) : null;
        if (collector != null) collector.role = "tool";
        return new { time = (DateTime.UtcNow.ToFileTimeUtc() - Epoch) / 10000.0, monotonic = Clock.Elapsed.TotalMilliseconds,
            cores = Environment.ProcessorCount, system = Machine(), processes = rows, collector = collector,
            unavailable = unavailable, collectionMs = Clock.Elapsed.TotalMilliseconds - start };
    }
    static int Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        uint host; if (args.Length < 1 || !uint.TryParse(args[0], out host)) return 1;
        uint fixedRoot = 0; if (args.Length == 2) uint.TryParse(args[1], out fixedRoot);
        string line;
        while ((line = Console.ReadLine()) != null) {
            try { if (line != "sample") throw new Exception("不支持的采集命令。"); Console.WriteLine(Json.Serialize(Sample(host, fixedRoot))); }
            catch (Exception error) { Console.WriteLine(Json.Serialize(new { error = error.Message })); }
        }
        return 0;
    }
}
