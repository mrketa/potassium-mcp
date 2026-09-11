import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import test from "node:test";
import { distTagForVersion, main, tarballPackageMetadata, validatePublishArgs } from "../release-publish.js";

test("npm publication keeps prereleases off the latest tag", () => {
  assert.equal(distTagForVersion("1.2.3"), "latest");
  assert.equal(distTagForVersion("1.2.3-beta.1"), "beta");
  assert.equal(distTagForVersion("1.2.3-rc.2+build"), "rc");
});

test("prerelease labels cannot select latest or an npm version range", () => {
  for (const version of ["1.2.3-latest", "1.2.3-latest.1", "1.2.3-LATEST", "1.2.3-latest-rc", "1.2.3-123", "1.2.3-v1"]) {
    assert.equal(distTagForVersion(version), "next");
  }
  assert.equal(distTagForVersion("1.2.3+build.1"), "latest");
  for (const version of ["", "v1.2.3", "1.2", "01.2.3", "1.2.3-01", "1.2.3-rc..1", "1.2.3-", "1.2.3+", "1.2.3 --tag latest", "1.2.3\n", "9007199254740992.0.0", null]) {
    assert.throws(() => distTagForVersion(version), /semver/);
  }
});

test("npm publication accepts only non-routing options", () => {
  assert.deepEqual(validatePublishArgs(["--dry-run", "--provenance", "--otp", "123456"]), [
    "--dry-run",
    "--provenance",
    "--otp",
    "123456",
  ]);
  assert.deepEqual(validatePublishArgs(["--otp=654321"]), ["--otp=654321"]);
  assert.throws(() => validatePublishArgs(["--registry=https://example.invalid"]), /Unsupported/);
  assert.throws(() => validatePublishArgs(["--tag", "latest"]), /Unsupported/);
  assert.throws(() => validatePublishArgs(["--otp", "not-valid"]), /Unsupported/);
  const secretOption = `--token=${"s".repeat(40)}`;
  assert.throws(() => validatePublishArgs([secretOption]), (error) => !error.message.includes(secretOption));
});

function tarball(manifest, { name = "package/package.json", type = 48, linkname = "" } = {}) {
  const content = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header.fill(32, 148, 156);
  header[156] = type;
  header.write(linkname, 157);
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512 + 1024)]));
}

test("tarball identity rejects duplicate manifests, corruption, and truncated archives", () => {
  const manifest = { name: "@mrketa/potassium-mcp", version: "1.2.3" };
  const bytes = tarball(manifest);
  assert.deepEqual(tarballPackageMetadata(bytes), manifest);
  const tar = gunzipSync(bytes);
  const duplicate = gzipSync(Buffer.concat([tar.subarray(0, tar.length - 1024), tar]));
  assert.throws(() => tarballPackageMetadata(duplicate), /Ambiguous/);
  const corrupted = Buffer.from(tar);
  corrupted[10] ^= 1;
  assert.throws(() => tarballPackageMetadata(gzipSync(corrupted)), /header checksum/);
  assert.throws(() => tarballPackageMetadata(gzipSync(tar.subarray(0, tar.length - 512))), /terminator/);
});

async function publication(t, { version = "1.2.3-beta.1", packed = {}, metadata = {}, extraEntry } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potassium-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = { name: "@mrketa/potassium-mcp", version };
  let bytes = tarball({ ...expected, ...packed });
  if (extraEntry) {
    const original = gunzipSync(bytes);
    const replacement = gunzipSync(tarball({ ...expected, version: "1.2.3-rc.1" }, extraEntry));
    bytes = gzipSync(Buffer.concat([original.subarray(0, original.length - 1024), replacement]));
  }
  const artifact = {
    filename: "potassium-mcp.tgz", ...expected,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    sha256: createHash("sha256").update(bytes).digest("hex"), ...metadata,
  };
  const metadataPath = path.join(root, "NPM-ARTIFACT.json");
  const packagePath = path.join(root, "package.json");
  const tarballPath = path.join(root, "potassium-mcp.tgz");
  await writeFile(packagePath, JSON.stringify(expected));
  await writeFile(tarballPath, bytes);
  await writeFile(`${tarballPath}.sha256`, `${artifact.sha256}  ${artifact.filename}\n`);
  await writeFile(metadataPath, JSON.stringify(artifact));
  const calls = [];
  return {
    artifact, tarballPath, metadataPath, calls,
    publish: (respond, args = []) => main(args, { NPM_TOKEN: "test-fixture-token" }, {
      metadataPath, packagePath,
      command: async (argv) => {
        calls.push(argv);
        return respond(argv);
      },
    }),
  };
}

test("extraction aliases and nonregular entries cannot replace the validated manifest", async (t) => {
  for (const extraEntry of [
    { name: "package/./package.json" },
    { name: "package/src/../package.json" },
    { name: "package//package.json" },
    { name: "package\\package.json" },
    { name: "./package/package.json" },
    { name: "/package/package.json" },
    { name: "other/package.json" },
    { name: "package/Package.json" },
    { name: "package/package.json." },
    { name: "package/package.json " },
    { name: "package/package.json:stream" },
    { name: "package/package.json" },
    { name: "package/link", type: 49, linkname: "package/package.json" },
    { name: "package/link", type: 50, linkname: "package.json" },
    { name: "package/extended", type: 120 },
  ]) {
    const release = await publication(t, { version: "1.2.3", extraEntry });
    await assert.rejects(release.publish(() => assert.fail("npm must not run")), /Noncanonical|Ambiguous|regular files/);
    assert.deepEqual(release.calls, []);
  }
});

const missingVersion = () => {
  throw Object.assign(new Error("version absent"), { stdout: JSON.stringify({ error: { code: "E404" } }) });
};

test("a missing registry version publishes only the verified prebuilt tarball", async (t) => {
  const release = await publication(t, { version: "1.2.3-latest.1" });
  const result = await release.publish((args) => args[0] === "view" ? missingVersion() : "", ["--dry-run", "--provenance"]);
  assert.equal(result.status, "dry-run");
  assert.deepEqual(release.calls, [
    ["view", "@mrketa/potassium-mcp@1.2.3-latest.1", "--json", "--registry=https://registry.npmjs.org/"],
    ["publish", release.tarballPath, "--dry-run", "--provenance", "--ignore-scripts", "--access", "public", "--registry=https://registry.npmjs.org/", "--tag", "next"],
  ]);
});

test("partial publication retry skips npm without retagging an identical version", async (t) => {
  const release = await publication(t);
  let published = false;
  const registry = (args) => {
    if (args[0] === "publish") { published = true; return ""; }
    if (!published) return missingVersion();
    return JSON.stringify({ name: release.artifact.name, version: release.artifact.version, dist: { integrity: release.artifact.integrity } });
  };
  assert.equal((await release.publish(registry)).status, "published");
  // Model npm success followed by a failed GitHub upload: the same release runs again.
  release.calls.length = 0;
  assert.equal((await release.publish(registry)).status, "resumed");
  assert.deepEqual(release.calls.map((args) => args[0]), ["view"]);
});

test("existing registry version must match both identity and integrity", async (t) => {
  for (const mismatch of [
    { name: "@other/package" }, { version: "1.2.3" }, { dist: { integrity: "sha512-different" } }, { dist: {} },
  ]) {
    const release = await publication(t);
    await assert.rejects(release.publish(() => JSON.stringify({
      name: release.artifact.name, version: release.artifact.version, dist: { integrity: release.artifact.integrity }, ...mismatch,
    })), /identity\/integrity mismatch/);
    assert.deepEqual(release.calls.map((args) => args[0]), ["view"]);
  }
});

test("only structured E404 permits publishing; registry failures fail closed", async (t) => {
  for (const response of [
    () => { throw Object.assign(new Error("authentication failed"), { stdout: '{"error":{"code":"E401"}}' }); },
    () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); },
    () => { throw Object.assign(new Error("E404 text is not sufficient"), { stderr: "npm error E404" }); },
    () => "", () => undefined, () => "[]", () => "null", () => "{bad json",
  ]) {
    const release = await publication(t);
    await assert.rejects(release.publish(response));
    assert.deepEqual(release.calls.map((args) => args[0]), ["view"]);
  }
});

test("invalid sidecars and packed identities fail before contacting npm", async (t) => {
  for (const options of [
    { metadata: { filename: "../other.tgz" } },
    { metadata: { name: "@other/package" } },
    { metadata: { version: "1.2.3" } },
    { metadata: { integrity: `sha512-${"A".repeat(86)}==` } },
    { metadata: { sha256: "0".repeat(64) } },
    { packed: { version: "9.9.9" } },
    { packed: { name: "@other/package" } },
    { packed: { publishConfig: { tag: "latest" } } },
    { packed: { publishConfig: { registry: "https://example.invalid/" } } },
  ]) {
    const release = await publication(t, options);
    await assert.rejects(release.publish(() => assert.fail("npm must not run")));
    assert.deepEqual(release.calls, []);
  }
});

test("corrupted tarball or checksum sidecar cannot reach npm", async (t) => {
  for (const target of ["tarball", "checksum"]) {
    const release = await publication(t);
    await writeFile(target === "tarball" ? release.tarballPath : `${release.tarballPath}.sha256`, "corrupted");
    await assert.rejects(release.publish(() => assert.fail("npm must not run")), /checksum/);
    assert.deepEqual(release.calls, []);
  }
});

test("artifact replacement during the registry query cannot be published", async (t) => {
  const release = await publication(t);
  const replacement = tarball({ name: release.artifact.name, version: release.artifact.version, description: "changed" });
  await assert.rejects(release.publish(async () => {
    const metadata = JSON.parse(await readFile(release.metadataPath, "utf8"));
    metadata.integrity = `sha512-${createHash("sha512").update(replacement).digest("base64")}`;
    metadata.sha256 = createHash("sha256").update(replacement).digest("hex");
    await writeFile(release.tarballPath, replacement);
    await writeFile(`${release.tarballPath}.sha256`, `${metadata.sha256}  ${metadata.filename}\n`);
    await writeFile(release.metadataPath, JSON.stringify(metadata));
    return missingVersion();
  }), /changed during registry/);
  assert.deepEqual(release.calls.map((args) => args[0]), ["view"]);
});
