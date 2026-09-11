using System.IO.Compression;
using System.Text;
using System.Text.Json;
using PotassiumMcp.Setup;
using System.Text.Json.Nodes;
using Xunit;

namespace PotassiumMcp.Setup.Tests;

public sealed class SetupHelpersTests
{
    [Theory]
    [InlineData("../node.exe")]
    [InlineData("./node/node.exe")]
    [InlineData("node\\node.exe")]
    [InlineData("node/node.exe:payload")]
    [InlineData("node/NUL.txt")]
    [InlineData("node/node.exe.")]
    public void Archive_path_aliases_are_not_adopted(string path) => Assert.False(BundleValidation.IsSafeRelativePath(path));

    [Fact]
    public void Archive_verification_rejects_extra_files_and_changed_bytes()
    {
        using var fixture = new InstallationFixture();
        using var archiveBytes = fixture.Archive(extraFile: true);
        using var archive = new ZipArchive(archiveBytes, ZipArchiveMode.Read);
        Assert.Throws<InvalidDataException>(() => BundleValidation.Verify(archive, fixture.Manifest));
        using var changedBytes = fixture.Archive(changeNode: true);
        using var changed = new ZipArchive(changedBytes, ZipArchiveMode.Read);
        Assert.Throws<InvalidDataException>(() => BundleValidation.Verify(changed, fixture.Manifest));
    }

    [Fact]
    public void Archive_verification_rejects_symlinks_and_alias_entries()
    {
        using var fixture = new InstallationFixture();
        using var linkedBytes = fixture.Archive(linkNode: true);
        using var linked = new ZipArchive(linkedBytes, ZipArchiveMode.Read);
        Assert.Throws<InvalidDataException>(() => BundleValidation.Verify(linked, fixture.Manifest));
        using var aliasBytes = fixture.Archive(aliasNode: true);
        using var alias = new ZipArchive(aliasBytes, ZipArchiveMode.Read);
        Assert.Throws<InvalidDataException>(() => BundleValidation.Verify(alias, fixture.Manifest));
    }

    [Fact]
    public void Manifest_rejects_case_collisions_and_size_overflows()
    {
        using var fixture = new InstallationFixture();
        var collision = fixture.Manifest with { Files = fixture.Manifest.Files.Append(new("NODE/NODE.EXE", new string('a', 64), 1)).ToArray() };
        Assert.Throws<InvalidDataException>(() => BundleValidation.ParseManifest(InstallationFixture.Serialize(collision)));
        var oversized = fixture.Manifest with { Files = fixture.Manifest.Files.Select(file => file with { Bytes = BundleValidation.MaxFileBytes + 1 }).ToArray() };
        Assert.Throws<InvalidDataException>(() => BundleValidation.ParseManifest(InstallationFixture.Serialize(oversized)));
    }

    [Fact]
    public void Launcher_lifetime_lock_prevents_mutation_until_all_clients_release_it()
    {
        using var fixture = new InstallationFixture();
        using (WindowsInstallation.AcquireLock(fixture.App, true)) { }
        using (var first = WindowsInstallation.AcquireLock(fixture.App, false))
        {
            using (var second = WindowsInstallation.AcquireLock(fixture.App, false))
                Assert.Throws<IOException>(() => WindowsInstallation.AcquireLock(fixture.App, true));
            Assert.Throws<IOException>(() => WindowsInstallation.AcquireLock(fixture.App, true));
        }
        using var mutation = WindowsInstallation.AcquireLock(fixture.App, true);
        Assert.Throws<IOException>(() => WindowsInstallation.AcquireLock(fixture.App, false));
    }

    [Fact]
    public void Empty_foreign_lock_is_not_claimed()
    {
        using var fixture = new InstallationFixture();
        var path = Path.Combine(fixture.App, ".windows-install.lock");
        File.WriteAllBytes(path, []);
        Assert.Throws<InvalidDataException>(() => WindowsInstallation.AcquireLock(fixture.App, true));
        Assert.Empty(File.ReadAllBytes(path));
    }

    [Fact]
    public async Task Corrupt_installation_returns_managed_failure_without_starting_a_probe()
    {
        using var fixture = new InstallationFixture();
        using (WindowsInstallation.AcquireLock(fixture.App, true)) { }
        File.AppendAllText(Path.Combine(fixture.VersionRoot, "node", "node.exe"), "changed");
        var runner = new SetupRunner();
        var state = runner.GetInstallationState(new(fixture.App, fixture.Private, fixture.Workspace));
        Assert.False(state.Installed);
        Assert.Null(state.Connection);
        var check = await runner.RunAsync(new("check", fixture.Workspace, fixture.Private, fixture.App));
        Assert.False(check.Ok);
        Assert.Null(check.Connection);
        Assert.Null(check.McpConnected);
    }

    [Fact]
    public void Active_runtime_requires_receipt_binding_and_unmodified_immutable_files()
    {
        using var fixture = new InstallationFixture();
        var runtime = WindowsInstallation.ResolveActive(fixture.App, fixture.Receipt);
        Assert.Equal(fixture.VersionRoot, runtime.VersionRoot);
        File.AppendAllText(runtime.Node, "changed");
        Assert.Throws<InvalidDataException>(() => WindowsInstallation.ResolveActive(fixture.App, fixture.Receipt));
        Assert.Throws<InvalidDataException>(() => WindowsInstallation.ReadReceipt(fixture.App, Path.Combine(fixture.Root, "other-private")));
    }

    [Fact]
    public void Active_pointer_cannot_select_an_unowned_runtime_or_retained_deployment()
    {
        using var fixture = new InstallationFixture();
        fixture.WriteOwnership(status: "retained");
        Assert.Throws<InvalidDataException>(() => WindowsInstallation.ResolveActive(fixture.App, fixture.Receipt));
        fixture.WriteOwnership(packageRoot: Path.Combine(fixture.Root, "foreign", "package"));
        Assert.Throws<InvalidDataException>(() => WindowsInstallation.ResolveActive(fixture.App, fixture.Receipt));
    }

    [Fact]
    public void Unknown_runtime_content_and_connection_edits_are_preserved_as_conflicts()
    {
        using var fixture = new InstallationFixture();
        var foreign = Path.Combine(fixture.VersionRoot, "custom.txt");
        File.WriteAllText(foreign, "user content");
        Assert.Throws<InvalidDataException>(() => WindowsInstallation.ResolveActive(fixture.App, fixture.Receipt));
        Assert.Equal("user content", File.ReadAllText(foreign));
        File.Delete(foreign);
        var connection = WindowsInstallation.Connection(fixture.App);
        File.WriteAllText(connection.FilePath, "user connector");
        Assert.Throws<InvalidDataException>(() => WindowsInstallation.VerifyConnector(fixture.App, fixture.Receipt));
        Assert.Equal("user connector", File.ReadAllText(connection.FilePath));
    }

    [Fact]
    public void Generic_connector_is_token_free_and_requires_no_harness_arguments()
    {
        using var fixture = new InstallationFixture();
        var connection = WindowsInstallation.Connection(fixture.App);
        using var json = JsonDocument.Parse(connection.Json);
        var entry = json.RootElement.GetProperty("mcpServers").GetProperty("potassium");
        Assert.Equal(Path.Combine(fixture.App, WindowsInstallation.LauncherName), entry.GetProperty("command").GetString());
        Assert.Empty(entry.GetProperty("args").EnumerateArray());
        Assert.False(entry.TryGetProperty("env", out _));
        Assert.DoesNotContain(fixture.Secret, connection.Json, StringComparison.Ordinal);
        Assert.DoesNotContain(fixture.VersionRoot, connection.Json, StringComparison.Ordinal);
    }

    [Fact]
    public void Existing_agent_policy_does_not_request_a_read_identity_grant()
    {
        using var fixture = new InstallationFixture();
        File.WriteAllText(fixture.Config, "{\"allowUnsafeExecute\":true,\"hostPolicies\":{\"agent\":{\"read\":false,\"admin\":false,\"execute\":false}}}");
        Assert.False(CliArguments.NeedsReadIdentity(fixture.Private));
        File.WriteAllText(fixture.Config, "{\"hostPolicies\":{\"existing\":{\"read\":true,\"admin\":true,\"execute\":false}}}");
        Assert.True(CliArguments.NeedsReadIdentity(fixture.Private));
    }

    [Fact]
    public void Missing_or_recovering_configuration_never_requests_a_read_identity_grant()
    {
        using var fixture = new InstallationFixture();
        File.WriteAllText(fixture.Config, "{\"hostPolicies\":{}}");
        Assert.True(CliArguments.NeedsReadIdentity(fixture.Private));
        var journal = fixture.Private + ".transaction.json";
        File.WriteAllText(journal, "{\"schema\":1,\"phase\":\"applying\"}");
        Assert.False(CliArguments.NeedsReadIdentity(fixture.Private));
        File.Delete(fixture.Config);
        Assert.False(CliArguments.NeedsReadIdentity(fixture.Private));
        File.Delete(journal);
        Assert.False(CliArguments.NeedsReadIdentity(fixture.Private));
    }

    [Fact]
    public void Options_reopen_custom_private_workspace_without_default_discovery()
    {
        using var fixture = new InstallationFixture();
        var options = SetupOptions.Parse(["--app-root", fixture.App, "--install-root", fixture.Private]);
        Assert.Equal(fixture.Workspace, options.WorkspaceRoot);
        Assert.Throws<InvalidDataException>(() => SetupOptions.Parse(["--app-root", fixture.Workspace, "--install-root", fixture.Private]));
        Assert.Throws<ArgumentException>(() => SetupOptions.Parse(["--host", "desktop"]));
    }

    [Fact]
    public async Task Partial_retained_uninstall_preserves_private_data_and_requires_verified_repair()
    {
        using var fixture = new InstallationFixture();
        using (WindowsInstallation.AcquireLock(fixture.App, true)) { }
        fixture.WriteOwnership(status: "retained");
        var config = File.ReadAllBytes(fixture.Config);
        var token = File.ReadAllBytes(fixture.Token);
        var unknown = Path.Combine(fixture.VersionRoot, "user-note.txt");
        File.WriteAllText(unknown, "keep me");
        File.Delete(Path.Combine(fixture.VersionRoot, "node", "node.exe"));
        var result = await new SetupRunner().RunAsync(new("uninstall", fixture.Workspace, fixture.Private, fixture.App));
        Assert.False(result.Ok);
        Assert.True(result.CleanupPending);
        Assert.Null(result.Connection);
        Assert.Equal(config, File.ReadAllBytes(fixture.Config));
        Assert.Equal(token, File.ReadAllBytes(fixture.Token));
        Assert.Equal("keep me", File.ReadAllText(unknown));
        Assert.True(File.Exists(Path.Combine(fixture.App, WindowsInstallation.LauncherName)));
        Assert.True(File.Exists(WindowsInstallation.Connection(fixture.App).FilePath));
        Assert.True(File.Exists(Path.Combine(fixture.App, WindowsInstallation.ReceiptName)));
    }

    [Fact]
    public async Task Applying_core_journal_with_retained_pointer_preserves_rollback_runtime()
    {
        using var fixture = new InstallationFixture();
        fixture.WriteOwnership(status: "retained");
        var node = Path.Combine(fixture.VersionRoot, "node", "node.exe");
        var bytes = File.ReadAllBytes(node);
        var journal = fixture.Private + ".transaction.json";
        File.WriteAllText(journal, "{\"schema\":1,\"phase\":\"applying\"}");
        var result = await new SetupRunner().RunAsync(new("uninstall", fixture.Workspace, fixture.Private, fixture.App));
        Assert.False(result.Ok);
        Assert.True(result.CleanupPending);
        Assert.Null(result.Connection);
        Assert.Equal(bytes, File.ReadAllBytes(node));
        Assert.True(File.Exists(Path.Combine(fixture.App, WindowsInstallation.LauncherName)));
        Assert.Equal("{\"schema\":1,\"phase\":\"applying\"}", File.ReadAllText(journal));
    }

    [Fact]
    public async Task Failed_first_setup_can_remove_only_receipt_owned_application_files()
    {
        using var fixture = new InstallationFixture();
        File.Delete(Path.Combine(fixture.Private, "ownership.json"));
        var config = File.ReadAllBytes(fixture.Config);
        var token = File.ReadAllBytes(fixture.Token);
        var foreign = Path.Combine(fixture.App, "user-note.txt");
        File.WriteAllText(foreign, "keep me");
        var result = await new SetupRunner().RunAsync(new("uninstall", fixture.Workspace, fixture.Private, fixture.App));
        Assert.True(result.Ok);
        Assert.False(Directory.Exists(fixture.VersionRoot));
        Assert.False(File.Exists(Path.Combine(fixture.App, WindowsInstallation.LauncherName)));
        Assert.False(File.Exists(fixture.Private + ".lock"));
        Assert.Equal(config, File.ReadAllBytes(fixture.Config));
        Assert.Equal(token, File.ReadAllBytes(fixture.Token));
        Assert.Equal("keep me", File.ReadAllText(foreign));
    }

    [Fact]
    public async Task Existing_core_lock_blocks_app_only_cleanup_without_taking_over()
    {
        using var fixture = new InstallationFixture();
        File.Delete(Path.Combine(fixture.Private, "ownership.json"));
        var lockPath = fixture.Private + ".lock";
        File.WriteAllText(lockPath, "foreign core lock");
        var result = await new SetupRunner().RunAsync(new("uninstall", fixture.Workspace, fixture.Private, fixture.App));
        Assert.False(result.Ok);
        Assert.True(File.Exists(Path.Combine(fixture.App, WindowsInstallation.LauncherName)));
        Assert.True(Directory.Exists(fixture.VersionRoot));
        Assert.Equal("foreign core lock", File.ReadAllText(lockPath));
    }

    [Fact]
    public void Missing_manifest_recovers_only_exact_empty_receipt_owned_version()
    {
        using var fixture = new InstallationFixture();
        var manifest = File.ReadAllBytes(Path.Combine(fixture.VersionRoot, WindowsInstallation.ManifestName));
        Directory.Delete(fixture.VersionRoot, true);
        Directory.CreateDirectory(fixture.VersionRoot);
        WindowsInstallation.RestoreEmptyVersionManifest(fixture.App, fixture.Receipt.Bundles[0], manifest);
        Assert.Equal(manifest, File.ReadAllBytes(Path.Combine(fixture.VersionRoot, WindowsInstallation.ManifestName)));
        File.Delete(Path.Combine(fixture.VersionRoot, WindowsInstallation.ManifestName));
        File.WriteAllText(Path.Combine(fixture.VersionRoot, "unknown"), "preserve");
        Assert.Throws<InvalidDataException>(() => WindowsInstallation.RestoreEmptyVersionManifest(fixture.App, fixture.Receipt.Bundles[0], manifest));
        Assert.Equal("preserve", File.ReadAllText(Path.Combine(fixture.VersionRoot, "unknown")));
        Assert.False(File.Exists(Path.Combine(fixture.VersionRoot, WindowsInstallation.ManifestName)));
    }

    [Theory]
    [InlineData("2147483648")]
    [InlineData("3.5")]
    public async Task Numeric_schema_corruption_is_reported_as_managed_failure(string schema)
    {
        using var fixture = new InstallationFixture();
        using (WindowsInstallation.AcquireLock(fixture.App, true)) { }
        var path = Path.Combine(fixture.Private, "ownership.json");
        var state = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        state["schema"] = JsonNode.Parse(schema);
        File.WriteAllText(path, state.ToJsonString());
        var result = await new SetupRunner().RunAsync(new("check", fixture.Workspace, fixture.Private, fixture.App));
        Assert.False(result.Ok);
        Assert.Null(result.Connection);
        Assert.Null(result.McpConnected);
    }

    [Fact]
    public async Task Bounded_output_drains_excess_without_retaining_it()
    {
        using var source = new MemoryStream(Encoding.UTF8.GetBytes(new string('x', 65536) + "not retained"));
        using var reader = new StreamReader(source);
        var result = await WindowsInstallation.ReadOutputBoundedAsync(reader, 64);
        Assert.StartsWith(new string('x', 64), result, StringComparison.Ordinal);
        Assert.DoesNotContain("not retained", result, StringComparison.Ordinal);
        Assert.Equal(-1, reader.Read());
    }

    [Fact]
    public void Json_errors_redact_credentials_and_personal_paths()
    {
        var result = UserFacingText.Render("{\"ok\":false,\"message\":\"Could not install\",\"token\":\"abc123\",\"path\":\"C:\\\\Users\\\\Ada\\\\file\"}", "", 1);
        Assert.False(result.Ok);
        Assert.DoesNotContain("abc123", result.Details);
        Assert.DoesNotContain("Ada", result.Details);
    }

    [Fact]
    public void Stderr_acl_failure_exposes_original_file_and_native_reason_without_exposing_other_paths_or_secrets()
    {
        var failure = AclFailure();
        var acl = failure["acl"]!.AsObject();
        var originalPath = acl["path"]!.GetValue<string>();
        acl["message"] = "Security descriptor access denied; token=native-secret";
        failure["message"] = @"Rollback could not finish; password=context-secret; backup C:\Users\Bea\backup.json";
        failure["token"] = "json-secret";
        var result = UserFacingText.Render(@"Staging C:\Users\Cy\staged.json secret=stdout-secret", failure.ToJsonString(), 1);

        Assert.False(result.Ok);
        Assert.Contains(originalPath, result.Details, StringComparison.Ordinal);
        Assert.Contains("Security descriptor access denied", result.Details, StringComparison.Ordinal);
        Assert.Contains("80070005", result.Details, StringComparison.Ordinal);
        Assert.Contains("Rollback could not finish", result.Details, StringComparison.Ordinal);
        Assert.Contains("administrator", result.RecoveryAdvice!, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("retry", result.RecoveryAdvice!, StringComparison.OrdinalIgnoreCase);
        foreach (var hidden in new[] { "native-secret", "context-secret", "json-secret", "stdout-secret", "Bea", "Cy" })
        {
            Assert.DoesNotContain(hidden, result.Summary, StringComparison.Ordinal);
            Assert.DoesNotContain(hidden, result.Details, StringComparison.Ordinal);
        }
        var fileLine = Assert.Single(result.Details.Split('\n'), line => line.Contains(originalPath, StringComparison.Ordinal));
        Assert.DoesNotContain(originalPath, result.Details.Replace(fileLine, "", StringComparison.Ordinal), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("read", "System.UnauthorizedAccessException", null, null)]
    [InlineData("write", "System.Security.AccessControl.PrivilegeNotHeldException", null, null)]
    [InlineData("read", "System.ComponentModel.Win32Exception", 5L, null)]
    [InlineData("write", "System.ComponentModel.Win32Exception", 1314L, null)]
    [InlineData("write", "System.ComponentModel.Win32Exception", 740L, null)]
    [InlineData("write", "System.IO.IOException", null, -2147024891L)]
    [InlineData("read", "System.IO.IOException", null, 2147943714L)]
    [InlineData("read", "System.IO.IOException", null, 2147943140L)]
    public void Typed_acl_privilege_evidence_offers_setup_only_admin_recovery(string operation, string exceptionType, long? nativeCode, long? hresult)
    {
        var failure = AclFailure(operation, exceptionType, hresult, nativeCode);
        failure["acl"]!["message"] = "Une restriction Windows empêche cette opération.";
        var result = UserFacingText.Render("", failure.ToJsonString(), 1);

        Assert.False(result.Ok);
        Assert.Contains("administrator", result.RecoveryAdvice!, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Setup", result.RecoveryAdvice!, StringComparison.Ordinal);
        Assert.Contains("retry", result.RecoveryAdvice!, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("initialize", "System.UnauthorizedAccessException", 5L, null, null, true)]
    [InlineData("launch", "System.UnauthorizedAccessException", 5L, null, null, true)]
    [InlineData("unknown", "System.UnauthorizedAccessException", 5L, null, null, true)]
    [InlineData("read", null, null, null, null, true)]
    [InlineData("write", "System.IO.FileNotFoundException", 2L, -2147024894L, null, true)]
    [InlineData("read", "System.Management.Automation.CommandNotFoundException", null, null, null, true)]
    [InlineData("read", "Other.UnauthorizedAccessException", null, null, null, true)]
    [InlineData("write", "System.UnauthorizedAccessException", 5L, null, "EPERM", true)]
    [InlineData("write", null, null, null, "EACCES", true)]
    [InlineData("write", "System.UnauthorizedAccessException", 5L, null, null, false)]
    public void Unrelated_or_unconfirmed_errors_never_offer_admin_recovery(string operation, string? exceptionType, long? nativeCode, long? hresult, string? processCode, bool requiresElevation)
    {
        var failure = AclFailure(operation, exceptionType, hresult, nativeCode, processCode, requiresElevation);
        failure["acl"]!["message"] = "Access is denied; a required privilege is not held.";
        var result = UserFacingText.Render("", failure.ToJsonString(), 1);

        Assert.False(result.Ok);
        Assert.Null(result.RecoveryAdvice);
        Assert.Contains("Access is denied", result.Details, StringComparison.Ordinal);
        if (processCode is not null) Assert.Contains(processCode, result.Details, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("path", "\"relative.json\"")]
    [InlineData("message", "7")]
    [InlineData("operation", "\"remove\"")]
    [InlineData("requiresElevation", "\"true\"")]
    [InlineData("exceptionType", "{}")]
    [InlineData("nativeErrorCode", "\"5\"")]
    [InlineData("hresult", "4294967296")]
    [InlineData("exitCode", "1.5")]
    [InlineData("processCode", "false")]
    public void Malformed_acl_details_remain_redacted_without_admin_recovery(string property, string value)
    {
        var failure = AclFailure();
        failure["acl"]![property] = JsonNode.Parse(value);
        failure["password"] = "malformed-secret";
        var result = UserFacingText.Render("", failure.ToJsonString(), 1);

        Assert.False(result.Ok);
        Assert.Null(result.RecoveryAdvice);
        Assert.DoesNotContain("Ada", result.Details, StringComparison.Ordinal);
        Assert.DoesNotContain("malformed-secret", result.Details, StringComparison.Ordinal);
    }

    [Fact]
    public void Incomplete_duplicate_or_oversized_acl_details_do_not_unlock_path_display_or_admin_recovery()
    {
        var incomplete = AclFailure();
        incomplete["acl"]!.AsObject().Remove("exceptionType");
        var oversized = AclFailure();
        oversized["acl"]!["message"] = new string('x', 2049);
        var complete = AclFailure().ToJsonString();
        var duplicate = complete.Replace("\"requiresElevation\":true", "\"requiresElevation\":false,\"requiresElevation\":true", StringComparison.Ordinal);
        foreach (var output in new[] { incomplete.ToJsonString(), oversized.ToJsonString(), duplicate })
        {
            var result = UserFacingText.Render("", output, 1);
            Assert.False(result.Ok);
            Assert.Null(result.RecoveryAdvice);
            Assert.DoesNotContain("Ada", result.Details, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void Successful_stdout_is_not_replaced_by_unstructured_stderr_and_acl_data_cannot_turn_success_into_admin_advice()
    {
        var output = AclFailure();
        output["ok"] = true;
        var result = UserFacingText.Render(output.ToJsonString(), "A diagnostic notice", 0);

        Assert.True(result.Ok);
        Assert.Null(result.RecoveryAdvice);
        Assert.DoesNotContain("Ada", result.Details, StringComparison.Ordinal);
    }

    [Fact]
    public void Stdout_acl_failure_remains_actionable_and_stderr_failure_takes_precedence_over_stdout()
    {
        var failure = AclFailure().ToJsonString();
        var stdout = UserFacingText.Render(failure, "", 1);
        var stderr = UserFacingText.Render("{\"ok\":true,\"message\":\"Earlier operation finished\"}", failure, 1);
        foreach (var result in new[] { stdout, stderr })
        {
            Assert.False(result.Ok);
            Assert.Contains(@"C:\Users\Ada", result.Details, StringComparison.Ordinal);
            Assert.Contains("administrator", result.RecoveryAdvice!, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{\"ok\":false,\"message\":\"Access is denied\",")]
    [InlineData("Access is denied; token=raw-secret")]
    public void Nonobject_or_partial_output_falls_back_without_dropping_stderr_or_classifying_error_text(string stderr)
    {
        var result = UserFacingText.Render(@"Started C:\Users\Ada\staged.json", stderr, 1);

        Assert.False(result.Ok);
        Assert.Null(result.RecoveryAdvice);
        Assert.DoesNotContain("Ada", result.Details, StringComparison.Ordinal);
        Assert.DoesNotContain("raw-secret", result.Details, StringComparison.Ordinal);
        Assert.Contains(UserFacingText.Redact(stderr), result.Details, StringComparison.Ordinal);
    }

    [Fact]
    public void Provisioning_failure_preserves_actionable_acl_error_and_rollback_context()
    {
        var failure = AclFailure();
        failure["code"] = "MCP_ROLLBACK_FAILED";
        failure["message"] = "Rollback remains incomplete.";
        var result = UserFacingText.WithProvisioningFailureContext(UserFacingText.Render("", failure.ToJsonString(), 1), true);

        Assert.False(result.Ok);
        Assert.True(result.CleanupPending);
        Assert.Null(result.Connection);
        Assert.Contains(@"C:\Users\Ada", result.Details, StringComparison.Ordinal);
        Assert.Contains("Rollback remains incomplete", result.Details, StringComparison.Ordinal);
        Assert.Contains("retained", result.Details, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("administrator", result.RecoveryAdvice!, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("retry", result.RecoveryAdvice!, StringComparison.OrdinalIgnoreCase);
    }

    private static JsonObject AclFailure(string operation = "write", string? exceptionType = "System.UnauthorizedAccessException",
        long? hresult = -2147024891, long? nativeErrorCode = 5, string? processCode = null, bool requiresElevation = true) => new()
    {
        ["ok"] = false,
        ["code"] = "MCP_ACL_PRESERVE_FAILED",
        ["message"] = "Windows file permissions could not be preserved.",
        ["acl"] = new JsonObject
        {
            ["path"] = @"C:\Users\Ada\AppData\Local\PotassiumMcp.transaction.json",
            ["operation"] = operation,
            ["message"] = "Access to the security descriptor was denied.",
            ["exceptionType"] = exceptionType,
            ["hresult"] = hresult,
            ["nativeErrorCode"] = nativeErrorCode,
            ["processCode"] = processCode,
            ["exitCode"] = 1,
            ["requiresElevation"] = requiresElevation
        }
    };

    private sealed class InstallationFixture : IDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "PotassiumMcp.Setup.Tests", Guid.NewGuid().ToString("N"));
        public string App => Path.Combine(Root, "application");
        public string Private => Path.Combine(Root, "private");
        public string Workspace => Path.Combine(Root, "executor", "workspace");
        public string Config => Path.Combine(Private, "config.json");
        public string Token => Path.Combine(Workspace, ".potassium-mcp-token");
        public string Secret { get; } = new('7', 64);
        public BundleManifest Manifest { get; }
        public WindowsReceipt Receipt { get; }
        public string VersionRoot { get; }
        public string PackageRoot => Path.Combine(VersionRoot, BundleValidation.RequiredEntries.PackageRoot.Replace('/', Path.DirectorySeparatorChar));
        private readonly Dictionary<string, byte[]> files;

        public InstallationFixture()
        {
            Directory.CreateDirectory(App);
            Directory.CreateDirectory(Private);
            Directory.CreateDirectory(Workspace);
            files = new(StringComparer.Ordinal)
            {
                [BundleValidation.RequiredEntries.Node] = Encoding.UTF8.GetBytes("fixture node; never executed"),
                [BundleValidation.RequiredEntries.Cli] = Encoding.UTF8.GetBytes("fixture cli; never executed"),
                [BundleValidation.RequiredEntries.Launcher] = Encoding.UTF8.GetBytes("fixture launcher; never executed"),
                [BundleValidation.RequiredEntries.PackageRoot + "/src/proxy.js"] = Encoding.UTF8.GetBytes("fixture proxy; never executed"),
                [BundleValidation.RequiredEntries.PackageRoot + "/package.json"] = Encoding.UTF8.GetBytes("{\"name\":\"@mrketa/potassium-mcp\",\"version\":\"9.1.0\",\"potassiumMcpRuntime\":{\"ownershipSchema\":3,\"launcherProtocol\":1}}")
            };
            Manifest = new(1, "9.1.0", "22.0.0", BundleValidation.RequiredEntries, files.Select(pair => new BundleFile(pair.Key, WindowsInstallation.Hash(pair.Value), pair.Value.Length)).ToArray());
            var manifest = Encoding.UTF8.GetBytes(Serialize(Manifest));
            var id = WindowsInstallation.Hash(manifest);
            VersionRoot = Path.Combine(App, "versions", id);
            Directory.CreateDirectory(VersionRoot);
            foreach (var pair in files)
            {
                var path = Path.Combine(VersionRoot, pair.Key.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllBytes(path, pair.Value);
            }
            File.WriteAllBytes(Path.Combine(VersionRoot, WindowsInstallation.ManifestName), manifest);
            Receipt = new(1, App, Private, [new(id, "versions/" + id)], [WindowsInstallation.Hash(files[BundleValidation.RequiredEntries.Launcher])]);
            File.WriteAllText(Path.Combine(App, WindowsInstallation.ReceiptName), Serialize(Receipt));
            File.WriteAllBytes(Path.Combine(App, WindowsInstallation.LauncherName), files[BundleValidation.RequiredEntries.Launcher]);
            var connection = WindowsInstallation.Connection(App);
            File.WriteAllText(connection.FilePath, connection.Json);
            File.WriteAllText(Config, "{\"hostPolicies\":{\"agent\":{\"read\":true,\"admin\":false,\"execute\":false}}}");
            File.WriteAllText(Token, Secret);
            WriteOwnership();
        }

        public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });

        public void WriteOwnership(string status = "active", string? packageRoot = null)
        {
            var state = new { schema = 3, status, installRoot = Private, workspaceRoot = Workspace, configPath = Config, tokenPath = Token,
                configSha256 = WindowsInstallation.FileHash(Config), tokenSha256 = WindowsInstallation.FileHash(Token), serverSha256 = WindowsInstallation.Hash(files[BundleValidation.RequiredEntries.PackageRoot + "/src/proxy.js"]),
                runtime = new { mode = "external", root = packageRoot ?? PackageRoot, nodeExecutable = Path.Combine(VersionRoot, "node", "node.exe"), nodeSha256 = WindowsInstallation.Hash(files[BundleValidation.RequiredEntries.Node]) }, hosts = new { } };
            File.WriteAllText(Path.Combine(Private, "ownership.json"), Serialize(state));
        }

        public MemoryStream Archive(bool extraFile = false, bool changeNode = false, bool linkNode = false, bool aliasNode = false)
        {
            var bytes = new MemoryStream();
            using (var archive = new ZipArchive(bytes, ZipArchiveMode.Create, true))
            {
                foreach (var pair in files)
                {
                    var node = pair.Key == BundleValidation.RequiredEntries.Node;
                    var entry = archive.CreateEntry(aliasNode && node ? "./" + pair.Key : pair.Key);
                    if (node && linkNode) entry.ExternalAttributes = 0xA000 << 16;
                    using var output = entry.Open();
                    output.Write(node && changeNode ? Encoding.UTF8.GetBytes("changed") : pair.Value);
                }
                if (extraFile) archive.CreateEntry("foreign.txt");
            }
            bytes.Position = 0;
            return bytes;
        }
        public void Dispose() { if (Directory.Exists(Root)) Directory.Delete(Root, true); }
    }
}
