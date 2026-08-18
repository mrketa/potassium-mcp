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
    public void Arguments_are_explicit_and_do_not_enable_admin_without_consent()
    {
        var arguments = CliArguments.Build(new CliRequest("install", ["codex", "cursor", "codex"], "user", "C:\\bundle.tgz"));
        Assert.Equal(["install", "--json", "--scope", "user", "--package-source", "C:\\bundle.tgz", "--host", "codex", "--host", "cursor"], arguments);
        Assert.DoesNotContain("--allow-unsafe-execute", arguments);
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
}
