using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PotassiumMcp.Setup;

public sealed record BundleFile(string Path, string Sha256);
public sealed record BundleManifest(IReadOnlyList<BundleFile> Files);
public sealed record CliRequest(string Command, IReadOnlyCollection<string> Hosts, string Scope, string PackageSource, bool AllowUnsafeExecute = false);
public sealed record CliResult(bool Ok, string Summary, string Details);

public static class HostCatalog
{
    public static readonly string[] CommonHosts = ["codex", "claude-code", "claude-desktop", "vscode", "cursor", "gemini"];

    public static string RestartInstructions(IEnumerable<string> hosts) =>
        "When setup finishes, close and reopen " +
        (hosts.Any() ? string.Join(", ", hosts) : "your AI app") +
        ". Then attach Potassium MCP from that app's MCP or tools settings. No account sign-in is needed here.";
}

public static class AdminConsent
{
    public static bool IsAllowed(bool advancedSelected, bool informedConsentChecked) => advancedSelected && informedConsentChecked;
}

public static class CliArguments
{
    public static IReadOnlyList<string> Build(CliRequest request)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Command);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Scope);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.PackageSource);
        var arguments = new List<string> { request.Command, "--json", "--scope", request.Scope, "--package-source", request.PackageSource };
        foreach (var host in request.Hosts.Distinct(StringComparer.OrdinalIgnoreCase))
            arguments.AddRange(["--host", host]);
        if (request.AllowUnsafeExecute) arguments.Add("--allow-unsafe-execute");
        return arguments;
    }
}

public static class UserFacingText
{
    private static readonly Regex Secret = new(@"(?i)([""']?(?:token|secret|password|authorization)[""']?\s*[:=]\s*)[""']?[^""'\s,;}]+[""']?", RegexOptions.Compiled);
    private static readonly Regex WindowsPath = new("(?i)[a-z]:\\\\[^\\r\\n\\\"']+", RegexOptions.Compiled);
    private static readonly Regex HomePath = new("(?i)(/home|/users)/[^\\s\\\"']+", RegexOptions.Compiled);

    public static CliResult Render(string stdout, string stderr, int exitCode)
    {
        var message = string.IsNullOrWhiteSpace(stdout) ? stderr : stdout;
        try
        {
            using var json = JsonDocument.Parse(stdout);
            var root = json.RootElement;
            var ok = exitCode == 0 && (!root.TryGetProperty("ok", out var value) || value.ValueKind != JsonValueKind.False);
            var summary = FirstString(root, "message", "summary", "status") ?? (ok ? "Finished." : "Setup could not finish.");
            var details = Redact(root.GetRawText());
            return new CliResult(ok, Redact(summary), details);
        }
        catch (JsonException)
        {
            return new CliResult(exitCode == 0, exitCode == 0 ? "Finished." : "Setup could not finish.", Redact(message));
        }
    }

    private static string? FirstString(JsonElement root, params string[] names) => names
        .Select(name => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null)
        .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));

    public static string Redact(string value) => HomePath.Replace(WindowsPath.Replace(Secret.Replace(value ?? "", "$1\"[hidden]\""), "[path]"), "[path]");
}

public static class LegalNotices
{
    public static string ApacheLicense()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("PotassiumMcp.Setup.assets.Potassium-LICENSE.txt")
            ?? throw new InvalidOperationException("The Potassium MCP license is unavailable.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    public const string NodeAttribution = "This installer bundles Node.js solely to run the local Potassium MCP setup command. Node.js is licensed under the MIT License. Its exact LICENSE file is included in the verified runtime bundle and extracted only into the private temporary workspace used for setup.";
}

public static class BundleValidation
{
    public static BundleManifest ParseManifest(string manifestJson)
    {
        var manifest = JsonSerializer.Deserialize<BundleManifest>(manifestJson, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidDataException("The bundled runtime manifest is unavailable.");
        if (manifest.Files is null || manifest.Files.Count == 0 || manifest.Files.Any(file => file is null || !IsSafeRelativePath(file.Path) || !IsSha256(file.Sha256)))
            throw new InvalidDataException("The bundled runtime manifest is invalid.");
        return manifest;
    }

    public static void Verify(ZipArchive archive, BundleManifest manifest)
    {
        var entries = archive.Entries.Where(entry => !string.IsNullOrEmpty(entry.Name)).ToDictionary(entry => entry.FullName.Replace('/', '\\'), StringComparer.OrdinalIgnoreCase);
        if (entries.Count != manifest.Files.Count) throw new InvalidDataException("The bundled runtime does not match its manifest.");
        foreach (var file in manifest.Files)
        {
            var path = file.Path.Replace('/', '\\');
            if (!entries.TryGetValue(path, out var entry) || !string.Equals(Hash(entry), file.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("The bundled runtime did not pass its integrity check.");
        }
    }

    public static bool IsSafeRelativePath(string? path) => !string.IsNullOrWhiteSpace(path) && !Path.IsPathRooted(path) && !path.Contains("..", StringComparison.Ordinal) && !path.Contains(':');
    private static bool IsSha256(string? hash) => hash is { Length: 64 } && hash.All(Uri.IsHexDigit);
    private static string Hash(ZipArchiveEntry entry) { using var stream = entry.Open(); return Convert.ToHexString(SHA256.HashData(stream)); }
}

public sealed class RuntimeWorkspace : IDisposable
{
    public string Root { get; }
    public RuntimeWorkspace(string root) => Root = root;
    public static RuntimeWorkspace Create() => new(Path.Combine(Path.GetTempPath(), "PotassiumMcp.Setup", Guid.NewGuid().ToString("N")));
    public void Extract(Stream zipStream, BundleManifest manifest)
    {
        Directory.CreateDirectory(Root);
        using var archive = new ZipArchive(zipStream, ZipArchiveMode.Read, leaveOpen: false);
        BundleValidation.Verify(archive, manifest);
        foreach (var entry in archive.Entries.Where(entry => !string.IsNullOrEmpty(entry.Name)))
        {
            var destination = Path.GetFullPath(Path.Combine(Root, entry.FullName));
            if (!destination.StartsWith(Path.GetFullPath(Root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("The bundled runtime contains an unsafe file path.");
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            entry.ExtractToFile(destination);
        }
    }
    public void Dispose() { try { if (Directory.Exists(Root)) Directory.Delete(Root, recursive: true); } catch { } }
}

public sealed class SetupRunner
{
    private readonly Assembly assembly;
    public SetupRunner(Assembly? assembly = null) => this.assembly = assembly ?? Assembly.GetExecutingAssembly();

    public async Task<CliResult> RunAsync(CliRequest request, CancellationToken cancellationToken = default)
    {
        var manifestStream = Resource("PotassiumMcp.Setup.assets.runtime-bundle.manifest.json") ?? throw new InvalidOperationException("This setup file is missing its bundled runtime manifest.");
        var zipStream = Resource("PotassiumMcp.Setup.assets.runtime-bundle.zip") ?? throw new InvalidOperationException("This setup file is missing its bundled Node runtime.");
        using var manifestReader = new StreamReader(manifestStream);
        var manifest = BundleValidation.ParseManifest(await manifestReader.ReadToEndAsync(cancellationToken));
        using var workspace = RuntimeWorkspace.Create();
        workspace.Extract(zipStream, manifest);
        var node = Directory.EnumerateFiles(workspace.Root, "node.exe", SearchOption.AllDirectories).SingleOrDefault() ?? throw new InvalidDataException("The bundled Node runtime is incomplete.");
        var package = Directory.EnumerateFiles(workspace.Root, "*.tgz", SearchOption.AllDirectories).SingleOrDefault() ?? throw new InvalidDataException("The bundled package is incomplete.");
        var cli = Directory.EnumerateFiles(workspace.Root, "potassium-mcp.js", SearchOption.AllDirectories).SingleOrDefault() ?? throw new InvalidDataException("The bundled command is incomplete.");
        var start = new ProcessStartInfo(node) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        start.ArgumentList.Add(cli);
        foreach (var argument in CliArguments.Build(request with { PackageSource = package })) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start the local setup command.");
        var output = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var error = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);
        return UserFacingText.Render(await output, await error, process.ExitCode);
    }

    private Stream? Resource(string logicalName) => assembly.GetManifestResourceStream(logicalName);
}
