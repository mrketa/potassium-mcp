import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { packNpmRelease, parseReleaseArgs, portableRelative, selectPublicFiles } from "./release.mjs";
import { validateNpmArtifact } from "../potassium-mcp/release-publish.js";
import { loadSmokeArtifact } from "./package-smoke.mjs";

async function fixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "celestial-release-"));
  const listed = Object.keys(files);
  await writeFile(path.join(root, "release-manifest.json"), `${JSON.stringify({ schemaVersion: 1, files: ["release-manifest.json", ...listed] })}\n`);
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  return root;
}

test("portableRelative emits separator-stable paths and rejects escapes", () => {
  const root = path.resolve("repo");
  assert.equal(portableRelative(root, path.join(root, "potassium-mcp", "src", "server.js")), "potassium-mcp/src/server.js");
  assert.throws(() => portableRelative(root, path.resolve("outside", "config.json")), /escapes/);
});

test("selectPublicFiles accepts precisely manifest-listed regular files", async (t) => {
  const root = await fixture({ "src/main.js": "export const safe = true;\n" });
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(root, ".github", "workflows", "release.yml"), "name: fixture\n");
  const files = await selectPublicFiles(root);
  assert.deepEqual(files.map(({ path: file }) => file), ["release-manifest.json", "src/main.js"]);
});

test("selectPublicFiles ignores unlisted repository files and rejects secret-bearing release files", async (t) => {
  const root = await fixture({ "src/main.js": "export const safe = true;\n" });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "unexpected.js"), "do not publish\n");
  const files = await selectPublicFiles(root);
  assert.deepEqual(files.map(({ path: file }) => file), ["release-manifest.json", "src/main.js"]);
  await writeFile(path.join(root, "src/main.js"), `export const config = { "token": "${"1".repeat(32)}" };\n`);
  await assert.rejects(selectPublicFiles(root), /Potential secret literal/);
});

test("selectPublicFiles rejects common credential assignments and local absolute paths", async (t) => {
  const root = await fixture({ "src/main.js": "export const safe = true;\n" });
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "src/main.js");
  const secret = "s".repeat(40);
  for (const unsafe of [
    `TOKEN=${secret}\n`,
    `$env:API_KEY = "${secret}"\n`,
    `local password = "${secret}"\n`,
    `Authorization: Bearer ${secret}\n`,
    "cache = C:" + String.fromCharCode(92) + "Users" + String.fromCharCode(92) + "operator" + String.fromCharCode(92) + "private.json\n",
    "share = " + String.fromCharCode(92, 92) + "workstation" + String.fromCharCode(92) + "private" + String.fromCharCode(92) + "token.txt\n",
    "cache = /home/" + "operator/private.json\n",
  ]) {
    await writeFile(target, unsafe);
    await assert.rejects(selectPublicFiles(root), /Potential secret literal|Absolute local path/);
  }
});

test("release gate rejects undeclared binary trust and unsealed parser executables", async (t) => {
  const unknown = await fixture({ "assets/unknown.wasm": Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]) });
  const unsealed = await fixture({ "potassium-mcp/assets/parser-host/win32-x64/PotassiumMcp.ParserHost.exe": Buffer.from("MZ-unsealed") });
  const native = await fixture({ "potassium-mcp/assets/native-parser/win32-x64/PotassiumMcp.LuauParser.exe": Buffer.from("MZ-unsealed") });
  t.after(() => Promise.all([unknown, unsealed, native].map((root) => rm(root, { recursive: true, force: true }))));
  await assert.rejects(selectPublicFiles(unknown), /Unverified binary/);
  await assert.rejects(selectPublicFiles(unsealed), /Parser host asset missing/);
  await assert.rejects(selectPublicFiles(native), /Native parser asset missing/);
});

function npmTarball(files) {
  const entries = [];
  for (const [name, value] of Object.entries(files)) {
    const content = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`);
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
    entries.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

async function npmFixture(t) {
  const manifest = {
    name: "@mrketa/potassium-mcp", version: "1.2.3-beta.1", type: "module",
    bin: { "potassium-mcp": "bin/cli.js" },
    files: ["bin/", "src/", "assets/", "README.md", "LICENSE"],
    scripts: { "release:pack": "node ../tools/release.mjs pack", test: "node --test", prepack: "exit 99" },
    dependencies: { "@modelcontextprotocol/sdk": "1.30.0" },
  };
  const files = {
    "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "bin/cli.js": "#!/usr/bin/env node\nimport '../src/main.js';\n",
    "src/main.js": "console.log('runtime');\n",
    "assets/bootstrap.luau": "return true\n",
    "README.md": "Runtime fixture\n", LICENSE: "Fixture license\n",
  };
  const root = await fixture(Object.fromEntries(Object.entries(files).map(([file, content]) => [`potassium-mcp/${file}`, content])));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "potassium-mcp", "release-publish.js"), "source only");
  await mkdir(path.join(root, "potassium-mcp", "node_modules"));
  await writeFile(path.join(root, "potassium-mcp", ".npmrc"), "tag=latest\n");
  await writeFile(path.join(root, "potassium-mcp", "src", "local-config.json"), JSON.stringify({ token: "s".repeat(40) }));
  return { root, manifest, files };
}

function packCommand({ manifest, files }, capture, corruptIntegrity = false) {
  return async (args, { cwd }) => {
    assert.deepEqual(args, ["pack", "--json", "--ignore-scripts"]);
    capture.stage = cwd;
    assert.deepEqual((await readdir(cwd)).sort(), ["LICENSE", "README.md", "assets", "bin", "package.json", "src"]);
    const installed = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    assert.deepEqual(await readdir(path.join(cwd, "src")), ["main.js"]);
    assert.equal(Object.hasOwn(installed, "scripts"), false);
    assert.deepEqual(installed.dependencies, manifest.dependencies);
    assert.deepEqual(installed.bin, manifest.bin);
    const packedFiles = {};
    for (const [file, content] of Object.entries(files)) {
      packedFiles[file] = await readFile(path.join(cwd, file), "utf8");
      if (file !== "package.json") assert.equal(packedFiles[file], content);
    }
    capture.bytes = npmTarball(packedFiles);
    const filename = "mrketa-potassium-mcp-1.2.3-beta.1.tgz";
    await writeFile(path.join(cwd, filename), capture.bytes);
    return JSON.stringify([{
      filename, name: manifest.name, version: manifest.version,
      integrity: corruptIntegrity ? "sha512-wrong" : `sha512-${createHash("sha512").update(capture.bytes).digest("base64")}`,
    }]);
  };
}

test("npm packing stages runtime-only content without mutating the source manifest", async (t) => {
  const fixture = await npmFixture(t);
  const capture = {};
  const metadata = await packNpmRelease(fixture.root, { command: packCommand(fixture, capture) });
  assert.notEqual(capture.stage, path.join(fixture.root, "potassium-mcp"));
  const destination = path.join(fixture.root, "release-out");
  const artifact = await validateNpmArtifact(path.join(destination, "NPM-ARTIFACT.json"), fixture.manifest);
  assert.deepEqual(await readFile(artifact.tarball), capture.bytes);
  assert.deepEqual(metadata, {
    filename: artifact.filename, name: artifact.name, version: artifact.version,
    integrity: artifact.integrity, sha256: artifact.sha256,
  });
  assert.equal(await readFile(path.join(fixture.root, "potassium-mcp", "package.json"), "utf8"), fixture.files["package.json"]);
  await assert.rejects(readFile(path.join(capture.stage, "package.json")), { code: "ENOENT" });
  // A second pack uses a new clean staging tree and preserves identical bytes.
  const again = await packNpmRelease(fixture.root, { command: packCommand(fixture, {}) });
  assert.deepEqual(again, metadata);
});

test("failed npm integrity verification removes stale publish metadata and cleans staging", async (t) => {
  const fixture = await npmFixture(t);
  await packNpmRelease(fixture.root, { command: packCommand(fixture, {}) });
  const capture = {};
  await assert.rejects(packNpmRelease(fixture.root, { command: packCommand(fixture, capture, true) }), /integrity/);
  await assert.rejects(readFile(path.join(fixture.root, "release-out", "NPM-ARTIFACT.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(capture.stage, "package.json")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(fixture.root, "potassium-mcp", "package.json"), "utf8"), fixture.files["package.json"]);
});

test("npm staging refuses escaping runtime paths before invoking npm", async (t) => {
  const fixture = await npmFixture(t);
  fixture.manifest.files.push("../outside");
  await writeFile(path.join(fixture.root, "potassium-mcp", "package.json"), JSON.stringify(fixture.manifest));
  await assert.rejects(packNpmRelease(fixture.root, { command: () => assert.fail("npm must not run") }), /Invalid npm runtime path/);
});

test("npm staging applies the public secret-content gate before invoking npm", async (t) => {
  const fixture = await npmFixture(t);
  await writeFile(path.join(fixture.root, "potassium-mcp", "src", "main.js"), `const token = "${"s".repeat(40)}";\n`);
  await assert.rejects(packNpmRelease(fixture.root, { command: () => assert.fail("npm must not run") }), /Potential secret literal/);
  await assert.rejects(readFile(path.join(fixture.root, "release-out", "NPM-ARTIFACT.json")), { code: "ENOENT" });
});

test("isolated npm output and selected smoke metadata preserve historical artifact bytes", async (t) => {
  const fixture = await npmFixture(t);
  const historical = path.join(fixture.root, "release-out");
  await packNpmRelease(fixture.root, { command: packCommand(fixture, {}) });
  const historicalFiles = await readdir(historical);
  const original = await Promise.all(historicalFiles.map((file) => readFile(path.join(historical, file))));
  const output = path.join(historical, "ownership-candidate");
  const capture = {};
  const metadata = await packNpmRelease(fixture.root, { output, command: packCommand(fixture, capture) });
  const metadataPath = path.join(output, "NPM-ARTIFACT.json");
  const selected = await loadSmokeArtifact({ npmArtifact: metadataPath });
  assert.deepEqual(selected.tarballBytes, capture.bytes);
  assert.equal(selected.artifact.tarball, path.join(output, metadata.filename));
  assert.equal(selected.artifact.npmArtifact, metadataPath);
  for (const [index, file] of historicalFiles.entries()) assert.deepEqual(await readFile(path.join(historical, file)), original[index]);
  await assert.rejects(packNpmRelease(fixture.root, { output, command: packCommand(fixture, {}, true) }));
  await assert.rejects(readFile(metadataPath), { code: "ENOENT" });
  await assert.rejects(loadSmokeArtifact({ npmArtifact: metadataPath }), { code: "ENOENT" });
  for (const [index, file] of historicalFiles.entries()) assert.deepEqual(await readFile(path.join(historical, file)), original[index]);
});

test("selected smoke metadata binds archive identity, checksum sidecar and optional tarball before installation", async (t) => {
  const fixture = await npmFixture(t);
  const output = path.join(fixture.root, "release-out");
  const metadata = await packNpmRelease(fixture.root, { command: packCommand(fixture, {}) });
  const npmArtifact = path.join(output, "NPM-ARTIFACT.json");
  const tarball = path.join(output, metadata.filename);
  const alternate = path.join(fixture.root, "alternate.tgz");
  const bytes = await readFile(tarball);
  await writeFile(alternate, bytes);
  assert.deepEqual((await loadSmokeArtifact({ npmArtifact, tarball: alternate })).tarballBytes, bytes);
  await writeFile(alternate, npmTarball({ "package.json": JSON.stringify({ name: metadata.name, version: metadata.version }), "src/other.js": "different same-version package" }));
  await assert.rejects(loadSmokeArtifact({ npmArtifact, tarball: alternate }));
  await writeFile(`${tarball}.sha256`, `${"0".repeat(64)}  ${metadata.filename}\n`);
  await assert.rejects(loadSmokeArtifact({ npmArtifact }));
  await writeFile(`${tarball}.sha256`, `${metadata.sha256}  ${metadata.filename}\n`);
  await writeFile(npmArtifact, JSON.stringify({ ...metadata, version: "1.2.4-beta.1" }));
  await assert.rejects(loadSmokeArtifact({ npmArtifact }));
  await writeFile(npmArtifact, JSON.stringify({ ...metadata, filename: "../alternate.tgz" }));
  await assert.rejects(loadSmokeArtifact({ npmArtifact }));
  assert.deepEqual(await readFile(tarball), bytes);
});

test("npm output refuses source overlap, escapes and redirected ancestors before npm or writes", async (t) => {
  const fixture = await npmFixture(t);
  const source = path.join(fixture.root, "potassium-mcp");
  const noNpm = () => assert.fail("invalid destination must not invoke npm");
  for (const output of [source, path.join(source, "candidate"), fixture.root, path.resolve(fixture.root, "..", "outside-release")]) {
    await assert.rejects(packNpmRelease(fixture.root, { output, command: noNpm }));
  }
  const target = path.join(fixture.root, "untouched");
  const linked = path.join(fixture.root, "redirected");
  await mkdir(target);
  await writeFile(path.join(target, "NPM-ARTIFACT.json"), "historical");
  await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(packNpmRelease(fixture.root, { output: path.join(linked, "candidate"), command: noNpm }));
  assert.deepEqual(await readdir(target), ["NPM-ARTIFACT.json"]);
  assert.equal(await readFile(path.join(target, "NPM-ARTIFACT.json"), "utf8"), "historical");
  assert.equal(await readFile(path.join(source, "package.json"), "utf8"), fixture.files["package.json"]);
});

test("npm output CLI rejects duplicate, missing, unknown and meaningless options", () => {
  assert.deepEqual(parseReleaseArgs(["npm-pack", "--output", "release-out/ownership-candidate"]), { command: "npm-pack", options: { output: "release-out/ownership-candidate" } });
  for (const args of [
    ["npm-pack", "--output"], ["npm-pack", "--output", ""],
    ["npm-pack", "--output", "a", "--output", "b"],
    ["npm-pack", "--output", "--unknown"], ["npm-pack", "--output-dir", "a"],
    ["check", "--output", "a"], ["pack", "--output", "a"], ["npm-pack", "extra"],
  ]) assert.throws(() => parseReleaseArgs(args));
});
