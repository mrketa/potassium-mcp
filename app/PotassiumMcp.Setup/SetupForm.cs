namespace PotassiumMcp.Setup;

public sealed class SetupForm : Form
{
    private readonly SetupOptions options;
    private readonly SetupRunner runner = new();
    private readonly Button install = ActionButton("&Install", "Install Potassium MCP");
    private readonly Button check = ActionButton("&Check connection", "Check connection");
    private readonly Button repair = ActionButton("&Repair", "Repair installation");
    private readonly Button remove = ActionButton("&Remove…", "Remove installation");
    private readonly Button browseWorkspace = ActionButton("Change &folder…", "Change workspace folder");
    private readonly Button copyConfiguration = ActionButton("Copy confi&guration", "Copy configuration");
    private readonly Button copyCommand = ActionButton("Copy co&mmand", "Copy command");
    private readonly Button copyPath = ActionButton("Copy &path", "Copy configuration file path");
    private readonly Button close = ActionButton("Close", "Close setup");
    private readonly LinkLabel maintenance = Link("Maintenance", "Installation maintenance");
    private readonly LinkLabel showDetails = Link("Show details", "Show operation details");
    private readonly TextBox workspace = ReadOnlyField("Potassium workspace folder");
    private readonly TextBox command = ReadOnlyField("Stable MCP command");
    private readonly TextBox connectionPath = ReadOnlyField("Connection configuration file path");
    private readonly Label workspaceStatus = Paragraph("", "Workspace discovery status");
    private readonly Label status = Paragraph("", "Setup status");
    private readonly Label connectionStatus = Paragraph("", "MCP and executor connection status");
    private readonly Label warning = Paragraph("", "Setup attention required");
    private readonly Label copyStatus = Paragraph("", "Clipboard status");
    private readonly TextBox details = new()
    {
        Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false,
        Dock = DockStyle.Top, Height = 140, AccessibleName = "Operation details", Visible = false
    };
    private readonly TableLayoutPanel maintenancePanel = Column("Maintenance actions");
    private readonly TableLayoutPanel connectionPanel = Column("Connect an MCP-capable harness");
    private readonly Panel scroll;
    private ConnectionInfo? connection;
    private bool busy;
    private bool installed;

    public SetupForm(SetupOptions options)
    {
        this.options = options;
        SuspendLayout();
        Text = "Potassium MCP Setup";
        AccessibleName = "Potassium MCP Setup";
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96F, 96F);
        Font = new Font("Segoe UI", 10F);
        ClientSize = new Size(740, 590);
        MinimumSize = new Size(580, 440);

        var shell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        scroll = new Panel { Dock = DockStyle.Fill, AutoScroll = true, Padding = new Padding(24, 20, 24, 8), TabIndex = 0 };
        var content = Column("Setup and connection");
        scroll.Controls.Add(content);
        shell.Controls.Add(scroll, 0, 0);
        Controls.Add(shell);

        var heading = Paragraph("Install Potassium MCP", "Setup purpose");
        heading.Font = new Font(Font.FontFamily, 16F, FontStyle.Bold);
        Add(content, heading);
        Add(content, Paragraph("Set up one local MCP connection for any MCP-capable harness. No app selection or automatic app configuration is needed.", "Setup introduction"));
        Add(content, Paragraph("Potassium workspace", "Workspace label"));
        Add(content, workspace);
        Add(content, workspaceStatus);
        Add(content, Row("Workspace actions", browseWorkspace));

        Add(content, Row("Setup actions", install, check, maintenance));
        Add(maintenancePanel, Row("Maintenance commands", repair, remove));
        Add(maintenancePanel, Paragraph("Remove deletes only verified app-owned files. Private settings, credentials and artifacts are kept. Remove the MCP entry from your harness yourself.", "Removal information"));
        maintenancePanel.Visible = false;
        Add(content, maintenancePanel);

        status.Font = new Font(Font, FontStyle.Bold);
        Add(content, status);
        Add(content, warning);
        Add(content, connectionStatus);
        Add(connectionPanel, Paragraph("Connect your harness", "Connection instructions heading"));
        Add(connectionPanel, Paragraph("Copy configuration into your harness’s MCP settings, keeping existing servers. The file below has the same token-free settings. Restart or reload your harness to connect.", "Connection instructions"));
        Add(connectionPanel, Row("Copy connection information", copyConfiguration, copyCommand, copyPath));
        Add(connectionPanel, copyStatus);
        Add(connectionPanel, Paragraph("Command · no arguments", "Command label"));
        Add(connectionPanel, command);
        Add(connectionPanel, Paragraph("Configuration file", "Configuration file label"));
        Add(connectionPanel, connectionPath);
        connectionPanel.Visible = false;
        Add(content, connectionPanel);
        Add(content, showDetails);
        Add(content, details);

        var footer = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 2, Padding = new Padding(24, 8, 24, 12), TabIndex = 1 };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var license = Link("Licenses and notices", "Licenses and notices");
        license.LinkClicked += (_, _) => ShowNotices();
        footer.Controls.Add(license, 0, 0);
        footer.Controls.Add(close, 1, 0);
        close.TabIndex = 1;
        shell.Controls.Add(footer, 0, 1);

        workspace.Text = options.WorkspaceRoot ?? runner.DiscoverWorkspace() ?? "";
        workspaceStatus.Text = string.IsNullOrWhiteSpace(workspace.Text)
            ? "Workspace not found. Choose your existing Potassium workspace with Change folder."
            : options.WorkspaceRoot is not null ? "Using the workspace supplied to Setup." : "Using the discovered Potassium workspace.";
        var state = runner.GetInstallationState(options);
        installed = state.Installed;
        status.Text = state.Summary;
        SetConnection(state.Connection);
        showDetails.Visible = false;
        warning.Visible = false;
        connectionStatus.Visible = false;

        maintenance.LinkClicked += (_, _) => TogglePanel(maintenancePanel, maintenance, "Maintenance", "Hide maintenance");
        showDetails.LinkClicked += (_, _) =>
        {
            details.Visible = !details.Visible;
            showDetails.Text = details.Visible ? "Hide details" : "Show details";
            if (details.Visible) details.Focus();
        };
        browseWorkspace.Click += (_, _) => BrowseWorkspace();
        install.Click += async (_, _) => await ExecuteAsync("install");
        check.Click += async (_, _) => await ExecuteAsync("check");
        repair.Click += async (_, _) => await ExecuteAsync("repair");
        remove.Click += async (_, _) => await ExecuteAsync("uninstall");
        copyConfiguration.Click += (_, _) => CopyConnection(connection?.Json, "Configuration copied.");
        copyCommand.Click += (_, _) => CopyConnection(connection?.Command, "Command copied. Use it without arguments.");
        copyPath.Click += (_, _) => CopyConnection(connection?.FilePath, "Configuration file path copied.");
        close.Click += (_, _) => Close();
        FormClosing += (_, eventArgs) =>
        {
            if (!busy) return;
            eventArgs.Cancel = true;
            warning.Text = "Please wait for the current operation to finish before closing Setup. No process has been stopped.";
            warning.Visible = true;
        };
        AcceptButton = install;
        CancelButton = close;
        UpdateControls();
        ResumeLayout(true);
    }

    private async Task ExecuteAsync(string operation)
    {
        if (busy) return;
        if (operation is "install" or "repair" && !Directory.Exists(workspace.Text))
        {
            workspaceStatus.Text = "Choose an existing Potassium workspace with Change folder before continuing.";
            browseWorkspace.Focus();
            UpdateControls();
            return;
        }
        if (operation == "uninstall" && MessageBox.Show(this,
            "Remove Potassium MCP from this application folder?\n\nPrivate settings, credentials and artifacts will be kept. Close MCP sessions first. Remove the connection from your harness’s settings yourself.",
            "Remove Potassium MCP", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;

        var revealConnection = false;
        busy = true;
        SetConnection(null);
        warning.Visible = false;
        connectionStatus.Visible = false;
        details.Clear();
        details.Visible = false;
        showDetails.Text = "Show details";
        showDetails.Visible = false;
        status.Text = operation == "check" ? "Checking the installed MCP connection…" : "Working locally. Please keep Setup open…";
        UpdateControls();
        try
        {
            var progress = new Progress<string>(message => status.Text = UserFacingText.Redact(message));
            var response = await runner.RunAsync(new CliRequest(operation,
                string.IsNullOrWhiteSpace(workspace.Text) ? null : workspace.Text,
                options.InstallRoot, options.ApplicationRoot), progress);
            status.Text = response.Summary;
            details.Text = response.Details;
            showDetails.Visible = !string.IsNullOrWhiteSpace(response.Details);
            var notices = new List<string>();
            if (response.CleanupPending)
                notices.Add("Cleanup is pending. Some files may still be in use. Close MCP sessions, then retry the operation; see details before making further changes.");
            if (response.RestartRequired)
                notices.Add("Restart or reload your MCP harness before using the connection again. Follow any additional restart instructions in the details.");
            warning.Text = string.Join(Environment.NewLine, notices);
            warning.Visible = notices.Count > 0;
            if (operation == "check")
            {
                connectionStatus.Text = $"MCP connection: {ConnectionState(response.McpConnected)}.  Potassium executor: {ExecutorState(response.ExecutorConnected)}.";
                connectionStatus.Visible = true;
            }
            if (response.Ok && !response.CleanupPending)
            {
                if (operation == "uninstall") installed = false;
                else if (operation is "install" or "repair") installed = true;
                SetConnection(operation == "uninstall" ? null : response.Connection);
                if (operation is "install" or "repair" && response.Connection is not null)
                {
                    maintenancePanel.Visible = false;
                    maintenance.Text = "Maintenance";
                    revealConnection = true;
                }
            }
            if (!response.Ok && showDetails.Visible)
            {
                details.Visible = true;
                showDetails.Text = "Hide details";
            }
        }
        catch (Exception exception)
        {
            status.Text = "Setup could not finish. No successful outcome has been confirmed.";
            details.Text = UserFacingText.Redact(exception.Message);
            details.Visible = true;
            showDetails.Visible = true;
            showDetails.Text = "Hide details";
        }
        finally
        {
            busy = false;
            UpdateControls();
            if (revealConnection)
            {
                scroll.ScrollControlIntoView(status);
                copyConfiguration.Focus();
                scroll.ScrollControlIntoView(copyConfiguration);
            }
        }
    }

    private void BrowseWorkspace()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose your existing Potassium workspace", UseDescriptionForTitle = true,
            ShowNewFolderButton = false, SelectedPath = Directory.Exists(workspace.Text) ? workspace.Text : ""
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        workspace.Text = dialog.SelectedPath;
        workspaceStatus.Text = "Using the selected workspace. Install or Repair applies this folder.";
        SetConnection(null);
        connectionStatus.Visible = false;
        UpdateControls();
    }

    private void SetConnection(ConnectionInfo? value)
    {
        connection = value;
        command.Text = value?.Command ?? "";
        connectionPath.Text = value?.FilePath ?? "";
        connectionPanel.Visible = value is not null;
        copyStatus.Text = "";
        copyStatus.Visible = false;
    }

    private void UpdateControls()
    {
        var validWorkspace = Directory.Exists(workspace.Text);
        install.Text = installed ? "&Update" : "&Install";
        install.AccessibleName = installed ? "Update Potassium MCP" : "Install Potassium MCP";
        install.Enabled = !busy && validWorkspace;
        repair.Enabled = !busy && validWorkspace;
        check.Enabled = !busy && Directory.Exists(options.ApplicationRoot);
        remove.Enabled = !busy && Directory.Exists(options.ApplicationRoot);
        maintenance.Enabled = !busy;
        browseWorkspace.Enabled = !busy;
        close.Enabled = !busy;
        copyConfiguration.Enabled = !busy && connection is not null && !string.IsNullOrWhiteSpace(connection.Json);
        copyCommand.Enabled = !busy && connection is not null && !string.IsNullOrWhiteSpace(connection.Command);
        copyPath.Enabled = !busy && connection is not null && !string.IsNullOrWhiteSpace(connection.FilePath);
        UseWaitCursor = busy;
    }

    private void CopyConnection(string? value, string confirmation)
    {
        if (busy || connection is null || string.IsNullOrWhiteSpace(value)) return;
        try
        {
            Clipboard.SetText(value);
            copyStatus.Text = confirmation;
        }
        catch (System.Runtime.InteropServices.ExternalException)
        {
            copyStatus.Text = "The clipboard is busy. Try copying again.";
        }
        copyStatus.Visible = true;
    }

    private void ShowNotices()
    {
        try
        {
            using var dialog = new Form
            {
                Text = "Licenses and notices", AccessibleName = "Licenses and notices",
                StartPosition = FormStartPosition.CenterParent, ClientSize = new Size(640, 440),
                MinimumSize = new Size(400, 300), Font = Font, AutoScaleMode = AutoScaleMode.Dpi,
                MinimizeBox = false, ShowInTaskbar = false
            };
            var contents = new TextBox
            {
                Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical,
                Text = LegalNotices.ApacheLicense() + Environment.NewLine + Environment.NewLine + LegalNotices.NodeAttribution,
                AccessibleName = "License and attribution text", TabIndex = 0
            };
            var dismiss = ActionButton("Close", "Close licenses and notices");
            dismiss.Dock = DockStyle.Bottom;
            dismiss.DialogResult = DialogResult.OK;
            dismiss.TabIndex = 1;
            dialog.Controls.Add(contents);
            dialog.Controls.Add(dismiss);
            dialog.CancelButton = dismiss;
            dialog.ShowDialog(this);
        }
        catch (Exception exception)
        {
            MessageBox.Show(this, UserFacingText.Redact(exception.Message), "Notices unavailable", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static string ConnectionState(bool? connected) => connected switch { true => "connected", false => "not connected", null => "not confirmed" };
    private static string ExecutorState(bool? connected) => connected switch { true => "attached", false => "not attached", null => "not confirmed" };

    private static void TogglePanel(Control panel, LinkLabel link, string collapsed, string expanded)
    {
        panel.Visible = !panel.Visible;
        link.Text = panel.Visible ? expanded : collapsed;
    }

    private static Button ActionButton(string text, string name) => new()
    {
        Text = text, AccessibleName = name, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
        MinimumSize = new Size(88, 30), Padding = new Padding(8, 2, 8, 2), UseVisualStyleBackColor = true
    };

    private static LinkLabel Link(string text, string name) => new()
    {
        Text = text, AccessibleName = name, AutoSize = true, TabStop = true, Anchor = AnchorStyles.Left,
        Margin = new Padding(0, 6, 12, 6)
    };

    private static TextBox ReadOnlyField(string name) => new()
    {
        ReadOnly = true, AccessibleName = name, Dock = DockStyle.Top
    };

    private static Label Paragraph(string text, string name) => new()
    {
        Text = text, AccessibleName = name, AutoSize = true, Dock = DockStyle.Top,
        UseMnemonic = false, Margin = new Padding(0, 0, 0, 8)
    };

    private static TableLayoutPanel Column(string name)
    {
        var panel = new TableLayoutPanel
        {
            AccessibleName = name, Dock = DockStyle.Top, AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, RowCount = 0,
            Margin = Padding.Empty, TabStop = false
        };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        return panel;
    }

    private static void Add(TableLayoutPanel panel, Control control)
    {
        control.TabIndex = panel.RowCount;
        panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        panel.Controls.Add(control, 0, panel.RowCount++);
    }

    private static FlowLayoutPanel Row(string name, params Control[] controls)
    {
        var row = new FlowLayoutPanel
        {
            AccessibleName = name, Dock = DockStyle.Top, AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = true, Margin = new Padding(0, 4, 0, 8), TabStop = false
        };
        for (var index = 0; index < controls.Length; index++)
        {
            controls[index].TabIndex = index;
            row.Controls.Add(controls[index]);
        }
        return row;
    }
}
