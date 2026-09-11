namespace PotassiumMcp.Setup;

internal static class Program
{
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
}
