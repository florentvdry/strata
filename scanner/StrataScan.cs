// StrataScan — the disk-scanning helper behind Strata.
//
//   StrataScan info
//       Prints one JSON object: { admin, drives: [...] }.
//   StrataScan scan <path> <outFile> [--mft] [--hidden] [--links]
//       Scans <path> and writes the result to <outFile> (format: see WriteResult).
//       Progress goes to stdout as JSON lines. stdin accepts:
//       "pause", "resume", "snapshot <file>" and "stop".
//   StrataScan delete <listFile> [recycle|permanent]
//       Deletes the paths listed one per line and prints a result per path.
//   StrataScan dupes <listFile>
//       <listFile> holds "size<TAB>path" lines grouped by size. Prints the groups
//       of identical files as JSON lines.
//
// Compiled with the .NET Framework csc (C# 5), so no modern syntax here.

using System;
using System.Collections.Generic;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Without this the runtime applies .NET 4.0 path rules, which reject \\?\ long paths.
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.7.2", FrameworkDisplayName = ".NET Framework 4.7.2")]

namespace Strata
{
    static class Program
    {
        static int Main(string[] args)
        {
            Out.Init();
            if (args.Length == 0) { Out.Line("{\"type\":\"error\",\"message\":\"no command\"}"); return 2; }
            try
            {
                switch (args[0])
                {
                    case "info": Info.Run(); return 0;
                    case "scan": return ScanCommand.Run(args);
                    case "dupes": Dupes.Run(args[1]); return 0;
                    case "delete": Deleter.Run(args[1], args.Length > 2 && args[2] == "permanent"); return 0;
                }
                Out.Line("{\"type\":\"error\",\"message\":\"unknown command\"}");
                return 2;
            }
            catch (Exception e)
            {
                Out.Line("{\"type\":\"error\",\"message\":" + Json.Str(e.Message) + "}");
                return 1;
            }
        }
    }

    // ───────────────────────── output helpers ─────────────────────────

    static class Out
    {
        static StreamWriter w;
        static readonly object gate = new object();
        public static void Init()
        {
            w = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            w.AutoFlush = true;
        }
        public static void Line(string s) { lock (gate) { w.Write(s); w.Write('\n'); } }
    }

    static class Json
    {
        public static string Str(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder(s.Length + 8);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
        public static string Num(double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) return "0";
            return d.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        }
        public static string Bool(bool b) { return b ? "true" : "false"; }
    }

    // ───────────────────────── file types ─────────────────────────

    static class FileTypes
    {
        // Indices shared with the UI (src/renderer/lib/types.js).
        public const byte Other = 0, Video = 1, App = 2, System = 3, Image = 4, Archive = 5, Code = 6, Audio = 7, Doc = 8;
        public const int Count = 9;
        static readonly Dictionary<string, byte> map = new Dictionary<string, byte>(StringComparer.OrdinalIgnoreCase);

        static void Add(byte t, string list) { foreach (var e in list.Split(' ')) if (e.Length > 0) map[e] = t; }

        static FileTypes()
        {
            Add(Video, "mp4 mkv avi mov wmv webm m4v flv mpg mpeg ts m2ts mts vob 3gp ogv rm rmvb divx f4v braw r3d prproj");
            Add(App, "exe dll pak vpk uasset uexp ubulk utoc ucas bundle assets resource resS forge rpf big ba2 bsa esm esp wad gcf vdf acf sav sys32 ocx appx msix appxbundle msixbundle apk xapk ipa so dylib bik bnk wem pck arc dat001 cache0 xnb pdx ff ipak xpak sabs sabl tre pck2 unity3d obb blob");
            Add(System, "sys log etl evtx tmp temp mui cat manifest ini reg dmp mdmp hdmp edb jfm chk blf regtrans-ms evt cpl drv efi mum inf pnf dat db db-wal db-shm sqlite ldb lock lck trace etw pf");
            Add(Image, "jpg jpeg png gif bmp tif tiff webp heic heif avif raw cr2 cr3 nef arw dng orf rw2 raf psd psb xcf kra svg ico icns tga exr hdr lrcat lrdata dds jxl afphoto");
            Add(Archive, "zip rar 7z tar gz tgz bz2 xz zst lz lzma cab iso img vhd vhdx vmdk vdi qcow2 dmg wim esd msi msp msu nupkg crx xpi bak backup tib");
            Add(Code, "js mjs cjs ts tsx jsx py pyc pyd java class jar war c cc cpp cxx h hpp cs vb fs go rs rb php swift kt kts scala lua pl r m mm sh ps1 psm1 bat cmd json yaml yml toml xml map wasm o obj lib a pdb ilk idb ipch pch whl gem crate node gradle sln csproj vcxproj nuspec css scss less html htm vue svelte sql ipynb");
            Add(Audio, "mp3 wav flac aac ogg oga m4a wma opus aiff aif mid midi ape alac wv dsf amr caf");
            Add(Doc, "pdf doc docx xls xlsx xlsm ppt pptx txt md rtf odt ods odp csv tsv epub mobi azw3 pages numbers key one pst ost msg eml vsdx pub tex djvu xps oxps chm");
        }

        public static byte Classify(string name)
        {
            int dot = name.LastIndexOf('.');
            if (dot <= 0 || dot == name.Length - 1)
            {
                return 0;
            }
            byte t;
            if (map.TryGetValue(name.Substring(dot + 1), out t)) return t;
            return 0;
        }
    }

    // ───────────────────────── native ─────────────────────────

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct FindData
    {
        public uint Attributes;
        public uint CreationLow, CreationHigh;
        public uint AccessLow, AccessHigh;
        public uint WriteLow, WriteHigh;
        public uint SizeHigh, SizeLow;
        public uint Reserved0, Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string FileName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string AltName;
    }

    static class Native
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr FindFirstFileExW(string name, int infoLevel, out FindData data, int searchOp, IntPtr filter, int flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool FindNextFileW(IntPtr h, out FindData data);
        [DllImport("kernel32.dll")]
        public static extern bool FindClose(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool ReadFile(SafeFileHandle h, byte[] buf, int count, out int read, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetFilePointerEx(SafeFileHandle h, long distance, out long newPos, uint method);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder buf, uint size, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool GetDiskFreeSpaceW(string root, out uint sectorsPerCluster, out uint bytesPerSector, out uint freeClusters, out uint totalClusters);

        public static readonly IntPtr Invalid = new IntPtr(-1);
        public const uint AttrReadOnly = 0x1, AttrHidden = 0x2, AttrSystem = 0x4, AttrDirectory = 0x10,
            AttrReparse = 0x400, AttrOffline = 0x1000, AttrRecallOnOpen = 0x40000, AttrRecallOnAccess = 0x400000;

        public static bool IsAdmin()
        {
            try { return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); }
            catch { return false; }
        }

        public static int ClusterSize(string root)
        {
            uint spc, bps, fc, tc;
            if (GetDiskFreeSpaceW(root, out spc, out bps, out fc, out tc)) return (int)(spc * bps);
            return 4096;
        }

        public static double UnixFromFileTime(long ft)
        {
            if (ft <= 0) return 0;
            return (ft - 116444736000000000L) / 1e7;
        }

        // "\\?\" form of a path so long paths enumerate.
        public static string LongPath(string p)
        {
            if (p.StartsWith(@"\\?\") || p.Length < 240) return p;
            if (p.StartsWith(@"\\")) return @"\\?\UNC\" + p.Substring(2);
            return @"\\?\" + p;
        }
    }

    // ───────────────────────── info ─────────────────────────

    static class Info
    {
        public static void Run()
        {
            var bus = new Dictionary<char, string>();
            var media = new Dictionary<char, string>();
            try { ReadStorage(bus, media); } catch { }
            string sysRoot = Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.Windows)) ?? "C:\\";
            var sb = new StringBuilder();
            sb.Append("{\"type\":\"info\",\"admin\":").Append(Json.Bool(Native.IsAdmin())).Append(",\"drives\":[");
            bool first = true;
            foreach (var d in DriveInfo.GetDrives())
            {
                try
                {
                    if (!d.IsReady) continue;
                    if (d.DriveType == DriveType.CDRom) continue;
                    char letter = char.ToUpperInvariant(d.Name[0]);
                    string b, m;
                    bus.TryGetValue(letter, out b);
                    media.TryGetValue(letter, out m);
                    if (d.DriveType == DriveType.Network) b = "Network";
                    if (d.DriveType == DriveType.Removable && b == null) b = "Removable";
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append("{\"letter\":").Append(Json.Str(letter.ToString()))
                      .Append(",\"root\":").Append(Json.Str(d.RootDirectory.FullName))
                      .Append(",\"label\":").Append(Json.Str(d.VolumeLabel))
                      .Append(",\"fs\":").Append(Json.Str(d.DriveFormat))
                      .Append(",\"total\":").Append(Json.Num(d.TotalSize))
                      .Append(",\"free\":").Append(Json.Num(d.TotalFreeSpace))
                      .Append(",\"kind\":").Append(Json.Str(d.DriveType.ToString()))
                      .Append(",\"bus\":").Append(Json.Str(b))
                      .Append(",\"media\":").Append(Json.Str(m))
                      .Append(",\"cluster\":").Append(Native.ClusterSize(d.RootDirectory.FullName))
                      .Append(",\"system\":").Append(Json.Bool(string.Equals(d.RootDirectory.FullName, sysRoot, StringComparison.OrdinalIgnoreCase)))
                      .Append('}');
                }
                catch { }
            }
            sb.Append("]}");
            Out.Line(sb.ToString());
        }

        // Bus (NVMe, SATA, USB…) and media (SSD/HDD) per drive letter, from the Storage WMI provider.
        static void ReadStorage(Dictionary<char, string> bus, Dictionary<char, string> media)
        {
            var scope = new ManagementScope(@"\\.\root\Microsoft\Windows\Storage");
            scope.Connect();
            var disks = new Dictionary<string, string[]>();
            using (var q = new ManagementObjectSearcher(scope, new ObjectQuery("SELECT DeviceId, BusType, MediaType FROM MSFT_PhysicalDisk")))
            {
                foreach (ManagementObject o in q.Get())
                {
                    string id = Convert.ToString(o["DeviceId"]);
                    int bt = Convert.ToInt32(o["BusType"]);
                    int mt = Convert.ToInt32(o["MediaType"]);
                    disks[id] = new string[] { BusName(bt), mt == 4 ? "SSD" : mt == 3 ? "HDD" : mt == 5 ? "SCM" : null };
                }
            }
            using (var q = new ManagementObjectSearcher(scope, new ObjectQuery("SELECT DriveLetter, DiskNumber FROM MSFT_Partition")))
            {
                foreach (ManagementObject o in q.Get())
                {
                    object dl = o["DriveLetter"];
                    if (dl == null) continue;
                    char c = Convert.ToChar(dl);
                    if (c == '\0' || c == ' ') continue;
                    c = char.ToUpperInvariant(c);
                    string[] info;
                    if (disks.TryGetValue(Convert.ToString(o["DiskNumber"]), out info))
                    {
                        if (info[0] != null) bus[c] = info[0];
                        if (info[1] != null) media[c] = info[1];
                    }
                }
            }
        }

        static string BusName(int t)
        {
            switch (t)
            {
                case 1: return "SCSI";
                case 3: return "ATA";
                case 6: return "FireWire";
                case 7: return "USB";
                case 8: return "RAID";
                case 9: return "iSCSI";
                case 10: return "SAS";
                case 11: return "SATA";
                case 12: return "SD";
                case 13: return "MMC";
                case 15: return "Virtual";
                case 17: return "NVMe";
                case 18: return "SCM";
                case 19: return "UFS";
            }
            return null;
        }
    }

    // ───────────────────────── scan result model ─────────────────────────

    // One row of the result. Parents always come before their children.
    sealed class Node
    {
        public int Parent;
        public string Name;
        public long Size;
        public double MTime;
        public byte Flags;
        public byte Type;
    }

    static class NodeFlags
    {
        public const byte Dir = 1, Hidden = 2, System = 4, Reparse = 8, Denied = 16, Cloud = 32;
    }

    sealed class ScanOptions
    {
        public string Root;
        public string Out;
        public bool Mft, Hidden, Links;
    }

    // Shared state between the scanning thread(s), the progress ticker and stdin commands.
    sealed class ScanState
    {
        public volatile bool Paused, StopRequested, Finished;
        public readonly ManualResetEvent Running = new ManualResetEvent(true);
        public volatile Action<string> SnapshotHandler;
        public volatile string Phase = "walk";
        public volatile string Current = "";
        public long Files, Dirs, Bytes, Errors;
        public double Pct;
        public long DriveUsed;
        public bool IsDriveRoot;
        public readonly DateTime Started = DateTime.UtcNow;

        // Top-level items (direct children of the root), for the "map building up" view.
        public readonly object TopGate = new object();
        public readonly List<TopItem> Tops = new List<TopItem>();

        // Biggest files so far.
        readonly object bigGate = new object();
        readonly List<KeyValuePair<long, string>> biggest = new List<KeyValuePair<long, string>>();
        long bigMin;

        public void OfferBig(long size, string path)
        {
            if (size <= Interlocked.Read(ref bigMin)) return;
            lock (bigGate)
            {
                biggest.Add(new KeyValuePair<long, string>(size, path));
                biggest.Sort((a, b) => b.Key.CompareTo(a.Key));
                if (biggest.Count > 5) biggest.RemoveAt(biggest.Count - 1);
                if (biggest.Count == 5) Interlocked.Exchange(ref bigMin, biggest[4].Key);
            }
        }

        public string BiggestJson()
        {
            var sb = new StringBuilder("[");
            lock (bigGate)
            {
                for (int i = 0; i < biggest.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    string p = biggest[i].Value;
                    sb.Append("{\"path\":").Append(Json.Str(p))
                      .Append(",\"size\":").Append(biggest[i].Key)
                      .Append(",\"type\":").Append(FileTypes.Classify(p)).Append('}');
                }
            }
            return sb.Append(']').ToString();
        }

        public void WaitIfPaused() { Running.WaitOne(); }
    }

    sealed class TopItem
    {
        public string Name;
        public bool IsDir;
        public long Bytes;
        public int State; // 0 pending, 1 active, 2 done
        public int Pending; // outstanding directory jobs (walk mode)
        public readonly long[] TypeBytes = new long[FileTypes.Count];

        public int Dominant()
        {
            int best = 0; long bv = -1;
            for (int i = 0; i < TypeBytes.Length; i++) if (TypeBytes[i] > bv) { bv = TypeBytes[i]; best = i; }
            return best;
        }
    }

    static class ScanCommand
    {
        public static int Run(string[] args)
        {
            var o = new ScanOptions();
            o.Root = args[1];
            o.Out = args[2];
            for (int i = 3; i < args.Length; i++)
            {
                if (args[i] == "--mft") o.Mft = true;
                else if (args[i] == "--hidden") o.Hidden = true;
                else if (args[i] == "--links") o.Links = true;
            }
            o.Root = NormalizeRoot(o.Root);
            if (!Directory.Exists(o.Root))
            {
                Out.Line("{\"type\":\"error\",\"message\":" + Json.Str("Folder not found: " + o.Root) + "}");
                return 1;
            }

            var st = new ScanState();
            string driveRoot = Path.GetPathRoot(o.Root);
            string fs = "";
            long total = 0, free = 0;
            int cluster = 4096;
            try
            {
                var di = new DriveInfo(driveRoot);
                fs = di.DriveFormat;
                total = di.TotalSize;
                free = di.TotalFreeSpace;
                cluster = Native.ClusterSize(driveRoot);
            }
            catch { }
            st.IsDriveRoot = string.Equals(driveRoot, o.Root, StringComparison.OrdinalIgnoreCase);
            st.DriveUsed = total - free;

            var stdin = new Thread(() => ReadCommands(st));
            stdin.IsBackground = true;
            stdin.Start();
            var ticker = new Thread(() => Tick(st));
            ticker.IsBackground = true;
            ticker.Start();

            string method = "Walk";
            List<Node> nodes = null;
            if (o.Mft)
            {
                string why = null;
                if (!string.Equals(fs, "NTFS", StringComparison.OrdinalIgnoreCase)) why = "Fast scan needs an NTFS drive — using a normal scan.";
                else if (!Native.IsAdmin()) why = "Fast scan needs administrator rights — using a normal scan.";
                if (why == null)
                {
                    try
                    {
                        var m = new MftScanner(o, st);
                        nodes = m.Run();
                        method = "MFT";
                    }
                    catch (UnauthorizedAccessException) { why = "Windows refused raw access to the drive — using a normal scan."; }
                    catch (Exception e) { why = "Could not read the file table (" + e.Message + ") — using a normal scan."; }
                }
                if (why != null)
                {
                    Out.Line("{\"type\":\"notice\",\"message\":" + Json.Str(why) + "}");
                    st.Files = st.Dirs = st.Bytes = 0;
                    lock (st.TopGate) st.Tops.Clear();
                }
            }
            if (nodes == null)
            {
                st.Phase = "walk";
                nodes = new Walker(o, st).Run();
            }

            st.Phase = "build";
            long files = 0, dirs = 0, bytes = 0;
            foreach (var n in nodes) { if ((n.Flags & NodeFlags.Dir) != 0) dirs++; else { files++; bytes += n.Size; } }
            double duration = (DateTime.UtcNow - st.Started).TotalSeconds;
            WriteResult(o.Out, nodes, Header(o, fs, cluster, total, free, method, duration, st.StopRequested, files, dirs - 1, Interlocked.Read(ref st.Errors), bytes));
            st.Finished = true;
            Out.Line("{\"type\":\"done\",\"out\":" + Json.Str(o.Out) + ",\"partial\":" + Json.Bool(st.StopRequested) + ",\"method\":" + Json.Str(method) + "}");
            return 0;
        }

        static string NormalizeRoot(string p)
        {
            p = p.Trim().Trim('"');
            if (p.Length == 2 && p[1] == ':') p += "\\";
            if (p.Length > 3 && p.EndsWith("\\")) p = p.TrimEnd('\\');
            try { p = Path.GetFullPath(p); } catch { }
            if (p.Length == 2 && p[1] == ':') p += "\\";
            return p;
        }

        public static string Header(ScanOptions o, string fs, int cluster, long total, long free, string method, double duration, bool partial, long files, long dirs, long errors, long bytes)
        {
            var sb = new StringBuilder("{");
            sb.Append("\"version\":1");
            sb.Append(",\"root\":").Append(Json.Str(o.Root));
            sb.Append(",\"fs\":").Append(Json.Str(fs));
            sb.Append(",\"cluster\":").Append(cluster);
            sb.Append(",\"total\":").Append(total);
            sb.Append(",\"free\":").Append(free);
            sb.Append(",\"method\":").Append(Json.Str(method));
            sb.Append(",\"scannedAt\":").Append(Json.Num((DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds));
            sb.Append(",\"duration\":").Append(Json.Num(Math.Round(duration, 1)));
            sb.Append(",\"partial\":").Append(Json.Bool(partial));
            sb.Append(",\"files\":").Append(files);
            sb.Append(",\"dirs\":").Append(dirs);
            sb.Append(",\"errors\":").Append(errors);
            sb.Append(",\"bytes\":").Append(bytes);
            sb.Append(",\"options\":{\"mft\":").Append(Json.Bool(o.Mft)).Append(",\"hidden\":").Append(Json.Bool(o.Hidden)).Append(",\"links\":").Append(Json.Bool(o.Links)).Append('}');
            sb.Append('}');
            return sb.ToString();
        }

        // Layout (little-endian):
        //   "STRATA01" | int32 headerLen | header JSON (UTF-8) | zero pad to 8
        //   int32 N | int32 0
        //   float64[N] size | float64[N] mtime (unix s) | int32[N] parent | uint8[N] flags | uint8[N] type
        //   int32 namesLen | names, UTF-8, NUL-separated
        public static void WriteResult(string path, List<Node> nodes, string header)
        {
            string tmp = path + ".part";
            using (var fsm = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20))
            using (var w = new BinaryWriter(fsm))
            {
                int n = nodes.Count;
                w.Write(Encoding.ASCII.GetBytes("STRATA01"));
                byte[] h = Encoding.UTF8.GetBytes(header);
                w.Write(h.Length);
                w.Write(h);
                long pos = 8 + 4 + h.Length;
                while (pos % 8 != 0) { w.Write((byte)0); pos++; }
                w.Write(n);
                w.Write(0);
                for (int i = 0; i < n; i++) w.Write((double)nodes[i].Size);
                for (int i = 0; i < n; i++) w.Write(nodes[i].MTime);
                for (int i = 0; i < n; i++) w.Write(nodes[i].Parent);
                for (int i = 0; i < n; i++) w.Write(nodes[i].Flags);
                for (int i = 0; i < n; i++) w.Write(nodes[i].Type);
                var ms = new MemoryStream();
                var enc = new UTF8Encoding(false);
                for (int i = 0; i < n; i++)
                {
                    if (i > 0) ms.WriteByte(0);
                    byte[] b = enc.GetBytes(nodes[i].Name ?? "");
                    ms.Write(b, 0, b.Length);
                }
                w.Write((int)ms.Length);
                ms.WriteTo(fsm);
            }
            if (File.Exists(path)) File.Delete(path);
            File.Move(tmp, path);
        }

        static void ReadCommands(ScanState st)
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    line = line.Trim();
                    if (line == "pause") { st.Paused = true; st.Running.Reset(); }
                    else if (line == "resume") { st.Paused = false; st.Running.Set(); }
                    else if (line == "stop") { st.StopRequested = true; st.Paused = false; st.Running.Set(); }
                    else if (line.StartsWith("snapshot "))
                    {
                        var h = st.SnapshotHandler;
                        string p = line.Substring(9);
                        if (h != null) new Thread(() => h(p)) { IsBackground = true }.Start();
                        else Out.Line("{\"type\":\"snapshot\",\"error\":\"not ready\"}");
                    }
                }
            }
            catch { }
        }

        static void Tick(ScanState st)
        {
            while (!st.Finished)
            {
                Thread.Sleep(180);
                if (st.Finished) break;
                var sb = new StringBuilder("{\"type\":\"progress\"");
                sb.Append(",\"phase\":").Append(Json.Str(st.Paused ? "paused" : st.Phase));
                sb.Append(",\"files\":").Append(Interlocked.Read(ref st.Files));
                sb.Append(",\"dirs\":").Append(Interlocked.Read(ref st.Dirs));
                sb.Append(",\"bytes\":").Append(Interlocked.Read(ref st.Bytes));
                sb.Append(",\"errors\":").Append(Interlocked.Read(ref st.Errors));
                sb.Append(",\"pct\":").Append(Json.Num(Math.Round(st.Pct, 4)));
                sb.Append(",\"current\":").Append(Json.Str(st.Current));
                sb.Append(",\"tops\":[");
                lock (st.TopGate)
                {
                    for (int i = 0; i < st.Tops.Count; i++)
                    {
                        var t = st.Tops[i];
                        if (i > 0) sb.Append(',');
                        sb.Append("{\"name\":").Append(Json.Str(t.Name))
                          .Append(",\"dir\":").Append(Json.Bool(t.IsDir))
                          .Append(",\"bytes\":").Append(Interlocked.Read(ref t.Bytes))
                          .Append(",\"state\":").Append(t.State)
                          .Append(",\"type\":").Append(t.Dominant()).Append('}');
                    }
                }
                sb.Append("],\"biggest\":").Append(st.BiggestJson()).Append('}');
                Out.Line(sb.ToString());
            }
        }
    }

    // ───────────────────────── directory walk ─────────────────────────

    sealed class Walker
    {
        readonly ScanOptions o;
        readonly ScanState st;
        readonly List<Node> nodes = new List<Node>(1 << 16);
        readonly object nodesGate = new object();
        readonly Stack<Job> jobs = new Stack<Job>();
        readonly object jobsGate = new object();
        readonly HashSet<string> linkTargets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int outstanding;
        int topCount;
        int topDone;

        struct Job { public int Node; public string Path; public int Depth; public TopItem Top; }

        public Walker(ScanOptions o, ScanState st) { this.o = o; this.st = st; }

        public List<Node> Run()
        {
            var root = new Node { Parent = -1, Name = o.Root, Flags = NodeFlags.Dir };
            nodes.Add(root);
            Interlocked.Increment(ref st.Dirs);
            st.SnapshotHandler = WriteSnapshot;
            outstanding = 1;
            ProcessDir(new Job { Node = 0, Path = o.Root, Depth = 0, Top = null });
            Interlocked.Decrement(ref outstanding);

            int workers = Math.Max(2, Math.Min(8, Environment.ProcessorCount));
            var threads = new List<Thread>();
            for (int i = 0; i < workers; i++)
            {
                var t = new Thread(Work);
                t.IsBackground = true;
                t.Start();
                threads.Add(t);
            }
            foreach (var t in threads) t.Join();
            st.Pct = 1;
            return nodes;
        }

        void Work()
        {
            while (true)
            {
                Job job;
                lock (jobsGate)
                {
                    while (jobs.Count == 0)
                    {
                        if (Volatile.Read(ref outstanding) == 0) { Monitor.PulseAll(jobsGate); return; }
                        Monitor.Wait(jobsGate, 50);
                    }
                    job = jobs.Pop();
                }
                st.WaitIfPaused();
                if (!st.StopRequested) ProcessDir(job);
                FinishJob(job);
            }
        }

        void FinishJob(Job job)
        {
            if (job.Top != null && Interlocked.Decrement(ref job.Top.Pending) == 0)
            {
                job.Top.State = 2;
                Interlocked.Increment(ref topDone);
            }
            UpdatePct();
            if (Interlocked.Decrement(ref outstanding) == 0)
                lock (jobsGate) Monitor.PulseAll(jobsGate);
        }

        void UpdatePct()
        {
            double p;
            if (st.IsDriveRoot && st.DriveUsed > 0) p = (double)Interlocked.Read(ref st.Bytes) / st.DriveUsed;
            else
            {
                int tc = Math.Max(1, topCount);
                int active = 0;
                lock (st.TopGate) foreach (var t in st.Tops) if (t.State == 1) active++;
                p = (Volatile.Read(ref topDone) + active * 0.45) / tc;
            }
            p = Math.Min(0.99, p);
            if (p > st.Pct) st.Pct = p;
        }

        void WriteSnapshot(string path)
        {
            List<Node> copy;
            lock (nodesGate) copy = new List<Node>(nodes);
            long files = 0, dirs = 0, bytes = 0;
            foreach (var n in copy) { if ((n.Flags & NodeFlags.Dir) != 0) dirs++; else { files++; bytes += n.Size; } }
            try
            {
                var di = new DriveInfo(Path.GetPathRoot(o.Root));
                ScanCommand.WriteResult(path, copy, ScanCommand.Header(o, di.DriveFormat, Native.ClusterSize(Path.GetPathRoot(o.Root)), di.TotalSize, di.TotalFreeSpace, "Walk", (DateTime.UtcNow - st.Started).TotalSeconds, true, files, dirs - 1, Interlocked.Read(ref st.Errors), bytes));
                Out.Line("{\"type\":\"snapshot\",\"out\":" + Json.Str(path) + "}");
            }
            catch (Exception e) { Out.Line("{\"type\":\"snapshot\",\"error\":" + Json.Str(e.Message) + "}"); }
        }

        void ProcessDir(Job job)
        {
            st.Current = job.Path;
            if (job.Top != null && job.Top.State == 0) job.Top.State = 1;
            var local = new List<Node>();
            var subPaths = new List<string>();
            var localTypes = new long[FileTypes.Count];
            long bytes = 0, files = 0, dirs = 0;
            bool rootLevel = job.Depth == 0;
            List<TopItem> newTops = rootLevel ? new List<TopItem>() : null;

            string pattern = Native.LongPath(job.Path.EndsWith("\\") ? job.Path + "*" : job.Path + "\\*");
            FindData fd;
            IntPtr h = Native.FindFirstFileExW(pattern, 1, out fd, 0, IntPtr.Zero, 2);
            if (h == Native.Invalid)
            {
                int err = Marshal.GetLastWin32Error();
                if (err != 2 && err != 18) // not "no files"
                {
                    Interlocked.Increment(ref st.Errors);
                    lock (nodesGate) nodes[job.Node].Flags |= NodeFlags.Denied;
                }
                return;
            }
            try
            {
                do
                {
                    string name = fd.FileName;
                    if (name == "." || name == "..") continue;
                    uint a = fd.Attributes;
                    bool hidden = (a & Native.AttrHidden) != 0, system = (a & Native.AttrSystem) != 0;
                    if (!o.Hidden && (hidden || system)) continue;
                    bool isDir = (a & Native.AttrDirectory) != 0;
                    bool reparse = (a & Native.AttrReparse) != 0;
                    var n = new Node();
                    n.Name = name;
                    n.MTime = Native.UnixFromFileTime(((long)fd.WriteHigh << 32) | fd.WriteLow);
                    byte f = 0;
                    if (isDir) f |= NodeFlags.Dir;
                    if (hidden) f |= NodeFlags.Hidden;
                    if (system) f |= NodeFlags.System;
                    if (reparse) f |= NodeFlags.Reparse;
                    if (isDir)
                    {
                        dirs++;
                        bool descend = !reparse || (o.Links && ShouldFollow(job.Path, name, job.Depth));
                        subPaths.Add(descend ? name : null);
                        if (rootLevel) newTops.Add(new TopItem { Name = name, IsDir = true, State = descend ? 0 : 2 });
                    }
                    else
                    {
                        long size = ((long)fd.SizeHigh << 32) | fd.SizeLow;
                        if ((a & (Native.AttrRecallOnAccess | Native.AttrRecallOnOpen | Native.AttrOffline)) != 0) { size = 0; f |= NodeFlags.Cloud; }
                        n.Size = size;
                        n.Type = FileTypes.Classify(name);
                        bytes += size;
                        files++;
                        localTypes[n.Type] += size;
                        if (size > (64L << 20)) st.OfferBig(size, Rel(job.Path, name));
                        subPaths.Add(null);
                        if (rootLevel)
                        {
                            var t = new TopItem { Name = name, IsDir = false, State = 2, Bytes = size };
                            t.TypeBytes[n.Type] = size;
                            newTops.Add(t);
                        }
                    }
                    n.Flags = f;
                    n.Parent = job.Node;
                    local.Add(n);
                } while (Native.FindNextFileW(h, out fd));
            }
            finally { Native.FindClose(h); }

            Interlocked.Add(ref st.Bytes, bytes);
            Interlocked.Add(ref st.Files, files);
            Interlocked.Add(ref st.Dirs, dirs);
            if (job.Top != null)
            {
                Interlocked.Add(ref job.Top.Bytes, bytes);
                for (int i = 0; i < localTypes.Length; i++) if (localTypes[i] != 0) Interlocked.Add(ref job.Top.TypeBytes[i], localTypes[i]);
            }

            int baseIndex;
            lock (nodesGate)
            {
                baseIndex = nodes.Count;
                nodes.AddRange(local);
            }

            if (rootLevel)
            {
                lock (st.TopGate) st.Tops.AddRange(newTops);
                topCount = newTops.Count;
                foreach (var t in newTops) if (t.State == 2) topDone++;
            }

            // Push in reverse so the first folder is worked on first (depth-first).
            var pushed = new List<Job>();
            for (int i = subPaths.Count - 1; i >= 0; i--)
            {
                if (subPaths[i] == null) continue;
                var top = rootLevel ? newTops[i] : job.Top;
                if (top != null) { Interlocked.Increment(ref top.Pending); top.State = Math.Max(top.State, rootLevel ? 0 : 1); }
                string child = job.Path.EndsWith("\\") ? job.Path + subPaths[i] : job.Path + "\\" + subPaths[i];
                pushed.Add(new Job { Node = baseIndex + i, Path = child, Depth = job.Depth + 1, Top = top });
            }
            if (pushed.Count > 0)
            {
                Interlocked.Add(ref outstanding, pushed.Count);
                lock (jobsGate)
                {
                    foreach (var j in pushed) jobs.Push(j);
                    Monitor.PulseAll(jobsGate);
                }
            }
        }

        string Rel(string dir, string name)
        {
            string full = dir.EndsWith("\\") ? dir + name : dir + "\\" + name;
            if (full.StartsWith(o.Root, StringComparison.OrdinalIgnoreCase)) full = full.Substring(o.Root.Length).TrimStart('\\');
            return full;
        }

        // Follow a junction/symlink only when it leads somewhere we haven't been and isn't an ancestor.
        bool ShouldFollow(string parent, string name, int depth)
        {
            if (depth > 64) return false;
            string full = parent.EndsWith("\\") ? parent + name : parent + "\\" + name;
            using (var hnd = Native.CreateFileW(Native.LongPath(full), 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero))
            {
                if (hnd.IsInvalid) return false;
                var sb = new StringBuilder(1024);
                uint len = Native.GetFinalPathNameByHandleW(hnd, sb, 1024, 0);
                if (len == 0 || len >= 1024) return false;
                string target = sb.ToString();
                if (target.StartsWith(@"\\?\UNC\")) target = @"\\" + target.Substring(8);
                else if (target.StartsWith(@"\\?\")) target = target.Substring(4);
                target = target.TrimEnd('\\');
                string p = parent.TrimEnd('\\') + "\\";
                if (p.StartsWith(target + "\\", StringComparison.OrdinalIgnoreCase)) return false;
                lock (linkTargets)
                {
                    if (linkTargets.Contains(target)) return false;
                    linkTargets.Add(target);
                }
                return true;
            }
        }
    }

    // ───────────────────────── NTFS master file table ─────────────────────────

    sealed class MftScanner
    {
        const long RootRecord = 5;
        readonly ScanOptions o;
        readonly ScanState st;
        SafeFileHandle vol;
        int clusterSize, recordSize, sectorSize;
        long mftBytes;
        readonly List<long[]> runs = new List<long[]>(); // { lcn, clusters }

        // Per-record data.
        int[] parent;
        string[] names;
        byte[] namePrio;
        long[] sizes;
        double[] mtimes;
        uint[] attrs;
        byte[] rflags; // 1 in use, 2 directory, 4 base record seen
        long recordCount, readRecords;

        // Incremental resolution of top-level ancestors for the live map.
        int[] topOf; // -2 unknown, -3 excluded, else index into st.Tops
        readonly List<int> unresolved = new List<int>();
        readonly Dictionary<int, int> topIndex = new Dictionary<int, int>();
        readonly object readGate = new object();

        public MftScanner(ScanOptions o, ScanState st) { this.o = o; this.st = st; }

        public List<Node> Run()
        {
            st.Phase = "mft";
            string letter = o.Root.Substring(0, 2);
            vol = Native.CreateFileW(@"\\.\" + letter, 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (vol.IsInvalid)
            {
                int err = Marshal.GetLastWin32Error();
                if (err == 5) throw new UnauthorizedAccessException();
                throw new IOException("CreateFile error " + err);
            }
            using (vol)
            {
                ReadBoot();
                ReadMftLayout();
                Allocate();
                st.SnapshotHandler = Snapshot;
                ReadAll();
                st.SnapshotHandler = null;
                st.Phase = "build";
                return Build(true);
            }
        }

        byte[] ReadAt(long offset, int count)
        {
            var buf = new byte[count];
            long np;
            if (!Native.SetFilePointerEx(vol, offset, out np, 0)) throw new IOException("seek failed");
            int read;
            if (!Native.ReadFile(vol, buf, count, out read, IntPtr.Zero)) throw new IOException("read failed (" + Marshal.GetLastWin32Error() + ")");
            return buf;
        }

        void ReadBoot()
        {
            byte[] b = ReadAt(0, 512);
            if (Encoding.ASCII.GetString(b, 3, 4) != "NTFS") throw new IOException("not an NTFS boot sector");
            sectorSize = BitConverter.ToUInt16(b, 0x0B);
            int spc = b[0x0D];
            if (spc > 0x80) spc = 1 << (256 - spc);
            clusterSize = sectorSize * spc;
            long mftLcn = BitConverter.ToInt64(b, 0x30);
            sbyte cpr = (sbyte)b[0x40];
            recordSize = cpr > 0 ? cpr * clusterSize : 1 << (-cpr);
            runs.Add(new long[] { mftLcn, Math.Max(1, (recordSize * 16 + clusterSize - 1) / clusterSize) });
        }

        byte[] ReadRecordRaw(long index)
        {
            long off = index * recordSize;
            long vcnByte = 0;
            foreach (var r in runs)
            {
                long len = r[1] * clusterSize;
                if (off < vcnByte + len)
                {
                    long disk = r[0] * clusterSize + (off - vcnByte);
                    long aligned = disk - disk % sectorSize;
                    int pad = (int)(disk - aligned);
                    int count = ((pad + recordSize + sectorSize - 1) / sectorSize) * sectorSize;
                    byte[] raw = ReadAt(aligned, count);
                    var rec = new byte[recordSize];
                    Buffer.BlockCopy(raw, pad, rec, 0, recordSize);
                    return rec;
                }
                vcnByte += len;
            }
            throw new IOException("record outside known MFT extents");
        }

        // Find $MFT's own data runs (including any continued in extension records).
        void ReadMftLayout()
        {
            byte[] rec = ReadRecordRaw(0);
            if (!Fixup(rec, 0)) throw new IOException("bad $MFT record");
            var pieces = new List<KeyValuePair<long, List<long[]>>>();
            long dataSize = 0;
            var extra = new List<long>();
            ForEachAttr(rec, 0, delegate (int type, int a)
            {
                if (type == 0x80 && rec[a + 9] == 0 && rec[a + 8] != 0)
                {
                    long startVcn = BitConverter.ToInt64(rec, a + 0x10);
                    if (startVcn == 0) dataSize = BitConverter.ToInt64(rec, a + 0x30);
                    pieces.Add(new KeyValuePair<long, List<long[]>>(startVcn, ParseRuns(rec, a)));
                }
                else if (type == 0x20)
                {
                    if (rec[a + 8] == 0)
                    {
                        int vo = BitConverter.ToUInt16(rec, a + 0x14);
                        int vl = BitConverter.ToInt32(rec, a + 0x10);
                        int p = a + vo, end = p + vl;
                        while (p + 26 <= end)
                        {
                            int t = BitConverter.ToInt32(rec, p);
                            int l = BitConverter.ToUInt16(rec, p + 4);
                            long refRec = BitConverter.ToInt64(rec, p + 16) & 0xFFFFFFFFFFFFL;
                            if (t == 0x80 && refRec != 0 && !extra.Contains(refRec)) extra.Add(refRec);
                            if (l <= 0) break;
                            p += l;
                        }
                    }
                }
            });
            // Provisional runs (from record 0) let us read the extension records.
            runs.Clear();
            foreach (var pc in pieces) runs.AddRange(pc.Value);
            foreach (long x in extra)
            {
                byte[] er = ReadRecordRaw(x);
                if (!Fixup(er, 0)) continue;
                ForEachAttr(er, 0, delegate (int type, int a)
                {
                    if (type == 0x80 && er[a + 9] == 0 && er[a + 8] != 0)
                        pieces.Add(new KeyValuePair<long, List<long[]>>(BitConverter.ToInt64(er, a + 0x10), ParseRuns(er, a)));
                });
            }
            pieces.Sort((p1, p2) => p1.Key.CompareTo(p2.Key));
            runs.Clear();
            foreach (var pc in pieces) runs.AddRange(pc.Value);
            mftBytes = dataSize;
            recordCount = dataSize / recordSize;
            if (recordCount <= 0) throw new IOException("empty MFT");
        }

        static List<long[]> ParseRuns(byte[] rec, int a)
        {
            var list = new List<long[]>();
            int p = a + BitConverter.ToUInt16(rec, a + 0x20);
            int end = a + BitConverter.ToInt32(rec, a + 4);
            long lcn = 0;
            while (p < end && rec[p] != 0)
            {
                int lenSize = rec[p] & 0xF, offSize = rec[p] >> 4;
                long len = 0;
                for (int i = 0; i < lenSize; i++) len |= (long)rec[p + 1 + i] << (8 * i);
                long off = 0;
                for (int i = 0; i < offSize; i++) off |= (long)rec[p + 1 + lenSize + i] << (8 * i);
                if (offSize > 0 && (rec[p + lenSize + offSize] & 0x80) != 0) off |= -1L << (8 * offSize);
                p += 1 + lenSize + offSize;
                if (offSize == 0) list.Add(new long[] { -1, len }); // sparse
                else { lcn += off; list.Add(new long[] { lcn, len }); }
            }
            return list;
        }

        bool Fixup(byte[] b, int at)
        {
            if (b[at] != 'F' || b[at + 1] != 'I' || b[at + 2] != 'L' || b[at + 3] != 'E') return false;
            int usaOfs = BitConverter.ToUInt16(b, at + 4);
            int usaCount = BitConverter.ToUInt16(b, at + 6);
            if (usaOfs + usaCount * 2 > recordSize) return false;
            if (usaCount < 2) return true;
            ushort usn = BitConverter.ToUInt16(b, at + usaOfs);
            int stride = recordSize / (usaCount - 1); // 512 normally; the sector size on some 4K-native disks
            for (int i = 1; i < usaCount; i++)
            {
                int pos = at + i * stride - 2;
                if (pos + 2 > at + recordSize) break;
                if (BitConverter.ToUInt16(b, pos) != usn) return false;
                b[pos] = b[at + usaOfs + i * 2];
                b[pos + 1] = b[at + usaOfs + i * 2 + 1];
            }
            return true;
        }

        delegate void AttrVisitor(int type, int offset);

        void ForEachAttr(byte[] b, int at, AttrVisitor v)
        {
            int a = at + BitConverter.ToUInt16(b, at + 0x14);
            int end = at + recordSize;
            while (a + 16 <= end)
            {
                int type = BitConverter.ToInt32(b, a);
                if (type == -1) break;
                int len = BitConverter.ToInt32(b, a + 4);
                if (len <= 0 || a + len > end) break;
                v(type, a);
                a += len;
            }
        }

        void Allocate()
        {
            int n = (int)Math.Min(recordCount, int.MaxValue - 1);
            parent = new int[n];
            names = new string[n];
            namePrio = new byte[n];
            sizes = new long[n];
            mtimes = new double[n];
            attrs = new uint[n];
            rflags = new byte[n];
            topOf = new int[n];
            for (int i = 0; i < n; i++) { parent[i] = -1; topOf[i] = -2; }
            topOf[RootRecord] = -1;
        }

        void ReadAll()
        {
            const int chunk = 1 << 20;
            long recIndex = 0;
            byte[] carry = new byte[recordSize];
            int carryLen = 0;
            int resolvedUpTo = 0;
            long lastTick = 0;
            foreach (var r in runs)
            {
                if (recIndex >= recordCount) break;
                long runBytes = r[1] * clusterSize;
                for (long done = 0; done < runBytes && recIndex < recordCount; done += chunk)
                {
                    st.WaitIfPaused();
                    if (st.StopRequested) return;
                    int count = (int)Math.Min(chunk, runBytes - done);
                    byte[] buf = r[0] < 0 ? new byte[count] : ReadAt(r[0] * clusterSize + done, count);
                    Monitor.Enter(readGate);
                    int p = 0;
                    if (carryLen > 0)
                    {
                        int need = recordSize - carryLen;
                        Buffer.BlockCopy(buf, 0, carry, carryLen, Math.Min(need, count));
                        if (count >= need) { ParseRecord(carry, 0, recIndex++); p = need; carryLen = 0; }
                        else { carryLen += count; Monitor.Exit(readGate); continue; }
                    }
                    for (; p + recordSize <= count && recIndex < recordCount; p += recordSize) ParseRecord(buf, p, recIndex++);
                    if (p < count && recIndex < recordCount) { carryLen = count - p; Buffer.BlockCopy(buf, p, carry, 0, carryLen); }
                    readRecords = recIndex;
                    st.Pct = Math.Min(0.97, (double)recIndex / recordCount);
                    if (recIndex - lastTick > 32768)
                    {
                        lastTick = recIndex;
                        resolvedUpTo = ResolveTops(resolvedUpTo, (int)recIndex);
                    }
                    Monitor.Exit(readGate);
                }
            }
            readRecords = recIndex;
            ResolveTops(resolvedUpTo, (int)recIndex);
            lock (st.TopGate) foreach (var t in st.Tops) t.State = 2;
        }

        void ParseRecord(byte[] b, int at, long index)
        {
            if (index >= parent.Length) return;
            if (!Fixup(b, at)) return;
            int flags = BitConverter.ToUInt16(b, at + 0x16);
            if ((flags & 1) == 0) return;
            long baseRef = BitConverter.ToInt64(b, at + 0x20) & 0xFFFFFFFFFFFFL;
            int target = (int)(baseRef != 0 ? baseRef : index);
            if (target >= parent.Length) return;
            if (baseRef == 0)
            {
                rflags[target] |= 1 | 4;
                if ((flags & 2) != 0) rflags[target] |= 2;
            }
            int a = at + BitConverter.ToUInt16(b, at + 0x14);
            int end = at + recordSize;
            while (a + 16 <= end)
            {
                int type = BitConverter.ToInt32(b, a);
                if (type == -1) break;
                int len = BitConverter.ToInt32(b, a + 4);
                if (len <= 0 || a + len > end) break;
                bool nonRes = b[a + 8] != 0;
                int nameLen = b[a + 9];
                if (type == 0x10 && !nonRes)
                {
                    int v = a + BitConverter.ToUInt16(b, a + 0x14);
                    mtimes[target] = Native.UnixFromFileTime(BitConverter.ToInt64(b, v + 8));
                    attrs[target] = BitConverter.ToUInt32(b, v + 32);
                }
                else if (type == 0x30 && !nonRes)
                {
                    int v = a + BitConverter.ToUInt16(b, a + 0x14);
                    int nlen = b[v + 0x40];
                    int ns = b[v + 0x41];
                    byte prio = (byte)(ns == 2 ? 1 : ns == 0 ? 2 : 3);
                    if (prio > namePrio[target])
                    {
                        namePrio[target] = prio;
                        long pref = BitConverter.ToInt64(b, v) & 0xFFFFFFFFFFFFL;
                        parent[target] = (int)Math.Min(pref, int.MaxValue);
                        names[target] = Encoding.Unicode.GetString(b, v + 0x42, nlen * 2);
                    }
                }
                else if (type == 0x80 && nameLen == 0)
                {
                    if (!nonRes) sizes[target] = BitConverter.ToUInt32(b, a + 0x10);
                    else if (BitConverter.ToInt64(b, a + 0x10) == 0) sizes[target] = BitConverter.ToInt64(b, a + 0x30);
                }
                a += len;
            }
            if (baseRef == 0 && (flags & 2) == 0)
            {
                Interlocked.Increment(ref st.Files);
            }
            else if (baseRef == 0) Interlocked.Increment(ref st.Dirs);
        }

        bool Excluded(int r)
        {
            if (r == RootRecord) return false;
            if (o.Hidden) return false;
            return (attrs[r] & (Native.AttrHidden | Native.AttrSystem)) != 0;
        }

        long FileSize(int r)
        {
            if ((attrs[r] & (Native.AttrRecallOnAccess | Native.AttrRecallOnOpen | Native.AttrOffline)) != 0) return 0;
            return sizes[r];
        }

        // Attribute newly read records to their top-level folder; retry ones whose parents weren't read yet.
        int ResolveTops(int from, int to)
        {
            var retry = new List<int>(unresolved);
            unresolved.Clear();
            for (int r = from; r < to; r++)
                if ((rflags[r] & 4) != 0 && names[r] != null && r != RootRecord) retry.Add(r);
            long bytes = 0;
            foreach (int r in retry)
            {
                int t = TopFor(r, to);
                if (t == -2) { unresolved.Add(r); continue; }
                if (t < 0 || (rflags[r] & 2) != 0) continue;
                long s = FileSize(r);
                bytes += s;
                var top = st.Tops[t];
                top.Bytes += s;
                top.TypeBytes[FileTypes.Classify(names[r])] += s;
                if (s > (64L << 20)) st.OfferBig(s, PathOf(r));
            }
            Interlocked.Add(ref st.Bytes, bytes);
            if (st.Tops.Count > 0)
            {
                // Tops become "done" once the reader has moved well past them; good enough for a live view.
                lock (st.TopGate) foreach (var tp in st.Tops) if (tp.State == 0) tp.State = 1;
            }
            return to;
        }

        int TopFor(int r, int readLimit)
        {
            var chain = new List<int>();
            int cur = r;
            int result;
            while (true)
            {
                if (cur < 0 || cur >= topOf.Length) { result = -3; break; }
                if (topOf[cur] != -2 && cur != r) { result = topOf[cur]; break; }
                if (cur >= readLimit || (rflags[cur] & 4) == 0 || names[cur] == null) { result = -2; break; }
                if (Excluded(cur)) { result = -3; topOf[cur] = -3; break; }
                int p = parent[cur];
                if (p == RootRecord)
                {
                    int idx;
                    if (!topIndex.TryGetValue(cur, out idx))
                    {
                        lock (st.TopGate)
                        {
                            idx = st.Tops.Count;
                            st.Tops.Add(new TopItem { Name = names[cur], IsDir = (rflags[cur] & 2) != 0, State = 1 });
                        }
                        topIndex[cur] = idx;
                    }
                    topOf[cur] = idx;
                    result = idx;
                    break;
                }
                if (p == cur || chain.Count > 512) { result = -3; break; }
                chain.Add(cur);
                cur = p;
            }
            if (result != -2) foreach (int c in chain) topOf[c] = result;
            return result;
        }

        string PathOf(int r)
        {
            var parts = new List<string>();
            int cur = r;
            for (int guard = 0; guard < 256 && cur != RootRecord && cur >= 0 && cur < names.Length && names[cur] != null; guard++)
            {
                parts.Add(names[cur]);
                if (parent[cur] == cur) break;
                cur = parent[cur];
            }
            parts.Reverse();
            return string.Join("\\", parts.ToArray());
        }

        void Snapshot(string path)
        {
            try
            {
                List<Node> nodes;
                lock (readGate) nodes = Build(false);
                long files = 0, dirs = 0, bytes = 0;
                foreach (var n in nodes) { if ((n.Flags & NodeFlags.Dir) != 0) dirs++; else { files++; bytes += n.Size; } }
                var di = new DriveInfo(o.Root.Substring(0, 3));
                ScanCommand.WriteResult(path, nodes, ScanCommand.Header(o, "NTFS", clusterSize, di.TotalSize, di.TotalFreeSpace, "MFT", (DateTime.UtcNow - st.Started).TotalSeconds, true, files, dirs - 1, 0, bytes));
                Out.Line("{\"type\":\"snapshot\",\"out\":" + Json.Str(path) + "}");
            }
            catch (Exception e) { Out.Line("{\"type\":\"snapshot\",\"error\":" + Json.Str(e.Message) + "}"); }
        }

        // Turn the record table into parent-first nodes, starting at the scan root.
        List<Node> Build(bool final)
        {
            int n = (int)Math.Min(readRecords, parent.Length);
            var head = new int[parent.Length];
            var next = new int[parent.Length];
            for (int i = 0; i < head.Length; i++) head[i] = -1;
            for (int r = n - 1; r >= 0; r--)
            {
                if ((rflags[r] & 4) == 0 || names[r] == null || r == RootRecord) continue;
                int p = parent[r];
                if (p < 0 || p >= n || p == r) continue;
                next[r] = head[p];
                head[p] = r;
            }

            int start = FindStart(head, next);
            if (start < 0) throw new IOException("folder not found in the file table");

            var nodes = new List<Node>(Math.Max(16, (int)(st.Files + st.Dirs)));
            var map = new Dictionary<int, int>();
            var stack = new Stack<int>();
            var root = new Node { Parent = -1, Name = o.Root, Flags = NodeFlags.Dir, MTime = mtimes[start] };
            nodes.Add(root);
            map[start] = 0;
            stack.Push(start);
            var visited = new bool[parent.Length];
            visited[start] = true;
            long files = 0, dirs = 0, bytes = 0;
            while (stack.Count > 0)
            {
                int d = stack.Pop();
                int di = map[d];
                for (int c = head[d]; c != -1; c = next[c])
                {
                    if (visited[c]) continue;
                    visited[c] = true;
                    if (Excluded(c)) continue;
                    bool isDir = (rflags[c] & 2) != 0;
                    uint a = attrs[c];
                    var node = new Node();
                    node.Parent = di;
                    node.Name = names[c];
                    node.MTime = mtimes[c];
                    byte f = 0;
                    if (isDir) f |= NodeFlags.Dir;
                    if ((a & Native.AttrHidden) != 0) f |= NodeFlags.Hidden;
                    if ((a & Native.AttrSystem) != 0) f |= NodeFlags.System;
                    if ((a & Native.AttrReparse) != 0) f |= NodeFlags.Reparse;
                    if (!isDir)
                    {
                        node.Size = FileSize(c);
                        if (node.Size == 0 && sizes[c] > 0) f |= NodeFlags.Cloud;
                        node.Type = FileTypes.Classify(node.Name);
                        files++;
                        bytes += node.Size;
                    }
                    else dirs++;
                    node.Flags = f;
                    map[c] = nodes.Count;
                    nodes.Add(node);
                    if (isDir) stack.Push(c);
                }
            }
            if (final)
            {
                st.Files = files;
                st.Dirs = dirs;
                st.Bytes = bytes;
            }
            return nodes;
        }

        int FindStart(int[] head, int[] next)
        {
            string rest = o.Root.Length > 3 ? o.Root.Substring(3) : "";
            int cur = (int)RootRecord;
            if (rest.Length == 0) return cur;
            foreach (string part in rest.Split(new char[] { '\\' }, StringSplitOptions.RemoveEmptyEntries))
            {
                int found = -1;
                for (int c = head[cur]; c != -1; c = next[c])
                    if (string.Equals(names[c], part, StringComparison.OrdinalIgnoreCase)) { found = c; break; }
                if (found < 0) return -1;
                cur = found;
            }
            return cur;
        }
    }

    // ───────────────────────── deletion ─────────────────────────

    static class Deleter
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct ShFileOp
        {
            public IntPtr Hwnd;
            public uint Func;
            [MarshalAs(UnmanagedType.LPWStr)] public string From;
            [MarshalAs(UnmanagedType.LPWStr)] public string To;
            public ushort Flags;
            public bool Aborted;
            public IntPtr NameMappings;
            [MarshalAs(UnmanagedType.LPWStr)] public string Title;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHFileOperationW(ref ShFileOp op);

        const uint FoDelete = 3;
        // FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI | FOF_WANTNUKEWARNING
        const ushort RecycleFlags = 0x4 | 0x10 | 0x40 | 0x400 | 0x4000;

        public static void Run(string listFile, bool permanent)
        {
            var paths = new List<string>();
            foreach (string l in File.ReadAllLines(listFile, Encoding.UTF8)) if (l.Trim().Length > 0) paths.Add(l.Trim());
            if (!permanent) RecycleBatches(paths);
            for (int i = 0; i < paths.Count; i++)
            {
                string p = paths[i];
                Progress(i, paths.Count, p);
                string error = null;
                if (Exists(p))
                {
                    try
                    {
                        if (permanent) DeleteTree(p);
                        else if (p.Length >= 260) error = "Path too long for the Recycle Bin";
                        else if (!Recycle(p + "\0")) error = "In use or access denied";
                    }
                    catch (Exception e) { error = e.Message; }
                }
                bool ok = !Exists(p);
                long remaining = ok ? 0 : SizeOf(p);
                if (!ok && (error == null || remaining > 0)) error = "Some files are in use or protected";
                Out.Line("{\"type\":\"result\",\"path\":" + Json.Str(p) + ",\"ok\":" + Json.Bool(ok) + ",\"remaining\":" + remaining + ",\"error\":" + Json.Str(ok ? null : error) + "}");
            }
            Out.Line("{\"type\":\"done\"}");
        }

        static void Progress(int done, int total, string current)
        {
            Out.Line("{\"type\":\"progress\",\"done\":" + done + ",\"total\":" + total + ",\"current\":" + Json.Str(current) + "}");
        }

        // One shell operation per batch is much faster than one per item; failures get retried singly.
        static void RecycleBatches(List<string> paths)
        {
            const int batch = 64;
            for (int i = 0; i < paths.Count; i += batch)
            {
                var sb = new StringBuilder();
                for (int j = i; j < Math.Min(paths.Count, i + batch); j++)
                    if (paths[j].Length < 260 && Exists(paths[j])) sb.Append(paths[j]).Append('\0');
                if (sb.Length == 0) continue;
                Progress(i, paths.Count, paths[i]);
                Recycle(sb.ToString());
            }
        }

        static bool Recycle(string doubleNullList)
        {
            var op = new ShFileOp();
            op.Func = FoDelete;
            op.From = doubleNullList;
            op.Flags = RecycleFlags;
            return SHFileOperationW(ref op) == 0 && !op.Aborted;
        }

        static bool Exists(string p)
        {
            string lp = Native.LongPath(p);
            return File.Exists(lp) || Directory.Exists(lp);
        }

        static long SizeOf(string p)
        {
            string lp = Native.LongPath(p);
            try
            {
                if (File.Exists(lp)) return new FileInfo(lp).Length;
                var di = new DirectoryInfo(lp);
                if ((di.Attributes & FileAttributes.ReparsePoint) != 0) return 0;
                long total = 0;
                foreach (var f in di.EnumerateFileSystemInfos())
                {
                    if (f is FileInfo) total += ((FileInfo)f).Length;
                    else if ((f.Attributes & FileAttributes.ReparsePoint) == 0) total += SizeOf(p.TrimEnd('\\') + "\\" + f.Name);
                }
                return total;
            }
            catch { return 0; }
        }

        // Permanent delete. Junctions and symlinks are removed as links, never followed.
        static void DeleteTree(string p)
        {
            string lp = Native.LongPath(p);
            if (Directory.Exists(lp))
            {
                var di = new DirectoryInfo(lp);
                if ((di.Attributes & FileAttributes.ReparsePoint) == 0)
                {
                    foreach (var f in di.EnumerateFileSystemInfos())
                    {
                        try { DeleteTree(p.TrimEnd('\\') + "\\" + f.Name); } catch { }
                    }
                }
                try { di.Attributes = FileAttributes.Directory; } catch { }
                di.Delete(false);
            }
            else if (File.Exists(lp))
            {
                var attr = File.GetAttributes(lp);
                if ((attr & FileAttributes.ReadOnly) != 0) File.SetAttributes(lp, attr & ~FileAttributes.ReadOnly);
                File.Delete(lp);
            }
        }
    }

    // ───────────────────────── duplicates ─────────────────────────

    static class Dupes
    {
        const int Sample = 64 * 1024;
        const long FullHashLimit = 1L << 30;

        public static void Run(string listFile)
        {
            var groups = new List<KeyValuePair<long, List<string>>>();
            long curSize = -1;
            List<string> cur = null;
            foreach (string line in File.ReadAllLines(listFile, Encoding.UTF8))
            {
                int tab = line.IndexOf('\t');
                if (tab <= 0) continue;
                long size = long.Parse(line.Substring(0, tab));
                if (size != curSize || cur == null)
                {
                    cur = new List<string>();
                    curSize = size;
                    groups.Add(new KeyValuePair<long, List<string>>(size, cur));
                }
                cur.Add(line.Substring(tab + 1));
            }
            // Biggest potential savings first.
            groups.Sort((a, b) => ((double)b.Key * (b.Value.Count - 1)).CompareTo((double)a.Key * (a.Value.Count - 1)));
            long totalWork = 0;
            foreach (var g in groups) totalWork += Math.Min(g.Key, FullHashLimit) * g.Value.Count;
            long doneWork = 0;
            DateTime lastTick = DateTime.MinValue;
            DateTime started = DateTime.UtcNow;

            foreach (var g in groups)
            {
                if ((DateTime.UtcNow - started).TotalSeconds > 240) break;
                // Pass 1: first+last sample.
                var bySample = new Dictionary<string, List<string>>();
                foreach (string p in g.Value)
                {
                    string h = SampleHash(p, g.Key);
                    if (h == null) continue;
                    List<string> l;
                    if (!bySample.TryGetValue(h, out l)) bySample[h] = l = new List<string>();
                    l.Add(p);
                }
                foreach (var sg in bySample.Values)
                {
                    if (sg.Count < 2) continue;
                    bool full = g.Key <= FullHashLimit;
                    var byHash = new Dictionary<string, List<string>>();
                    foreach (string p in sg)
                    {
                        string h = full ? FullHash(p) : "sampled"; // big files: samples only
                        if (h == null) continue;
                        List<string> l;
                        if (!byHash.TryGetValue(h, out l)) byHash[h] = l = new List<string>();
                        l.Add(p);
                        doneWork += Math.Min(g.Key, FullHashLimit);
                        if ((DateTime.UtcNow - lastTick).TotalMilliseconds > 250)
                        {
                            lastTick = DateTime.UtcNow;
                            Out.Line("{\"type\":\"progress\",\"done\":" + doneWork + ",\"total\":" + totalWork + "}");
                        }
                    }
                    foreach (var hg in byHash.Values)
                    {
                        if (hg.Count < 2) continue;
                        var sb = new StringBuilder("{\"type\":\"group\",\"size\":");
                        sb.Append(g.Key).Append(",\"verified\":").Append(Json.Bool(full)).Append(",\"paths\":[");
                        for (int i = 0; i < hg.Count; i++) { if (i > 0) sb.Append(','); sb.Append(Json.Str(hg[i])); }
                        sb.Append("]}");
                        Out.Line(sb.ToString());
                    }
                }
            }
            Out.Line("{\"type\":\"done\"}");
        }

        static FileStream Open(string p)
        {
            return new FileStream(Native.LongPath(p), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16, FileOptions.SequentialScan);
        }

        static string SampleHash(string p, long size)
        {
            try
            {
                using (var f = Open(p))
                using (var md5 = MD5.Create())
                {
                    var buf = new byte[Sample];
                    int n = f.Read(buf, 0, Sample);
                    md5.TransformBlock(buf, 0, n, null, 0);
                    if (size > Sample * 2)
                    {
                        f.Seek(size / 2, SeekOrigin.Begin);
                        n = f.Read(buf, 0, Sample);
                        md5.TransformBlock(buf, 0, n, null, 0);
                        f.Seek(-Sample, SeekOrigin.End);
                        n = f.Read(buf, 0, Sample);
                        md5.TransformBlock(buf, 0, n, null, 0);
                    }
                    md5.TransformFinalBlock(new byte[0], 0, 0);
                    return Convert.ToBase64String(md5.Hash);
                }
            }
            catch { return null; }
        }

        static string FullHash(string p)
        {
            try
            {
                using (var f = Open(p))
                using (var md5 = MD5.Create())
                    return Convert.ToBase64String(md5.ComputeHash(f));
            }
            catch { return null; }
        }
    }
}
