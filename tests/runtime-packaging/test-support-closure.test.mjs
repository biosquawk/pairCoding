// NEW archive-selection fixtures only. Never execute runtime preparation or old regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { requiredFiles, allowedSource, verifyAndCopy } from '../../scripts/verify-source-revision.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const support = 'scripts/runtime-operator-remainder.mjs';
const importers = ['tests/runtime-prepare-cli/remainder.test.mjs',
  'tests/runtime-remainder-image-equality/image-equality.test.mjs',
  'tests/runtime-image-retention/seams.test.mjs',
  'tests/runtime-prepare-cli/docker-client-metadata.test.mjs'];
function write(root, name, bytes) {
  const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes);
}
function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
function fixture(t, importer, withSupport = true) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'test-support-closure-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'); fs.mkdirSync(root);
  for (const name of requiredFiles) {
    const original = path.join(repo, name);
    write(root, name, fs.existsSync(original) ? fs.readFileSync(original) : `// SYNTHETIC source placeholder: ${name}\n`);
  }
  write(root, 'tests/execution/selection.test.ts', '// selection only, never run\n');
  write(root, importer, importer === importers[2]
    ? "// Dynamic fixture reference, selection only.\nconst support = 'runtime-operator-remainder.mjs';\n"
    : "import '../../scripts/runtime-operator-remainder.mjs';\n");
  // Poisoned fixture proves the packager/verifier only copy source; not a runtime substitute.
  if (withSupport) write(root, support, "throw new Error('TEST_SUPPORT_MUST_NOT_EXECUTE');\n");
  for (const name of ['scripts/runtime-unreviewed.mjs', 'scripts/runtime-recovery-controller.mjs',
    'scripts/runtime-operator-remainder-copy.mjs', 'scripts/.env.local']) write(root, name, '// excluded fixture\n');
  git(root, 'init', '--quiet'); git(root, 'add', '--force', '--all');
  git(root, '-c', 'user.name=source-fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '--quiet', '-m', 'source selection only');
  return { root, base, revision: git(root, 'rev-parse', 'HEAD') };
}
function dryRun(f) {
  return spawnSync(process.execPath, [path.join(f.root, 'scripts/package-windows.mjs'), '--commit', f.revision, '--dry-run'],
    { cwd: f.root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}
test('finite private support selected by both policies, public command unchanged, source never executed', t => {
  const f = fixture(t, importers[0]), r = dryRun(f); assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout), selected = plan.files.map(f => f.path);
  assert.ok(selected.includes(support), 'actual archive selection must include test dependency');
  assert.deepEqual(selected, git(f.root, 'ls-tree', '-r', '--name-only', f.revision).split('\n').filter(allowedSource).sort());
  assert.equal(plan.commands.length, 13); assert.ok(!plan.commands.some(c => c.command.includes('remainder')));
  assert.ok(plan.commands.find(c => c.name === 'test').requiredFiles.includes(support));
  assert.ok(!plan.commands.find(c => c.name === 'runtime:prepare').requiredFiles.includes(support));
  assert.equal(plan.commands.find(c => c.name === 'test').command, 'node scripts/runtime-test.mjs');
  for (const name of ['scripts/runtime-unreviewed.mjs', 'scripts/runtime-recovery-controller.mjs',
    'scripts/runtime-operator-remainder-copy.mjs', 'scripts/.env.local']) assert.equal(selected.includes(name), false, name);
  const dest = path.join(f.base, 'verified');
  assert.equal(verifyAndCopy({ source: f.root, revision: f.revision, destination: dest }).byteVerification, 'PASS');
  assert.deepEqual(fs.readFileSync(path.join(dest, support)), fs.readFileSync(path.join(f.root, support)));
});
for (const importer of importers) test(`missing private dependency rejects selected importer before copy/output: ${importer}`, t => {
  const f = fixture(t, importer, false), r = dryRun(f);
  assert.equal(r.status, 1, 'no successful plan with a known unresolved test dependency');
  assert.match(r.stderr, /test.support|test support/i);
  const dest = path.join(f.base, 'must-not-exist');
  assert.throws(() => verifyAndCopy({ source: f.root, revision: f.revision, destination: dest }), /MISSING_TEST_SUPPORT/);
  assert.equal(fs.existsSync(dest), false);
});
