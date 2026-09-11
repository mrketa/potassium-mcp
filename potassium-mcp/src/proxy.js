import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { resolveConfigPath } from "./paths.js";
import { assertHostId } from "./host-policy.js";
import WebSocket from "ws";
import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { proofMatches, proxyProof, resolveBrokerLaunch } from "./broker.js";
import { commandConfigPath, isMainModule, loadConfig } from "./server.js";

function commandHostId(argv = process.argv.slice(2)) {
  const indices = argv.flatMap((value, index) => value === "--host-id" ? [index] : []);
  if (indices.length !== 1 || indices[0] === argv.length - 1) {
    throw new Error("--host-id requires one explicit normalized host ID");
  }
  return assertHostId(argv[indices[0] + 1]);
}
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Promise continuations leave gaps between startup phases. Keep terminal-event
// ownership on the socket until forwarding takes over, retaining the first error.
const startupSockets = new WeakMap();

function startupLifecycle(socket) {
  const existing = startupSockets.get(socket);
  if (existing) return existing;
  const detach = () => {
    socket.off("error", onError);
    socket.off("close", onClose);
  };
  const lifecycle = {
    error: undefined,
    onFailure: undefined,
    fail(error) {
      lifecycle.error ??= error;
      lifecycle.onFailure?.(lifecycle.error);
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      return lifecycle.error;
    },
    release() {
      lifecycle.onFailure = undefined;
      detach();
      startupSockets.delete(socket);
    },
  };
  const onError = (error) => lifecycle.fail(error);
  const onClose = () => {
    lifecycle.onFailure?.(lifecycle.error);
    detach();
  };
  startupSockets.set(socket, lifecycle);
  if (socket.readyState !== WebSocket.CLOSED) {
    socket.on("error", onError);
    socket.once("close", onClose);
  }
  return lifecycle;
}

export function connect(url, maxFrameBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      maxPayload: maxFrameBytes,
      handshakeTimeout: timeoutMs,
    });
    const lifecycle = startupLifecycle(socket);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("open", onOpen);
      lifecycle.onFailure = undefined;
      callback(value);
    };
    const onOpen = () => finish(resolve, socket);
    const onFailure = (error) => finish(reject, error ?? new Error("Broker closed during connection"));
    const timer = setTimeout(() => {
      lifecycle.fail(new Error("Broker connection attempt timed out"));
    }, timeoutMs);
    lifecycle.onFailure = onFailure;
    socket.once("open", onOpen);
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

  const configFile = resolveConfigPath(options);
  const launch = await resolveBrokerLaunch({ configFile });
  const start = options.spawn ?? spawn;
  const child = start(launch.command, launch.args, { detached: true, stdio: "ignore", windowsHide: true });
  let spawnError;
  child.once?.("error", (error) => { spawnError = error; });
  child.unref();

  let lastError;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Unable to start Potassium broker: ${spawnError.message}`);
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (Date.now() < deadline) await delay(Math.min(50, deadline - Date.now()));
    }
  }
  throw new Error(`Unable to connect to Potassium broker: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function authenticate(socket, config, hostId) {
  const lifecycle = startupLifecycle(socket);
  await new Promise((resolve, reject) => {
    let phase = "challenge";
    let settled = false;
    let pendingSends = 0;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("message", onMessage);
      lifecycle.onFailure = undefined;
      if (error) reject(error);
      else resolve();
    };
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => lifecycle.fail(new Error("Broker authentication timed out")),
        config.proxyHandshakeTimeoutMs,
      );
    };
    const complete = () => {
      if (phase === "authenticated" && pendingSends === 0) finish();
    };
    const send = (message) => {
      pendingSends += 1;
      try {
        socket.send(JSON.stringify(message), (error) => {
          pendingSends -= 1;
          if (error) lifecycle.fail(error);
          else complete();
        });
      } catch (error) {
        lifecycle.fail(error);
      }
    };
    let clientNonce;
    const onMessage = (data, isBinary) => {
      if (settled) return;
      if (isBinary) return lifecycle.fail(new Error("Broker sent a binary authentication frame"));
      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        return lifecycle.fail(new Error("Broker sent invalid authentication JSON"));
      }
      try {
        if (phase === "challenge") {
          const expectedServerProof = typeof message?.serverNonce === "string"
            ? proxyProof(config.token, "server", clientNonce, message.serverNonce, hostId)
            : "";
          if (
            message?.type !== "proxy-challenge"
            || message.protocol !== 1
            || !/^[a-f0-9]{64}$/i.test(message.serverNonce ?? "")
            || !proofMatches(message.proof, expectedServerProof)
          ) return lifecycle.fail(new Error("Invalid broker challenge"));
          phase = "ready";
          armTimeout();
          send({
            type: "proxy-ack",
            proof: proxyProof(config.token, "client", clientNonce, message.serverNonce, hostId),
          });
        } else {
          if (message?.type !== "proxy-ready") return lifecycle.fail(new Error("Broker rejected proxy authentication"));
          phase = "authenticated";
          socket.off("message", onMessage);
          complete();
        }
      } catch (error) {
        lifecycle.fail(error);
      }
    };
    lifecycle.onFailure = (error) => finish(error ?? new Error("Broker closed during authentication"));
    if (lifecycle.error) return finish(lifecycle.error);
    if (socket.readyState !== WebSocket.OPEN) {
      return lifecycle.fail(new Error("Broker closed during authentication"));
    }
    try {
      assertHostId(hostId);
      clientNonce = randomBytes(32).toString("hex");
      socket.on("message", onMessage);
      armTimeout();
      send({ type: "proxy-hello", protocol: 1, clientNonce, hostId });
    } catch (error) {
      lifecycle.fail(error);
    }
  });
  if (lifecycle.error) throw lifecycle.error;
}

export async function runProxy(options = {}) {
  const hostId = assertHostId(options.hostId);
  const configFile = resolveConfigPath(options);
  const config = options.config ?? await loadConfig(configFile);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const logError = options.logError ?? ((message) => console.error("[potassium-proxy]", message));
  const socket = await (options.connectOrStart ?? connectOrStart)(config, { ...options, configFile });
  const lifecycle = startupLifecycle(socket);
  try {
    if (lifecycle.error) throw lifecycle.error;
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Broker closed during authentication");
    await (options.authenticate ?? authenticate)(socket, config, hostId);
    if (lifecycle.error) throw lifecycle.error;
  } catch (error) {
    throw lifecycle.fail(error);
  }
  let input;
  let waitingForDrain = false;
  let pendingWrites = 0;

  let closeTimer;
  let onSocketClose;
  const onDrain = () => {
    waitingForDrain = false;
    socket.resume();
  };
  const onSocketMessage = (data, isBinary) => {
    if (isBinary || Buffer.byteLength(data) > config.proxyMaxFrameBytes) {
      logError("Invalid broker frame");
      socket.close(1009, "invalid broker frame");
      return;
    }
    if (!stdout.write(`${data.toString("utf8")}\n`) && !waitingForDrain) {
      waitingForDrain = true;
      socket.pause();
      stdout.once("drain", onDrain);
    }
  };
  const onSocketError = (error) => logError(error.message);
  const closeSocket = () => {
    if (closeTimer !== undefined) return;
    socket.close();
    closeTimer = setTimeout(() => socket.terminate(), config.shutdownGraceMs ?? 1000);
    closeTimer.unref?.();
  };
  const onStreamError = (error) => {
    logError(error.message);
    closeSocket();
  };
  const onSend = (error) => {
    pendingWrites -= 1;
    if (error) {
      logError(error.message);
      socket.close(1011, "failed to forward MCP frame");
    } else if (pendingWrites === 0 && socket.readyState === WebSocket.OPEN) {
      stdin.resume?.();
    }
  };
  const onStdinData = (chunk) => {
    stdin.pause?.();
    try {
      input.append(chunk);
      for (let message = input.readMessage(); message !== null; message = input.readMessage()) {
        const frame = JSON.stringify(message);
        if (Buffer.byteLength(frame) > config.proxyMaxFrameBytes) {
          logError("MCP frame exceeds proxy limit");
          socket.close(1009, "MCP frame exceeds proxy limit");
          return;
        }
        pendingWrites += 1;
        socket.send(frame, onSend);
      }
      if (pendingWrites === 0 && socket.readyState === WebSocket.OPEN) stdin.resume?.();
    } catch {
      logError("Invalid MCP stdio frame");
      socket.close(1007, "invalid MCP stdio frame");
    }
  };

  try {
    input = new ReadBuffer({ maxBufferSize: config.proxyMaxFrameBytes });
    socket.on("message", onSocketMessage);
    socket.on("error", onSocketError);
    const closed = new Promise((resolve) => {
      onSocketClose = resolve;
      if (socket.readyState === WebSocket.CLOSED) resolve();
      else socket.once("close", onSocketClose);
    });
    if (lifecycle.error) throw lifecycle.error;
    lifecycle.release();
    stdin.once("end", closeSocket);
    stdin.once("close", closeSocket);
    stdin.once("error", onStreamError);
    stdout.once("error", onStreamError);
    process.once("SIGINT", closeSocket);
    process.once("SIGTERM", closeSocket);
    if (socket.readyState === WebSocket.CLOSING || stdin.readableEnded || stdin.destroyed || stdout.destroyed) closeSocket();
    if (socket.readyState === WebSocket.OPEN) stdin.on("data", onStdinData);
    await closed;
  } catch (error) {
    throw startupLifecycle(socket).fail(error);
  } finally {
    clearTimeout(closeTimer);
    stdin.off("data", onStdinData);
    stdin.off("end", closeSocket);
    stdin.off("close", closeSocket);
    stdin.off("error", onStreamError);
    stdout.off("error", onStreamError);
    process.off("SIGINT", closeSocket);
    process.off("SIGTERM", closeSocket);
    socket.off("message", onSocketMessage);
    socket.off("error", onSocketError);
    if (onSocketClose) socket.off("close", onSocketClose);
    stdout.off("drain", onDrain);
    if (waitingForDrain) socket.resume();
    input?.clear();
    stdin.pause?.();
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }
}

// Historical schema-2 launchers and user-owned wrappers still call this internal file.
// New registrations use bin/potassium-mcp.js serve; do not rewrite those wrappers here.
export async function main(argv = process.argv.slice(2)) {
  await runProxy({ configFile: commandConfigPath(argv), hostId: commandHostId(argv) });
}
if (isMainModule(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    console.error("[potassium-proxy] Fatal:", error);
    process.exitCode = 1;
  });
}
