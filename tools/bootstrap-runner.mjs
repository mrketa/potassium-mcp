import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const luneVersion = "0.10.4";
const archives = {
  "win32-x64": ["windows-x86_64", "7f0161867fe1f39a7b3d4dc5854d2ddc2dfe64794a184c253953b0e4ff5f0813"],
  "linux-x64": ["linux-x86_64", "ffba0bd404ae078c9543ef5ac12479938a741aab255768a11a08517ae963b288"],
};
const cache = path.join(root, ".cache", `lune-${luneVersion}`);
const executable = () => process.env.LUNE_BIN || path.join(cache, process.platform === "win32" ? "lune.exe" : "lune");
const executionOptions = { cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { ...executionOptions, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(binary)} failed: ${result.error?.message || result.stderr || result.stdout || result.status}`);
  return result.stdout;
}
export async function installToolchain() {
  const asset = archives[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error("Pinned bootstrap toolchain supports Windows x64 and Linux x64 only");
  const filename = `lune-${luneVersion}-${asset[0]}.zip`;
  const response = await fetch(`https://github.com/lune-org/lune/releases/download/v${luneVersion}/${filename}`, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Lune download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== asset[1]) throw new Error("Pinned Lune archive SHA-256 mismatch");
  await mkdir(cache, { recursive: true });
  const archive = path.join(cache, filename);
  await writeFile(archive, bytes);
  if (process.platform === "win32") {
    command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $env:LUNE_ARCHIVE -DestinationPath $env:LUNE_DESTINATION -Force"], { env: { ...process.env, LUNE_ARCHIVE: archive, LUNE_DESTINATION: cache } });
  } else {
    command("unzip", ["-o", archive, "-d", cache]);
    await chmod(path.join(cache, "lune"), 0o755);
  }
  console.log(JSON.stringify({ toolchain: luneVersion, archiveSha256: asset[1], installed: true }));
}
export async function runBootstrap(mode = "full", { cycles = 100, jobs = 256, repeats = 5, scenarioSource } = {}) {
  if (!["full", "queue", "benchmark", "lifecycle", "scenario"].includes(mode)) throw new Error("Mode must be full, queue, benchmark, lifecycle, or scenario");
  if (mode === "scenario" && typeof scenarioSource !== "string") throw new Error("scenario mode requires scenarioSource");
  const { stdout: version } = await execFileAsync(executable(), ["--version"], executionOptions);
  if (version.trim() !== `lune ${luneVersion}`) throw new Error(`Expected lune ${luneVersion}; found ${version.trim()}`);
  let temporary;
  let output;
  try {
    let scenarioPath = "";
    if (mode === "scenario") {
      temporary = mkdtempSync(path.join(tmpdir(), "potassium-bootstrap-scenario-"));
      scenarioPath = path.join(temporary, "scenario.luau");
      writeFileSync(scenarioPath, scenarioSource);
    }
    ({ stdout: output } = await execFileAsync(executable(), ["run", "tools/bootstrap-runner.luau", mode, String(cycles), String(jobs), String(repeats), scenarioPath], executionOptions));
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
  const marker = output.split(/\r?\n/).findLast((line) => line.startsWith("BOOTSTRAP_RESULT="));
  if (!marker) throw new Error(`Bootstrap runner did not return its result envelope: ${output}`);
  const report = JSON.parse(marker.slice("BOOTSTRAP_RESULT=".length));
  if (!report.ok || report.failed !== 0 || !(report.total > 0 || (mode === "scenario" && report.measured > 0))) throw new Error(`Bootstrap fixture failed: ${JSON.stringify(report)}`);
  return report;
}
async function main() {
  const mode = process.argv[2] || "full";
  if (process.argv.length > 3) throw new Error("Usage: node tools/bootstrap-runner.mjs [toolchain|full|queue|benchmark|lifecycle]");
  if (mode === "toolchain") await installToolchain();
  else console.log(JSON.stringify(await runBootstrap(mode), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
