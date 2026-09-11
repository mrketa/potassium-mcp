using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using PotassiumMcp.ParserHost;

internal static class Program
{
    private static async Task<int> Main(string[] arguments)
    {
        Workspace? workspace = null;
        byte[] result;
        var stage = "arguments";
        var fixedProbe = arguments.Length == 2 && arguments[0] == "--probe" && arguments[1] == "fixed";
        try
        {
            if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess) throw new HostError("PARSER_BACKEND_UNAVAILABLE", "Windows x64 AppContainer backend is unavailable");
            if (arguments.Length != 0 && !fixedProbe) throw new HostError("PARSER_HOST_ARGUMENTS", "Parser host arguments are invalid");
            stage = "input";
            var input = Console.OpenStandardInput();
            var json = await Task.Run(() => ReadRequest(input)).WaitAsync(TimeSpan.FromSeconds(5));
            var (request, probeMode) = PrepareRequest(json, fixedProbe);
            // The parent keeps this channel open until completion. EOF, a cancel byte,
            // or parent death all cancel; nothing else is deserialized or executed.
            var disconnected = Task.Run(() => { try { input.ReadByte(); } catch (IOException) { } });
            stage = "workspace";
            workspace = new Workspace();
            var packageRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", ".."));
            stage = "runtime-staging";
            workspace.Stage(packageRoot);
            if (disconnected.IsCompleted) throw new HostError("PARSER_CANCELLED", "Parser request channel closed");
            stage = "sandbox-launch";
            using (var sandbox = new Sandbox(workspace, probeMode))
            {
                stage = "sandbox-run";
                result = await sandbox.Run(request, disconnected);
            }
            stage = "worker-result";
            using var document = JsonDocument.Parse(result, new JsonDocumentOptions { MaxDepth = 128 });
            var value = document.RootElement;
            if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("schema", out var schema) || !schema.TryGetInt32(out var version) || version != 1) throw new HostError("PARSER_PROTOCOL_ERROR", "Parser worker result is invalid");
            if (!value.TryGetProperty("error", out _))
            {
                var valid = fixedProbe
                    ? value.TryGetProperty("probe", out var mode) && mode.ValueKind == JsonValueKind.String && mode.GetString() == probeMode
                    : value.TryGetProperty("parser", out var parser) && parser.ValueKind == JsonValueKind.Object && value.TryGetProperty("trees", out var trees) && trees.ValueKind == JsonValueKind.Array && value.TryGetProperty("truncated", out var truncated) && truncated.ValueKind == JsonValueKind.False;
                if (!valid) throw new HostError("PARSER_PROTOCOL_ERROR", "Parser worker result is invalid");
            }
        }
        catch (Exception error)
        {
            if (fixedProbe)
            {
                var diagnostic = error.ToString();
                if (diagnostic.Length > 8192) diagnostic = diagnostic[..8192];
                Console.Error.WriteLine(JsonSerializer.Serialize(new { probeError = stage, exception = diagnostic }));
            }
            var code = error is HostError host ? host.Code : error is TimeoutException ? "PARSER_INPUT_TIMEOUT" : "PARSER_BACKEND_UNAVAILABLE";
            // Do not serialize exception paths, source text, command lines or diagnostics.
            var message = error is HostError ? error.Message : "Parser backend failed (" + error.GetType().Name + (error is System.ComponentModel.Win32Exception native ? ", win32=" + native.NativeErrorCode : ", hresult=" + error.HResult) + ")";
            result = Failure(code, message);
        }
        finally { workspace?.Dispose(); }
        if (workspace?.CleanupError != null) result = Failure("PARSER_CLEANUP_FAILED", workspace.CleanupError);
        try { using var output = Console.OpenStandardOutput(); await output.WriteAsync(result); await output.FlushAsync(); }
        catch (IOException) { return 1; }
        return 0;
    }

    private static byte[] Failure(string code, string message) => JsonSerializer.SerializeToUtf8Bytes(new { schema = 1, error = new { code, message } });

    private static byte[] ReadRequest(Stream input)
    {
        Span<byte> header = stackalloc byte[4]; input.ReadExactly(header);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length is 0 or > Native.InputLimit) throw new HostError("PARSER_INPUT_LIMIT", "Parser input limit exceeded");
        var request = new byte[checked((int)length)]; input.ReadExactly(request); return request;
    }

    private static (byte[] Input, string? ProbeMode) PrepareRequest(byte[] bytes, bool probe)
    {
        try
        {
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 16 });
            var root = document.RootElement;
            using var framed = new MemoryStream();
            var encoding = new UTF8Encoding(false, true);
            if (probe)
            {
                var mode = root.GetProperty("mode").GetString();
                if (mode is not ("denials" or "cpu" or "memory" or "stdout" or "wall")) throw new HostError("PARSER_INPUT_INVALID", "Fixed parser probe mode is invalid");
                if (mode != "denials") return (Array.Empty<byte>(), mode);
                var paths = root.GetProperty("paths");
                if (paths.ValueKind != JsonValueKind.Array || paths.GetArrayLength() is < 1 or > 8) throw new HostError("PARSER_INPUT_LIMIT", "Parser probe path count is invalid");
                var port = root.GetProperty("port").GetInt32();
                if (port is < 1 or > 65535) throw new HostError("PARSER_INPUT_INVALID", "Parser probe port is invalid");
                framed.Write("PMCPPRB1"u8); WriteLength(framed, paths.GetArrayLength());
                foreach (var item in paths.EnumerateArray())
                {
                    var path = item.GetString();
                    if (string.IsNullOrEmpty(path) || path.Length > 1024 || path.Contains('\0')) throw new HostError("PARSER_INPUT_INVALID", "Parser probe path is invalid");
                    var pathBytes = encoding.GetBytes(path);
                    if (pathBytes.Length > 4096) throw new HostError("PARSER_INPUT_LIMIT", "Parser probe path byte limit exceeded");
                    WriteLength(framed, pathBytes.Length); framed.Write(pathBytes);
                }
                WriteLength(framed, port);
                return (framed.ToArray(), mode);
            }
            if (root.GetProperty("schema").GetInt32() != 1) throw new HostError("PARSER_INPUT_INVALID", "Parser request schema is invalid");
            var modules = root.GetProperty("modules");
            if (modules.ValueKind != JsonValueKind.Array || modules.GetArrayLength() is < 1 or > 32) throw new HostError("PARSER_INPUT_LIMIT", "Parser module count is invalid");
            framed.Write("PMCPAST1"u8); WriteLength(framed, modules.GetArrayLength());
            var total = 0;
            foreach (var module in modules.EnumerateArray())
            {
                var source = module.GetProperty("source").GetString();
                if (source == null) throw new HostError("PARSER_INPUT_INVALID", "Parser source must be a string");
                if (source.Length > 262144) throw new HostError("PARSER_INPUT_LIMIT", "Parser source byte limit exceeded");
                var sourceBytes = encoding.GetBytes(source);
                total += sourceBytes.Length;
                if (sourceBytes.Length > 262144 || total > 4194304) throw new HostError("PARSER_INPUT_LIMIT", "Parser source byte limit exceeded");
                WriteLength(framed, sourceBytes.Length); framed.Write(sourceBytes);
            }
            return (framed.ToArray(), null);
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException or EncoderFallbackException or FormatException)
        { throw new HostError("PARSER_INPUT_INVALID", "Parser request data is invalid"); }
    }

    private static void WriteLength(Stream output, int value)
    {
        Span<byte> encoded = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(encoded, checked((uint)value));
        output.Write(encoded);
    }
}
