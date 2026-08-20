using Xunit;
using System.IO.Compression;
using System.Text;
using PotassiumMcp.Setup;

namespace PotassiumMcp.Setup.Tests;

public sealed class SetupHelpersTests
{
    [Fact]
    public void Manifest_validation_rejects_unsafe_path_and_bad_hash()
    {
        Assert.Throws<InvalidDataException>(() => BundleValidation.ParseManifest("{\"files\":[{\"path\":\"../node.exe\",\"sha256\":\"not-a-hash\"}]}"));
    }

    [Fact]
    public void Manifest_validation_accepts_and_verifies_exact_archive()
    {
        const string content = "node";
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(content)));
        var manifest = BundleValidation.ParseManifest($"{{\"files\":[{{\"path\":\"runtime/node.exe\",\"sha256\":\"{hash}\"}}]}}");
        using var bytes = new MemoryStream();
        using (var archive = new ZipArchive(bytes, ZipArchiveMode.Create, true))
        using (var writer = new StreamWriter(archive.CreateEntry("runtime/node.exe").Open())) writer.Write(content);
        bytes.Position = 0;
        using var input = new ZipArchive(bytes, ZipArchiveMode.Read);
        BundleValidation.Verify(input, manifest);
    }

    [Fact]
    public void Manifest_validation_accepts_tar_style_current_directory_prefix()
    {
        const string content = "node";
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(content)));
        var manifest = BundleValidation.ParseManifest($"{{\"files\":[{{\"path\":\"runtime/node.exe\",\"sha256\":\"{hash}\"}}]}}");
        using var bytes = new MemoryStream();
        using (var archive = new ZipArchive(bytes, ZipArchiveMode.Create, true))
        using (var writer = new StreamWriter(archive.CreateEntry("./runtime/node.exe").Open())) writer.Write(content);
        bytes.Position = 0;
        using var input = new ZipArchive(bytes, ZipArchiveMode.Read);

        BundleValidation.Verify(input, manifest);
    }

    [Fact]
    public void Install_arguments_include_explicit_paths_and_do_not_enable_admin_without_consent()
    {
        var arguments = CliArguments.Build(new CliRequest("install", ["codex", "cursor", "codex"], "user", "C:\\bundle.tgz", WorkspaceRoot: "C:\\Potassium\\workspace", AutoexecRoot: "C:\\Potassium\\autoexec"));
        Assert.Equal(["install", "--json", "--scope", "user", "--package-source", "C:\\bundle.tgz", "--host", "codex", "--host", "cursor", "--workspace", "C:\\Potassium\\workspace", "--autoexec", "C:\\Potassium\\autoexec"], arguments);
        Assert.DoesNotContain("--allow-unsafe-execute", arguments);
    }

    [Fact]
    public void Host_catalog_includes_visible_omp_option()
    {
        Assert.Contains("omp", HostCatalog.CommonHosts, StringComparer.OrdinalIgnoreCase);
    }

    [Fact]
    public void Omp_install_arguments_use_project_scope_without_working_directory_argument()
    {
        var arguments = CliArguments.Build(new CliRequest("install", ["omp"], "project", "C:\\bundle.tgz", WorkspaceRoot: "C:\\Potassium\\workspace", AutoexecRoot: "C:\\Potassium\\autoexec", WorkingDirectory: "C:\\project"));
        Assert.Equal(["install", "--json", "--scope", "project", "--package-source", "C:\\bundle.tgz", "--host", "omp", "--workspace", "C:\\Potassium\\workspace", "--autoexec", "C:\\Potassium\\autoexec"], arguments);
    }

    [Fact]
    public void Project_directory_validation_requires_an_existing_directory()
    {
        var existing = Path.Combine(Path.GetTempPath(), "PotassiumMcp.Setup.Tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(existing);
        try
        {
            Assert.True(ProjectDirectory.IsValid(existing));
            Assert.False(ProjectDirectory.IsValid(Path.Combine(existing, "missing")));
            Assert.False(ProjectDirectory.IsValid(null));
        }
        finally
        {
            Directory.Delete(existing, recursive: true);
        }
    }

    [Fact]
    public void Combined_cli_results_preserve_each_failure()
    {
        var combined = CliResults.Combine([
            new CliResult(true, "User hosts installed", "codex configured"),
            new CliResult(false, "OMP failed", "project configuration failed")
        ]);

        Assert.False(combined.Ok);
        Assert.Contains("User hosts installed", combined.Summary);
        Assert.Contains("OMP failed", combined.Summary);
        Assert.Contains("codex configured", combined.Details);
        Assert.Contains("project configuration failed", combined.Details);
    }

    [Fact]
    public void Verify_arguments_exclude_install_only_options()
    {
        var arguments = CliArguments.Build(new CliRequest("verify", ["codex"], "user", "C:\\bundle.tgz", true, "C:\\Potassium\\workspace", "C:\\Potassium\\autoexec"));
        Assert.Equal(["verify", "--json"], arguments);
    }

    [Fact]
    public void Uninstall_arguments_request_owned_uninstall_only()
    {
        var arguments = CliArguments.Build(new CliRequest("uninstall", ["codex"], "user", "C:\\bundle.tgz", true, "C:\\Potassium\\workspace", "C:\\Potassium\\autoexec"));
        Assert.Equal(["uninstall", "--json", "--all"], arguments);
    }

    [Fact]
    public void Discovery_prefers_valid_ownership_paths()
    {
        var local = CreateTemporaryLocalAppData();
        try
        {
            var ownedWorkspace = Directory.CreateDirectory(Path.Combine(local, "owned-workspace")).FullName;
            var ownedAutoexec = Directory.CreateDirectory(Path.Combine(local, "owned-autoexec")).FullName;
            var ownedScript = Path.Combine(ownedAutoexec, "potassium_mcp_autoexec.lua");
            File.WriteAllText(ownedScript, "-- owned");
            Directory.CreateDirectory(Path.Combine(local, "Potassium", "workspace"));
            Directory.CreateDirectory(Path.Combine(local, "Potassium", "autoexec"));
            File.WriteAllText(Path.Combine(local, "Potassium", "autoexec", "potassium_mcp_autoexec.lua"), "-- fallback");
            Directory.CreateDirectory(Path.Combine(local, "Potassium", "MCP"));
            File.WriteAllText(Path.Combine(local, "Potassium", "MCP", "ownership.json"),
                $$"""{"schema":2,"workspaceRoot":"{{ownedWorkspace.Replace("\\", "\\\\")}}","autoexecRoot":"{{ownedAutoexec.Replace("\\", "\\\\")}}","scripts":[{"target":"{{ownedScript.Replace("\\", "\\\\")}}"}]}""");

            var discovery = PotassiumPathDiscoveryService.Discover(local);

            Assert.Equal(ownedWorkspace, discovery.WorkspaceRoot);
            Assert.Equal(ownedAutoexec, discovery.AutoexecRoot);
        }
        finally { Directory.Delete(local, recursive: true); }
    }

    [Fact]
    public void Discovery_derives_legacy_autoexec_only_from_its_owned_script()
    {
        var local = CreateTemporaryLocalAppData();
        try
        {
            var workspace = Directory.CreateDirectory(Path.Combine(local, "Potassium", "workspace")).FullName;
            var autoexec = Directory.CreateDirectory(Path.Combine(local, "Potassium", "autoexec")).FullName;
            var autoexecScript = Path.Combine(autoexec, "potassium_mcp_autoexec.lua");
            File.WriteAllText(autoexecScript, "-- owned");
            Directory.CreateDirectory(Path.Combine(local, "Potassium", "MCP"));
            File.WriteAllText(Path.Combine(local, "Potassium", "MCP", "ownership.json"),
                $$"""{"schema":2,"workspaceRoot":"{{workspace.Replace("\\", "\\\\")}}","scripts":[{"target":"{{autoexecScript.Replace("\\", "\\\\")}}"}]}""");

            var discovery = PotassiumPathDiscoveryService.Discover(local);

            Assert.Equal(workspace, discovery.WorkspaceRoot);
            Assert.Equal(autoexec, discovery.AutoexecRoot);
        }
        finally { Directory.Delete(local, recursive: true); }
    }

    [Theory]
    [InlineData("workspace")]
    [InlineData("data")]
    public void Discovery_accepts_one_existing_workspace_candidate(string workspaceName)
    {
        var local = CreateTemporaryLocalAppData();
        try
        {
            var workspace = Directory.CreateDirectory(Path.Combine(local, "Potassium", workspaceName)).FullName;
            var autoexec = Directory.CreateDirectory(Path.Combine(local, "Potassium", "autoexec")).FullName;

            var discovery = PotassiumPathDiscoveryService.Discover(local);

            Assert.Equal(workspace, discovery.WorkspaceRoot);
            Assert.Equal(autoexec, discovery.AutoexecRoot);
        }
        finally { Directory.Delete(local, recursive: true); }
    }

    [Fact]
    public void Discovery_rejects_ambiguous_or_incomplete_candidates()
    {
        var ambiguous = CreateTemporaryLocalAppData();
        var incomplete = CreateTemporaryLocalAppData();
        try
        {
            Directory.CreateDirectory(Path.Combine(ambiguous, "Potassium", "workspace"));
            Directory.CreateDirectory(Path.Combine(ambiguous, "Potassium", "data"));
            var autoexec = Directory.CreateDirectory(Path.Combine(ambiguous, "Potassium", "autoexec")).FullName;
            File.WriteAllText(Path.Combine(autoexec, "potassium_mcp_autoexec.lua"), "-- installed");
            Directory.CreateDirectory(Path.Combine(incomplete, "Potassium", "workspace"));

            Assert.False(PotassiumPathDiscoveryService.Discover(ambiguous).IsResolved);
            Assert.False(PotassiumPathDiscoveryService.Discover(incomplete).IsResolved);
        }
        finally
        {
            Directory.Delete(ambiguous, recursive: true);
            Directory.Delete(incomplete, recursive: true);
        }
    }

    [Fact]
    public void Json_rendering_redacts_secrets_and_paths()
    {
        var result = UserFacingText.Render("{\"ok\":false,\"message\":\"Could not install\",\"token\":\"abc123\",\"path\":\"C:\\\\Users\\\\Ada\\\\file\"}", "", 1);
        Assert.False(result.Ok);
        Assert.Equal("Could not install", result.Summary);
        Assert.DoesNotContain("abc123", result.Details);
        Assert.DoesNotContain("Ada", result.Details);
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, false)]
    [InlineData(true, true, true)]
    public void Admin_access_requires_informed_consent(bool advanced, bool checkedConsent, bool expected) => Assert.Equal(expected, AdminConsent.IsAllowed(advanced, checkedConsent));

    [Fact]
    public void Workspace_cleanup_removes_private_temp_directory()
    {
        string path;
        using (var workspace = RuntimeWorkspace.Create())
        {
            path = workspace.Root;
            Directory.CreateDirectory(path);
            File.WriteAllText(Path.Combine(path, "private.txt"), "temporary");
        }
        Assert.False(Directory.Exists(path));
    }

    private static string CreateTemporaryLocalAppData()
    {
        var path = Path.Combine(Path.GetTempPath(), "PotassiumMcp.Setup.Tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }
}
