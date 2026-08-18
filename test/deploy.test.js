import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deploy } from "../src/deploy.js";

async function fixture(t) { const root = await mkdtemp(path.join(os.tmpdir(), "potassium-deploy-")); t.after(() => rm(root, { recursive: true, force: true })); const scripts = path.join(root, "scripts"); const workspace = path.join(root, "workspace"); const autoexec = path.join(root, "autoexec"); await mkdir(scripts, { recursive: true }); await writeFile(path.join(scripts, "potassium_mcp_bootstrap.lua"), "return { bridge = true }\n"); await writeFile(path.join(scripts, "potassium_mcp_autoexec.lua"), "return { autoexec = true }\n"); return { root, scripts, workspace, autoexec }; }
const options = (value) => ({ projectRoot: value.root, scriptSourceRoot: value.scripts, workspaceRoot: value.workspace, autoexecRoot: value.autoexec, compileProbe: () => {} });

test("deploy installs exactly the canonical bootstrap and autoexec with byte parity", async (t) => { const value = await fixture(t); const state = await deploy(options(value)); assert.equal(state.schema, 3); assert.deepEqual(state.files.map(({ name }) => name), ["bootstrap", "autoexec"]); for (const file of state.files) { assert.equal(await readFile(file.source, "utf8"), await readFile(file.target, "utf8")); } });
test("deploy rolls back both scripts and state when activation fails", async (t) => { const value = await fixture(t); await mkdir(value.workspace, { recursive: true }); await mkdir(value.autoexec, { recursive: true }); const bootstrap = path.join(value.workspace, ".potassium-mcp-bootstrap.lua"); const autoexec = path.join(value.autoexec, "potassium_mcp_autoexec.lua"); await writeFile(bootstrap, "old bootstrap\n"); await writeFile(autoexec, "old autoexec\n"); await assert.rejects(deploy({ ...options(value), onActivation: (name) => { if (name === "autoexec") throw new Error("stop"); } }), /stop/); assert.equal(await readFile(bootstrap, "utf8"), "old bootstrap\n"); assert.equal(await readFile(autoexec, "utf8"), "old autoexec\n"); });
test("deploy rejects a source path that overlaps a mutation target", async (t) => { const value = await fixture(t); await assert.rejects(deploy({ ...options(value), workspaceRoot: value.scripts }), /must not overlap/); });
