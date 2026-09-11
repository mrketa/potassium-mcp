using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace PotassiumMcp.Setup;

public sealed record SetupOptions(string ApplicationRoot, string InstallRoot, string? WorkspaceRoot = null)
{
    public static SetupOptions Parse(string[] args)
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var app = Path.Combine(local, "Programs", "Potassium MCP");
        var install = Path.Combine(local, "Potassium", "MCP");
        string? workspace = null;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var index = 0; index < args.Length; index++)
        {
            var key = args[index];
            if (key is not ("--app-root" or "--install-root" or "--workspace") || !seen.Add(key) || ++index >= args.Length || string.IsNullOrWhiteSpace(args[index]) || args[index].StartsWith("--", StringComparison.Ordinal))
                throw new ArgumentException("Supported setup options: --app-root <directory>, --install-root <directory>, --workspace <directory>.");
            var path = WindowsInstallation.CanonicalPath(args[index]);
            switch (key) { case "--app-root": app = path; break; case "--install-root": install = path; break; case "--workspace": workspace = path; break; }
        }
        app = WindowsInstallation.CanonicalPath(app);
        install = WindowsInstallation.CanonicalPath(install);
        workspace ??= PotassiumPathDiscoveryService.FromOwnership(install);
        WindowsInstallation.ValidateRoots(app, install, workspace);
        return new(app, install, workspace);
    }
}

public sealed record CliRequest(string Command, string? WorkspaceRoot, string InstallRoot, string ApplicationRoot);
public sealed record CliResult(bool Ok, string Summary, string Details, ConnectionInfo? Connection = null, bool CleanupPending = false, bool RestartRequired = false, bool? McpConnected = null, bool? ExecutorConnected = null);
public sealed record InstallationState(bool Installed, string Summary, ConnectionInfo? Connection = null);

public static class CliArguments
{
    public static IReadOnlyList<string> Build(CliRequest request, string runtimeRoot, bool addReadIdentity)
    {
        var command = request.Command.ToLowerInvariant();
        if (command is not ("install" or "repair" or "uninstall")) throw new ArgumentException("Unsupported setup command.");
        var arguments = new List<string> { command == "install" ? "setup" : command, "--json", "--install-root", request.InstallRoot };
        if (command == "uninstall") { arguments.Add("--all"); return arguments; }
        ArgumentException.ThrowIfNullOrWhiteSpace(request.WorkspaceRoot);
        arguments.AddRange(["--workspace", request.WorkspaceRoot, "--runtime-root", runtimeRoot, "--initial-full-access-host", "agent"]);
        if (addReadIdentity) arguments.AddRange(["--read-host", "agent"]);
        return arguments;
    }

    public static bool NeedsReadIdentity(string installRoot)
    {
        // Recovery may restore a different policy; only core setup decides fresh initialization.
        var journal = installRoot + ".transaction.json";
        WindowsInstallation.RejectLinks(journal);
        if (File.Exists(journal)) return false;
        var path = Path.Combine(installRoot, "config.json");
        WindowsInstallation.RejectLinks(path);
        if (!File.Exists(path)) return false;
        var bytes = WindowsInstallation.ReadBounded(path, 8 * 1024 * 1024);
        BundleValidation.RejectDuplicateProperties(bytes);
        using var config = JsonDocument.Parse(bytes);
        if (!config.RootElement.TryGetProperty("hostPolicies", out var policies)) return true;
        if (policies.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Existing access policies are invalid; they were not reset.");
        return !policies.TryGetProperty("agent", out _);
    }
}

public static class PotassiumPathDiscoveryService
{
    public static string? FromOwnership(string installRoot)
    {
        var path = Path.Combine(installRoot, "ownership.json");
        WindowsInstallation.RejectLinks(path);
        if (!File.Exists(path)) return null;
        var bytes = WindowsInstallation.ReadBounded(path, 8 * 1024 * 1024);
        BundleValidation.RejectDuplicateProperties(bytes);
        using var state = JsonDocument.Parse(bytes);
        var root = state.RootElement;
        if (!root.TryGetProperty("schema", out var schema) || schema.GetInt32() is not (2 or 3)
            || !root.TryGetProperty("installRoot", out var ownedRoot) || !WindowsInstallation.SamePath(ownedRoot.GetString()!, installRoot)
            || !root.TryGetProperty("workspaceRoot", out var workspace) || !Path.IsPathFullyQualified(workspace.GetString() ?? "")) throw new InvalidDataException("Existing private ownership metadata is invalid; choose verified recovery rather than replacing it.");
        return WindowsInstallation.CanonicalPath(workspace.GetString()!);
    }

    public static string? Discover(string localAppData)
    {
        var root = Path.Combine(localAppData, "Potassium");
        var owned = FromOwnership(Path.Combine(root, "MCP"));
        if (owned is not null) return owned;
        var candidates = new[] { Path.Combine(root, "workspace"), Path.Combine(root, "data") }.Where(Directory.Exists).ToArray();
        return candidates.Length == 1 ? WindowsInstallation.CanonicalPath(candidates[0]) : null;
    }
}

public static class UserFacingText
{
    private static readonly Regex Secret = new(@"(?i)([""']?(?:token|secret|password|authorization)[""']?\s*[:=]\s*)[""']?[^""'\s,;}]+[""']?", RegexOptions.Compiled);
    private static readonly Regex WindowsPath = new("(?i)[a-z]:\\\\[^\\r\\n\\\"']+", RegexOptions.Compiled);
    private static readonly Regex HomePath = new("(?i)(/home|/users)/[^\\s\\\"']+", RegexOptions.Compiled);

    public static CliResult Render(string stdout, string stderr, int exitCode)
    {
        try
        {
            using var json = JsonDocument.Parse(stdout);
            var root = json.RootElement;
            var ok = exitCode == 0 && (!root.TryGetProperty("ok", out var value) || value.ValueKind != JsonValueKind.False);
            var summary = new[] { "message", "summary", "status" }.Select(name => root.TryGetProperty(name, out var item) && item.ValueKind == JsonValueKind.String ? item.GetString() : null).FirstOrDefault(item => !string.IsNullOrWhiteSpace(item)) ?? (ok ? "Finished." : "Setup could not finish.");
            return new(ok, Redact(summary), Redact(root.GetRawText()),
                CleanupPending: root.TryGetProperty("cleanupPending", out var cleanup) && cleanup.ValueKind == JsonValueKind.True,
                RestartRequired: root.TryGetProperty("restartRequired", out var restart) && restart.ValueKind == JsonValueKind.True);
        }
        catch (JsonException) { return new(false, "The setup command did not return a complete result.", Redact(string.IsNullOrWhiteSpace(stdout) ? stderr : stdout)); }
    }

    public static string Redact(string value) => HomePath.Replace(WindowsPath.Replace(Secret.Replace(value ?? "", "$1\"[hidden]\""), "[path]"), "[path]");
}

public static class LegalNotices
{
    public static string ApacheLicense()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("PotassiumMcp.Setup.assets.Potassium-LICENSE.txt") ?? throw new InvalidOperationException("The Potassium MCP license is unavailable.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
    public const string NodeAttribution = "This installer includes Node.js (MIT License) and a dedicated .NET launcher. Their exact licenses and third-party notices are retained in the verified, versioned application directory. Node.js runs the local public Potassium MCP command; no separate Node installation is required.";
}

public sealed class SetupRunner
{
    private readonly Assembly assembly;
    public SetupRunner(Assembly? assembly = null) => this.assembly = assembly ?? Assembly.GetExecutingAssembly();
    public string? DiscoverWorkspace() => PotassiumPathDiscoveryService.Discover(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));

    public InstallationState GetInstallationState(SetupOptions options)
    {
        try
        {
            WindowsInstallation.RejectLinks(options.ApplicationRoot);
            if (!Directory.Exists(options.ApplicationRoot) && !File.Exists(options.ApplicationRoot))
                return new(false, "Potassium MCP has not been installed here.");
            using var lease = WindowsInstallation.AcquireLock(options.ApplicationRoot, false);
            var receipt = WindowsInstallation.ReadReceipt(options.ApplicationRoot, options.InstallRoot);
            if (receipt is null) return new(false, "Potassium MCP has not been installed here.");
            WindowsInstallation.ResolveActive(options.ApplicationRoot, receipt);
            return new(true, "Installed. Use Check connection to test MCP and executor availability separately.", WindowsInstallation.Connection(options.ApplicationRoot));
        }
        catch (Exception error) when (ManagedError(error)) { return new(false, UserFacingText.Redact(error.Message)); }
    }

    public string VerifyEmbeddedBundle()
    {
        using var bundle = OpenBundle();
        return JsonSerializer.Serialize(new { valid = true, versionId = bundle.Id, zipSha256 = bundle.ZipHash, files = bundle.Manifest.Files.Count, packageVersion = bundle.Manifest.PackageVersion, nodeVersion = bundle.Manifest.NodeVersion });
    }

    public Task<CliResult> RunAsync(CliRequest request, IProgress<string>? progress = null) => Task.Run(async () =>
    {
        try
        {
            request = request with { Command = request.Command.ToLowerInvariant(), ApplicationRoot = WindowsInstallation.CanonicalPath(request.ApplicationRoot), InstallRoot = WindowsInstallation.CanonicalPath(request.InstallRoot), WorkspaceRoot = request.WorkspaceRoot is null ? null : WindowsInstallation.CanonicalPath(request.WorkspaceRoot) };
            if (request.Command is not ("install" or "repair" or "uninstall" or "check")) throw new ArgumentException("Unsupported setup action.");
            WindowsInstallation.ValidateRoots(request.ApplicationRoot, request.InstallRoot, request.WorkspaceRoot);
            if (request.Command == "check") return await CheckAsync(request, progress);
            using var lease = WindowsInstallation.AcquireLock(request.ApplicationRoot, true);
            var receipt = WindowsInstallation.ReadReceipt(request.ApplicationRoot, request.InstallRoot);
            if (request.Command == "uninstall")
            {
                if (receipt is null) throw new InvalidDataException("No owned application installation was found. Existing files were left untouched.");
                return await UninstallAsync(request, receipt, progress);
            }
            var workspace = request.WorkspaceRoot ?? PotassiumPathDiscoveryService.FromOwnership(request.InstallRoot) ?? DiscoverWorkspace();
            if (workspace is null || !Directory.Exists(workspace)) throw new InvalidDataException("Choose an existing Potassium workspace before installing or repairing.");
            request = request with { WorkspaceRoot = workspace };
            WindowsInstallation.ValidateRoots(request.ApplicationRoot, request.InstallRoot, workspace);
            progress?.Report("Verifying the bundled Node runtime and package…");
            using var bundle = OpenBundle();
            receipt ??= WindowsInstallation.CreateReceipt(request.ApplicationRoot, request.InstallRoot);
            var provisioned = Provision(request.ApplicationRoot, receipt, bundle, progress);
            receipt = provisioned.Receipt;
            var root = Path.Combine(request.ApplicationRoot, "versions", bundle.Id);
            var runtimeRoot = Path.Combine(root, bundle.Manifest.Entries.PackageRoot.Replace('/', Path.DirectorySeparatorChar));
            var node = Path.Combine(root, bundle.Manifest.Entries.Node.Replace('/', Path.DirectorySeparatorChar));
            var cli = Path.Combine(root, bundle.Manifest.Entries.Cli.Replace('/', Path.DirectorySeparatorChar));
            var command = request.Command == "repair" && !File.Exists(Path.Combine(request.InstallRoot, "ownership.json")) ? "install" : request.Command;
            progress?.Report("Configuring the durable runtime and preserving existing access settings…");
            var result = await RunCli(node, cli, root, CliArguments.Build(request with { Command = command }, runtimeRoot, CliArguments.NeedsReadIdentity(request.InstallRoot)));
            var cleanupPending = result.CleanupPending || provisioned.CleanupPending;
            if (!result.Ok) return result with { Summary = "Setup did not finish. Verified application files were retained for repair; no previous runtime was deleted.", CleanupPending = cleanupPending };
            if (result.CleanupPending) return result with { Summary = "Configuration was committed, but recovery cleanup is still required. Run Repair before connecting.", Connection = null, CleanupPending = true };
            WindowsInstallation.ResolveActive(request.ApplicationRoot, receipt);
            return result with { Summary = request.Command == "repair" ? "Potassium MCP was repaired." : "Potassium MCP was installed.", Details = result.Details + "\nThe connection uses one durable local launcher. Fresh setup grants the agent read, admin, and execute access. Existing access settings were preserved. Executor availability has not been checked. Autoexec is derived from the workspace parent." + (provisioned.CleanupPending ? "\nUnrecognized or incomplete staging content was preserved; cleanup is pending." : ""), Connection = cleanupPending ? null : WindowsInstallation.Connection(request.ApplicationRoot), CleanupPending = cleanupPending };
        }
        catch (Exception error) when (ManagedError(error)) { return new CliResult(false, "The operation could not finish safely.", UserFacingText.Redact(error.Message)); }
    });

    private static bool ManagedError(Exception error) => error is InvalidDataException or IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException or FormatException or JsonException or KeyNotFoundException or System.ComponentModel.Win32Exception or NotSupportedException or OverflowException;

    private sealed class EmbeddedBundle : IDisposable
    {
        public byte[] ManifestBytes { get; }
        public BundleManifest Manifest { get; }
        public string Id { get; }
        public string ZipHash { get; }
        public ZipArchive Archive { get; }
        public EmbeddedBundle(byte[] manifestBytes, Stream zip)
        {
            ManifestBytes = manifestBytes;
            Manifest = BundleValidation.ParseManifest(manifestBytes);
            Id = WindowsInstallation.Hash(manifestBytes);
            try
            {
                if (!zip.CanSeek || zip.Length > BundleValidation.MaxTotalBytes + 64 * 1024 * 1024) throw new InvalidDataException("Bundled archive is not bounded and seekable.");
                ZipHash = BundleValidation.HashBounded(zip, zip.Length);
                zip.Position = 0;
                Archive = new ZipArchive(zip, ZipArchiveMode.Read);
                BundleValidation.Verify(Archive, Manifest);
            }
            catch { zip.Dispose(); throw; }
        }
        public void Dispose() => Archive.Dispose();
    }

    private EmbeddedBundle OpenBundle()
    {
        using var manifest = assembly.GetManifestResourceStream("PotassiumMcp.Setup.runtime-bundle.manifest.json") ?? throw new InvalidDataException("This Setup.exe has no verified runtime manifest.");
        if (manifest.Length > BundleValidation.MaxManifestBytes) throw new InvalidDataException("Bundled manifest exceeds its size limit.");
        var bytes = new byte[checked((int)manifest.Length)];
        manifest.ReadExactly(bytes);
        var zip = assembly.GetManifestResourceStream("PotassiumMcp.Setup.runtime-bundle.zip") ?? throw new InvalidDataException("This Setup.exe has no bundled runtime.");
        return new(bytes, zip);
    }

    private static (WindowsReceipt Receipt, bool CleanupPending) Provision(string applicationRoot, WindowsReceipt receipt, EmbeddedBundle bundle, IProgress<string>? progress)
    {
        var cleanupPending = false;
        foreach (var staged in receipt.Bundles.Where(record => record.Location.StartsWith("staging/", StringComparison.Ordinal)).ToArray())
        {
            cleanupPending |= !RemoveBundle(applicationRoot, staged);
            if (!Directory.Exists(Path.Combine(applicationRoot, staged.Location.Replace('/', Path.DirectorySeparatorChar))))
            {
                var next = receipt with { Bundles = receipt.Bundles.Where(record => record != staged).ToArray() };
                WindowsInstallation.WriteReceipt(next, receipt);
                receipt = next;
            }
        }
        var version = new InstalledBundle(bundle.Id, "versions/" + bundle.Id);
        var versionRoot = Path.Combine(applicationRoot, "versions", bundle.Id);
        if (Directory.Exists(versionRoot))
        {
            if (!receipt.Bundles.Contains(version)) throw new InvalidDataException("The target version already exists without ownership. It was not adopted.");
            if (!File.Exists(Path.Combine(versionRoot, WindowsInstallation.ManifestName)))
                WindowsInstallation.RestoreEmptyVersionManifest(applicationRoot, version, bundle.ManifestBytes);
            WindowsInstallation.ReadBundle(applicationRoot, version);
            WindowsInstallation.VerifyDirectory(versionRoot, bundle.Manifest, allowMissing: true);
            ExtractMissing(versionRoot, bundle);
        }
        else
        {
            var staging = new InstalledBundle(bundle.Id, "staging/" + Guid.NewGuid().ToString("N"));
            var stageRoot = Path.Combine(applicationRoot, staging.Location.Replace('/', Path.DirectorySeparatorChar));
            WindowsInstallation.RejectLinks(stageRoot);
            Directory.CreateDirectory(stageRoot);
            WindowsInstallation.AtomicWrite(Path.Combine(stageRoot, WindowsInstallation.ManifestName), bundle.ManifestBytes, false);
            var next = receipt with { Bundles = receipt.Bundles.Append(staging).ToArray() };
            WindowsInstallation.WriteReceipt(next, receipt);
            receipt = next;
            progress?.Report("Provisioning an immutable application version…");
            ExtractMissing(stageRoot, bundle);
            WindowsInstallation.VerifyDirectory(stageRoot, bundle.Manifest);
            WindowsInstallation.RejectLinks(versionRoot);
            Directory.CreateDirectory(Path.GetDirectoryName(versionRoot)!);
            next = receipt with { Bundles = receipt.Bundles.Contains(version) ? receipt.Bundles : receipt.Bundles.Append(version).ToArray() };
            WindowsInstallation.WriteReceipt(next, receipt);
            receipt = next;
            Directory.Move(stageRoot, versionRoot);
            next = receipt with { Bundles = receipt.Bundles.Where(record => record != staging).ToArray() };
            WindowsInstallation.WriteReceipt(next, receipt);
            receipt = next;
        }
        WindowsInstallation.VerifyDirectory(versionRoot, bundle.Manifest);
        var launcherSource = Path.Combine(versionRoot, bundle.Manifest.Entries.Launcher.Replace('/', Path.DirectorySeparatorChar));
        var launcher = Path.Combine(applicationRoot, WindowsInstallation.LauncherName);
        var launcherHash = bundle.Manifest.Files.Single(file => file.Path == bundle.Manifest.Entries.Launcher).Sha256;
        WindowsInstallation.RejectLinks(launcher);
        if (File.Exists(launcher) && !receipt.LauncherHashes.Contains(WindowsInstallation.FileHash(launcher))) throw new InvalidDataException("The stable launcher has unknown edits and was not overwritten.");
        if (!receipt.LauncherHashes.Contains(launcherHash))
        {
            var next = receipt with { LauncherHashes = receipt.LauncherHashes.Append(launcherHash).ToArray() };
            WindowsInstallation.WriteReceipt(next, receipt);
            receipt = next;
        }
        if (!File.Exists(launcher) || WindowsInstallation.FileHash(launcher) != launcherHash)
            WindowsInstallation.AtomicCopy(launcherSource, launcher, launcherHash);
        var connection = WindowsInstallation.Connection(applicationRoot);
        var connectionBytes = Encoding.UTF8.GetBytes(connection.Json);
        WindowsInstallation.RejectLinks(connection.FilePath);
        if (File.Exists(connection.FilePath))
        {
            if (!WindowsInstallation.ReadBounded(connection.FilePath, 65536).AsSpan().SequenceEqual(connectionBytes)) throw new InvalidDataException("The connection file has unknown edits and was not overwritten.");
        }
        else WindowsInstallation.AtomicWrite(connection.FilePath, connectionBytes, false);
        return (receipt, cleanupPending);
    }

    private static void ExtractMissing(string root, EmbeddedBundle bundle)
    {
        var buffer = new byte[64 * 1024];
        foreach (var file in bundle.Manifest.Files)
        {
            var target = Path.Combine(root, file.Path.Replace('/', Path.DirectorySeparatorChar));
            WindowsInstallation.RejectLinks(target);
            if (File.Exists(target)) continue;
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            using var source = bundle.Archive.GetEntry(file.Path)!.Open();
            using var destination = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            long written = 0;
            int count;
            while ((count = source.Read(buffer)) > 0)
            {
                written += count;
                if (written > file.Bytes) throw new InvalidDataException("Bundled file exceeded its declared size during extraction.");
                destination.Write(buffer, 0, count);
            }
            if (written != file.Bytes) throw new InvalidDataException("Bundled file was truncated during extraction.");
            destination.Flush(true);
        }
    }

    private static async Task<CliResult> RunCli(string node, string cli, string workingDirectory, IReadOnlyList<string> args)
    {
        var start = WindowsInstallation.StartInfo(node, workingDirectory);
        start.RedirectStandardOutput = start.RedirectStandardError = true;
        start.RedirectStandardInput = true;
        start.ArgumentList.Add(cli);
        foreach (var argument in args) start.ArgumentList.Add(argument);
        WindowsInstallation.PreventStandardHandleInheritance();
        using var process = Process.Start(start) ?? throw new IOException("The public setup command could not be started.");
        process.StandardInput.Close();
        var output = WindowsInstallation.ReadOutputBoundedAsync(process.StandardOutput);
        var error = WindowsInstallation.ReadOutputBoundedAsync(process.StandardError);
        await process.WaitForExitAsync();
        return UserFacingText.Render(await output, await error, process.ExitCode);
    }

    private static async Task<CliResult> UninstallAsync(CliRequest request, WindowsReceipt receipt, IProgress<string>? progress)
    {
        if (CoreRecoveryExists(receipt.InstallRoot)) return RecoveryPending("Private transaction recovery is pending. Run Repair before removing application files.");
        var statePath = Path.Combine(receipt.InstallRoot, "ownership.json");
        WindowsInstallation.RejectLinks(statePath);
        if (Directory.Exists(statePath)) throw new InvalidDataException("Private ownership is not a regular metadata file.");
        byte[]? expectedState = File.Exists(statePath) ? WindowsInstallation.ReadBounded(statePath, 8 * 1024 * 1024) : null;
        CliResult result;
        if (expectedState is not null)
        {
            BundleValidation.RejectDuplicateProperties(expectedState);
            var expected = JsonNode.Parse(expectedState) as JsonObject ?? throw new InvalidDataException("Private ownership metadata is invalid.");
            if (expected["schema"]?.GetValue<int>() != 3 || !WindowsInstallation.SamePath(expected["installRoot"]?.GetValue<string>() ?? "", receipt.InstallRoot)) throw new InvalidDataException("Private ownership does not match this application.");
            var status = expected["status"]?.GetValue<string>();
            if (status is not ("active" or "retained")) throw new InvalidDataException("Private ownership has an unknown deployment status.");
            if (status == "active") WindowsInstallation.ResolveActive(request.ApplicationRoot, receipt);
            var runtime = FindCleanupRuntime(receipt);
            if (runtime is null)
            {
                if (status == "retained" && receipt.Bundles.All(record => !Directory.Exists(Path.Combine(receipt.ApplicationRoot, record.Location.Replace('/', Path.DirectorySeparatorChar))))
                    && !File.Exists(Path.Combine(receipt.ApplicationRoot, WindowsInstallation.LauncherName)) && !File.Exists(WindowsInstallation.Connection(receipt.ApplicationRoot).FilePath))
                    return new(true, "Application files were already removed.", "Private data and ownership metadata remain preserved.");
                return RecoveryPending("The remaining runtime cannot safely verify private cleanup. Run Repair to restore the exact owned runtime before removing it.");
            }
            progress?.Report("Verifying removal through the public command and preserving private data…");
            result = await RunCli(runtime.Value.Node, runtime.Value.Cli, runtime.Value.Root, CliArguments.Build(request, runtime.Value.Root, false));
            if (!result.Ok) return result;
            if (result.CleanupPending || CoreRecoveryExists(receipt.InstallRoot)) return result with { Summary = "Deployment was removed, but recovery cleanup is still required. Application files were retained for Repair.", Connection = null, CleanupPending = true };
            var after = WindowsInstallation.ReadBounded(statePath, 8 * 1024 * 1024);
            BundleValidation.RejectDuplicateProperties(after);
            expected["status"] = "retained";
            expected["hosts"] = new JsonObject();
            if (!JsonNode.DeepEquals(expected, JsonNode.Parse(after))) throw new InvalidDataException("Private ownership changed after the verified removal command. Application files were preserved.");
            expectedState = after;
        }
        else result = new(true, "Removing application files from an incomplete setup.", "No private ownership pointer exists; private files are not adopted or deleted.");
        // The app lock excludes Windows launchers; the core-format lease also excludes standalone CLI setup/repair.
        using var cleanupLease = new CoreCleanupLease(receipt.InstallRoot, expectedState);
        var clean = true;
        var launcher = Path.Combine(request.ApplicationRoot, WindowsInstallation.LauncherName);
        clean &= RemoveOwnedFile(launcher, receipt.LauncherHashes);
        var connection = WindowsInstallation.Connection(request.ApplicationRoot);
        clean &= RemoveOwnedFile(connection.FilePath, [WindowsInstallation.Hash(Encoding.UTF8.GetBytes(connection.Json))]);
        foreach (var record in receipt.Bundles) clean &= RemoveBundle(request.ApplicationRoot, record);
        return result with { Summary = clean ? "Potassium MCP was removed. Private data was preserved." : "Deployment was removed; some application files were preserved.", Details = result.Details + "\nConfiguration, token, artifacts and ownership recovery metadata were not deleted. Unknown or in-use application files are never forcibly removed.", CleanupPending = !clean, Connection = null };
    }

    private static CliResult RecoveryPending(string details) => new(false, "Application files were preserved for verified recovery.", details, CleanupPending: true);

    private static bool CoreRecoveryExists(string installRoot)
    {
        foreach (var path in new[] { installRoot + ".transaction.json", installRoot + ".lock.recovery" })
        {
            WindowsInstallation.RejectLinks(path);
            if (File.Exists(path) || Directory.Exists(path)) return true;
        }
        return false;
    }

    private static (string Node, string Cli, string Root)? FindCleanupRuntime(WindowsReceipt receipt)
    {
        foreach (var record in receipt.Bundles.Reverse().Where(record => record.Location.StartsWith("versions/", StringComparison.Ordinal)))
        {
            try
            {
                var root = Path.Combine(receipt.ApplicationRoot, record.Location.Replace('/', Path.DirectorySeparatorChar));
                var manifest = WindowsInstallation.ReadBundle(receipt.ApplicationRoot, record);
                WindowsInstallation.VerifyDirectory(root, manifest);
                return (Path.Combine(root, manifest.Entries.Node.Replace('/', Path.DirectorySeparatorChar)), Path.Combine(root, manifest.Entries.Cli.Replace('/', Path.DirectorySeparatorChar)), root);
            }
            catch (Exception error) when (ManagedError(error)) { }
        }
        return null;
    }

    private sealed class CoreCleanupLease : IDisposable
    {
        private FileStream? stream;

        public CoreCleanupLease(string installRoot, byte[]? expectedState)
        {
            if (CoreRecoveryExists(installRoot)) throw new InvalidDataException("Private transaction recovery is pending. Application files were preserved.");
            var path = installRoot + ".lock";
            WindowsInstallation.RejectLinks(path);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var owner = JsonSerializer.SerializeToUtf8Bytes(new { schema = 1, pid = Environment.ProcessId, hostname = System.Net.Dns.GetHostName(), installRoot, nonce = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(16)).ToLowerInvariant() });
            try { stream = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read, 4096, FileOptions.DeleteOnClose); }
            catch (IOException error) { throw new IOException("A private setup operation or unrecovered core lock prevents application cleanup. Close its owner or run verified Repair.", error); }
            try
            {
                stream.Write(owner);
                stream.Flush(true);
                if (CoreRecoveryExists(installRoot)) throw new InvalidDataException("Private recovery began before application cleanup. No application files were removed.");
                var statePath = Path.Combine(installRoot, "ownership.json");
                WindowsInstallation.RejectLinks(statePath);
                if (Directory.Exists(statePath) || (expectedState is null ? File.Exists(statePath) : !File.Exists(statePath)
                    || !WindowsInstallation.ReadBounded(statePath, 8 * 1024 * 1024).AsSpan().SequenceEqual(expectedState))) throw new InvalidDataException("Private ownership changed before application cleanup. Application files were preserved.");
            }
            catch { Dispose(); throw; }
        }

        public void Dispose()
        {
            if (stream is null) return;
            stream.Dispose();
            stream = null;
        }
    }

    private static bool RemoveOwnedFile(string path, IEnumerable<string> hashes)
    {
        try
        {
            WindowsInstallation.RejectLinks(path);
            if (!File.Exists(path)) return !Directory.Exists(path);
            if (!hashes.Contains(WindowsInstallation.FileHash(path), StringComparer.Ordinal)) return false;
            File.Delete(path);
            return true;
        }
        catch (Exception error) when (ManagedError(error)) { return false; }
    }

    private static bool RemoveBundle(string applicationRoot, InstalledBundle record)
    {
        var root = Path.Combine(applicationRoot, record.Location.Replace('/', Path.DirectorySeparatorChar));
        try
        {
            WindowsInstallation.RejectLinks(root);
            if (!Directory.Exists(root)) return !File.Exists(root);
            var manifest = WindowsInstallation.ReadBundle(applicationRoot, record);
            var clean = true;
            foreach (var file in manifest.Files) clean &= RemoveOwnedFile(Path.Combine(root, file.Path.Replace('/', Path.DirectorySeparatorChar)), [file.Sha256]);
            // The manifest remains as deletion authority until all known files have been removed.
            if (clean)
            {
                var directories = manifest.Files.SelectMany(file => Parents(file.Path)).Distinct(StringComparer.OrdinalIgnoreCase).OrderByDescending(path => path.Length);
                foreach (var directory in directories)
                {
                    var path = Path.Combine(root, directory.Replace('/', Path.DirectorySeparatorChar));
                    WindowsInstallation.RejectLinks(path);
                    if (Directory.Exists(path) && !Directory.EnumerateFileSystemEntries(path).Any()) Directory.Delete(path);
                }
                if (Directory.EnumerateFileSystemEntries(root).All(path => Path.GetFileName(path) == WindowsInstallation.ManifestName))
                {
                    clean &= RemoveOwnedFile(Path.Combine(root, WindowsInstallation.ManifestName), [record.VersionId]);
                    if (clean) Directory.Delete(root);
                }
                else clean = false;
            }
            return clean;
        }
        catch (Exception error) when (ManagedError(error)) { return false; }
    }

    private static IEnumerable<string> Parents(string path)
    {
        while (path.LastIndexOf('/') is var index && index >= 0) { path = path[..index]; yield return path; }
    }

    private static async Task<CliResult> CheckAsync(CliRequest request, IProgress<string>? progress)
    {
        using var lease = WindowsInstallation.AcquireLock(request.ApplicationRoot, false);
        var receipt = WindowsInstallation.ReadReceipt(request.ApplicationRoot, request.InstallRoot) ?? throw new InvalidDataException("No owned application installation was found.");
        WindowsInstallation.ResolveActive(request.ApplicationRoot, receipt);
        progress?.Report("Starting the stable launcher and negotiating MCP…");
        var connection = WindowsInstallation.Connection(request.ApplicationRoot);
        var start = WindowsInstallation.StartInfo(connection.Command, request.ApplicationRoot);
        start.RedirectStandardInput = start.RedirectStandardOutput = start.RedirectStandardError = true;
        WindowsInstallation.PreventStandardHandleInheritance();
        using var process = Process.Start(start) ?? throw new IOException("The stable launcher could not be started.");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        var errors = WindowsInstallation.ReadOutputBoundedAsync(process.StandardError, 0);
        var reader = new BoundedLineReader(process.StandardOutput);
        var initialized = false;
        CliResult result;
        try
        {
            var response = await Exchange(process, reader, 1, "initialize", new { protocolVersion = "2025-03-26", capabilities = new { }, clientInfo = new { name = "potassium-windows-setup", version = "1.0.0" } }, timeout.Token);
            if (!response.TryGetProperty("protocolVersion", out var protocol) || protocol.ValueKind != JsonValueKind.String || !response.TryGetProperty("capabilities", out _)) throw new InvalidDataException("The launcher did not negotiate MCP initialization.");
            initialized = true;
            await process.StandardInput.WriteLineAsync("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}".AsMemory(), timeout.Token);
            await process.StandardInput.FlushAsync(timeout.Token);
            var tools = await Exchange(process, reader, 2, "tools/list", new { }, timeout.Token);
            if (!tools.GetProperty("tools").EnumerateArray().Any(tool => tool.GetProperty("name").GetString() == "potassium_status")) throw new InvalidDataException("The agent identity does not expose the read-only status tool. Existing access settings were not changed.");
            var status = await Exchange(process, reader, 3, "tools/call", new { name = "potassium_status", arguments = new { } }, timeout.Token);
            if (status.TryGetProperty("isError", out var isError) && isError.ValueKind == JsonValueKind.True) throw new InvalidDataException("The MCP status tool returned an error.");
            bool connected;
            if (status.TryGetProperty("structuredContent", out var structured) && structured.TryGetProperty("connected", out var connectedValue) && connectedValue.ValueKind is JsonValueKind.True or JsonValueKind.False) connected = connectedValue.GetBoolean();
            else throw new InvalidDataException("The MCP status response did not report executor connectivity.");
            result = new(true, connected ? "MCP is responding. Potassium executor is connected." : "MCP is responding. Potassium executor is not connected.", "Verified the installed stable launcher with MCP initialize, tools/list and potassium_status. No game code was executed.", connection, McpConnected: true, ExecutorConnected: connected);
        }
        catch (Exception error) when (ManagedError(error) || error is OperationCanceledException)
        {
            result = new(false, "Connection verification did not complete.", error is OperationCanceledException ? "The bounded live MCP check timed out. Executor connectivity is unknown." : UserFacingText.Redact(error.Message), McpConnected: initialized);
        }
        try
        {
            process.StandardInput.Close();
            var drain = WindowsInstallation.ReadOutputBoundedAsync(process.StandardOutput, 0);
            await Task.WhenAll(process.WaitForExitAsync(), errors, drain).WaitAsync(TimeSpan.FromSeconds(20));
        }
        catch (Exception error) when (ManagedError(error) || error is TimeoutException)
        {
            result = result with { Ok = false, CleanupPending = true, Connection = null, Details = result.Details + "\nThe probe was sent EOF, but its complete shutdown could not be confirmed. No shared broker or mutation process was forcibly terminated." };
        }
        return result;
    }

    private static async Task<JsonElement> Exchange(Process process, BoundedLineReader reader, int id, string method, object parameters, CancellationToken cancellationToken)
    {
        await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { jsonrpc = "2.0", id, method, @params = parameters }).AsMemory(), cancellationToken);
        await process.StandardInput.FlushAsync(cancellationToken);
        var total = 0;
        for (var message = 0; message < 64; message++)
        {
            var line = await reader.ReadAsync(2 * 1024 * 1024 - total, cancellationToken);
            total += line.Length;
            using var parsed = JsonDocument.Parse(line);
            var root = parsed.RootElement;
            if (root.TryGetProperty("id", out var responseId) && responseId.ValueKind == JsonValueKind.Number && responseId.GetInt32() == id)
            {
                if (root.TryGetProperty("error", out _)) throw new InvalidDataException("The live MCP request returned a protocol error.");
                return root.GetProperty("result").Clone();
            }
            if (!root.TryGetProperty("method", out _)) throw new InvalidDataException("The launcher returned an unexpected MCP response.");
        }
        throw new InvalidDataException("The live MCP check exceeded its message limit.");
    }

    private sealed class BoundedLineReader(StreamReader reader)
    {
        private readonly char[] buffer = new char[8192];
        private int offset;
        private int count;

        public async Task<string> ReadAsync(int limit, CancellationToken cancellationToken)
        {
            var text = new StringBuilder(Math.Min(Math.Max(limit, 0), 4096));
            while (true)
            {
                if (offset == count)
                {
                    count = await reader.ReadAsync(buffer.AsMemory(), cancellationToken);
                    offset = 0;
                    if (count == 0) throw new IOException("The launcher closed stdout before answering the MCP request.");
                }
                var newline = Array.IndexOf(buffer, '\n', offset, count - offset);
                var length = (newline < 0 ? count : newline) - offset;
                if (text.Length + length > limit) throw new InvalidDataException("The live MCP response exceeded its size limit.");
                text.Append(buffer, offset, length);
                offset += length;
                if (newline >= 0) { offset++; return text.ToString(); }
            }
        }
    }
}
