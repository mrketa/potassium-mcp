using System.Diagnostics;

namespace PotassiumMcp.Setup;

public sealed class SetupForm : Form
{
    private readonly Dictionary<string, CheckBox> hosts = new(StringComparer.OrdinalIgnoreCase);
    private readonly RadioButton standard = new() { Text = "Standard setup (recommended)", Checked = true, AutoSize = true };
    private readonly RadioButton advanced = new() { Text = "Advanced: allow trusted local admin actions", AutoSize = true };
    private readonly CheckBox consent = new() { Text = "I understand this can let trusted local tools make changes.", AutoSize = true, Visible = false };
    private readonly Button install = new() { Text = "Install", AutoSize = true };
    private readonly Button repair = new() { Text = "Repair", AutoSize = true };
    private readonly Button uninstall = new() { Text = "Uninstall", AutoSize = true };
    private readonly Button doctor = new() { Text = "Check this PC", AutoSize = true };
    private readonly Button verify = new() { Text = "Live verify", AutoSize = true };
    private readonly TextBox workspaceRoot = new() { Width = 470, AccessibleName = "Potassium workspace folder" };
    private readonly TextBox autoexecRoot = new() { Width = 470, AccessibleName = "Potassium autoexec folder" };
    private readonly Button browseWorkspace = new() { Text = "Browse workspace…", AutoSize = true };
    private readonly Button browseAutoexec = new() { Text = "Browse autoexec…", AutoSize = true };
    private readonly TextBox projectRoot = new() { Width = 470, AccessibleName = "OMP project folder" };
    private readonly Button browseProject = new() { Text = "Browse project…", AutoSize = true };
    private readonly Label pathStatus = new() { AutoSize = true, MaximumSize = new Size(640, 0), ForeColor = Color.DimGray, AccessibleName = "Potassium path discovery status" };
    private readonly TextBox result = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, MinimumSize = new Size(620, 120), AccessibleName = "Setup results" };
    private readonly Label restart = new() { AutoSize = true, MaximumSize = new Size(640, 0) };
    private readonly SetupRunner runner = new();

    public SetupForm()
    {
        Text = "Potassium MCP Setup";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(720, 810);
        Font = new Font("Segoe UI", 10F);
        AccessibleName = "Potassium MCP Setup";
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(28), AutoScroll = true, ColumnCount = 1, RowCount = 1 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Controls.Add(layout);
        Add(layout, new Label { Text = "Connect Potassium MCP", Font = new Font(Font, FontStyle.Bold), AutoSize = true, AccessibleName = "Welcome" });
        Add(layout, new Label { Text = "This setup connects your AI app to Potassium on this PC. It only uses local setup commands. It does not sign in, send telemetry, or contact an AI provider.", AutoSize = true, MaximumSize = new Size(640, 0) });
        Add(layout, new Label { Text = "Choose the AI apps you use", Font = new Font(Font, FontStyle.Bold), AutoSize = true });
        var hostPanel = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, AccessibleName = "Supported AI apps" };
        foreach (var host in HostCatalog.CommonHosts)
        {
            var checkbox = new CheckBox { Text = DisplayHost(host), Tag = host, AutoSize = true, Checked = IsDetected(host), AccessibleName = DisplayHost(host) };
            hosts.Add(host, checkbox);
            hostPanel.Controls.Add(checkbox);
        }
        Add(layout, hostPanel);
        Add(layout, new Label { Text = "OMP project", Font = new Font(Font, FontStyle.Bold), AutoSize = true });
        Add(layout, FolderRow("Project", projectRoot, browseProject));
        Add(layout, new Label { Text = "Potassium folders", Font = new Font(Font, FontStyle.Bold), AutoSize = true });
        Add(layout, FolderRow("Workspace", workspaceRoot, browseWorkspace));
        Add(layout, FolderRow("Autoexec", autoexecRoot, browseAutoexec));
        Add(layout, pathStatus);
        Add(layout, new Label { Text = "Access level", Font = new Font(Font, FontStyle.Bold), AutoSize = true });
        Add(layout, standard);
        Add(layout, advanced);
        Add(layout, new Label { Text = "Advanced access is off by default. Turn it on only if you trust the local AI tools that will use Potassium MCP. You can change this later by running setup again.", AutoSize = true, MaximumSize = new Size(640, 0), ForeColor = Color.Maroon });
        Add(layout, consent);
        var actions = new FlowLayoutPanel { AutoSize = true, WrapContents = true, AccessibleName = "Setup actions" };
        actions.Controls.AddRange([install, repair, uninstall, doctor, verify]);
        Add(layout, actions);
        Add(layout, restart);
        Add(layout, result, fill: true);
        var footer = new FlowLayoutPanel { AutoSize = true };
        var license = new LinkLabel { Text = "Potassium license (Apache-2.0)", AutoSize = true };
        var attribution = new LinkLabel { Text = "Node.js attribution", AutoSize = true };
        license.Click += (_, _) => ShowText("Potassium MCP license", LegalNotices.ApacheLicense());
        attribution.Click += (_, _) => ShowText("Node.js attribution", LegalNotices.NodeAttribution);
        footer.Controls.AddRange([license, attribution]);
        Add(layout, footer);
        browseWorkspace.Click += (_, _) => BrowseForFolder(workspaceRoot, "Choose the Potassium workspace folder");
        browseAutoexec.Click += (_, _) => BrowseForFolder(autoexecRoot, "Choose the Potassium autoexec folder");
        browseProject.Click += (_, _) => BrowseForFolder(projectRoot, "Choose the OMP project folder");
        var discovery = PotassiumPathDiscoveryService.Discover(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
        workspaceRoot.Text = discovery.WorkspaceRoot ?? "";
        autoexecRoot.Text = discovery.AutoexecRoot ?? "";
        pathStatus.Text = discovery.Status;
        advanced.CheckedChanged += (_, _) => { consent.Visible = advanced.Checked; consent.Checked = false; };
        install.Click += async (_, _) => await ExecuteAsync("install");
        repair.Click += async (_, _) => await ExecuteAsync("repair");
        uninstall.Click += async (_, _) => await ExecuteAsync("uninstall");
        doctor.Click += (_, _) => RunStaticDoctor();
        verify.Click += async (_, _) => await ExecuteAsync("verify");
        restart.Text = HostCatalog.RestartInstructions(SelectedHosts());
        foreach (var host in hosts.Values) host.CheckedChanged += (_, _) => restart.Text = HostCatalog.RestartInstructions(SelectedHosts());
    }

    private static void Add(TableLayoutPanel layout, Control control, bool fill = false)
    {
        control.Margin = new Padding(0, 0, 0, 12);
        layout.RowStyles.Add(new RowStyle(fill ? SizeType.Percent : SizeType.AutoSize, fill ? 100 : 0));
        layout.Controls.Add(control, 0, layout.RowCount++);
        if (fill) control.Dock = DockStyle.Fill;
    }

    private static FlowLayoutPanel FolderRow(string label, TextBox textBox, Button browse)
    {
        var row = new FlowLayoutPanel { AutoSize = true, WrapContents = true, AccessibleName = label + " folder" };
        row.Controls.AddRange([new Label { Text = label + ":", AutoSize = true, Margin = new Padding(0, 6, 8, 0) }, textBox, browse]);
        return row;
    }

    private async Task ExecuteAsync(string command)
    {
        var selected = SelectedHosts();
        if (command is "install" or "repair" && selected.Count == 0)
        {
            result.Text = "Choose at least one AI app before continuing.";
            return;
        }
        if (command is "install" or "repair" && (!Directory.Exists(workspaceRoot.Text) || !Directory.Exists(autoexecRoot.Text)))
        {
            result.Text = "Choose existing Potassium workspace and autoexec folders before continuing.";
            return;
        }
        if (command is "install" or "repair" && selected.Contains("omp", StringComparer.OrdinalIgnoreCase) && !ProjectDirectory.IsValid(projectRoot.Text))
        {
            result.Text = "Choose an existing OMP project folder before continuing.";
            return;
        }
        if (advanced.Checked && !AdminConsent.IsAllowed(true, consent.Checked))
        {
            result.Text = "To use advanced access, first confirm that you understand the warning.";
            consent.Focus();
            return;
        }
        SetBusy(true);
        result.Text = command == "verify" ? "Checking your installed connection…" : "Working locally…";
        try
        {
            var responses = new List<CliResult>();
            if (command is "install" or "repair")
            {
                var allowUnsafeExecute = AdminConsent.IsAllowed(advanced.Checked, consent.Checked);
                var userHosts = selected.Where(host => !string.Equals(host, "omp", StringComparison.OrdinalIgnoreCase)).ToArray();
                if (userHosts.Length > 0)
                    responses.Add(await RunRequestAsync(new CliRequest(command, userHosts, "user", "bundled-package.tgz", allowUnsafeExecute, workspaceRoot.Text, autoexecRoot.Text)));
                if (selected.Contains("omp", StringComparer.OrdinalIgnoreCase))
                    responses.Add(await RunRequestAsync(new CliRequest(command, ["omp"], "project", "bundled-package.tgz", allowUnsafeExecute, workspaceRoot.Text, autoexecRoot.Text, projectRoot.Text)));
            }
            else
            {
                responses.Add(await RunRequestAsync(new CliRequest(command, Array.Empty<string>(), "", "")));
            }
            var response = CliResults.Combine(responses);
            result.Text = response.Summary + Environment.NewLine + Environment.NewLine + response.Details;
        }
        catch (Exception exception)
        {
            result.Text = "Setup could not finish." + Environment.NewLine + Environment.NewLine + UserFacingText.Redact(exception.Message);
        }
        finally { SetBusy(false); }
    }

    private async Task<CliResult> RunRequestAsync(CliRequest request)
    {
        try
        {
            return await runner.RunAsync(request);
        }
        catch (Exception exception)
        {
            return new CliResult(false, "Setup could not finish.", UserFacingText.Redact(exception.Message));
        }
    }

    private List<string> SelectedHosts() => hosts.Where(pair => pair.Value.Checked).Select(pair => pair.Key).ToList();
    private void SetBusy(bool busy)
    {
        UseWaitCursor = busy;
        foreach (var button in new[] { install, repair, uninstall, doctor, verify, browseWorkspace, browseAutoexec, browseProject }) button.Enabled = !busy;
    }
    private void BrowseForFolder(TextBox target, string title)
    {
        using var dialog = new FolderBrowserDialog { Description = title, UseDescriptionForTitle = true, SelectedPath = Directory.Exists(target.Text) ? target.Text : "" };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            target.Text = dialog.SelectedPath;
            pathStatus.Text = "Using the folders you selected.";
        }
    }
    private static void ShowText(string title, string text)
    {
        using var dialog = new Form { Text = title, StartPosition = FormStartPosition.CenterParent, Size = new Size(700, 560), MinimizeBox = false, MaximizeBox = false };
        var contents = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Text = text, AccessibleName = title };
        dialog.Controls.Add(contents);
        dialog.ShowDialog();
    }
    private static string DisplayHost(string host) => host switch { "claude-code" => "Claude Code", "claude-desktop" => "Claude Desktop", "vscode" => "VS Code", "omp" => "OMP", _ => char.ToUpperInvariant(host[0]) + host[1..] };
    private static bool IsDetected(string host) => host switch
    {
        "claude-desktop" => File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Claude", "claude_desktop_config.json")),
        "cursor" => Directory.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Cursor")),
        "vscode" => Directory.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Code")),
        _ => false
    };

    private void RunStaticDoctor()
    {
        var detected = hosts.Where(pair => IsDetected(pair.Key)).Select(pair => DisplayHost(pair.Key)).ToArray();
        var selected = SelectedHosts();
        result.Text = "This PC check does not contact a service." + Environment.NewLine + Environment.NewLine +
            (detected.Length == 0 ? "No supported AI app was detected automatically. You can still choose one from the list above." : "Detected: " + string.Join(", ", detected) + ".") +
            Environment.NewLine + (selected.Count == 0 ? "No app is selected yet." : "Selected: " + string.Join(", ", selected) + ".") +
            Environment.NewLine + "Use Live verify after installation to check the local MCP connection.";
    }
}
