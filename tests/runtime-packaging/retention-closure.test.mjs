// Run against immutable accepted producer + owned packaging overlay composition.
// Source-byte/copy proof only: never invokes prepare, Docker, or ZIP creation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { allowedSource, requiredFiles, verifyAndCopy } from '../../scripts/verify-source-revision.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = 'scripts/runtime-image-retention.mjs';
const acceptedHash = '19e2c8b7a62d8b0cabf96131a9d0e88b0af0d42b9f8f00e4b21ce5ba649eaed7';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function write(root, name, bytes) {
  const dest = path.join(root, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes);
}
function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function fixture(t, omit = false) {
  const base = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'retention-closure-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'); fs.mkdirSync(root);
  // Keep helper independently explicit so a missing allowlist entry cannot silently
  // remove the very input this regression is meant to exercise.
  for (const name of new Set([...requiredFiles, helper])) {
    if (omit && name === helper) continue;
    write(root, name, fs.readFileSync(path.join(repo, name)));
  }
  write(root, 'tests/execution/retention-fixture.test.ts', '// source-only fixture; never executed\n');
  write(root, 'tests/execution/retention-fixture.test.mjs', '// source-only fixture; never executed\n');
  git(root, 'init', '--quiet'); git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '--force', '--all');
  git(root, '-c', 'user.name=retention-fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '--quiet', '-m', 'source-only fixture');
  return { base, root, revision: git(root, 'rev-parse', 'HEAD') };
}
function pack(f, mode) {
  return spawnSync(process.execPath, [path.join(f.root, 'scripts/package-windows.mjs'), '--commit', f.revision, mode],
    { cwd: f.root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}
test('retention: both finite policies select the accepted helper, not operator recovery', t => {
  const f = fixture(t), result = pack(f, '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(digest(fs.readFileSync(path.join(f.root, helper))), acceptedHash);
  assert.equal(allowedSource(helper), true); assert.ok(requiredFiles.includes(helper));
  assert.ok(plan.sourceVerification.requiredFiles.includes(helper));
  assert.ok(plan.commands.find(c => c.name === 'runtime:prepare').requiredFiles.includes(helper));
  assert.equal(plan.files.find(file => file.path === helper)?.sha256, acceptedHash);
  for (const excluded of ['scripts/runtime-operator-remainder.mjs', 'scripts/runtime-operator-image-recovery.mjs', 'scripts/runtime-unreviewed.mjs']) {
    // HUMAN625/628: real remainder is private test-support, never a public required input.
    assert.equal(allowedSource(excluded), excluded === 'scripts/runtime-operator-remainder.mjs');
    assert.equal(requiredFiles.includes(excluded), false);
    assert.equal(plan.commands.find(c => c.name === 'runtime:prepare').requiredFiles.includes(excluded), false);
    assert.equal(plan.files.some(file => file.path === excluded), false);
  }
});
test('retention: actual Git and trusted-manifest copying retain exact accepted helper bytes', t => {
  const f = fixture(t), gitCopy = path.join(f.base, 'git-copy');
  const result = verifyAndCopy({ source: f.root, revision: f.revision, destination: gitCopy });
  assert.equal(result.trustMode, 'GIT_HEAD');
  assert.equal(digest(fs.readFileSync(path.join(gitCopy, helper))), acceptedHash);
  const plan = pack(f, '--dry-run'); assert.equal(plan.status, 0, plan.stderr);
  const manifest = path.join(f.base, 'manifest.json'); fs.writeFileSync(manifest, plan.stdout);
  const trustedCopy = path.join(f.base, 'trusted-copy');
  // gitCopy has no .git; the exact dry-run manifest is external test trust only.
  const trusted = verifyAndCopy({ source: gitCopy, revision: f.revision, destination: trustedCopy,
    trustedManifest: manifest, manifestSha256: digest(Buffer.from(plan.stdout)) });
  assert.equal(trusted.trustMode, 'EXTERNAL_MANIFEST_SHA256');
  assert.equal(digest(fs.readFileSync(path.join(trustedCopy, helper))), acceptedHash);
  assert.deepEqual(fs.readFileSync(path.join(trustedCopy, helper)), fs.readFileSync(path.join(repo, helper)));
});
test('retention: omission refuses package planning and both copy modes before destination creation', t => {
  const f = fixture(t, true), result = pack(f, '--dry-run');
  assert.equal(result.status, 1); assert.match(result.stderr, /Brak wymaganego pliku: scripts\/runtime-image-retention\.mjs/);
  const destination = path.join(f.base, 'never-git');
  assert.throws(() => verifyAndCopy({ source: f.root, revision: f.revision, destination }), /MISSING_REQUIRED_FILE/);
  assert.equal(fs.existsSync(destination), false);
  // A self-consistent manifest deliberately omits the helper too; trust does not
  // waive the mandatory source contract.
  const files = git(f.root, 'ls-tree', '-r', '--name-only', f.revision).split('\n').filter(allowedSource).map(name => {
    const bytes = fs.readFileSync(path.join(f.root, name)); return { path: name, bytes: bytes.length, sha256: digest(bytes) };
  });
  const manifest = path.join(f.base, 'omitted.json'), raw = Buffer.from(JSON.stringify({ sourceCommit: f.revision, files }));
  fs.writeFileSync(manifest, raw); const trustedDestination = path.join(f.base, 'never-trusted');
  assert.throws(() => verifyAndCopy({ source: f.root, revision: f.revision, destination: trustedDestination,
    trustedManifest: manifest, manifestSha256: digest(raw) }), /MISSING_REQUIRED_FILE/);
  assert.equal(fs.existsSync(trustedDestination), false);
});
