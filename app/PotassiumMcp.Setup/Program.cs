using System.ComponentModel;
using System.Diagnostics;
using System.Security.Principal;

namespace PotassiumMcp.Setup;

internal static class Program
{
    private const string ElevatedUserArgument = "--elevated-user";

    [STAThread]
    private static void Main(string[] args)
    {
        if (Array.IndexOf(args, "--verify-bundle") >= 0)
        {
            try
            {
                if (args.Length != 1)
                    throw new ArgumentException("--verify-bundle cannot be combined with other arguments.");
                Console.Out.WriteLine(new SetupRunner().VerifyEmbeddedBundle());
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine(System.Text.Json.JsonSerializer.Serialize(new
                {
                    valid = false,
                    error = UserFacingText.Redact(exception.Message)
                }));
                Environment.ExitCode = 1;
            }
            return;
        }

        ApplicationConfiguration.Initialize();
        try
        {
            if (!EnsureElevated(ref args)) return;
            var options = SetupOptions.Parse(args);
            Application.Run(new SetupForm(options));
        }
        catch (Exception exception)
        {
            MessageBox.Show(
                UserFacingText.Redact(exception.Message),
                "Potassium MCP Setup could not start",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Environment.ExitCode = 1;
        }
    }

    private static bool EnsureElevated(ref string[] args)
    {
        using var identity = WindowsIdentity.GetCurrent();
        var user = identity.User?.Value ?? throw new UnauthorizedAccessException("Setup could not identify the current Windows account.");
        var relaunched = args.Length > 0 && args[0] == ElevatedUserArgument;
        if (relaunched)
        {
            if (args.Length < 2 || !string.Equals(args[1], user, StringComparison.Ordinal))
                throw new UnauthorizedAccessException("Setup must be approved by the same Windows account that opened it. Using another administrator account would change the per-user installation and private-file ownership. No installation was started.");
            args = args[2..];
        }

        // The marker prevents retries and account switches; only the actual token grants access.
        if (new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) return true;
        if (relaunched)
            throw new UnauthorizedAccessException("Setup requires administrator approval. Windows did not grant administrator access, so no installation was started.");

        var start = new ProcessStartInfo(Environment.ProcessPath ?? throw new InvalidOperationException("Setup could not locate its executable."))
        {
            UseShellExecute = true,
            Verb = "runas",
            WorkingDirectory = Environment.CurrentDirectory
        };
        start.ArgumentList.Add(ElevatedUserArgument);
        start.ArgumentList.Add(user);
        foreach (var argument in args) start.ArgumentList.Add(argument);

        Process elevated;
        try
        {
            elevated = Process.Start(start) ?? throw new InvalidOperationException("Windows did not start the administrator instance of Setup.");
        }
        catch (Win32Exception exception) when (exception.NativeErrorCode is 5 or 1223)
        {
            throw new UnauthorizedAccessException("Administrator approval was cancelled or denied. Setup cannot continue without it. No installation was started.", exception);
        }
        using (elevated)
        {
            elevated.WaitForExit();
            Environment.ExitCode = elevated.ExitCode;
        }
        return false;
    }
}
