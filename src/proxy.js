import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { proofMatches, proxyProof } from "./broker.js";
import { commandConfigPath, isMainModule, loadConfig } from "./server.js";

const configArgument = commandConfigPath();
const configPath = configArgument ?? process.env.POTASSIUM_MCP_CONFIG;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function connect(url, maxFrameBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      maxPayload: maxFrameBytes,
      handshakeTimeout: timeoutMs,
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      callback(value);
    };
    const onOpen = () => finish(resolve, socket);
    const onError = (error) => finish(reject, error);
    const timer = setTimeout(() => {
      finish(reject, new Error("Broker connection attempt timed out"));
      socket.once("error", () => {});
      socket.terminate();
    }, timeoutMs);
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

export async function connectOrStart(config, options = {}) {
  if (config.proxyPort === 0) {
    throw new Error("proxyPort 0 cannot be used by a standalone proxy");
  }
  const url = `ws://${config.proxyHost.includes(":") ? `[${config.proxyHost}]` : config.proxyHost}:${config.proxyPort}`;
  const deadline = Date.now() + config.proxyHandshakeTimeoutMs;
  const attempt = () => connect(
    url,
    config.proxyMaxFrameBytes,
    Math.max(1, Math.min(500, deadline - Date.now())),
  );
  try {
    return await attempt();
  } catch {}

  const start = options.spawn ?? spawn;
  const child = start(
    process.execPath,
    [
      fileURLToPath(new URL("./broker.js", import.meta.url)),
      ...(configPath ? ["--config", configPath] : []),
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();

  let lastError;
  while (Date.now() < deadline) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (Date.now() < deadline) await delay(Math.min(50, deadline - Date.now()));
    }
  }
  throw new Error(`Unable to connect to Potassium broker: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function nextJson(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
      callback(value);
    };
    const onMessage = (data, isBinary) => {
      if (isBinary) return finish(reject, new Error("Broker sent a binary authentication frame"));
      try {
        finish(resolve, JSON.parse(data.toString("utf8")));
      } catch {
        finish(reject, new Error("Broker sent invalid authentication JSON"));
      }
    };
    const onError = (error) => finish(reject, error);
    const onClose = () => finish(reject, new Error("Broker closed during authentication"));
    const timer = setTimeout(
      () => finish(reject, new Error("Broker authentication timed out")),
      timeoutMs,
    );
    socket.once("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export async function authenticate(socket, config) {
  const clientNonce = randomBytes(32).toString("hex");
  socket.send(JSON.stringify({ type: "proxy-hello", protocol: 1, clientNonce }));
  const challenge = await nextJson(socket, config.proxyHandshakeTimeoutMs);
  const expectedServerProof = typeof challenge?.serverNonce === "string"
    ? proxyProof(config.token, "server", clientNonce, challenge.serverNonce)
    : "";
  if (
    challenge?.type !== "proxy-challenge"
    || challenge.protocol !== 1
    || !/^[a-f0-9]{64}$/i.test(challenge.serverNonce ?? "")
    || !proofMatches(challenge.proof, expectedServerProof)
  ) throw new Error("Invalid broker challenge");
  socket.send(JSON.stringify({
    type: "proxy-ack",
    proof: proxyProof(config.token, "client", clientNonce, challenge.serverNonce),
  }));
  const ready = await nextJson(socket, config.proxyHandshakeTimeoutMs);
  if (ready?.type !== "proxy-ready") throw new Error("Broker rejected proxy authentication");
}

export async function runProxy(options = {}) {
  const config = options.config ?? await loadConfig(options.configPath ?? configPath);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const logError = options.logError ?? ((message) => console.error("[potassium-proxy]", message));
  const socket = await (options.connectOrStart ?? connectOrStart)(config, options);
  let input;
  let waitingForDrain = false;

  const onDrain = () => {
    waitingForDrain = false;
    socket.resume();
  };
  const onSocketMessage = (data, isBinary) => {
    if (isBinary || Buffer.byteLength(data) > config.proxyMaxFrameBytes) {
      socket.close(1009, "invalid broker frame");
      return;
    }
    if (!stdout.write(`${data.toString("utf8")}\n`)) {
      waitingForDrain = true;
      socket.pause();
      stdout.once("drain", onDrain);
    }
  };
  const onSocketError = (error) => logError(error.message);
  const closeSocket = () => socket.close();
  const onStdinData = (chunk) => {
    try {
      input.append(chunk);
      for (let message = input.readMessage(); message !== null; message = input.readMessage()) {
        const frame = JSON.stringify(message);
        if (Buffer.byteLength(frame) > config.proxyMaxFrameBytes) {
          socket.close(1009, "MCP frame exceeds proxy limit");
          return;
        }
        socket.send(frame);
      }
    } catch {
      socket.close(1007, "invalid MCP stdio frame");
    }
  };

  try {
    await authenticate(socket, config);
    input = new ReadBuffer({ maxBufferSize: config.proxyMaxFrameBytes });
    socket.on("message", onSocketMessage);
    socket.on("error", onSocketError);
    stdin.on("data", onStdinData);
    stdin.once("end", closeSocket);
    stdin.once("close", closeSocket);
    await new Promise((resolve) => socket.once("close", resolve));
  } finally {
    stdin.off("data", onStdinData);
    stdin.off("end", closeSocket);
    stdin.off("close", closeSocket);
    socket.off("message", onSocketMessage);
    socket.off("error", onSocketError);
    stdout.off("drain", onDrain);
    if (waitingForDrain) socket.resume();
    input?.clear();
    stdin.pause?.();
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }
}

export async function main() { await runProxy(); }
if (isMainModule(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    console.error("[potassium-proxy] Fatal:", error);
    process.exitCode = 1;
  });
}
