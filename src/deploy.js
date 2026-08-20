import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = path.join(packageRoot, "assets");
const defaultWorkspaceRoot = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Potassium", "workspace")
  : path.resolve(packageRoot, "../workspace");
const files = [["bootstrap", "potassium_mcp_bootstrap.lua", ".potassium-mcp-bootstrap.lua"], ["autoexec", "potassium_mcp_autoexec.lua", "potassium_mcp_autoexec.lua"]];
const exists = (target) => access(target, constants.F_OK).then(() => true).catch(() => false);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function resolvedPath(target) { return await exists(target) ? realpath(target) : path.resolve(target); }
function overlaps(left, right) { const relative = path.relative(left, right); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".."); }
export async function rejectUnsafePaths({ scriptSourceRoot, workspaceRoot, autoexecRoot, targets, statePath }) {
  const [source, workspace, autoexec, state, ...resolvedTargets] = await Promise.all([scriptSourceRoot, workspaceRoot, autoexecRoot, statePath, ...targets].map(resolvedPath));
  const protectedRoots = [workspace, autoexec, state, ...resolvedTargets];
  if (protectedRoots.some((target) => overlaps(source, target) || overlaps(target, source))) throw new Error("scriptSourceRoot must not overlap a deployment target");
  for (const [index, target] of [state, ...resolvedTargets].entries()) for (const other of [state, ...resolvedTargets].slice(index + 1)) if (overlaps(target, other) || overlaps(other, target)) throw new Error("deployment targets must not overlap");
}
async function stage(target, content) { const staged = `${target}.${randomUUID()}.staging`; await mkdir(path.dirname(staged), { recursive: true }); await writeFile(staged, content); return staged; }
async function backup(target) { const present = await exists(target); const backupPath = `${target}.${randomUUID()}.backup`; if (present) await rename(target, backupPath); return { target, backupPath, present, activated: false }; }
async function restore(item) { if (item.activated) await rm(item.target, { force: true }); if (item.present && await exists(item.backupPath)) await rename(item.backupPath, item.target); }

export async function deploy(options = {}) {
  const scriptSourceRoot = path.resolve(options.scriptSourceRoot ?? assetsRoot);
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.env.POTASSIUM_WORKSPACE ?? defaultWorkspaceRoot);
  const autoexecRoot = path.resolve(options.autoexecRoot ?? path.join(workspaceRoot, "..", "autoexec"));
  const statePath = path.resolve(options.statePath ?? path.join(workspaceRoot, ".potassium-mcp-deploy-state.json"));
  const scripts = await Promise.all(files.map(async ([name, sourceName, targetName]) => {
    const source = path.join(scriptSourceRoot, sourceName); const content = await readFile(source);
    return { name, source, target: path.join(name === "bootstrap" ? workspaceRoot : autoexecRoot, targetName), content, sha256: sha256(content), bytes: content.byteLength };
  }));
  await rejectUnsafePaths({ scriptSourceRoot, workspaceRoot, autoexecRoot, targets: scripts.map(({ target }) => target), statePath });
  await options.compileProbe?.(scripts.map(({ source }) => source));
  const state = { schema: 3, deployedAt: new Date().toISOString(), scriptSourceRoot, workspaceRoot, autoexecRoot, files: scripts.map(({ name, source, target, sha256: digest, bytes }) => ({ name, source, target, sha256: digest, bytes })) };
  const staged = await Promise.all([...scripts.map(({ target, content }) => stage(target, content)), stage(statePath, `${JSON.stringify(state, null, 2)}\n`)]);
  const transaction = [];
  try {
    for (const target of [...scripts.map(({ target }) => target), statePath]) transaction.push(await backup(target));
    for (let index = 0; index < transaction.length; index += 1) { await rename(staged[index], transaction[index].target); transaction[index].activated = true; await options.onActivation?.(index < scripts.length ? scripts[index].name : "state"); }
    for (const item of scripts) { const deployed = await readFile(item.target); if (deployed.byteLength !== item.bytes || sha256(deployed) !== item.sha256) throw new Error(`deployed ${item.name} differs from canonical source`); }
  } catch (error) { await Promise.all(transaction.slice().reverse().map(restore)); throw error; }
  finally { await Promise.all(staged.map((file) => rm(file, { force: true }))); }
  await Promise.all(transaction.map(({ backupPath }) => rm(backupPath, { force: true }).catch(() => {})));
  return state;
}
