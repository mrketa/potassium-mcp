#!/usr/bin/env node
/**
 * Deterministic release assembly and policy gates. This file intentionally has
 * no third-party dependencies so the release process can audit itself.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.env.RELEASE_OUT ?? join(root, 'release-out'));
const appAssets = resolve(root, 'app', 'PotassiumMcp.Setup', 'assets');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const packageName = packageJson.name;
const npmPaths = new Set([
  'AI-GUIDE.md', 'ADVANCED.md', 'LICENSE', 'README.md', 'SECURITY.md',
  'config.example.json', 'package.json'
]);
const npmPrefixes = ['assets/', 'bin/', 'src/'];
const forbiddenPathParts = ['test/', 'tests/', 'tools/', '.github/', 'node_modules/', 'workspace/', 'private/'];
const forbiddenText = [
  /autofarm/i, /oh\s*my\s*pi/i, /anthropic[_ -]?api[_ -]?key/i,
  /openai[_ -]?api[_ -]?key/i, /google[_ -]?api[_ -]?key/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:npm|github|ghp|github_pat)_[A-Za-z0-9_\-]{20,}/,
  /AKIA[0-9A-Z]{16}/
];

function fail(message) { throw new Error(message); }
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function json(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}
function runNpm(args, options = {}) {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (!npmCli) fail('could not locate the npm CLI used by this Node installation');
  return run(process.execPath, [npmCli, ...args], options);
}
function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
function safeRelative(path, base = root) { return relative(base, path).split(sep).join('/'); }
function assertCleanText(path) {
  const contents = readFileSync(path);
  if (contents.includes(0)) return;
  const text = contents.toString('utf8');
  for (const expression of forbiddenText) if (expression.test(text)) fail(`private term or secret pattern in ${safeRelative(path)}`);
}
function assertVersion() {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`invalid package version: ${version}`);
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
  if (tag && tag !== `v${version}`) fail(`tag ${tag} does not match v${version}`);
  const distTag = process.env.NPM_DIST_TAG ?? (version.includes('-') ? 'next' : 'latest');
  if (version.includes('-') && distTag === 'latest') fail('prereleases must not publish with the latest dist-tag');
  if (!version.includes('-') && distTag !== 'latest') fail('stable releases must publish with the latest dist-tag');
  return distTag;
}
function assertNpmPath(path) {
  if (forbiddenPathParts.some((part) => path.includes(part))) fail(`forbidden npm artifact path: ${path}`);
  if (!(npmPaths.has(path) || npmPrefixes.some((prefix) => path.startsWith(prefix)))) fail(`npm artifact path is not allowlisted: ${path}`);
}
function parsePackJson() {
  const result = JSON.parse(runNpm(['pack', '--dry-run', '--json']));
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0].files)) fail('npm pack did not return one package inventory');
  return result[0];
}
function validateNpmPackage() {
  assertVersion();
  if (packageJson.license !== 'Apache-2.0') fail('package must declare Apache-2.0');
  if (!packageJson.bin?.['potassium-mcp'] || !npmPaths.has('package.json')) fail('missing potassium-mcp executable entrypoint');
  const pack = parsePackJson();
  const inventory = pack.files.map(({ path }) => path).sort();
  for (const item of inventory) assertNpmPath(item);
  for (const required of [...npmPaths, packageJson.bin['potassium-mcp']]) {
    if (!inventory.includes(required)) fail(`npm package is missing required public file: ${required}`);
  }
  for (const item of inventory) assertCleanText(join(root, item));
  json(join(out, 'npm-inventory.json'), { packageName, version, files: inventory });
  return pack;
}
function packNpm() {
  const pack = validateNpmPackage();
  mkdirSync(out, { recursive: true });
  const result = JSON.parse(runNpm(['pack', '--json', '--pack-destination', out]));
  const file = join(out, result[0].filename);
  if (!existsSync(file)) fail('npm pack did not create the expected tarball');
  return { file, pack };
}
function unpackEntrypoint(tgz, destination) {
  const temporary = join(out, '.npm-package');
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  run('tar', ['-xzf', tgz, '-C', temporary]);
  cpSync(join(temporary, 'package', 'bin'), join(destination, 'bin'), { recursive: true });
  rmSync(temporary, { recursive: true, force: true });
}
function nodePackageDirectories(lock) {
  return Object.entries(lock.packages ?? {}).filter(([path]) => path.startsWith('node_modules/'));
}
function dependencyNotices() {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const lines = ['THIRD-PARTY NOTICES', '', 'This release includes the following npm dependencies. License values are read from installed package metadata when available.', ''];
  const components = [];
  for (const [path, metadata] of nodePackageDirectories(lock).sort(([a], [b]) => a.localeCompare(b))) {
    const installed = join(root, path, 'package.json');
    const manifest = existsSync(installed) ? JSON.parse(readFileSync(installed, 'utf8')) : {};
    const name = manifest.name ?? metadata.name ?? basename(path);
    const license = manifest.license ?? 'NOASSERTION';
    lines.push(`${name}@${manifest.version ?? metadata.version ?? 'unknown'} — ${license}`);
    components.push({ type: 'library', name, version: manifest.version ?? metadata.version ?? 'unknown', licenses: license === 'NOASSERTION' ? [] : [{ license: { id: license } }], externalReferences: metadata.resolved ? [{ type: 'distribution', url: metadata.resolved }] : [] });
  }
  writeFileSync(join(out, 'THIRD-PARTY-NOTICES.txt'), `${lines.join('\n')}\n`);
  return components;
}
function writeSbom() {
  mkdirSync(out, { recursive: true });
  const components = dependencyNotices();
  json(join(out, `potassium-mcp-${version}.cdx.json`), {
    bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${createHash('sha256').update(`${packageName}@${version}`).digest('hex').slice(0, 8)}-0000-4000-8000-000000000000`, version: 1,
    metadata: { component: { type: 'application', name: packageName, version, licenses: [{ license: { id: 'Apache-2.0' } }] } }, components
  });
}
function copyNodeRuntime(destination) {
  const runtime = resolve(process.env.NODE_RUNTIME_DIR ?? dirname(process.execPath));
  if (!existsSync(join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'))) fail(`NODE_RUNTIME_DIR must contain the Node executable: ${runtime}`);
  cpSync(runtime, destination, { recursive: true, filter: (source) => !source.includes(`${sep}node_modules${sep}`) });
  const nodeLicense = [join(runtime, 'LICENSE'), join(dirname(runtime), 'LICENSE'), join(root, 'third-party', 'NODE-LICENSE')].find(existsSync);
  if (!nodeLicense) fail('Node runtime LICENSE was not found');
  copyFileSync(nodeLicense, join(destination, 'NODE-LICENSE'));
}
function powershellZip(source, destination) {
  run('tar', ['-a', '-c', '-f', destination, '-C', source, '.']);
}
function stageRuntimeBundle(tgz) {
  const stage = join(out, 'runtime-bundle');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  copyNodeRuntime(stage);
  copyFileSync(tgz, join(stage, 'potassium-mcp.tgz'));
  unpackEntrypoint(tgz, stage);
  copyFileSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
  copyFileSync(join(root, 'README.md'), join(stage, 'README.md'));
  copyFileSync(join(out, 'THIRD-PARTY-NOTICES.txt'), join(stage, 'THIRD-PARTY-NOTICES.txt'));
  for (const file of walk(stage)) assertCleanText(file);
  const manifest = { files: walk(stage).map((file) => ({ path: safeRelative(file, stage).split('/').join('\\'), sha256: sha256(file) })).sort((a, b) => a.path.localeCompare(b.path)) };
  mkdirSync(appAssets, { recursive: true });
  json(join(appAssets, 'runtime-bundle.manifest.json'), manifest);
  rmSync(join(appAssets, 'runtime-bundle.zip'), { force: true });
  powershellZip(stage, join(appAssets, 'runtime-bundle.zip'));
  return manifest;
}
function setupExe() {
  const fromEnvironment = process.env.SETUP_EXE;
  const candidates = [fromEnvironment, join(root, 'app', 'PotassiumMcp.Setup', 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish', 'PotassiumMcp.Setup.exe')].filter(Boolean);
  return candidates.find(existsSync) ?? fail('SETUP_EXE must point to the published Windows Setup.exe');
}
function stagePortable(tgz) {
  const portable = join(out, `potassium-mcp-${version}-windows-x64`);
  rmSync(portable, { recursive: true, force: true });
  mkdirSync(portable, { recursive: true });
  const setup = setupExe();
  copyFileSync(setup, join(out, `potassium-mcp-${version}-Setup.exe`));
  copyFileSync(setup, join(portable, 'Setup.exe'));
  copyFileSync(tgz, join(portable, 'potassium-mcp.tgz'));
  copyFileSync(join(root, 'LICENSE'), join(portable, 'LICENSE'));
  copyFileSync(join(root, 'README.md'), join(portable, 'README.md'));
  copyFileSync(join(out, 'THIRD-PARTY-NOTICES.txt'), join(portable, 'THIRD-PARTY-NOTICES.txt'));
  copyFileSync(join(out, 'runtime-bundle', 'NODE-LICENSE'), join(portable, 'NODE-LICENSE'));
  copyFileSync(join(appAssets, 'runtime-bundle.manifest.json'), join(portable, 'runtime-bundle.manifest.json'));
  for (const file of walk(portable)) assertCleanText(file);
  const zip = join(out, `${basename(portable)}.zip`);
  rmSync(zip, { force: true });
  powershellZip(portable, zip);
  return { portable, zip };
}
function checksums() {
  const files = walk(out).filter((file) => !file.endsWith('SHA256SUMS') && !file.endsWith('release-evidence.json') && !file.includes(`${sep}runtime-bundle${sep}`)).sort();
  const lines = files.map((file) => `${sha256(file)}  ${safeRelative(file, out)}`);
  writeFileSync(join(out, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}
function evidence(distTag) {
  const artifacts = walk(out).filter((file) => statSync(file).isFile()).map((file) => ({ path: safeRelative(file, out), sha256: sha256(file) })).sort((a, b) => a.path.localeCompare(b.path));
  json(join(out, 'release-evidence.json'), { packageName, version, distTag, ref: process.env.GITHUB_REF ?? null, sha: process.env.GITHUB_SHA ?? null, artifacts });
}
function assertUniqueNpmVersion() {
  try {
    runNpm(['view', `${packageName}@${version}`, 'version', '--json']);
  } catch (error) {
    if (/E404|404 Not Found/.test(`${error.stderr ?? ''}\n${error.message}`)) return;
    throw new Error(`could not confirm npm version availability: ${error.stderr ?? error.message}`);
  }
  fail(`npm already contains ${packageName}@${version}`);
}
const command = process.argv[2] ?? 'validate';
try {
  if (command === 'validate') validateNpmPackage();
  else if (command === 'sbom') writeSbom();
  else if (command === 'runtime') { const packed = packNpm(); writeSbom(); stageRuntimeBundle(packed.file); }
  else if (command === 'assemble') {
    const packed = packNpm();
    writeSbom();
    stageRuntimeBundle(packed.file);
    const portable = stagePortable(packed.file);
    rmSync(portable.portable, { recursive: true, force: true });
    rmSync(join(out, 'runtime-bundle'), { recursive: true, force: true });
    checksums();
    evidence(assertVersion());
  }
  else if (command === 'unique-version') assertUniqueNpmVersion();
  else fail(`unknown release command: ${command}`);
} catch (error) { console.error(`release policy failure: ${error.message}`); process.exitCode = 1; }
