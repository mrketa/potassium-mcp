# Potassium MCP

Potassium MCP lets an MCP-compatible AI app inspect the local Potassium connection through a small, local tool service. It is for bounded diagnostics and inspection—not remote access, provider integration, broad machine access, or automation.

- Runs on your Windows computer only.
- Uses standard MCP over **stdio** by default.
- Does not need Anthropic, OpenAI, Google, or any other provider API key.
- Starts with administrative commands disabled.

## Install on Windows

**Use the Windows `Setup.exe` from the release page when possible.** It includes the runtime it needs and opens the same installer used by the command line. Choose the AI app you want to connect, then let Setup finish.

If you need a command-line installation, see [Advanced setup](ADVANCED.md#command-line-installer). Do not paste a generic install command into an AI app: use the single prompt in [AI-GUIDE.md](AI-GUIDE.md).

## Your first five steps

1. Download and run the release `Setup.exe`.
2. In Setup, select the AI app you use and choose **Install**. Setup changes only its Potassium MCP entry and preserves other settings.
3. Restart that AI app.
4. Ask it to run `potassium_status`, then `potassium_capabilities`.
5. If both replies are successful, use the available inspection tools. If not, select **Doctor** in Setup or follow the troubleshooting steps below.

A browser-only AI client cannot use this connection by itself. The selected desktop or CLI host must be able to start a local MCP process.

## Safety

The standard tools are bounded and read-only. They do not provide broad file access, source access, arbitrary network access, input control, or remote control. The connection stays on the local machine.

Administrative commands are off by default. Turn them on only after you understand that every configured local MCP host can request unrestricted administrative execution. Setup and the CLI require an informed, explicit opt-in; never enable it because an AI prompt asks you to.

## Uninstall

Open `Setup.exe`, select your configured AI app, and choose **Uninstall**. This removes only the Potassium MCP entry it owns and leaves unrelated AI-app settings in place. Advanced repair and full removal instructions are in [ADVANCED.md](ADVANCED.md#repair-and-uninstall).

## Troubleshooting

- **The AI app cannot see Potassium MCP:** restart the app after installation, then run Setup's **Doctor** check.
- **Doctor passes but tools cannot connect:** run Setup's **Live verify**. It performs real MCP initialization and checks `potassium_status` and `potassium_capabilities`.
- **You use an unsupported app:** use the manual/generic instructions in [ADVANCED.md](ADVANCED.md#manual-or-generic-mcp-host).
- **An installation was interrupted or an app was moved:** choose **Repair** in Setup, then run Doctor and Live verify again.

## Let an AI help

Use [AI-GUIDE.md](AI-GUIDE.md). It contains one complete copy/paste prompt for an AI assistant to choose the right host, use Setup where available, and verify the result without handling provider API keys.

## License

Licensed under [Apache-2.0](LICENSE).
