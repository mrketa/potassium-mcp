using System.Diagnostics;
using PotassiumMcp.Setup;

namespace PotassiumMcp.Launcher;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("Potassium MCP Launcher 1.0.0"); return 0; }
        if (args.Length == 1 && args[0] == "--help")
        {
            Console.WriteLine("Potassium MCP Launcher\nRun without arguments for local MCP stdio. Uses this application's verified installation and the agent access identity.\nOptions: --help, --version");
            return 0;
        }
        if (args.Length != 0) { Console.Error.WriteLine("Unsupported launcher arguments. Use no arguments for MCP stdio, --help or --version."); return 2; }
        try
        {
            var applicationRoot = WindowsInstallation.CanonicalPath(AppContext.BaseDirectory);
            using var lease = WindowsInstallation.AcquireLock(applicationRoot, false);
            var receipt = WindowsInstallation.ReadReceipt(applicationRoot) ?? throw new InvalidDataException("This launcher has no application ownership receipt. Run Setup.exe.");
            var runtime = WindowsInstallation.ResolveActive(applicationRoot, receipt);
            var start = WindowsInstallation.StartInfo(runtime.Node, applicationRoot);
            start.RedirectStandardInput = start.RedirectStandardOutput = start.RedirectStandardError = true;
            foreach (var argument in new[] { runtime.Cli, "serve", "--config", runtime.Config, "--host-id", "agent" }) start.ArgumentList.Add(argument);
            WindowsInstallation.PreventStandardHandleInheritance();
            using var child = Process.Start(start) ?? throw new IOException("The verified Node runtime could not start.");
            using var cancellation = new CancellationTokenSource();
            ConsoleCancelEventHandler interrupt = (_, eventArgs) => { eventArgs.Cancel = true; cancellation.Cancel(); };
            Console.CancelKeyPress += interrupt;
            using var outputCancellation = new CancellationTokenSource();
            try
            {
                var input = CopyInput(Console.OpenStandardInput(), child.StandardInput.BaseStream, cancellation.Token);
                var output = CopyOutput(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), outputCancellation.Token);
                // Child diagnostics are drained, never mixed with MCP stdout or persisted as raw traffic.
                var diagnostics = Drain(child.StandardError.BaseStream);
                var exit = child.WaitForExitAsync();
                var interrupted = Task.Delay(Timeout.Infinite, cancellation.Token);
                var completed = await Task.WhenAny(input, output, exit, interrupted);
                if (completed != exit)
                {
                    child.StandardInput.Close();
                    if (await Task.WhenAny(exit, Task.Delay(TimeSpan.FromSeconds(10))) != exit)
                    {
                        // Stop only our stdio client. The detached, shared broker is not this launcher's lifetime.
                        child.Kill(entireProcessTree: false);
                    }
                    await exit;
                }
                cancellation.Cancel();
                try { await output.WaitAsync(TimeSpan.FromSeconds(2)); }
                catch (Exception error) when (error is IOException or OperationCanceledException or TimeoutException) { outputCancellation.Cancel(); }
                await diagnostics.WaitAsync(TimeSpan.FromSeconds(2));
                if (child.ExitCode != 0) Console.Error.WriteLine("The Potassium MCP stdio client exited unsuccessfully. Run Setup.exe and use Check connection or Repair.");
                return child.ExitCode;
            }
            finally
            {
                Console.CancelKeyPress -= interrupt;
                cancellation.Cancel();
                outputCancellation.Cancel();
                try { child.StandardInput.Close(); } catch (IOException) { }
                if (!child.HasExited)
                {
                    var exit = child.WaitForExitAsync();
                    if (await Task.WhenAny(exit, Task.Delay(TimeSpan.FromSeconds(10))) != exit) child.Kill(entireProcessTree: false);
                    await exit;
                }
            }
        }
        catch (Exception error) when (error is InvalidDataException or IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException or FormatException or System.Text.Json.JsonException or KeyNotFoundException or System.ComponentModel.Win32Exception or NotSupportedException or TimeoutException)
        {
            var reason = error is InvalidDataException ? error.Message : "Installation is missing, changed, updating, or unavailable. Close MCP sessions and run Setup.exe to repair it.";
            Console.Error.WriteLine("Potassium MCP launcher: " + reason);
            return 1;
        }
    }

    private static async Task CopyInput(Stream source, Stream destination, CancellationToken cancellationToken)
    {
        try { await source.CopyToAsync(destination, 64 * 1024, cancellationToken); await destination.FlushAsync(cancellationToken); }
        catch (Exception error) when (error is IOException or ObjectDisposedException or OperationCanceledException) { }
    }

    private static async Task CopyOutput(Stream source, Stream destination, CancellationToken cancellationToken)
    {
        try
        {
            var buffer = new byte[64 * 1024];
            int count;
            while ((count = await source.ReadAsync(buffer, cancellationToken)) > 0)
            {
                await destination.WriteAsync(buffer.AsMemory(0, count), cancellationToken);
                await destination.FlushAsync(cancellationToken);
            }
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException or OperationCanceledException) { }
    }

    private static async Task Drain(Stream source)
    {
        var buffer = new byte[8192];
        while (await source.ReadAsync(buffer) > 0) { }
    }
}
