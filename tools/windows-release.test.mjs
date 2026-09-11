import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BUNDLE_ENTRIES, NODE_SHA256, NODE_VERSION, buildWindows, inspectOutput, inventoryTree, main, publishOwnedOutput, safeBundlePath, stageWindows, validateBundleManifest, verifyTree, verifyWindowsExecutable } from "./windows-release.mjs";

function manifest() {
  return {
    schema: 1,
    packageVersion: "0.10.0-beta.1",
    nodeVersion: NODE_VERSION,
    entries: { ...BUNDLE_ENTRIES },
    files: [BUNDLE_ENTRIES.node, BUNDLE_ENTRIES.cli, BUNDLE_ENTRIES.launcher, `${BUNDLE_ENTRIES.packageRoot}/package.json`]
      .map((name) => ({ path: name, bytes: 1, sha256: name === BUNDLE_ENTRIES.node ? NODE_SHA256 : "a".repeat(64) })),
  };
}

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "potassium-windows-boundary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function npmReceipt(directory) {
  const source = JSON.parse(await readFile(new URL("../potassium-mcp/package.json", import.meta.url), "utf8"));
  const bytes = Buffer.from("candidate tarball bytes");
  const metadata = {
    filename: "candidate.tgz", name: source.name, version: source.version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
  const filename = path.join(directory, "NPM-ARTIFACT.json");
  const tarball = path.join(directory, metadata.filename);
  await writeFile(filename, JSON.stringify(metadata));
  await writeFile(tarball, "tampered candidate tarball bytes");
  return { filename, tarball, metadata };
}

test("Windows archive paths cannot target parent directories, aliases or device streams", () => {
  for (const name of ["../escape", "C:/escape", "a\\b", "a/b:secret", "a//b", "a/./b", "a/NUL.txt", "a/com1", "a/trailing.", "a/trailing "]) {
    assert.throws(() => safeBundlePath(name), /Noncanonical/);
  }
  assert.equal(safeBundlePath("app/node_modules/@scope/Русский/package.json"), "app/node_modules/@scope/Русский/package.json");
});

test("runtime manifest rejects alias collisions, absent entrypoints and a substituted Node", () => {
  const duplicate = manifest();
  duplicate.files.push({ ...duplicate.files[0], path: "NODE/NODE.EXE" });
  assert.throws(() => validateBundleManifest(duplicate), /duplicate/);
  const missing = manifest();
  missing.files = missing.files.filter((file) => file.path !== BUNDLE_ENTRIES.cli);
  assert.throws(() => validateBundleManifest(missing), /Missing required/);
  const substituted = manifest();
  substituted.files[0].sha256 = "b".repeat(64);
  assert.throws(() => validateBundleManifest(substituted), /immutable pin/);
  const parentFile = manifest();
  parentFile.files.push({ path: "app", sha256: "a".repeat(64), bytes: 1 });
  assert.throws(() => validateBundleManifest(parentFile), /file\/directory alias/);
});

test("manifest size bounds reject oversized files and aggregate decompression", () => {
  const largeFile = manifest();
  largeFile.files[1].bytes = 512 * 1024 * 1024 + 1;
  assert.throws(() => validateBundleManifest(largeFile), /Invalid/);
  const largeTotal = manifest();
  largeTotal.files.forEach((file) => { file.bytes = 300 * 1024 * 1024; });
  assert.throws(() => validateBundleManifest(largeTotal), /total byte limit/);
});

test("inventory compares actual Unicode file bytes, rejecting tampering and additional content", async (t) => {
  const directory = await temporary(t);
  await mkdir(path.join(directory, "資料"));
  const filename = path.join(directory, "資料", "Данные.txt");
  await writeFile(filename, "verified payload");
  const records = await inventoryTree(directory);
  assert.equal(records[0].path, "資料/Данные.txt");
  await verifyTree(directory, records.map(({ path: name, bytes, sha256 }) => ({ bytes, path: name, sha256 })));
  await writeFile(filename, "modified payload");
  await assert.rejects(verifyTree(directory, records), /differ/);
  await writeFile(filename, "verified payload");
  await writeFile(path.join(directory, "unexpected.txt"), "foreign");
  await assert.rejects(verifyTree(directory, records), /differ/);
});

test("inventory never traverses a directory junction outside its stage", async (t) => {
  const directory = await temporary(t);
  const stage = path.join(directory, "stage");
  const external = path.join(directory, "external");
  await mkdir(stage);
  await mkdir(external);
  await writeFile(path.join(external, "private.txt"), "not distributable");
  await symlink(external, path.join(stage, "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(inventoryTree(stage), /Links\/reparse/);
});

test("executable check rejects text stubs and x86 PE files", async (t) => {
  const directory = await temporary(t);
  const filename = path.join(directory, "Setup.exe");
  await writeFile(filename, "installer placeholder");
  await assert.rejects(verifyWindowsExecutable(filename), /Missing real/);
  const bytes = Buffer.alloc(4096);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(128, 0x3c);
  bytes.writeUInt32LE(0x00004550, 128);
  bytes.writeUInt16LE(0x014c, 132);
  bytes.writeUInt16LE(0x10b, 152);
  await writeFile(filename, bytes);
  await assert.rejects(verifyWindowsExecutable(filename), /not Windows x64/);
});

test("output publication preserves unowned Setup files and stale pending names", async (t) => {
  const directory = await temporary(t);
  const source = path.join(directory, "new");
  const output = path.join(directory, "existing");
  await mkdir(source);
  await mkdir(output);
  await writeFile(path.join(source, "Setup.exe"), "new");
  await writeFile(path.join(output, "Setup.exe"), "foreign executable");
  await writeFile(path.join(output, "Setup.exe.pending"), "foreign pending file");
  await assert.rejects(publishOwnedOutput(source, output), /unowned/);
  assert.equal(await readFile(path.join(output, "Setup.exe"), "utf8"), "foreign executable");
  assert.equal(await readFile(path.join(output, "Setup.exe.pending"), "utf8"), "foreign pending file");
  assert.deepEqual((await readdir(output)).sort(), ["Setup.exe", "Setup.exe.pending"]);
});

test("receipt-owned output replaces atomically and refuses modified or unknown content", async (t) => {
  const directory = await temporary(t);
  const source = path.join(directory, "new");
  const output = path.join(directory, "output");
  await mkdir(source);
  await writeFile(path.join(source, "Setup.exe"), "first complete artifact");
  await publishOwnedOutput(source, output);
  const first = await inspectOutput(output);
  await writeFile(path.join(source, "Setup.exe"), "second complete artifact");
  await publishOwnedOutput(source, output, first);
  assert.equal(await readFile(path.join(output, "Setup.exe"), "utf8"), "second complete artifact");
  const second = await inspectOutput(output);
  await assert.rejects(publishOwnedOutput(source, output, first), /changed during staging/);
  assert.equal((await inspectOutput(output)).snapshot, second.snapshot);
  await mkdir(path.join(output, "unknown-empty-directory"));
  await assert.rejects(publishOwnedOutput(source, output), /unowned/);
  await rm(path.join(output, "unknown-empty-directory"), { recursive: true });
  await writeFile(path.join(output, "Setup.exe"), "user edit");
  await assert.rejects(publishOwnedOutput(source, output), /modified or unowned/);
  assert.equal(await readFile(path.join(output, "Setup.exe"), "utf8"), "user edit");
});

test("output ancestors and previously owned stage junctions cannot redirect publication", async (t) => {
  const directory = await temporary(t);
  const source = path.join(directory, "new");
  const output = path.join(directory, "output");
  const external = path.join(directory, "external");
  await mkdir(source);
  await mkdir(path.join(source, "stage"));
  await writeFile(path.join(source, "stage", "runtime-bundle.zip"), "new stage");
  await mkdir(external);
  await writeFile(path.join(external, "foreign.txt"), "preserve");
  const redirected = path.join(directory, "redirected");
  await symlink(external, redirected, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(publishOwnedOutput(source, path.join(redirected, "output")), /Redirected/);
  assert.deepEqual(await readdir(external), ["foreign.txt"]);
  await publishOwnedOutput(source, output);
  await rm(path.join(output, "stage"), { recursive: true });
  await symlink(external, path.join(output, "stage"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(publishOwnedOutput(source, output), /Links\/reparse|Redirected/);
  assert.equal(await readFile(path.join(external, "foreign.txt"), "utf8"), "preserve");
  assert.deepEqual(await readdir(external), ["foreign.txt"]);
});

test("Windows stage selects the receipt-adjacent tarball and never falls back when it is absent", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await temporary(t);
  const receipt = await npmReceipt(directory);
  const output = path.join(directory, "windows-setup");
  await assert.rejects(main(["stage", "--npm-artifact", path.relative(process.cwd(), receipt.filename), "--output", output]), /checksum mismatch/);
  await assert.rejects(readdir(output), { code: "ENOENT" });
  await rm(receipt.tarball);
  await assert.rejects(stageWindows(output, { npmArtifact: receipt.filename }), (error) => error.code === "ENOENT" && error.path === receipt.tarball);
  await assert.rejects(readdir(output), { code: "ENOENT" });
  assert.deepEqual(await readdir(directory), ["NPM-ARTIFACT.json"]);
});

test("Windows build refuses a selected receipt identity without replacing owned output", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await temporary(t);
  const receipt = await npmReceipt(directory);
  await writeFile(receipt.filename, JSON.stringify({ ...receipt.metadata, name: "@fixture/other-package" }));
  const source = path.join(directory, "prior");
  const output = path.join(directory, "windows-setup");
  await mkdir(source);
  await writeFile(path.join(source, "Setup.exe"), "prior complete distribution");
  await publishOwnedOutput(source, output);
  const before = await inventoryTree(output);
  await assert.rejects(buildWindows(output, { npmArtifact: receipt.filename }), /name\/version does not match/);
  await assert.rejects(main(["build", "--output", output, "--npm-artifact", receipt.filename]), /name\/version does not match/);
  assert.deepEqual(await inventoryTree(output), before);
  assert.equal(await readFile(path.join(output, "Setup.exe"), "utf8"), "prior complete distribution");
  await writeFile(path.join(output, "foreign.txt"), "user-owned data");
  await assert.rejects(buildWindows(output, { npmArtifact: receipt.filename }), /modified or unowned/);
  assert.equal(await readFile(path.join(output, "foreign.txt"), "utf8"), "user-owned data");
});

test("Windows command rejects invalid input before creating output or consulting artifact identity", async (t) => {
  const directory = await temporary(t);
  const output = path.join(directory, "not-created");
  const receipt = path.join(directory, "missing-receipt.json");
  const cases = [
    [["stage", "--output", output, "--npm-artifact"], /Missing value/],
    [["build", "--output", output, "--npm-artifact", "--output"], /Missing value/],
    [["stage", "--output", output, "--npm-artifact", ""], /Missing value/],
    [["build", "--npm-artifact", receipt, "--output"], /Missing value/],
    [["stage", "--output", output, "--output", output], /Duplicate/],
    [["build", "--output", output, "--npm-artifact", receipt, "--npm-artifact", receipt], /Duplicate/],
    [["stage", "--output", output, "--unknown", receipt], /Unknown/],
    [["build", "--output", output, receipt], /Unknown/],
    [["check", "--output", output, "--npm-artifact", receipt], /stage\/build/],
    [["__proto__", "--output", output], /Usage/],
    [[], /Usage/],
  ];
  for (const [args, error] of cases) {
    await assert.rejects(main(args), error);
    await assert.rejects(readdir(output), { code: "ENOENT" });
  }
  assert.deepEqual(await readdir(directory), []);
});
