import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfigPath, resolveConfigSelection, resolveInstallRoot } from "../src/paths.js";
import { WINDOWS_POWERSHELL_PRELUDE, WINDOWS_POWERSHELL_SECURITY_PRELUDE, windowsPowerShellEnvironment } from "../src/windows-powershell.js";

const cliPath = fileURLToPath(new URL("../bin/potassium-mcp.js", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potassium CLI 空 白-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "executor 工作");
  const cwd = path.join(root, "foreign cwd");
  const installRoot = path.join(root, "private data");
  await mkdir(workspaceRoot);
  await mkdir(cwd);
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root };
  if (process.platform === "win32") {
    env.APPDATA = path.join(root, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(root, "AppData", "Local");
    await mkdir(env.APPDATA, { recursive: true });
    await mkdir(env.LOCALAPPDATA, { recursive: true });
  }
  delete env.POTASSIUM_MCP_CONFIG;
  delete env.POTASSIUM_MCP_INSTALL_ROOT;
  delete env.POTASSIUM_WORKSPACE;
  delete env.POTASSIUM_MCP_BROKER_STATE;
  return { root, cwd, workspaceRoot, installRoot, env };
}

function invoke(args, options = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 15000, cwd: options.cwd, env: options.env,
  });
  if (result.error) throw result.error;
  return result;
}

async function snapshot(root) {
  const result = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    result[entry.name] = entry.isDirectory() ? await snapshot(target) : await readFile(target, "utf8");
  }
  return result;
}

test("public CLI keeps default help and supports explicit help without startup", async (t) => {
  const value = await fixture(t);
  const before = await snapshot(value.root);
  const defaultHelp = invoke([], value);
  const explicitHelp = invoke(["--help"], value);
  assert.equal(defaultHelp.status, 0);
  assert.equal(defaultHelp.stderr, "");
  assert.equal(explicitHelp.stdout, defaultHelp.stdout);
  assert.match(defaultHelp.stdout, /potassium-mcp serve --host-id/);
  const jsonHelp = invoke(["serve", "--help", "--json"], value);
  assert.equal(jsonHelp.status, 0);
  assert.match(JSON.parse(jsonHelp.stdout).help, /config print/);
  assert.deepEqual(await snapshot(value.root), before);
});

test("CLI parser failures stay on stderr and cannot create setup state", async (t) => {
  const value = await fixture(t);
  const before = await snapshot(value.root);
  const cases = [
    ["serve", "--config", "--json"],
    ["serve", "--config", "missing.json", "--json"],
    ["serve", "--host-id", "Project A", "--json"],
    ["serve", "--host-id", "omp", "--config", "a", "--config", "b", "--json"],
    ["install", "--json"],
    ["setup", "--host", "omp", "--json"],
    ["host", "remove", "--host", "omp", "--json"],
    ["uninstall", "--json"],
    ["setup", "--execute-host", "project-a", "--json"],
    ["serve", "--host-id", "omp", "--allow-unsafe-execute", "--json"],
  ];
  for (const args of cases) {
    const result = invoke(args, value);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    const diagnostic = JSON.parse(result.stderr);
    assert.equal(diagnostic.ok, false);
    assert.equal(typeof diagnostic.error, "string");
  }
  assert.deepEqual(await snapshot(value.root), before);
});

test("serve reports missing setup without creating config, credentials, or locks", async (t) => {
  const value = await fixture(t);
  const before = await snapshot(value.root);
  const result = invoke(["serve", "--host-id", "omp", "--install-root", value.installRoot, "--json"], value);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(await snapshot(value.root), before);
});

test("CLI hostless setup dry-run accepts independent admin without unsafe execution and writes nothing", async (t) => {
  const value = await fixture(t);
  const before = await snapshot(value.root);
  const result = invoke([
    "setup", "--workspace", value.workspaceRoot, "--install-root", value.installRoot,
    "--read-host", "project-read", "--admin-host", "project-admin", "--http-admin", "--dry-run", "--json",
  ], value);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).dryRun, true);
  assert.deepEqual(await snapshot(value.root), before);
});

test("config print returns runnable public entries without changing private state or exposing credentials", async (t) => {
  const value = await fixture(t);
  const setup = invoke([
    "setup", "--workspace", value.workspaceRoot, "--install-root", value.installRoot,
    "--read-host", "project-a", "--json",
  ], value);
  assert.equal(setup.status, 0, setup.stderr);
  const before = await snapshot(value.root);
  const configFile = path.join(value.installRoot, "config.json");
  const token = (await readFile(path.join(value.workspaceRoot, ".potassium-mcp-token"), "utf8")).trim();
  const printed = invoke(["config", "print", "--config", configFile, "--host-id", "project-a", "--json"], value);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stderr, "");
  const entry = JSON.parse(printed.stdout);
  assert.equal(path.isAbsolute(entry.command), true);
  assert.deepEqual(entry.args.slice(1), ["serve", "--config", configFile, "--host-id", "project-a"]);
  assert.equal(path.basename(entry.args[0]), "potassium-mcp.js");
  assert.equal(printed.stdout.includes(token), false);
  const help = spawnSync(entry.command, [entry.args[0], "--help"], { cwd: value.cwd, env: value.env, encoding: "utf8", windowsHide: true });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /potassium-mcp serve/);
  const npm = invoke(["config", "print", "--config", configFile, "--host-id", "project-a", "--npm", "--json"], value);
  assert.equal(npm.status, 0, npm.stderr);
  const npmEntry = JSON.parse(npm.stdout);
  assert.match(JSON.stringify(npmEntry), /@mrketa\/potassium-mcp@\d+\.\d+\.\d+/);
  assert.equal(npm.stdout.includes(token), false);
  const unknown = invoke(["config", "print", "--config", configFile, "--host-id", "unconfigured-project", "--json"], value);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, "");
  assert.deepEqual(await snapshot(value.root), before);
});

test("Windows CLI setup preserves private files and ACLs with an incompatible inherited PowerShell Security module", {
  skip: process.platform !== "win32" && "requires the actual Windows PowerShell ACL boundary",
}, async (t) => {
  const value = await fixture(t);
  const cleanEnv = { ...value.env };
  for (const key of Object.keys(cleanEnv)) if (key.toLowerCase() === "psmodulepath") delete cleanEnv[key];
  const setupArgs = [
    "setup", "--workspace", value.workspaceRoot, "--install-root", value.installRoot,
    "--read-host", "project-a", "--json",
  ];
  const initial = invoke(setupArgs, { ...value, env: cleanEnv });
  assert.equal(initial.status, 0, initial.stderr);

  const configFile = path.join(value.installRoot, "config.json");
  const tokenFile = path.join(value.workspaceRoot, ".potassium-mcp-token");
  const aclPaths = [configFile, tokenFile, path.join(value.workspaceRoot, ".potassium-mcp-bootstrap.lua")];
  const configBefore = await readFile(configFile, "utf8");
  const tokenBefore = await readFile(tokenFile, "utf8");
  const readAcls = () => {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
      WINDOWS_POWERSHELL_SECURITY_PRELUDE,
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "$ErrorActionPreference = 'Stop'",
      "$paths = ConvertFrom-Json $env:POTASSIUM_TEST_ACL_PATHS",
      "$items = @(foreach ($target in $paths) {",
      "  $acl = [System.IO.File]::GetAccessControl($target)",
      "  [pscustomobject]@{",
      "    path = $target",
      "    protected = $acl.AreAccessRulesProtected",
      "    sddl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)",
      "    owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
      "    currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "    allowed = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value })",
      "  }",
      "})",
      "ConvertTo-Json -InputObject $items -Depth 4 -Compress",
    ].join("\n")], {
      encoding: "utf8", windowsHide: true, timeout: 15000, cwd: value.cwd,
      env: { ...cleanEnv, POTASSIUM_TEST_ACL_PATHS: JSON.stringify(aclPaths) },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const aclsBefore = readAcls();
  for (const acl of aclsBefore) {
    assert.equal(acl.protected, true, acl.path);
    assert.deepEqual(acl.allowed, [acl.currentUser], acl.path);
  }

  const moduleRoot = path.join(value.root, "incompatible PS7 modules");
  const securityModule = path.join(moduleRoot, "Microsoft.PowerShell.Security");
  await mkdir(securityModule, { recursive: true });
  await writeFile(path.join(securityModule, "Microsoft.PowerShell.Security.psd1"), [
    "@{",
    "  RootModule = 'Microsoft.PowerShell.Security.psm1'",
    "  ModuleVersion = '99.0.0'",
    "  GUID = 'a9b920b7-4801-4aa8-a328-0d37392b44b8'",
    "  FunctionsToExport = @('Get-Acl', 'Set-Acl')",
    "  CmdletsToExport = @()",
    "}",
  ].join("\n"));
  // Advertise the ACL commands, but fail module loading just like an incompatible PS7 module.
  await writeFile(path.join(securityModule, "Microsoft.PowerShell.Security.psm1"), [
    "throw 'Fixture: Microsoft.PowerShell.Security is incompatible with Windows PowerShell'",
    "function Get-Acl { throw 'The incompatible fixture must never provide ACL access' }",
    "function Set-Acl { throw 'The incompatible fixture must never change an ACL' }",
  ].join("\n"));
  const inheritedModulePath = Object.entries(value.env).find(([key]) => key.toLowerCase() === "psmodulepath")?.[1];
  const poisoned = {
    ...value,
    env: { ...cleanEnv, PSModulePath: [moduleRoot, inheritedModulePath].filter(Boolean).join(path.delimiter) },
  };
  const setup = invoke(setupArgs, poisoned);
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(await readFile(configFile, "utf8"), configBefore);
  assert.equal(await readFile(tokenFile, "utf8"), tokenBefore);
  assert.deepEqual(readAcls(), aclsBefore);

});

test("Windows PowerShell CIM identity ignores an incompatible child-reconstructed addon module path", {
  skip: process.platform !== "win32" && "requires actual Windows PowerShell CIM module discovery",
}, async (t) => {
  const value = await fixture(t);
  const moduleRoot = path.join(value.root, "reconstructed addon modules");
  const cimModule = path.join(moduleRoot, "CimCmdlets");
  await mkdir(cimModule, { recursive: true });
  await writeFile(path.join(cimModule, "CimCmdlets.psd1"), [
    "@{",
    "  RootModule = 'CimCmdlets.psm1'",
    "  ModuleVersion = '99.0.0'",
    "  GUID = 'ce02e748-41f9-4d78-a9a5-2c0727e97817'",
    "  FunctionsToExport = @('Get-CimInstance')",
    "  CmdletsToExport = @()",
    "}",
  ].join("\n"));
  await writeFile(path.join(cimModule, "CimCmdlets.psm1"), [
    "[IO.File]::WriteAllText($env:POTASSIUM_TEST_MODULE_MARKER, 'incompatible addon loaded')",
    "function Get-CimInstance {",
    "  param([string]$ClassName, [string]$Filter)",
    "  throw 'Fixture: addon Get-CimInstance is incompatible with Windows PowerShell'",
    "}",
    "Export-ModuleMember -Function Get-CimInstance",
  ].join("\n"));

  // Inherited-path filtering cannot model paths reconstructed during shell startup.
  // Poison only this owned child's search path, before the production prelude runs.
  const observe = (prelude, marker) => spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", [
      "$env:PSModulePath = $env:POTASSIUM_TEST_MODULE_ROOT + [IO.Path]::PathSeparator + [IO.Path]::Combine($PSHOME,'Modules');",
      prelude,
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "$ErrorActionPreference = 'Stop'",
      `Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}' | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress`,
    ].join("\n"),
  ], {
    encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 65536, cwd: value.cwd,
    env: windowsPowerShellEnvironment({
      ...value.env, POTASSIUM_TEST_MODULE_ROOT: moduleRoot, POTASSIUM_TEST_MODULE_MARKER: marker,
    }),
  });

  // Prove the fixture intercepts real command discovery when the prelude is lost.
  const controlMarker = path.join(value.root, "control-module-loaded");
  const control = observe("", controlMarker);
  if (control.error) throw control.error;
  assert.notEqual(control.status, 0, "The incompatible addon must prevent unguarded CIM observation");
  assert.equal(await readFile(controlMarker, "utf8"), "incompatible addon loaded");

  const protectedMarker = path.join(value.root, "protected-module-loaded");
  const result = observe(WINDOWS_POWERSHELL_PRELUDE, protectedMarker);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const identity = JSON.parse(result.stdout);
  assert.equal(identity.ProcessId, process.pid);
  assert.equal(identity.ParentProcessId, process.ppid);
  assert.equal(path.normalize(identity.ExecutablePath).toLowerCase(), path.normalize(process.execPath).toLowerCase());
  assert.equal(typeof identity.CommandLine, "string");
  assert.ok(identity.CommandLine.toLowerCase().includes(path.basename(process.execPath).toLowerCase()));
  await assert.rejects(readFile(protectedMarker, "utf8"), { code: "ENOENT" });
});

test("configuration selection honors explicit precedence and rejects CWD-dependent environment paths", () => {
  const cwd = path.join(os.tmpdir(), "foreign 工作");
  const explicit = path.join(cwd, "selected config.json");
  const fromEnv = path.join(os.tmpdir(), "environment", "config.json");
  const installRoot = path.join(os.tmpdir(), "private root");
  const env = { POTASSIUM_MCP_CONFIG: fromEnv, POTASSIUM_MCP_INSTALL_ROOT: path.join(os.tmpdir(), "env root") };
  assert.deepEqual(resolveConfigSelection({ cwd, configFile: "selected config.json", installRoot, env }), { path: explicit, source: "--config" });
  assert.deepEqual(resolveConfigSelection({ installRoot, env }), { path: path.join(installRoot, "config.json"), source: "--install-root" });
  assert.equal(resolveConfigPath({ env }), fromEnv);
  assert.equal(resolveConfigPath({ installRoot, env: { POTASSIUM_MCP_INSTALL_ROOT: env.POTASSIUM_MCP_INSTALL_ROOT } }), path.join(installRoot, "config.json"));
  assert.equal(resolveConfigPath({ env: { POTASSIUM_MCP_INSTALL_ROOT: env.POTASSIUM_MCP_INSTALL_ROOT } }), path.join(env.POTASSIUM_MCP_INSTALL_ROOT, "config.json"));
  assert.equal(resolveInstallRoot({ cwd, installRoot: "relative root", env }), path.join(cwd, "relative root"));
  assert.throws(() => resolveConfigPath({ env: { POTASSIUM_MCP_CONFIG: "relative/config.json" } }), /ambiguous/);
  assert.throws(() => resolveInstallRoot({ env: { POTASSIUM_MCP_INSTALL_ROOT: "relative-root" } }), /ambiguous/);
});

test("Windows drive-relative and root-relative environment values cannot select per-drive CWD", { skip: process.platform !== "win32" }, () => {
  assert.throws(() => resolveConfigPath({ configFile: "D:config.json" }), /ambiguous/);
  assert.throws(() => resolveConfigPath({ env: { POTASSIUM_MCP_CONFIG: "\\private\\config.json" } }), /ambiguous/);
});

test("explicit management install root overrides inherited config without touching that deployment", async (t) => {
  const value = await fixture(t);
  const ambientRoot = path.join(value.root, "other deployment");
  await mkdir(ambientRoot);
  const ambientConfig = path.join(ambientRoot, "config.json");
  await writeFile(ambientConfig, "{}");
  await writeFile(path.join(ambientRoot, "broker-state.json"), "invalid ambient broker state");
  value.env.POTASSIUM_MCP_CONFIG = ambientConfig;
  value.env.POTASSIUM_MCP_INSTALL_ROOT = ambientRoot;
  const before = await snapshot(value.root);
  for (const command of ["status", "stop"]) {
    const result = invoke(["broker", command, "--install-root", value.installRoot, "--json"], value);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).status, "absent");
  }
  assert.deepEqual(await snapshot(value.root), before);
});
