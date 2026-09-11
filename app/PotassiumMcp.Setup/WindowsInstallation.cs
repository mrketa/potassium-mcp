using System.Buffers;
using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PotassiumMcp.Setup;

public sealed record BundleFile(string Path, string Sha256, long Bytes);
public sealed record BundleEntries(string Node, string PackageRoot, string Cli, string Launcher);
public sealed record BundleManifest(int Schema, string PackageVersion, string NodeVersion, BundleEntries Entries, IReadOnlyList<BundleFile> Files);
public sealed record InstalledBundle(string VersionId, string Location);
public sealed record WindowsReceipt(int Schema, string ApplicationRoot, string InstallRoot, IReadOnlyList<InstalledBundle> Bundles, IReadOnlyList<string> LauncherHashes);
public sealed record VerifiedRuntime(string VersionRoot, string PackageRoot, string Node, string Cli, string Config, string WorkspaceRoot, BundleManifest Manifest);
public sealed record ConnectionInfo(string Command, IReadOnlyList<string> Args, string Json, string FilePath);

public static class BundleValidation
{
    public const int MaxManifestBytes = 8 * 1024 * 1024;
    public const int MaxFiles = 25000;
    public const long MaxFileBytes = 512L * 1024 * 1024;
    public const long MaxTotalBytes = 1024L * 1024 * 1024;
    public static readonly BundleEntries RequiredEntries = new("node/node.exe", "app/node_modules/@mrketa/potassium-mcp", "app/node_modules/@mrketa/potassium-mcp/bin/potassium-mcp.js", "launcher/PotassiumMcp.Launcher.exe");
    private static readonly HashSet<string> ReservedNames = new(["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"], StringComparer.OrdinalIgnoreCase);
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow, WriteIndented = true, MaxDepth = 64 };

    public static BundleManifest ParseManifest(string text) => ParseManifest(Encoding.UTF8.GetBytes(text));
    public static BundleManifest ParseManifest(byte[] bytes)
    {
        if (bytes.Length > MaxManifestBytes) throw new InvalidDataException("Runtime manifest exceeds its size limit.");
        RejectDuplicateProperties(bytes);
        BundleManifest manifest;
        try { manifest = JsonSerializer.Deserialize<BundleManifest>(bytes, Json) ?? throw new InvalidDataException("Runtime manifest is missing."); }
        catch (JsonException error) { throw new InvalidDataException("Runtime manifest is invalid.", error); }
        if (manifest.Schema != 1 || manifest.Entries != RequiredEntries || string.IsNullOrWhiteSpace(manifest.PackageVersion) || manifest.PackageVersion.Length > 128
            || string.IsNullOrWhiteSpace(manifest.NodeVersion) || manifest.NodeVersion.Length > 128 || manifest.Files is null || manifest.Files.Count is < 1 or > MaxFiles)
            throw new InvalidDataException("Runtime manifest contract is unsupported.");
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        foreach (var file in manifest.Files)
        {
            if (file is null || !IsSafeRelativePath(file.Path) || string.Equals(file.Path, WindowsInstallation.ManifestName, StringComparison.OrdinalIgnoreCase) || !IsSha256(file.Sha256)
                || file.Bytes < 0 || file.Bytes > MaxFileBytes || !paths.Add(file.Path)) throw new InvalidDataException("Runtime manifest contains an unsafe or duplicate file.");
            total = checked(total + file.Bytes);
        }
        if (total > MaxTotalBytes || !paths.Contains(RequiredEntries.Node) || !paths.Contains(RequiredEntries.Cli) || !paths.Contains(RequiredEntries.Launcher)
            || !paths.Contains(RequiredEntries.PackageRoot + "/package.json") || !paths.Contains(RequiredEntries.PackageRoot + "/src/proxy.js")) throw new InvalidDataException("Runtime manifest entries are incomplete or oversized.");
        foreach (var path in paths)
        {
            var parent = path;
            while (parent.LastIndexOf('/') is var index && index >= 0)
            {
                parent = parent[..index];
                if (paths.Contains(parent)) throw new InvalidDataException("Runtime manifest aliases a file and directory.");
            }
        }
        return manifest;
    }

    public static bool IsSha256(string? hash) => hash is { Length: 64 } && hash.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
    public static bool IsSafeRelativePath(string? path)
    {
        if (string.IsNullOrEmpty(path) || path.Length > 1024 || path.Contains('\\') || path.Contains(':') || path.StartsWith('/')) return false;
        foreach (var component in path.Split('/'))
        {
            if (component.Length == 0 || component is "." or ".." || component.EndsWith('.') || component.EndsWith(' ') || component.Any(character => character < 32 || "<>\"|?*".Contains(character))) return false;
            var dot = component.IndexOf('.');
            var stem = (dot < 0 ? component : component[..dot]).TrimEnd(' ');
            if (ReservedNames.Contains(stem)
                || (stem.Length == 4 && (stem.StartsWith("COM", StringComparison.OrdinalIgnoreCase) || stem.StartsWith("LPT", StringComparison.OrdinalIgnoreCase)) && (char.IsDigit(stem[3]) || "¹²³".Contains(stem[3])))) return false;
        }
        return true;
    }

    public static void Verify(ZipArchive archive, BundleManifest manifest)
    {
        if (archive.Entries.Count != manifest.Files.Count) throw new InvalidDataException("Runtime archive contains missing or extra entries.");
        var files = manifest.Files.ToDictionary(file => file.Path, StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in archive.Entries)
        {
            var mode = (entry.ExternalAttributes >> 16) & 0xF000;
            if (!IsSafeRelativePath(entry.FullName) || !seen.Add(entry.FullName) || !files.TryGetValue(entry.FullName, out var file)
                || entry.Length != file.Bytes || (entry.ExternalAttributes & 0x410) != 0 || (mode != 0 && mode != 0x8000)) throw new InvalidDataException("Runtime archive contains an unsafe, redirected or unexpected entry.");
            using var stream = entry.Open();
            if (HashBounded(stream, file.Bytes) != file.Sha256) throw new InvalidDataException("Runtime archive integrity check failed.");
        }
    }

    internal static string HashBounded(Stream stream, long expected)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
        try
        {
            long count = 0;
            int size;
            while ((size = stream.Read(buffer)) != 0)
            {
                count += size;
                if (count > expected) throw new InvalidDataException("Runtime stream exceeds its declared length.");
                hash.AppendData(buffer, 0, size);
            }
            if (count != expected) throw new InvalidDataException("Runtime stream is truncated.");
            return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }

    internal static void RejectDuplicateProperties(byte[] bytes)
    {
        try
        {
            var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { MaxDepth = 64 });
            var objects = new Stack<HashSet<string>>();
            while (reader.Read())
            {
                if (reader.TokenType == JsonTokenType.StartObject) objects.Push(new(StringComparer.Ordinal));
                else if (reader.TokenType == JsonTokenType.EndObject) objects.Pop();
                else if (reader.TokenType == JsonTokenType.PropertyName && !objects.Peek().Add(reader.GetString()!)) throw new InvalidDataException("Metadata contains duplicate properties.");
            }
        }
        catch (JsonException error) { throw new InvalidDataException("Metadata is not valid JSON.", error); }
    }
}

public static class WindowsInstallation
{
    public const string ReceiptName = "windows-installation.json";
    public const string ManifestName = "runtime-bundle.manifest.json";
    public const string LauncherName = "PotassiumMcp.Launcher.exe";
    private const string LockName = ".windows-install.lock";
    private static readonly byte[] LockBytes = Encoding.ASCII.GetBytes("Potassium MCP Windows installation lock v1\n");

    public static string CanonicalPath(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        var result = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        if (!Path.IsPathFullyQualified(result) || result == Path.GetPathRoot(result)) throw new InvalidDataException("Choose an absolute, non-root installation directory.");
        RejectLinks(result);
        return result;
    }

    public static void RejectLinks(string path)
    {
        for (var item = Path.GetFullPath(path); !string.IsNullOrEmpty(item); item = Path.GetDirectoryName(item))
        {
            try
            {
                if ((File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("A managed path is redirected by a symbolic link or reparse point.");
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
    }

    public static bool SamePath(string left, string right) => string.Equals(Path.TrimEndingDirectorySeparator(left), Path.TrimEndingDirectorySeparator(right), StringComparison.OrdinalIgnoreCase);
    public static bool Overlaps(string left, string right) => SamePath(left, right) || right.StartsWith(Path.TrimEndingDirectorySeparator(left) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    public static void ValidateRoots(string applicationRoot, string installRoot, string? workspaceRoot)
    {
        var roots = new List<string> { CanonicalPath(applicationRoot), CanonicalPath(installRoot) };
        if (workspaceRoot is not null)
        {
            roots.Add(CanonicalPath(workspaceRoot));
            roots.Add(CanonicalPath(Path.Combine(Path.GetDirectoryName(workspaceRoot)!, "autoexec")));
        }
        for (var i = 0; i < roots.Count; i++) for (var j = i + 1; j < roots.Count; j++)
            if (Overlaps(roots[i], roots[j]) || Overlaps(roots[j], roots[i])) throw new InvalidDataException("Application, private data, workspace and autoexec directories must not overlap.");
    }

    public static FileStream AcquireLock(string applicationRoot, bool mutation)
    {
        RejectLinks(applicationRoot);
        if (mutation) Directory.CreateDirectory(applicationRoot);
        var path = Path.Combine(applicationRoot, LockName);
        RejectLinks(path);
        try
        {
            FileStream stream;
            var created = false;
            if (mutation)
            {
                try { stream = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None); created = true; }
                catch (IOException) when (File.Exists(path)) { stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
            }
            else stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            try
            {
                if (created) { stream.Write(LockBytes); stream.Flush(true); }
                stream.Position = 0;
                var bytes = new byte[LockBytes.Length];
                if (stream.Length != bytes.Length || stream.Read(bytes) != bytes.Length || !bytes.AsSpan().SequenceEqual(LockBytes)) throw new InvalidDataException("Application lock file is not owned by Potassium MCP.");
                return stream;
            }
            catch { stream.Dispose(); throw; }
        }
        catch (IOException error) { throw new IOException("Potassium MCP is in use, updating, or its application lock is unavailable. Close MCP sessions before installing, repairing or removing it.", error); }
    }

    public static byte[] ReadBounded(string path, int limit)
    {
        RejectLinks(path);
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length > limit) throw new InvalidDataException("Managed metadata exceeds its size limit.");
        var bytes = new byte[checked((int)input.Length)];
        input.ReadExactly(bytes);
        if (input.ReadByte() != -1) throw new IOException("Managed metadata changed while being read.");
        return bytes;
    }

    public static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    public static string FileHash(string path)
    {
        RejectLinks(path);
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length > BundleValidation.MaxFileBytes) throw new InvalidDataException("Managed file exceeds its size limit.");
        return BundleValidation.HashBounded(input, input.Length);
    }

    public static WindowsReceipt? ReadReceipt(string applicationRoot, string? installRoot = null)
    {
        var path = Path.Combine(applicationRoot, ReceiptName);
        RejectLinks(path);
        if (!File.Exists(path)) return null;
        var bytes = ReadBounded(path, 1024 * 1024);
        BundleValidation.RejectDuplicateProperties(bytes);
        WindowsReceipt receipt;
        try { receipt = JsonSerializer.Deserialize<WindowsReceipt>(bytes, BundleValidation.Json) ?? throw new InvalidDataException("Application receipt is missing."); }
        catch (JsonException error) { throw new InvalidDataException("Application receipt is invalid.", error); }
        if (receipt.Schema != 1 || string.IsNullOrWhiteSpace(receipt.ApplicationRoot) || !Path.IsPathFullyQualified(receipt.ApplicationRoot) || !SamePath(receipt.ApplicationRoot, applicationRoot)
            || string.IsNullOrWhiteSpace(receipt.InstallRoot) || !Path.IsPathFullyQualified(receipt.InstallRoot) || (installRoot is not null && !SamePath(receipt.InstallRoot, installRoot))
            || receipt.Bundles is null || receipt.Bundles.Count > 128 || receipt.LauncherHashes is null || receipt.LauncherHashes.Count > 128
            || receipt.LauncherHashes.Any(hash => !BundleValidation.IsSha256(hash))) throw new InvalidDataException("Application receipt binding is invalid or belongs to another private installation.");
        ValidateRoots(applicationRoot, receipt.InstallRoot, null);
        var locations = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var bundle in receipt.Bundles)
            if (bundle is null || !BundleValidation.IsSha256(bundle.VersionId) || string.IsNullOrWhiteSpace(bundle.Location) || !locations.Add(bundle.Location)
                || !(bundle.Location == "versions/" + bundle.VersionId || (bundle.Location.StartsWith("staging/", StringComparison.Ordinal) && Guid.TryParseExact(bundle.Location[8..], "N", out _)))) throw new InvalidDataException("Application receipt contains an invalid runtime location.");
        return receipt;
    }

    internal static WindowsReceipt CreateReceipt(string applicationRoot, string installRoot)
    {
        if (Directory.EnumerateFileSystemEntries(applicationRoot).Any(path => Path.GetFileName(path) != LockName)) throw new InvalidDataException("Application directory is not empty and has no ownership receipt. Existing files were left untouched.");
        var receipt = new WindowsReceipt(1, applicationRoot, installRoot, [], []);
        WriteReceipt(receipt, null);
        return receipt;
    }

    internal static void WriteReceipt(WindowsReceipt receipt, WindowsReceipt? previous)
    {
        if (receipt.Bundles.Count > 128 || receipt.LauncherHashes.Count > 128) throw new InvalidDataException("Application history is full; preserve it for verified cleanup.");
        var path = Path.Combine(receipt.ApplicationRoot, ReceiptName);
        var current = ReadReceipt(receipt.ApplicationRoot, receipt.InstallRoot);
        if (JsonSerializer.Serialize(current, BundleValidation.Json) != JsonSerializer.Serialize(previous, BundleValidation.Json)) throw new IOException("Application receipt changed during the operation.");
        AtomicWrite(path, JsonSerializer.SerializeToUtf8Bytes(receipt, BundleValidation.Json), previous is not null);
    }

    internal static void AtomicWrite(string path, byte[] bytes, bool replace)
    {
        RejectLinks(path);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".writing";
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { file.Write(bytes); file.Flush(true); }
            RejectLinks(path);
            File.Move(temporary, path, replace);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    internal static void AtomicCopy(string source, string destination, string expectedHash)
    {
        RejectLinks(source);
        RejectLinks(destination);
        var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".writing";
        try
        {
            using (var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                if (input.Length > BundleValidation.MaxFileBytes) throw new InvalidDataException("Launcher exceeds its size limit.");
                input.CopyTo(output, 64 * 1024);
                output.Flush(true);
            }
            if (FileHash(temporary) != expectedHash) throw new InvalidDataException("Launcher changed during publication.");
            RejectLinks(destination);
            File.Move(temporary, destination, File.Exists(destination));
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public static ConnectionInfo Connection(string applicationRoot)
    {
        var command = Path.Combine(applicationRoot, LauncherName);
        var json = JsonSerializer.Serialize(new { mcpServers = new { potassium = new { command, args = Array.Empty<string>() } } }, BundleValidation.Json);
        return new(command, Array.Empty<string>(), json, Path.Combine(applicationRoot, "connection.json"));
    }

    public static BundleManifest ReadBundle(string applicationRoot, InstalledBundle bundle)
    {
        var root = Path.Combine(applicationRoot, bundle.Location.Replace('/', Path.DirectorySeparatorChar));
        var bytes = ReadBounded(Path.Combine(root, ManifestName), BundleValidation.MaxManifestBytes);
        if (Hash(bytes) != bundle.VersionId) throw new InvalidDataException("Runtime manifest no longer matches its application receipt.");
        return BundleValidation.ParseManifest(bytes);
    }

    public static void RestoreEmptyVersionManifest(string applicationRoot, InstalledBundle version, byte[] manifestBytes)
    {
        var receipt = ReadReceipt(applicationRoot) ?? throw new InvalidDataException("Application ownership is required to restore a version.");
        if (!receipt.Bundles.Contains(version) || version.Location != "versions/" + version.VersionId || Hash(manifestBytes) != version.VersionId)
            throw new InvalidDataException("The missing version manifest is not bound to this exact owned bundle.");
        BundleValidation.ParseManifest(manifestBytes);
        var root = Path.Combine(applicationRoot, version.Location.Replace('/', Path.DirectorySeparatorChar));
        RejectLinks(root);
        if (!Directory.Exists(root) || Directory.EnumerateFileSystemEntries(root).Any())
            throw new InvalidDataException("A missing manifest can only be restored in an empty, receipt-owned version folder. Existing content was preserved.");
        AtomicWrite(Path.Combine(root, ManifestName), manifestBytes, false);
    }

    public static void VerifyDirectory(string root, BundleManifest manifest, bool allowMissing = false)
    {
        RejectLinks(root);
        var allowedFiles = manifest.Files.Select(file => file.Path).Append(ManifestName).ToHashSet(StringComparer.Ordinal);
        var allowedDirectories = new HashSet<string>(StringComparer.Ordinal);
        foreach (var path in allowedFiles)
        {
            var parent = path;
            while (parent.LastIndexOf('/') is var index && index >= 0) { parent = parent[..index]; allowedDirectories.Add(parent); }
        }
        var pending = new Stack<string>();
        pending.Push(root);
        var count = 0;
        while (pending.Count > 0)
        {
            foreach (var path in Directory.EnumerateFileSystemEntries(pending.Pop()))
            {
                if (++count > BundleValidation.MaxFiles * 8) throw new InvalidDataException("Runtime directory exceeds its traversal limit.");
                RejectLinks(path);
                var relative = Path.GetRelativePath(root, path).Replace('\\', '/');
                if (Directory.Exists(path)) { if (!allowedDirectories.Contains(relative)) throw new InvalidDataException("Runtime contains an unknown directory; nothing was replaced."); pending.Push(path); }
                else if (!allowedFiles.Contains(relative)) throw new InvalidDataException("Runtime contains an unknown file; nothing was replaced.");
            }
        }
        foreach (var file in manifest.Files)
        {
            var path = Path.Combine(root, file.Path.Replace('/', Path.DirectorySeparatorChar));
            RejectLinks(path);
            if (!File.Exists(path) && allowMissing) continue;
            if (!File.Exists(path) || new FileInfo(path).Length != file.Bytes || FileHash(path) != file.Sha256) throw new InvalidDataException("An immutable runtime file is missing or modified. Unknown edits were preserved.");
        }
    }

    public static VerifiedRuntime ResolveActive(string applicationRoot, WindowsReceipt receipt)
    {
        var stateBytes = ReadBounded(Path.Combine(receipt.InstallRoot, "ownership.json"), 8 * 1024 * 1024);
        BundleValidation.RejectDuplicateProperties(stateBytes);
        using var state = JsonDocument.Parse(stateBytes);
        var value = state.RootElement;
        var config = Path.Combine(receipt.InstallRoot, "config.json");
        if (value.GetProperty("schema").GetInt32() != 3 || value.GetProperty("status").GetString() != "active"
            || !SamePath(value.GetProperty("installRoot").GetString()!, receipt.InstallRoot) || !SamePath(value.GetProperty("configPath").GetString()!, config)) throw new InvalidDataException("No active schema-3 Potassium MCP installation is selected.");
        var workspace = CanonicalPath(value.GetProperty("workspaceRoot").GetString()!);
        ValidateRoots(applicationRoot, receipt.InstallRoot, workspace);
        var runtime = value.GetProperty("runtime");
        if (runtime.GetProperty("mode").GetString() != "external") throw new InvalidDataException("The selected runtime is not an external owned package.");
        var package = CanonicalPath(runtime.GetProperty("root").GetString()!);
        var record = receipt.Bundles.SingleOrDefault(bundle => bundle.Location.StartsWith("versions/", StringComparison.Ordinal)
            && SamePath(Path.Combine(applicationRoot, bundle.Location.Replace('/', Path.DirectorySeparatorChar), BundleValidation.RequiredEntries.PackageRoot.Replace('/', Path.DirectorySeparatorChar)), package))
            ?? throw new InvalidDataException("The selected runtime is outside the application receipt.");
        var versionRoot = Path.Combine(applicationRoot, record.Location.Replace('/', Path.DirectorySeparatorChar));
        var manifest = ReadBundle(applicationRoot, record);
        VerifyDirectory(versionRoot, manifest);
        var node = Path.Combine(versionRoot, manifest.Entries.Node.Replace('/', Path.DirectorySeparatorChar));
        if (!SamePath(runtime.GetProperty("nodeExecutable").GetString()!, node) || runtime.GetProperty("nodeSha256").GetString() != manifest.Files.Single(file => file.Path == manifest.Entries.Node).Sha256
            || value.GetProperty("serverSha256").GetString() != manifest.Files.Single(file => file.Path == manifest.Entries.PackageRoot + "/src/proxy.js").Sha256
            || Hash(ReadBounded(config, 8 * 1024 * 1024)) != value.GetProperty("configSha256").GetString()) throw new InvalidDataException("Runtime or configuration ownership has changed. Run verified repair.");
        using var metadata = JsonDocument.Parse(ReadBounded(Path.Combine(package, "package.json"), 1024 * 1024));
        if (metadata.RootElement.GetProperty("name").GetString() != "@mrketa/potassium-mcp" || metadata.RootElement.GetProperty("version").GetString() != manifest.PackageVersion
            || metadata.RootElement.GetProperty("potassiumMcpRuntime").GetProperty("ownershipSchema").GetInt32() != 3
            || metadata.RootElement.GetProperty("potassiumMcpRuntime").GetProperty("launcherProtocol").GetInt32() != 1) throw new InvalidDataException("The bundled package does not support the public launcher contract.");
        VerifyConnector(applicationRoot, receipt);
        return new(versionRoot, package, node, Path.Combine(versionRoot, manifest.Entries.Cli.Replace('/', Path.DirectorySeparatorChar)), config, workspace, manifest);
    }

    public static void VerifyConnector(string applicationRoot, WindowsReceipt receipt)
    {
        if (!receipt.LauncherHashes.Contains(FileHash(Path.Combine(applicationRoot, LauncherName)), StringComparer.Ordinal)) throw new InvalidDataException("The stable launcher is not owned by this installation.");
        var connection = Connection(applicationRoot);
        if (!ReadBounded(connection.FilePath, 65536).AsSpan().SequenceEqual(Encoding.UTF8.GetBytes(connection.Json))) throw new InvalidDataException("Connection configuration has unknown edits; it was left untouched.");
    }

    public static ProcessStartInfo StartInfo(string executable, string workingDirectory)
    {
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = workingDirectory };
        var inherited = start.Environment.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase);
        start.Environment.Clear();
        foreach (var key in new[] { "SystemRoot", "WINDIR", "ComSpec", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "PATH", "PATHEXT", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PROGRAMDATA", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS" })
            if (inherited.TryGetValue(key, out var value) && value is not null) start.Environment[key] = value;
        start.Environment["USERNAME"] = Environment.UserName;
        start.Environment["USERDOMAIN"] = Environment.UserDomainName;
        return start;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    public static void PreventStandardHandleInheritance()
    {
        if (!OperatingSystem.IsWindows()) return;
        // Process.Start creates dedicated redirected child handles. Our inherited upstream
        // pipe writers must not also escape into the child and its long-lived broker.
        for (var standardHandle = -10; standardHandle >= -12; standardHandle--)
        {
            var handle = GetStdHandle(standardHandle);
            if (handle == IntPtr.Zero || handle == new IntPtr(-1)) continue;
            if (!SetHandleInformation(handle, 1, 0))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Could not isolate the runtime's inherited standard handles.");
        }
    }

    public static async Task<string> ReadOutputBoundedAsync(StreamReader reader, int limit = 1024 * 1024)
    {
        var text = new StringBuilder(Math.Min(limit, 4096));
        var buffer = new char[4096];
        int count;
        var truncated = false;
        while ((count = await reader.ReadAsync(buffer)) > 0)
        {
            var available = Math.Min(count, Math.Max(0, limit - text.Length));
            text.Append(buffer, 0, available);
            truncated |= available != count;
        }
        if (truncated) text.Append("\n[Output exceeded the bounded capture limit.]");
        return text.ToString();
    }
}
