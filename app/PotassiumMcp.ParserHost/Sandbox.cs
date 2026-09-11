using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace PotassiumMcp.ParserHost;

internal sealed class Sandbox : IDisposable
{
    private IntPtr job;
    private Native.ProcessInformation process;
    private readonly List<IntPtr> allocations = new();
    private IntPtr attributes;
    private bool attributesInitialized;
    private SafeFileHandle? childInput, childOutput, childError;
    private FileStream? input, output, error;
    private bool disposed;
    private readonly bool fixedProbe;
    private readonly long cpuLimitTicks;

    internal Sandbox(Workspace workspace, string? probeMode)
    {
        fixedProbe = probeMode != null;
        // A tighter fixed CPU probe separates CPU enforcement from the unchanged
        // wall deadline under host scheduler load. Production remains five seconds.
        cpuLimitTicks = probeMode == "cpu" ? 10_000_000 : 50_000_000;
        try
        {
            job = Native.CreateJobObject(IntPtr.Zero, null);
            Native.Check(job != IntPtr.Zero, "Create parser job");
            Native.SetJob(job, 9, new Native.ExtendedLimits {
                Basic = new Native.BasicLimits { Flags = Native.JobLimits, ActiveProcesses = 1, ProcessTime = cpuLimitTicks, JobTime = cpuLimitTicks },
                ProcessMemory = new UIntPtr(256 * 1024 * 1024), JobMemory = new UIntPtr(256 * 1024 * 1024)
            });
            Native.SetJob(job, 4, (uint)0xff);
            var pipeAttributes = new Native.SecurityAttributes { Length = Marshal.SizeOf<Native.SecurityAttributes>(), Inherit = true };
            Native.Check(Native.CreatePipe(out var inRead, out var inWrite, ref pipeAttributes, 0), "Create input pipe");
            childInput = inRead;
            input = new FileStream(inWrite, FileAccess.Write, 4096, false);
            Native.Check(Native.SetHandleInformation(inWrite, 1, 0), "Protect input handle");
            Native.Check(Native.CreatePipe(out var outRead, out var outWrite, ref pipeAttributes, 0), "Create output pipe");
            childOutput = outWrite;
            output = new FileStream(outRead, FileAccess.Read, 4096, false);
            Native.Check(Native.SetHandleInformation(outRead, 1, 0), "Protect output handle");
            Native.Check(Native.CreatePipe(out var errRead, out var errWrite, ref pipeAttributes, 0), "Create diagnostic pipe");
            childError = errWrite;
            error = new FileStream(errRead, FileAccess.Read, 4096, false);
            Native.Check(Native.SetHandleInformation(errRead, 1, 0), "Protect diagnostic handle");

            UIntPtr size = UIntPtr.Zero;
            const int attributeCount = 3;
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref size);
            attributes = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
            Native.Check(Native.InitializeProcThreadAttributeList(attributes, attributeCount, 0, ref size), "Initialize parser process attributes");
            attributesInitialized = true;
            SetAttribute(0x20009, new Native.SecurityCapabilities { Sid = workspace.Sid }); // No capabilities.
            // The atomic single-process job, with no breakaway flags, blocks children.
            // CHILD_PROCESS_POLICY prevents KERNELBASE initialization in the qualified
            // AppContainer environment; it is not part of this fixed boundary.
            SetAttribute(0x2000d, job); // Atomic job association, including a crash during CreateProcess.
            var handles = Marshal.AllocHGlobal(IntPtr.Size * 3); allocations.Add(handles);
            Marshal.WriteIntPtr(handles, 0, inRead.DangerousGetHandle());
            Marshal.WriteIntPtr(handles, IntPtr.Size, outWrite.DangerousGetHandle());
            Marshal.WriteIntPtr(handles, IntPtr.Size * 2, errWrite.DangerousGetHandle());
            Native.Check(Native.UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x20002), handles, new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero), "Restrict inherited parser handles");
            var startup = new Native.StartupInfoEx { Attributes = attributes, Startup = new Native.StartupInfo {
                Size = Marshal.SizeOf<Native.StartupInfoEx>(), Flags = 0x100,
                Stdin = inRead.DangerousGetHandle(), Stdout = outWrite.DangerousGetHandle(), Stderr = errWrite.DangerousGetHandle()
            } };
            var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(windows) || string.IsNullOrEmpty(localAppData)) throw new HostError("PARSER_BACKEND_UNAVAILABLE", "Required Windows profile environment is unavailable");
            var environment = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
                ["SystemRoot"] = windows, ["WINDIR"] = windows, ["TEMP"] = workspace.Runtime, ["TMP"] = workspace.Runtime,
                // CreateProcess consumes this to locate the lowbox profile, then
                // Windows redirects it to this AppContainer's own AC directory.
                ["LOCALAPPDATA"] = localAppData
            };
            var environmentBytes = string.Join('\0', environment.Select(pair => pair.Key + "=" + pair.Value)) + "\0\0";
            var environmentPointer = Marshal.StringToHGlobalUni(environmentBytes); allocations.Add(environmentPointer);
            var executable = Path.Combine(workspace.Runtime, "PotassiumMcp.LuauParser.exe");
            var command = new StringBuilder(Quote(executable) + (probeMode == null ? "" : " --probe " + probeMode));
            Native.Check(Native.CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                Native.Suspended | Native.UnicodeEnvironment | Native.ExtendedStartup | Native.NoWindow,
                environmentPointer, workspace.Runtime, ref startup, out process), "Create AppContainer parser process");
            // The job is assigned atomically at creation; even a host crash before
            // CreateProcess returns closes its sole job handle and kills the child.
            if (Native.ResumeThread(process.Thread) == uint.MaxValue) Native.Check(false, "Resume parser process");
            childInput.Dispose(); childOutput.Dispose(); childError.Dispose();
            childInput = childOutput = childError = null;
        }
        catch { Dispose(); throw; }
    }

    private static string Quote(string value)
    {
        if (value.Contains('"') || value.Contains('\0')) throw new IOException("Invalid parser executable path");
        return "\"" + value + "\"";
    }


    private void SetAttribute<T>(uint id, T value) where T : struct
    {
        var buffer = Marshal.AllocHGlobal(Marshal.SizeOf<T>()); allocations.Add(buffer);
        Marshal.StructureToPtr(value, buffer, false);
        Native.Check(Native.UpdateProcThreadAttribute(attributes, 0, new UIntPtr(id), buffer, new UIntPtr((uint)Marshal.SizeOf<T>()), IntPtr.Zero, IntPtr.Zero), "Set parser process attribute");
    }

    internal async Task<byte[]> Run(byte[] request, Task disconnected)
    {
        var stdout = Task.Run(() => ReadBounded(output!, Native.OutputLimit));
        var stderr = Task.Run(() => ReadBounded(error!, 65536, fixedProbe));
        var writer = Task.Run(() => { try { input!.Write(request); input.Flush(); } finally { input!.Dispose(); } });
        var exited = Task.Run(() => { Native.Check(Native.WaitForSingleObject(process.Process, Native.Infinite) == 0, "Wait for parser process"); });
        var timeout = Task.Delay(TimeSpan.FromSeconds(10));
        var pending = new List<Task> { stdout, stderr, writer, exited, disconnected, timeout };
        IOException? inputFailure = null;
        try
        {
            while (true)
            {
                var finished = await Task.WhenAny(pending);
                if (finished == disconnected) throw new HostError("PARSER_CANCELLED", "Parser request channel closed");
                if (finished == timeout) throw new HostError("PARSER_WALL_LIMIT", "Parser wall-time limit exceeded");
                pending.Remove(finished);
                if (finished == writer)
                {
                    // A loader/startup failure closes stdin before the first write.
                    // Retain the I/O error while waiting for the authoritative exit.
                    try { await writer; } catch (IOException failure) { inputFailure = failure; }
                    continue;
                }
                await finished;
                if (finished == exited) break;
            }
            await Task.WhenAll(stdout, stderr);
            try { await writer; } catch (IOException failure) { inputFailure ??= failure; }
            Native.Check(Native.GetExitCodeProcess(process.Process, out var code), "Read parser exit status");
            if (fixedProbe)
            {
                var diagnostic = await stderr;
                Console.Error.WriteLine(System.Text.Json.JsonSerializer.Serialize(new {
                    workerExit = code,
                    cpuLimitMilliseconds = cpuLimitTicks / 10_000,
                    workerStderr = Encoding.UTF8.GetString(diagnostic.AsSpan(0, Math.Min(diagnostic.Length, 8192))),
                    inputFailure = inputFailure?.Message
                }));
            }
            if (code != 0)
            {
                var cpu = Native.QueryInformationJobObject(job, 1, out var accounting, (uint)Marshal.SizeOf<Native.BasicAccounting>(), IntPtr.Zero) && accounting.UserTime >= cpuLimitTicks * 98 / 100;
                throw new HostError(cpu ? "PARSER_CPU_LIMIT" : "PARSER_WORKER_EXIT", cpu ? "Parser CPU limit exceeded" : $"Parser worker exited with status {code} (0x{code:x8})");
            }
            if (inputFailure != null) throw new HostError("PARSER_PROTOCOL_ERROR", "Parser input channel closed before request delivery completed");
            return await stdout;
        }
        finally
        {
            Native.TerminateJobObject(job, 1);
            await exited;
            // Child termination closes all inherited pipe ends. Observe failed I/O
            // tasks before disposing streams, so cleanup never races a pipe reader.
            try { await Task.WhenAll(writer, stdout, stderr); } catch { }
        }
    }

    private static byte[] ReadBounded(Stream stream, int ceiling, bool forwardReadiness = false)
    {
        using var bytes = new MemoryStream(); var buffer = new byte[16384]; int count;
        const string marker = "parser-probe-running";
        var matched = 0;
        while ((count = stream.Read(buffer)) != 0)
        {
            if (bytes.Length + count > ceiling) throw new HostError("PARSER_OUTPUT_LIMIT", "Parser output limit exceeded");
            bytes.Write(buffer, 0, count);
            for (var index = 0; forwardReadiness && index < count; index++)
            {
                matched = buffer[index] == marker[matched] ? matched + 1 : buffer[index] == marker[0] ? 1 : 0;
                if (matched == marker.Length)
                {
                    // Forward only a marker actually emitted by the native main.
                    Console.Error.WriteLine(marker);
                    forwardReadiness = false;
                }
            }
        }
        return bytes.ToArray();
    }

    public void Dispose()
    {
        if (disposed) return; disposed = true;
        if (job != IntPtr.Zero) Native.TerminateJobObject(job, 1);
        if (process.Process != IntPtr.Zero)
        {
            Native.TerminateProcess(process.Process, 1);
            Native.WaitForSingleObject(process.Process, 5000);
            Native.CloseHandle(process.Process);
        }
        if (process.Thread != IntPtr.Zero) Native.CloseHandle(process.Thread);
        if (job != IntPtr.Zero) Native.CloseHandle(job);
        childInput?.Dispose(); childOutput?.Dispose(); childError?.Dispose();
        input?.Dispose(); output?.Dispose(); error?.Dispose();
        if (attributes != IntPtr.Zero) { if (attributesInitialized) Native.DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
        foreach (var allocation in allocations) Marshal.FreeHGlobal(allocation);
    }
}

internal sealed class HostError(string code, string message) : Exception(message)
{ internal string Code { get; } = code; }
