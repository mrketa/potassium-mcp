import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const thisFile = fileURLToPath(import.meta.url);
const packageDirectory = dirname(thisFile);
const registry = "--registry=https://registry.npmjs.org/";
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function distTagForVersion(version) {
  const match = typeof version === "string" && semver.exec(version);
  if (!match || match[0] !== version || version.length > 256 || match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part)))) throw new Error("Invalid release semver");
  if (!match[4]) return "latest";
  const channel = match[4].split(".")[0];
  // Only known channels may become tags; labels such as latest, v1, or 123
  // must never be interpreted as stable tags or npm semver ranges.
  return ["alpha", "beta", "rc", "next", "canary", "dev"].includes(channel) ? channel : "next";
}

export function validatePublishArgs(argv) {
  const allowed = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run" || value === "--provenance") {
      allowed.push(value);
      continue;
    }
    if (value === "--otp" && /^\d{6}$/.test(argv[index + 1] ?? "")) {
      allowed.push(value, argv[++index]);
      continue;
    }
    if (/^--otp=\d{6}$/.test(value)) {
      allowed.push(value);
      continue;
    }
    throw new Error("Unsupported npm publish option");
  }
  return allowed;
}

export function runNpm(args, options) {
  const npmCli = options.env.npm_execpath ?? (process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : undefined);
  return npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], options)
    : execFileSync("npm", args, options);
}

// Read the identity from the artifact itself, not just its sidecar. npm produces
// a regular package/package.json entry; ambiguous or malformed archives fail closed.
export function tarballPackageMetadata(bytes) {
  const tar = gunzipSync(bytes);
  let metadata;
  let ended = false;
  const paths = new Set();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every((byte) => byte === 0)) throw new Error("Invalid npm tarball terminator");
      ended = true;
      break;
    }
    const text = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const octal = (start, end) => {
      const value = text(start, end).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error("Invalid npm tarball numeric header");
      return Number.parseInt(value, 8);
    };
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(148, 156)) throw new Error("Invalid npm tarball header checksum");
    const size = octal(124, 136);
    const end = offset + 512 + size;
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(next) || next > tar.length) throw new Error("Truncated npm tarball");
    const name = [text(345, 500), text(0, 100)].filter(Boolean).join("/");
    // npm extraction normalizes dot segments and platform path aliases. Accept
    // only the clean regular-file paths emitted by this release's npm staging.
    const segments = name.split("/");
    if (segments.length < 2 || segments[0] !== "package" || /[\\:\x00-\x1f\x7f]/.test(name)
      || segments.some((segment) => !segment || segment === "." || segment === ".." || /[. ]$/.test(segment))) throw new Error("Noncanonical npm tarball path");
    const canonical = name.toLowerCase();
    if (paths.has(canonical)) throw new Error("Ambiguous npm tarball duplicate path");
    paths.add(canonical);
    if (![0, 48].includes(header[156]) || text(157, 257)) throw new Error("Npm tarball entries must be regular files");
    if (name === "package/package.json") {
      if (metadata) throw new Error("Ambiguous npm tarball package manifest");
      metadata = JSON.parse(tar.subarray(offset + 512, end).toString("utf8"));
    }
    offset = next;
  }
  if (!ended || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Missing npm tarball package manifest");
  return metadata;
}

export async function validateNpmArtifact(metadataPath, expected) {
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Invalid npm artifact metadata");
  const { filename, name, version, integrity, sha256 } = metadata;
  distTagForVersion(version);
  if (name !== expected.name || version !== expected.version) throw new Error("Npm artifact name/version does not match the release package");
  if (typeof filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*\.tgz$/.test(filename) || basename(filename) !== filename) throw new Error("Invalid npm artifact filename");
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) || typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error("Invalid npm artifact checksums");
  const tarball = resolve(dirname(metadataPath), filename);
  if (!(await lstat(tarball)).isFile()) throw new Error("Npm artifact must be a regular file");
  const bytes = await readFile(tarball);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256 || `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity) throw new Error("Npm artifact checksum mismatch");
  const checksum = await readFile(`${tarball}.sha256`, "utf8");
  if (checksum !== `${sha256}  ${filename}\n`) throw new Error("Npm artifact checksum sidecar mismatch");
  const packed = tarballPackageMetadata(bytes);
  if (packed.publishConfig && (
    typeof packed.publishConfig !== "object" || Array.isArray(packed.publishConfig)
    || Object.keys(packed.publishConfig).some((key) => !["registry", "tag", "access"].includes(key))
    || packed.publishConfig.registry !== undefined && packed.publishConfig.registry !== "https://registry.npmjs.org/"
    || packed.publishConfig.tag !== undefined && packed.publishConfig.tag !== distTagForVersion(version)
    || packed.publishConfig.access !== undefined && packed.publishConfig.access !== "public"
  )) throw new Error("Npm tarball publishConfig overrides release routing");
  if (packed.name !== name || packed.version !== version) throw new Error("Npm tarball name/version does not match artifact metadata");
  return { filename, name, version, integrity, sha256, tarball };
}

function registryErrorCode(error) {
  for (const output of [error.stdout, error.stderr]) {
    try {
      const result = JSON.parse(String(output));
      if (result?.error?.code) return result.error.code;
    } catch { /* Plain-text diagnostics are not proof of a missing version. */ }
  }
  return undefined;
}

export async function main(argv = process.argv.slice(2), env = process.env, {
  command = runNpm,
  metadataPath = resolve(packageDirectory, "../release-out/NPM-ARTIFACT.json"),
  packagePath = join(packageDirectory, "package.json"),
} = {}) {
  const extraArgs = validatePublishArgs(argv);
  const expected = JSON.parse(await readFile(packagePath, "utf8"));
  const artifact = await validateNpmArtifact(metadataPath, expected);
  const tag = distTagForVersion(artifact.version);
  const token = env.NPM_TOKEN;
  if (!token) throw new Error("NPM_TOKEN must be set to publish @mrketa/potassium-mcp to npmjs.");
  const options = { cwd: packageDirectory, env: { ...env, NODE_AUTH_TOKEN: token }, encoding: "utf8", stdio: "pipe" };
  let published;
  let absent = false;
  try {
    published = await command(["view", `${artifact.name}@${artifact.version}`, "--json", registry], options);
  } catch (error) {
    if (registryErrorCode(error) !== "E404") throw error;
    absent = true;
  }
  if (!absent) {
    const existing = JSON.parse(String(published));
    if (existing?.name !== artifact.name || existing?.version !== artifact.version || existing?.dist?.integrity !== artifact.integrity) throw new Error("Published npm version identity/integrity mismatch; refusing to overwrite or retag");
    return { status: "resumed", ...artifact };
  }
  // Revalidate after the registry round trip before handing npm the exact file.
  const confirmed = await validateNpmArtifact(metadataPath, artifact);
  if (confirmed.tarball !== artifact.tarball || confirmed.integrity !== artifact.integrity || confirmed.sha256 !== artifact.sha256) throw new Error("Npm artifact changed during registry lookup");
  await command(["publish", artifact.tarball, ...extraArgs, "--ignore-scripts", "--access", "public", registry, "--tag", tag], { ...options, stdio: "inherit" });
  return { status: extraArgs.includes("--dry-run") ? "dry-run" : "published", tag, ...artifact };
}
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(`publish failed: ${error.message}`);
    process.exitCode = 1;
  });
}
