using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;

namespace PotassiumMcp.ParserHost;

internal sealed class Workspace : IDisposable
{
    private const string Owner = "PotassiumMcp.ParserHost/1";
    private readonly string userSid = WindowsIdentity.GetCurrent().User?.Value ?? throw new IOException("Parser host user identity is unavailable");
    private readonly string directory;
    private readonly string profile;
    private readonly FileStream lease;
    private bool profileOwned;
    private bool disposed;
    internal string Runtime { get; }
    internal IntPtr Sid { get; private set; }
    internal string? CleanupError { get; private set; }

    internal Workspace()
    {
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PotassiumMcp.ParserSandbox");
        AssertPlainAncestors(Path.GetDirectoryName(root)!);
        PrivateDirectory(root, userSid, allowExisting: true);
        AssertPrivateOwner(root, userSid);
        using var allocationLease = LockAllocation(root);
        Recover(root, userSid);
        var id = Guid.NewGuid().ToString("N");
        directory = Path.Combine(root, id);
        PrivateDirectory(directory, userSid, allowExisting: false);
        Runtime = Path.Combine(directory, "runtime");
        profile = ProfileName(userSid, id);
        lease = new FileStream(Path.Combine(directory, "lease"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        try
        {
            // The private, unguessable creation intent owns this exact name even if the
            // host dies between CreateAppContainerProfile and recording its result.
            SaveReceipt("creating");
            var result = Native.CreateAppContainerProfile(profile, profile, Owner, IntPtr.Zero, 0, out var sid);
            if (result < 0)
            {
                SaveReceipt("not-owned");
                Marshal.ThrowExceptionForHR(result);
            }
            Sid = sid;
            profileOwned = true;
            SaveReceipt("created");
            PrivateDirectory(Runtime, userSid, allowExisting: false);
        }
        catch { Dispose(); throw; }
    }

    // 62 characters, below CreateAppContainerProfile's 64-character ceiling.
    private static string ProfileName(string sid, string id) => "Potassium.Parser." + Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(sid)))[..12].ToLowerInvariant() + "." + id;
    private void SaveReceipt(string state)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { owner = Owner, schema = 1, userSid, id = Path.GetFileName(directory), profile, state });
        var temporary = Path.Combine(directory, "receipt.next");
        using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        { file.Write(bytes); file.Flush(true); }
        File.Move(temporary, Path.Combine(directory, "receipt.json"), true);
    }

    internal static void AssertPlainAncestors(string path)
    {
        var current = Path.GetFullPath(path);
        while (!string.IsNullOrEmpty(current))
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("Parser runtime path contains a reparse point");
            current = Path.GetDirectoryName(current);
        }
    }

    private static void PrivateDirectory(string path, string userSid, bool allowExisting)
    {
        Native.Check(Native.ConvertStringSecurityDescriptorToSecurityDescriptor($"O:{userSid}D:P(A;OICI;FA;;;{userSid})(A;OICI;FA;;;SY)", 1, out var descriptor, out _), "Create private directory security");
        try
        {
            var attributes = new Native.SecurityAttributes { Length = Marshal.SizeOf<Native.SecurityAttributes>(), Descriptor = descriptor };
            if (!Native.CreateDirectory(path, ref attributes))
            {
                var error = Marshal.GetLastWin32Error();
                if (!allowExisting || error != 183) throw new System.ComponentModel.Win32Exception(error, "Create private parser directory");
            }
            AssertPlainAncestors(path);
        }
        finally { Native.LocalFree(descriptor); }
    }

    private static void AssertPrivateOwner(string path, string sid)
    {
        AssertPlainAncestors(path);
        var security = new DirectoryInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        if (security.GetOwner(typeof(SecurityIdentifier))?.Value != sid || !security.AreAccessRulesProtected) throw new IOException("Parser workspace ownership is invalid");
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            if (rule.AccessControlType != AccessControlType.Allow || rule.IdentityReference.Value != sid && rule.IdentityReference.Value != "S-1-5-18") throw new IOException("Parser workspace access list is invalid");
    }

    private static FileStream LockAllocation(string root)
    {
        var filename = Path.Combine(root, "allocation.lock");
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                if (File.Exists(filename)) AssertPlainAncestors(filename);
                return new FileStream(filename, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            }
            catch (IOException) when (attempt < 200) { Thread.Sleep(25); }
        }
    }

    private static void Recover(string root, string sid)
    {
        // Bound recovery work; unknown entries and active leases are never touched.
        foreach (var entry in Directory.EnumerateDirectories(root).Take(128))
        {
            var id = Path.GetFileName(entry);
            if (id.Length != 32 || id.Any(c => !char.IsAsciiHexDigit(c))) continue;
            try
            {
                AssertPrivateOwner(entry, sid);
                var receiptPath = Path.Combine(entry, "receipt.json");
                var leasePath = Path.Combine(entry, "lease");
                if (!File.Exists(receiptPath))
                {
                    // The allocation lock excludes a constructor still creating its
                    // receipt. No profile exists before receipt.json is committed.
                    if (Directory.EnumerateFileSystemEntries(entry).All(file => Path.GetFileName(file) is "lease" or "receipt.next"))
                    {
                        using (var locked = new FileStream(leasePath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) { }
                        DeleteOwnedTree(entry);
                    }
                    continue;
                }
                if (!File.Exists(leasePath)) continue;
                AssertPlainAncestors(receiptPath); AssertPlainAncestors(leasePath);
                using (var locked = new FileStream(leasePath, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                {
                    if (new FileInfo(receiptPath).Length > 4096) continue;
                    using var receipt = JsonDocument.Parse(File.ReadAllBytes(receiptPath));
                    var value = receipt.RootElement;
                    var name = ProfileName(sid, id);
                    if (value.GetProperty("owner").GetString() != Owner || value.GetProperty("schema").GetInt32() != 1 || value.GetProperty("userSid").GetString() != sid || value.GetProperty("id").GetString() != id || value.GetProperty("profile").GetString() != name) continue;
                    if (value.GetProperty("state").GetString() is "creating" or "created") DeleteProfile(name);
                }
                DeleteOwnedTree(entry);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or KeyNotFoundException or InvalidOperationException or System.ComponentModel.Win32Exception) { }
        }
    }

    internal void Stage(string packageRoot)
    {
        AssertPlainAncestors(packageRoot);
        var manifestFile = Path.Combine(AppContext.BaseDirectory, "parser-host-manifest.json");
        AssertPlainAncestors(manifestFile);
        if (new FileInfo(manifestFile).Length > 65536) throw new IOException("Parser runtime seal exceeds its limit");
        using var manifest = JsonDocument.Parse(File.ReadAllBytes(manifestFile));
        if (manifest.RootElement.GetProperty("schema").GetInt32() != 1) throw new IOException("Parser runtime seal is unsupported");
        var seals = manifest.RootElement.GetProperty("runtime");
        const string relative = "assets/native-parser/win32-x64/PotassiumMcp.LuauParser.exe";
        var expected = seals.GetProperty(relative).GetString();
        if (expected == null || expected.Length != 64 || expected.Any(character => !char.IsAsciiHexDigit(character))) throw new IOException("Parser runtime seal is invalid");
        CopyFile(Path.Combine(packageRoot, relative), Path.Combine(Runtime, "PotassiumMcp.LuauParser.exe"), expected, 16 * 1024 * 1024);
        // Grant only the newly created profile read/execute on this owned runtime.
        // No ACL of a user directory, package installation, or source root changes.
        var acl = new DirectorySecurity();
        acl.SetOwner(new SecurityIdentifier(userSid)); acl.SetAccessRuleProtection(true, false);
        foreach (var principal in new[] { userSid, "S-1-5-18" }) acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(principal), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(Sid), FileSystemRights.ReadAndExecute, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(Runtime).SetAccessControl(acl);
    }

    private static void CopyFile(string source, string destination, string expected, long ceiling)
    {
        AssertPlainAncestors(source);
        using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length < 1 || input.Length > ceiling) throw new IOException("Parser runtime file size is invalid");
        using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[65536]; long bytes = 0; int count;
        while ((count = input.Read(buffer)) != 0) { bytes += count; if (bytes > ceiling) throw new IOException("Parser runtime file size is invalid"); hash.AppendData(buffer, 0, count); output.Write(buffer, 0, count); }
        if (!string.Equals(Convert.ToHexString(hash.GetHashAndReset()), expected, StringComparison.OrdinalIgnoreCase)) throw new IOException("Parser runtime seal mismatch: " + Path.GetFileName(source));
    }

    private static void DeleteProfile(string name)
    {
        var result = Native.DeleteAppContainerProfile(name);
        if (result < 0 && result != unchecked((int)0x80070002) && result != unchecked((int)0x80070003)) Marshal.ThrowExceptionForHR(result);
    }

    private static void DeleteOwnedTree(string directory)
    {
        AssertPlainAncestors(directory);
        // Keep recovery identity until every runtime entry has been removed.
        // Receipt is removed before lease so an interrupted final cleanup is
        // recognized as a pre-profile/empty lease by Recover.
        foreach (var child in Directory.EnumerateFileSystemEntries(directory).OrderBy(child => Path.GetFileName(child) switch { "receipt.json" => 1, "lease" => 2, _ => 0 }))
        {
            var attributes = File.GetAttributes(child);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Parser cleanup encountered a reparse point");
            if ((attributes & FileAttributes.Directory) != 0) DeleteOwnedTree(child); else File.Delete(child);
        }
        Directory.Delete(directory);
    }

    public void Dispose()
    {
        if (disposed) return; disposed = true;
        if (Sid != IntPtr.Zero) { Native.FreeSid(Sid); Sid = IntPtr.Zero; }
        try { if (profileOwned) DeleteProfile(profile); }
        catch (Exception error) { CleanupError = error.GetType().Name + ": profile cleanup failed"; }
        lease.Dispose();
        if (CleanupError == null)
        {
            try { DeleteOwnedTree(directory); }
            catch (Exception error) { CleanupError = error.GetType().Name + ": runtime cleanup failed"; }
        }
    }
}
