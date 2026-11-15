// Trusted operator-side preflight. No npm/install/test execution; no host-admin threat claim.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const digest = b => createHash('sha256').update(b).digest('hex');
const fullSHA = /^[a-f0-9]{40}$/;
const hashSHA = /^[a-f0-9]{64}$/;
const top = new Set(['.gitignore', 'README.md', 'paircoach.config.json', 'paircoach.runtime.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'metadata.json', 'playwright.config.ts', '.c8rc.json', '.quality-policy.json', '.quality-runner.json']);
// Finite source contract. These are source inputs, never prepared images, caches or receipts.
const runtimeScripts = [
  'runtime-prepare-cli.mjs', 'runtime-prepare-control.mjs', 'runtime-prepare.mjs',
  'runtime-operator.mjs', 'runtime-stage-inputs.mjs', 'runtime-files.mjs',
  'runtime-task.mjs', 'runtime-pom.mjs', 'runtime-spec.mjs', 'runtime-cache.mjs',
  'runtime-tools.mjs', 'runtime-dependencies.mjs', 'runtime-artifacts.mjs',
  'runtime-generate-templates.mjs', 'runtime-image-retention.mjs',
  'runtime-test.mjs', 'runtime-test-policy.mjs',
].map(name => `scripts/${name}`);
// Private inert test-support source, NOT a public prepare/npm/HTTP entry point.
// Conditional: old source compositions without these regressions need no operator module.
const runtimeTestSupport = 'scripts/runtime-operator-remainder.mjs';
const runtimeTestImporters = [
  'tests/runtime-prepare-cli/remainder.test.mjs',
  'tests/runtime-prepare-cli/docker-client-metadata.test.mjs',
  'tests/runtime-remainder-image-equality/image-equality.test.mjs',
  'tests/runtime-image-retention/seams.test.mjs', // includes dynamic fixture.load reference
];
const runtimeAssets = [
  'runtimes/README.md', 'runtimes/catalog.json', 'runtimes/images.lock.json',
  'runtimes/pin-status.json', 'runtimes/production-inputs.lock.json',
  'docker/runtime.Dockerfile',
  'examples/README.md',
  ...['javascript-counter', 'typescript-counter', 'python-calculator', 'java-pattern', 'spring-counter']
    .map(name => `examples/${name}/task.v2.json`),
  'examples/javascript-counter/package.json', 'examples/javascript-counter/main.js', 'examples/javascript-counter/counter.test.js',
  'examples/typescript-counter/package.json', 'examples/typescript-counter/tsconfig.json',
  'examples/typescript-counter/main.ts', 'examples/typescript-counter/counter.test.ts',
  'examples/python-calculator/requirements.txt', 'examples/python-calculator/calculator.py', 'examples/python-calculator/test_calculator.py',
  'examples/java-pattern/pom.xml', 'examples/java-pattern/src/main/java/demo/StrategyDemo.java',
  'examples/java-pattern/src/test/java/demo/StrategyDemoTest.java',
  'examples/spring-counter/pom.xml', 'examples/spring-counter/src/main/java/demo/CounterApplication.java',
  'examples/spring-counter/src/test/java/demo/CounterApplicationTest.java',
];
// Only the shipped authored pack; never arbitrary uploaded/private material.
const learningRequired = [
  'scripts/verify-learning-pack.mjs', 'characters/banc-mentor/AGENTS.md', 'characters/banc-mentor/skills/lesson-feedback/SKILL.md',
  ...['curriculum.json', 'knowledge-index.json', 'material.md'].map(n => `learning-packs/rest-spring/${n}`),
  ...['get-item', 'create-item', 'update-item', 'map-dto', 'validate-input', 'missing-item', 'name-conflict', 'cors-preflight', 'filter-items', 'page-items', 'idempotent-create', 'conditional-delete'].flatMap(id => [
    ...['challenge.md', 'pom.xml', 'settings.v2.json', 'src/main/java/demo/ApiApplication.java', 'src/test/java/demo/ApiContractTest.java']
      .map(n => `learning-packs/rest-spring/tasks/${id}/${n}`),
    `learning-packs/rest-spring/references/${id}/ApiApplication.java`,
  ]),
];
const learningSource = name => /^learning-packs\/rest-spring\/(?:curriculum\.json|knowledge-index\.json|material\.md|tasks\/[a-z0-9-]+\/(?:challenge\.md|pom\.xml|settings\.v2\.json|src\/main\/java\/demo\/ApiApplication\.java|src\/test\/java\/demo\/ApiContractTest\.java)|references\/[a-z0-9-]+\/ApiApplication\.java)$/.test(name);
const runtimeRequired = ['paircoach.runtime.json', 'docs/windows-polyglot.md', ...runtimeScripts, ...runtimeAssets];
export const requiredFiles = [...new Set([...top, ...runtimeRequired, ...learningRequired, 'scripts/coverage.mjs', 'scripts/coverage-policy.mjs', 'java-puzzlers/README.md', 'java-puzzlers/SOURCE.json', 'java-puzzlers/prepare-tasks.mjs', 'characters/default/AGENTS.md', 'characters/default/skills/lesson-feedback/SKILL.md', 'characters/halloween-theme/AGENTS.md', 'characters/halloween-theme/skills/lesson-feedback/SKILL.md', 'src/server/index.ts', 'src/server/runtimeIdentity.ts', 'docs/WINDOWS.md', 'docs/windows-start.md', 'docs/windows-package.md', 'docs/windows-coach-report-solarized.md', 'scripts/windows-verify.ps1', 'scripts/verify-source-revision.mjs', 'scripts/package-windows.mjs', 'scripts/clean.mjs', 'tests/snapshots/snapshot-crash.test.ts', 'tests/snapshots/snapshot-child.ts', 'tests/snapshots/helpers.ts', 'tests/journal-lease-native/lease.test.ts', 'tests/journal-lease-native/lease-child.ts'])];
const runtimeScriptSet = new Set(runtimeScripts);
// Finite source formats within the three product source roots, not arbitrary binary/runtime data.
const runtimeSource = name => /^runtimes\/(?:[A-Za-z0-9._/-]+\.(?:json|md|lock))$/.test(name) ||
  /^docker\/(?:[A-Za-z0-9._/-]+\.Dockerfile|Dockerfile(?:\.[A-Za-z0-9._-]+)?|[A-Za-z0-9._/-]+\.(?:mjs|js|py|sh|json|txt|lock|md))$/.test(name) ||
  /^examples\/[A-Za-z0-9._/-]+\.(?:js|cjs|mjs|ts|json|py|java|xml|txt|md|lock|properties|prefs)$/.test(name);
// Allow tracked test sources/support, never raw QA output or local runtime data.
export function allowedSource(name) {
  const parts = name.toLowerCase().split('/');
  if (/^(?:runtimes|docker|examples)\//.test(name) && parts.some(p => ['cache', 'caches', 'downloads', 'receipts', 'output', 'outputs', 'workspaces'].includes(p))) return false;
  if (parts.some(p => ['.git', '.paircoach', '.paircoding', 'node_modules', '.runtime', 'runtime', 'target', '__pycache__', '.pytest_cache', '.mypy_cache', '.venv', 'venv', '.m2', '.aws', '.ssh', 'tmp', '.tmp', 'artifacts', 'test-results', 'playwright-report', 'dist', 'coverage', 'credentials', 'secrets', 'logs', 'traces', 'screenshots', 'reports'].includes(p) ||
      p.startsWith('.env') || p.endsWith('.paircoding.json') || /\.(pem|key|pfx|p12|log)$/i.test(p))) return false;
  return top.has(name) || ['ARCHITECTURE.md', 'AGENTS.md'].includes(name) || runtimeScriptSet.has(name) || ['scripts/coverage.mjs', 'scripts/coverage-policy.mjs'].includes(name) || name === runtimeTestSupport || runtimeSource(name) || learningSource(name) || name === 'scripts/verify-learning-pack.mjs' || /^java-puzzlers\/[A-Za-z0-9._/-]+\.(?:java|xml|json|md|mjs)$/.test(name) || /^characters\/[A-Za-z0-9._/-]+\.(?:md|txt|json|ya?ml|py|mjs|js|sh)$/.test(name) || name.startsWith('src/') || name === 'docs/WINDOWS.md' || /^docs\/windows[^/]*\.md$/.test(name) || /^scripts\/package[^/]*\.mjs$/.test(name) || ['scripts/clean.mjs', 'scripts/windows-verify.ps1', 'scripts/verify-source-revision.mjs'].includes(name) ||
    (name.startsWith('tests/') && (/\.(ts|tsx|js|jsx|mjs|cjs|json|xml|txt|md|py|java|ps1)$/.test(name) || name === 'tests/qa/.gitignore'));
}
function fail(code, identity = {}) { const error = new Error(code); error.identity = identity; throw error; }
function safeName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(name) || name.length > 240 || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) fail('UNSAFE_PATH');
}
function noLinks(target) {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || fs.realpathSync(current) !== current) fail('SYMLINK_OR_REPARSE_PATH');
  }
  return absolute;
}
function readFile(root, name) {
  const target = noLinks(path.join(root, name));
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.nlink !== 1) fail('NON_REGULAR_SOURCE');
  return fs.readFileSync(target);
}
function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const r = spawnSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], { cwd: root, shell: false, maxBuffer: 128 * 1024 * 1024, env: { ...env, GIT_OPTIONAL_LOCKS: '0' } });
  if (r.error || r.status !== 0) fail('GIT_UNAVAILABLE_OR_INVALID_SOURCE');
  return r.stdout;
}
const text = b => b.toString('utf8').trim();
function eolOnly(bytes) {
  // Only valid UTF-8 without NUL is text. Preserve lone CR and all other bytes.
  if (bytes.includes(0)) return bytes;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return bytes; }
  return bytes.filter((b, i) => b !== 13 || bytes[i + 1] !== 10);
}
function validateSet(files) {
  if (!Array.isArray(files) || files.length > 20000) fail('INVALID_MANIFEST_FILES');
  const seen = new Set();
  for (const file of files) {
    safeName(file.path);
    const key = file.path.toLowerCase();
    if (!allowedSource(file.path) || seen.has(key)) fail('DUPLICATE_OR_DISALLOWED_PATH');
    seen.add(key);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !hashSHA.test(file.sha256 ?? '')) fail('INVALID_FILE_IDENTITY');
  }
  for (const name of requiredFiles) if (!files.some(f => f.path === name)) fail('MISSING_REQUIRED_FILE');
  if (runtimeTestImporters.some(name => files.some(f => f.path === name)) &&
      !files.some(f => f.path === runtimeTestSupport)) fail('MISSING_TEST_SUPPORT');
  if (!files.some(f => /^tests\/execution\/.+\.test\.ts$/.test(f.path))) fail('MISSING_EXECUTION_TESTS');
}
function inventory(root) {
  const found = [];
  function walk(dir = '') {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const name = dir ? dir + '/' + entry.name : entry.name;
      if (allowedSource(name)) {
        if (entry.isDirectory()) { walk(name); continue; }
        safeName(name); readFile(root, name); found.push(name);
      } else if (entry.isDirectory() && (['src', 'tests', 'docs', 'scripts', 'runtimes', 'docker', 'examples', 'characters', 'java-puzzlers'].includes(name) || ['tests/', 'runtimes/', 'docker/', 'examples/', 'characters/', 'java-puzzlers/'].some(prefix => name.startsWith(prefix)) || learningRequired.some(file => file.startsWith(name + '/')))) {
        // Do not descend denylisted test directories (or symlinks).
        if (learningRequired.some(file => file.startsWith(name + '/')) || ['docs', 'scripts'].includes(name) || ['probe.ts', 'probe.json', 'probe.Dockerfile'].some(file => allowedSource(name + '/' + file))) walk(name);
      }
    }
  }
  walk();
  return found.sort();
}
export function verifyCopiedInputs(destination, files) {
  const root = noLinks(destination);
  const actual = inventory(root);
  const expected = files.map(f => f.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('SOURCE_SET_MISMATCH');
  for (const file of files) {
    const bytes = readFile(root, file.path);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail('COPIED_BYTES_MISMATCH');
  }
}
export function verifyAndCopy({ source, revision, destination, trustedManifest, manifestSha256 }) {
  const identity = { actualRevision: null, trustMode: trustedManifest ? 'EXTERNAL_MANIFEST_SHA256' : 'GIT_HEAD', manifestDigest: null };
  try {
    if (!fullSHA.test(revision ?? '')) fail('INVALID_REVISION');
    const root = noLinks(source);
    if (!fs.statSync(root).isDirectory()) fail('INVALID_SOURCE_ROOT');
    let files, trustMode, manifestDigest = null;
    if (trustedManifest || manifestSha256) {
      if (!trustedManifest || !hashSHA.test(manifestSha256 ?? '')) fail('EXTERNAL_MANIFEST_AND_DIGEST_REQUIRED');
      const manifestPath = noLinks(trustedManifest);
      if (manifestPath === root || manifestPath.startsWith(root + path.sep)) fail('MANIFEST_MUST_BE_EXTERNAL');
      const raw = fs.readFileSync(manifestPath);
      if (raw.length > 16 * 1024 * 1024 || digest(raw) !== manifestSha256) fail('UNTRUSTED_MANIFEST_DIGEST');
      let manifest;
      try { manifest = JSON.parse(raw.toString('utf8')); } catch { fail('INVALID_MANIFEST'); }
      identity.actualRevision = fullSHA.test(manifest.sourceCommit ?? '') ? manifest.sourceCommit : null;
      identity.manifestDigest = digest(raw);
      if (manifest.sourceCommit !== revision) fail('MANIFEST_REVISION_MISMATCH', { actualRevision: fullSHA.test(manifest.sourceCommit ?? '') ? manifest.sourceCommit : null, trustMode: 'EXTERNAL_MANIFEST_SHA256', manifestDigest: digest(raw) });
      files = manifest.files;
      validateSet(files);
      trustMode = 'EXTERNAL_MANIFEST_SHA256'; manifestDigest = digest(raw);
    } else {
      // Require the intended root, never a surrounding unrelated Git repository.
      const topLevel = fs.realpathSync(text(git(root, ['rev-parse', '--show-toplevel'])));
      if (topLevel !== root) fail('SOURCE_IS_NOT_GIT_ROOT');
      const actualRevision = text(git(root, ['rev-parse', '--verify', 'HEAD^{commit}']));
      identity.actualRevision = actualRevision;
      if (actualRevision !== revision) fail('GIT_REVISION_MISMATCH', { actualRevision, trustMode: 'GIT_HEAD', manifestDigest: null });
      if (git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length) fail('DIRTY_SOURCE');
      const entries = git(root, ['ls-tree', '-r', '-z', revision]).toString('utf8').split('\0').filter(Boolean);
      files = [];
      for (const row of entries) {
        const m = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
        if (!m) fail('INVALID_GIT_TREE');
        const [, mode, type, oid, name] = m;
        if (!allowedSource(name)) continue;
        safeName(name);
        if (!['100644', '100755'].includes(mode) || type !== 'blob') fail('NON_REGULAR_GIT_ENTRY');
        const blob = git(root, ['cat-file', 'blob', oid]);
        const bytes = readFile(root, name);
        if (!eolOnly(bytes).equals(eolOnly(blob))) fail('GIT_SOURCE_BYTES_MISMATCH');
        files.push({ path: name, bytes: bytes.length, sha256: digest(bytes), gitBlobSha256: digest(blob) });
      }
      validateSet(files);
      trustMode = 'GIT_HEAD';
    }
    // Check the full source set and every byte BEFORE creating the destination.
    verifyCopiedInputs(root, files);
    const dest = path.resolve(destination);
    const parent = noLinks(path.dirname(dest));
    if (dest === root || dest.startsWith(root + path.sep) || root.startsWith(dest + path.sep) || parent !== path.dirname(dest)) fail('UNSAFE_DESTINATION');
    fs.mkdirSync(dest); // exclusive; leave any partial result for reconciliation
    for (const file of files) {
      // Re-read validated source: a change between validation and copy is an error.
      const bytes = readFile(root, file.path);
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail('SOURCE_CHANGED_DURING_COPY');
      const target = path.join(dest, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      noLinks(path.dirname(target));
      fs.writeFileSync(target, bytes, { flag: 'wx' });
    }
    // Check ordinary source changes/HEAD movement across the copy too.
    verifyCopiedInputs(root, files);
    if (trustMode === 'GIT_HEAD' && (text(git(root, ['rev-parse', 'HEAD'])) !== revision || git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length)) fail('SOURCE_CHANGED_DURING_COPY');
    verifyCopiedInputs(dest, files); // Last byte check before handing off to the operator/PowerShell.
    return { status: 'VERIFIED_INPUTS_NOT_WINDOWS_PASS', requestedRevision: revision, actualRevision: revision, trustMode, manifestDigest,
      byteVerification: 'PASS', eolPolicy: trustMode === 'GIT_HEAD' ? 'UTF8_NO_NUL_LF_CRLF_ONLY_COPY_EXACT' : 'EXACT_MANIFEST_BYTES', files };
  } catch (error) {
    error.identity = { ...identity, ...error.identity };
    throw error;
  }
}
function main() {
  const args = process.argv.slice(2), options = {};
  const names = { '--source': 'source', '--revision': 'revision', '--destination': 'destination', '--trusted-manifest': 'trustedManifest', '--manifest-sha256': 'manifestSha256', '--evidence': 'evidence' };
  for (let i = 0; i < args.length; i++) {
    const key = names[args[i]];
    if (!key || options[key] || !args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_ARGUMENTS');
    options[key] = args[++i];
  }
  if (!options.source || !options.revision || !options.destination || !options.evidence) fail('SOURCE_REVISION_DESTINATION_EVIDENCE_REQUIRED');
  // Evidence must be outside inputs and disposable copy; never overwrite a source file.
  const evidence = path.resolve(options.evidence), source = path.resolve(options.source), dest = path.resolve(options.destination);
  noLinks(path.dirname(evidence));
  if ([source, dest].some(root => evidence === root || evidence.startsWith(root + path.sep))) fail('UNSAFE_EVIDENCE_PATH');
  let report;
  try { report = verifyAndCopy(options); }
  catch (error) {
    report = { status: 'FAIL', requestedRevision: options.revision, actualRevision: null, byteVerification: 'FAIL', trustMode: options.trustedManifest ? 'EXTERNAL_MANIFEST_SHA256' : 'GIT_HEAD', manifestDigest: null, ...error.identity, diagnostic: safeDiagnostic(error) };
    fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    fail(report.diagnostic);
  }
  fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write('Verified revision and copied bytes; npm/test NOT_RUN.\n');
}
function safeDiagnostic(error) {
  // No paths, raw Git stderr, environment or file content in public diagnostics.
  return /^[A-Z][A-Z0-9_]{1,80}$/.test(error?.message ?? '') ? error.message : 'SOURCE_VERIFICATION_IO_OR_FORMAT_ERROR';
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(safeDiagnostic(error) + '\n'); process.exitCode = 1; }
}
