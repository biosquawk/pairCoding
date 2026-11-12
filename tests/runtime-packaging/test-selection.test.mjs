// Narrow discovery/command-closure proof. No repository test campaign or ZIP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { requiredFiles } from '../../scripts/verify-source-revision.mjs';
import { testCommand, proveSelection } from './test-selection-proof.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function write(root, name, bytes) { const dest = path.join(root, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes); }
function git(root, ...args) { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function fixture(t, families) {
  const base = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'selection-closure-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'); fs.mkdirSync(root);
  for (const name of requiredFiles) write(root, name, fs.readFileSync(path.join(repo, name)));
  for (const extension of families) write(root, `tests/root.test.${extension}`, '// inert source selection only\n');
  git(root, 'init', '--quiet'); git(root, 'config', 'core.autocrlf', 'false');
  const commit = () => { git(root, 'add', '--force', '--all'); git(root, '-c', 'user.name=selection-fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '--quiet', '--allow-empty', '-m', 'synthetic command closure'); return git(root, 'rev-parse', 'HEAD'); };
  return { base, root, commit, revision: commit() };
}
function pack(f, mode) { return spawnSync(process.execPath, [path.join(f.root, 'scripts/package-windows.mjs'), '--commit', f.revision, ...mode], { cwd: f.root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); }
test('selection: frozen package/docs/closure use exact portable two-lane TS+MJS command', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'))).scripts.test, testCommand);
  const row = fs.readFileSync(path.join(repo, 'docs/windows-package.md'), 'utf8').split('\n').find(line => line.startsWith('| `npm.cmd test`'));
  assert.ok(row.includes('`' + testCommand + '`'));
});
test('selection: actual npm test selects root/shallow/deep/spaced TS+MJS and excludes controls', t => {
  const base = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'npm-selection-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const proof = proveSelection({ source: repo, evidence: process.env.PAIRCOACH_SELECTION_EVIDENCE || path.join(base, 'evidence') });
  assert.equal(proof.status, 'PASS'); assert.equal(proof.selected.length, 8);
});
test('selection: finite dry-run records exact command and retains both test source families', t => {
  const f = fixture(t, ['ts', 'mjs']), result = pack(f, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.commands.find(c => c.name === 'test').command, testCommand);
  for (const extension of ['ts', 'mjs']) assert.ok(plan.files.some(file => file.path === `tests/root.test.${extension}`));
  assert.equal(fs.existsSync(path.join(f.root, 'node_modules')), false);
});
test('selection: missing MJS family refuses before output; mandatory TS recovery source stays required', t => {
  const f = fixture(t, ['ts']), destination = path.join(f.base, 'never');
  const result = pack(f, ['--output', destination]);
  assert.equal(result.status, 1); assert.match(result.stderr, /npm test: brak źródeł \*\.test\.mjs w ZIP/);
  assert.equal(fs.existsSync(destination), false);
  fs.unlinkSync(path.join(f.root, 'tests/snapshots/snapshot-crash.test.ts')); f.revision = f.commit();
  const noRecovery = pack(f, ['--output', destination]);
  assert.equal(noRecovery.status, 1); assert.match(noRecovery.stderr, /Brak wymaganego pliku: tests\/snapshots\/snapshot-crash\.test\.ts/);
  assert.equal(fs.existsSync(destination), false);
});
test('selection: legacy unquoted command is refused without executing npm or creating output', t => {
  const f = fixture(t, ['ts', 'mjs']), pkg = JSON.parse(fs.readFileSync(path.join(f.root, 'package.json')));
  pkg.scripts.test = 'tsx --test tests/**/*.test.ts'; write(f.root, 'package.json', JSON.stringify(pkg)); f.revision = f.commit();
  const destination = path.join(f.base, 'never'), result = pack(f, ['--output', destination]);
  assert.equal(result.status, 1); assert.match(result.stderr, /Nierozpoznany\/zmieniony npm script: test/);
  assert.equal(fs.existsSync(destination), false);
});
