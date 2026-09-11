import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

assert.equal(process.env.GITHUB_ACTIONS, "true", "npm provisioning is restricted to the CI runner");
assert(process.env.GITHUB_ENV, "CI environment output is required");
assert(["v22.23.2", "v24.15.0"].includes(process.version), "CI Node version is outside the qualified set");
const prefix = process.platform === "win32" ? path.dirname(process.execPath) : path.dirname(path.dirname(process.execPath));
const packageRoot = path.join(prefix, process.platform === "win32" ? "node_modules" : "lib/node_modules", "npm");
const cli = path.join(packageRoot, "bin/npm-cli.js");
const version = "11.12.1";
const environment = { ...process.env, NODE_AUTH_TOKEN: "" };
if (JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version !== version) {
  execFileSync(process.execPath, [cli, "install", "--global", "--prefix", prefix, `npm@${version}`, "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"], {
    encoding: "utf8", stdio: "inherit", timeout: 180000, env: environment,
  });
}
assert.equal(execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8", timeout: 10000, env: environment }).trim(), version, "CI npm selection failed");
appendFileSync(process.env.GITHUB_ENV, `npm_execpath=${cli}\n`);
console.log(JSON.stringify({ node: process.version, npm: version, selectedNpmCli: true }));
