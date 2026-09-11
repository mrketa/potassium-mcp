import os from "node:os";
import path from "node:path";

function explicitPath(value, name, cwd) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} requires a path`);
  if (process.platform === "win32" && /^[a-z]:(?![\\/])/i.test(value)) {
    throw new Error(`${name} drive-relative path is ambiguous; use an absolute path`);
  }
  return path.resolve(cwd, value);
}

function environmentPath(value, name) {
  if (typeof value !== "string" || value.trim() === "" || !path.isAbsolute(value)
    || (process.platform === "win32" && !/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(value))) {
    throw new Error(`${name} must be an absolute path; relative environment paths are ambiguous`);
  }
  return path.normalize(value);
}

export function resolveInstallRoot(options = {}) {
  const env = options.env ?? process.env;
  if (options.installRoot !== undefined) {
    return explicitPath(options.installRoot, "--install-root", options.cwd ?? process.cwd());
  }
  if (env.POTASSIUM_MCP_INSTALL_ROOT !== undefined) {
    return environmentPath(env.POTASSIUM_MCP_INSTALL_ROOT, "POTASSIUM_MCP_INSTALL_ROOT");
  }
  const local = env.LOCALAPPDATA === undefined
    ? path.join(os.homedir(), ".local", "share")
    : environmentPath(env.LOCALAPPDATA, "LOCALAPPDATA");
  return path.join(local, "Potassium", "MCP");
}

export function resolveConfigSelection(options = {}) {
  const env = options.env ?? process.env;
  if (options.configFile !== undefined) {
    return { path: explicitPath(options.configFile, "--config", options.cwd ?? process.cwd()), source: "--config" };
  }
  if (options.installRoot !== undefined) {
    return { path: path.join(resolveInstallRoot(options), "config.json"), source: "--install-root" };
  }
  if (env.POTASSIUM_MCP_CONFIG !== undefined) {
    return { path: environmentPath(env.POTASSIUM_MCP_CONFIG, "POTASSIUM_MCP_CONFIG"), source: "POTASSIUM_MCP_CONFIG" };
  }
  return {
    path: path.join(resolveInstallRoot(options), "config.json"),
    source: env.POTASSIUM_MCP_INSTALL_ROOT !== undefined ? "POTASSIUM_MCP_INSTALL_ROOT" : "default",
  };
}

export function resolveConfigPath(options = {}) {
  return resolveConfigSelection(options).path;
}
