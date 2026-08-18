import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const file = (path) => join(root, path);
const manifest = JSON.parse(readFileSync(file('package.json'), 'utf8'));
const release = readFileSync(file('tools/release.mjs'), 'utf8');
const workflow = readFileSync(file('.github/workflows/release.yml'), 'utf8');
const allowed = new Set([
  'AI-GUIDE.md', 'ADVANCED.md', 'LICENSE', 'README.md', 'SECURITY.md',
  'config.example.json', 'package.json'
]);
const allowedPrefixes = ['assets/', 'bin/', 'src/'];
const npmCli = [
  process.env.npm_execpath,
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].filter(Boolean).find(existsSync);

test('npm artifact has an exact allowlisted inventory and executable entrypoint', () => {
  const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], { cwd: file('.'), encoding: 'utf8' }));
  assert.equal(packed.length, 1);
  const files = packed[0].files.map(({ path }) => path).sort();
  assert.deepEqual(files, [
    'ADVANCED.md', 'AI-GUIDE.md', 'LICENSE', 'README.md', 'SECURITY.md',
    'assets/potassium_mcp_autoexec.lua', 'assets/potassium_mcp_bootstrap.lua',
    'bin/potassium-mcp.js', 'config.example.json', 'package.json',
    'src/admin-audit.js', 'src/bridge.js', 'src/broker.js', 'src/deploy.js', 'src/doctor.js', 'src/hosts.js',
    'src/install.js', 'src/proxy.js', 'src/safe-read.js', 'src/server.js', 'src/verify.js'
  ]);
  assert.equal(manifest.bin['potassium-mcp'], 'bin/potassium-mcp.js');
  assert(files.includes(manifest.bin['potassium-mcp']));
  assert(files.every((path) => allowed.has(path) || allowedPrefixes.some((prefix) => path.startsWith(prefix))));
});

test('release path roots are filesystem paths on every supported platform', () => {
  assert.doesNotMatch(release, /new URL\(import\.meta\.url\)\.pathname/);
  assert.match(release, /fileURLToPath\(import\.meta\.url\)/);
  assert.equal(file('package.json'), join(root, 'package.json'));
});

test('package metadata describes the bounded default and trusted opt-in without naming a provider', () => {
  assert.match(manifest.description, /default bounded inspection/i);
  assert.match(manifest.description, /opt-in trusted administration/i);
  assert.doesNotMatch(manifest.description, /\b(?:Anthropic|OpenAI|Google|Gemini|Claude|Codex)\b/i);
});

test('package and runtime staging reject private terms, secrets, tests, and tooling', () => {
  assert.match(release, /forbiddenPathParts/);
  assert.match(release, /autofarm/i);
  assert.match(release, /PRIVATE KEY/);
  assert.match(release, /assertCleanText/);
  assert.match(release, /unpackEntrypoint/);
  assert.match(release, /NODE-LICENSE/);
  assert.match(release, /THIRD-PARTY-NOTICES/);
  assert.match(release, /runtime-bundle\.manifest\.json/);
});

test('every independently distributed artifact carries required license material', () => {
  assert.match(release, /copyFileSync\(join\(root, 'LICENSE'\), join\(stage, 'LICENSE'\)\)/);
  assert.match(release, /copyFileSync\(join\(root, 'LICENSE'\), join\(portable, 'LICENSE'\)\)/);
  assert.match(release, /copyFileSync\(nodeLicense, join\(destination, 'NODE-LICENSE'\)\)/);
  assert.match(release, /copyFileSync\(join\(out, 'runtime-bundle', 'NODE-LICENSE'\), join\(portable, 'NODE-LICENSE'\)\)/);
  assert.match(release, /dependencyNotices/);
  assert.match(release, /CycloneDX/);
});

test('version, tag, duplicate version, artifact naming, and provenance gates are present', () => {
  assert.match(release, /tag \$\{tag\} does not match v\$\{version\}/);
  assert.match(release, /GITHUB_REF_TYPE === 'tag'/);
  assert.match(release, /prereleases must not publish with the latest dist-tag/);
  assert.match(release, /npm already contains/);
  assert.match(release, /potassium-mcp-\$\{version\}-windows-x64/);
  assert.match(release, /potassium-mcp-\$\{version\}-Setup\.exe/);
  assert.match(release, /potassium-mcp-\$\{version\}\.cdx\.json/);
  assert.match(workflow, /tags: \['v\*'\]/);
  assert.match(workflow, /npm publish .*--provenance/);
  assert.match(workflow, /NPM_PUBLISH_ENABLED == 'true'/);
  assert.match(workflow, /if: github\.event_name == 'push'/);
  assert.match(workflow, /actions\/attest-build-provenance/);
  assert.equal(existsSync(file('.npmignore')), true);
});
