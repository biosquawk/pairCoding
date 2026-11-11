import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { requiredFiles, allowedSource } from '../../scripts/verify-source-revision.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = b => createHash('sha256').update(b).digest('hex');
function write(root, name, content) { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); }
function git(root, ...args) { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function fixture(t) {
  const base = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'p1-package-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'); fs.mkdirSync(root);
  for (const name of requiredFiles) write(root, name, name.startsWith('src/') ? '// synthetic\n' : fs.readFileSync(path.join(repo, name)));
  for (const name of ['tests/scripts/package-closure-p1.test.mjs', 'tests/scripts/revision-verifier-p1.test.mjs']) write(root, name, fs.readFileSync(path.join(repo, name)));
  write(root, 'tests/execution/synthetic.test.ts', '// source test, never run by packaging\n');
  for (const name of ['.env', 'src/secret.key', 'tests/qa/raw.log', 'tests/qa/artifacts/raw.txt', 'docs/qa/raw.md', 'scripts/arbitrary.mjs']) write(root, name, 'MUST_NOT_BE_PACKAGED\n');
  git(root, 'init', '--quiet'); git(root, 'config', 'core.autocrlf', 'false');
  const commit = () => { git(root, 'add', '-A'); git(root, '-c', 'user.name=P1-test', '-c', 'user.email=p1-test@invalid.local', 'commit', '--quiet', '--allow-empty', '-m', 'synthetic package fixture'); return git(root, 'rev-parse', 'HEAD'); };
  return { base, root, commit, revision: commit() };
}
function pack(f, mode, expected = 0) {
  const r = spawnSync(process.execPath, [path.join(f.root, 'scripts/package-windows.mjs'), '--commit', f.revision, ...mode], { cwd: f.root, encoding: 'utf8' });
  assert.equal(r.status, expected, r.stderr); return r;
}
function zipFiles(zip) {
  // Independent central-directory STORE reader (no Git/package module reuse).
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); --i) if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { end = i; break; }
  assert.notEqual(end, -1);
  let pos = zip.readUInt32LE(end + 16); const out = new Map();
  for (let n = 0; n < zip.readUInt16LE(end + 10); n++) {
    assert.equal(zip.readUInt32LE(pos), 0x02014b50);
    const method = zip.readUInt16LE(pos + 10), size = zip.readUInt32LE(pos + 24), length = zip.readUInt16LE(pos + 28);
    const name = zip.subarray(pos + 46, pos + 46 + length).toString('utf8'), local = zip.readUInt32LE(pos + 42);
    pos += 46 + length + zip.readUInt16LE(pos + 30) + zip.readUInt16LE(pos + 32);
    if (name.endsWith('/')) continue;
    assert.equal(method, 0); assert.equal(out.has(name), false);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    out.set(name, zip.subarray(start, start + size));
  }
  return out;
}

test('real synthetic Git -> ZIP exact closure -> trusted archive -> verified disposable bytes', t => {
  const f = fixture(t), output = path.join(f.base, 'package');
  const list = pack(f, ['--list']).stdout.trim().split('\n');
  const tracked = git(f.root, 'ls-tree', '-r', '--name-only', f.revision).split('\n');
  assert.deepEqual(list, tracked.filter(allowedSource).sort(), 'packager/helper selection agree');
  for (const name of [...requiredFiles, 'tests/scripts/revision-verifier-p1.test.mjs', 'tests/scripts/package-closure-p1.test.mjs']) assert.ok(list.includes(name), name);
  assert.ok(!list.some(p => /raw\.|secret\.key|^\.env|scripts\/arbitrary/.test(p)));
  pack(f, ['--output', output]);
  const manifestPath = path.join(output, 'manifest.json'), rawManifest = fs.readFileSync(manifestPath), manifest = JSON.parse(rawManifest);
  assert.equal(manifest.sourceCommit, f.revision); assert.equal(manifest.sourceVerification.execution, 'NOT_RUN_BY_PACKAGER');
  assert.equal(manifest.commands.length, 10);
  assert.deepEqual(manifest.sourceVerification.recoveryTests, ['tests/snapshots/snapshot-crash.test.ts']);
  for (const name of recoveryFiles) assert.ok(manifest.sourceVerification.requiredFiles.includes(name), name);
  for (const cmd of manifest.commands) for (const name of cmd.requiredFiles) assert.ok(list.includes(name));
  for (const name of manifest.sourceVerification.requiredFiles) assert.ok(list.includes(name));
  const zip = fs.readFileSync(path.join(output, manifest.archive.name)), entries = zipFiles(zip);
  assert.equal(hash(zip), manifest.archive.sha256); assert.equal(zip.length, manifest.archive.bytes);
  assert.deepEqual([...entries.keys()].sort(), manifest.files.map(f => manifest.prefix + f.path).sort());
  const extracted = path.join(f.base, 'extracted'); fs.mkdirSync(extracted);
  for (const file of manifest.files) {
    const bytes = entries.get(manifest.prefix + file.path);
    assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
    const blob = spawnSync('git', ['show', `${f.revision}:${file.path}`], { cwd: f.root });
    assert.equal(blob.status, 0); assert.deepEqual(bytes, blob.stdout);
    write(extracted, file.path, bytes);
  }
  const args = [path.join(f.root, 'scripts/verify-source-revision.mjs'), '--source', extracted, '--revision', f.revision,
    '--destination', path.join(f.base, 'verified'), '--evidence', path.join(f.base, 'identity.json'),
    '--trusted-manifest', manifestPath, '--manifest-sha256', hash(rawManifest)];
  const verified = spawnSync(process.execPath, args, { cwd: f.base, encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr);
  const identity = JSON.parse(fs.readFileSync(path.join(f.base, 'identity.json')));
  assert.equal(identity.byteVerification, 'PASS'); assert.equal(identity.manifestDigest, hash(rawManifest));
  for (const file of manifest.files) assert.equal(hash(fs.readFileSync(path.join(f.base, 'verified', file.path))), file.sha256);
  // No overwrites, no install/build/test side effects.
  const before = hash(fs.readFileSync(manifestPath));
  pack(f, ['--output', output], 1); assert.equal(hash(fs.readFileSync(manifestPath)), before);
  assert.equal(fs.existsSync(path.join(f.root, 'node_modules')), false); assert.equal(fs.existsSync(path.join(f.root, 'dist')), false);
});
for (const [name, mutate] of [
  ['missing new required docs', f => fs.unlinkSync(path.join(f.root, 'docs/WINDOWS.md'))],
  ['missing verifier helper', f => fs.unlinkSync(path.join(f.root, 'scripts/verify-source-revision.mjs'))],
  ['missing clean closure', f => fs.unlinkSync(path.join(f.root, 'scripts/clean.mjs'))],
  ['unknown lifecycle script', f => { const p = path.join(f.root, 'package.json'), pkg = JSON.parse(fs.readFileSync(p)); pkg.scripts.postinstall = 'echo do-not-run'; fs.writeFileSync(p, JSON.stringify(pkg)); }],
  ['changed build command', f => { const p = path.join(f.root, 'package.json'), pkg = JSON.parse(fs.readFileSync(p)); pkg.scripts.build += ' && echo do-not-run'; fs.writeFileSync(p, JSON.stringify(pkg)); }],
  ['missing tsx dependency', f => { const p = path.join(f.root, 'package.json'), pkg = JSON.parse(fs.readFileSync(p)); delete pkg.devDependencies.tsx; fs.writeFileSync(p, JSON.stringify(pkg)); }],
  ['Windows device path', f => write(f.root, 'src/CON.ts', '// invalid Windows path\n')],
  ['Windows case alias', f => { write(f.root, 'src/alias.ts', '// lowercase\n'); write(f.root, 'src/ALIAS.ts', '// uppercase\n'); }],
  ['symlink source', f => fs.symlinkSync('server/index.ts', path.join(f.root, 'src/link.ts'))],
  ['export-ignore strips helper', f => write(f.root, '.gitattributes', 'scripts/verify-source-revision.mjs export-ignore\n')],
  ['export-subst changes bytes', f => { write(f.root, '.gitattributes', 'README.md export-subst\n'); fs.appendFileSync(path.join(f.root, 'README.md'), '\n$Format:%H$\n'); }],
]) test(`packager refuses ${name} before output is created`, t => {
  const f = fixture(t); mutate(f); f.revision = f.commit(); const output = path.join(f.base, 'rejected');
  pack(f, ['--output', output], 1); assert.equal(fs.existsSync(output), false);
});
test('packager rejects wrong SHA and source policy script mismatch', t => {
  const f = fixture(t); pack({ ...f, revision: '0'.repeat(40) }, ['--dry-run'], 1);
  fs.appendFileSync(path.join(f.root, 'scripts/package-windows.mjs'), '\n// dirty policy\n'); pack(f, ['--dry-run'], 1);
});
test('current docs agree on Codex trainer/report, model/effort, ephemeral, ComputerUse and pending QA', () => {
  for (const name of ['README.md', 'docs/windows-start.md', 'docs/windows-coach-report-solarized.md']) {
    const body = fs.readFileSync(path.join(repo, name), 'utf8');
    for (const value of ['gpt-6.1-sol', 'medium', '--ephemeral', 'ChatGPT', 'ComputerUse', 'PENDING_FINAL_QA']) assert.ok(body.includes(value), `${name}: ${value}`);
    assert.match(body, /bez (dodatkowego |nowego )?klucza|nie wymaga klucza/i);
    assert.doesNotMatch(body, /Codex jako CoachProvider nie oznacza Codex do raportu/);
  }
});

const recoveryFiles = ['tests/snapshots/snapshot-crash.test.ts', 'tests/snapshots/snapshot-child.ts', 'tests/snapshots/helpers.ts'];
test('Windows recovery selection resolves existing suite and mandatory package/copy closure', () => {
  const ps = fs.readFileSync(path.join(repo, 'scripts/windows-verify.ps1'), 'utf8');
  const selected = /\$RecoveryTests = @\(([^)]+)\)/.exec(ps);
  assert.ok(selected, 'explicit mandatory recovery selection');
  assert.deepEqual([...selected[1].matchAll(/'([^']+)'/g)].map(m => m[1]), [recoveryFiles[0]]);
  assert.match(ps, /Invoke-NodeCheck 'snapshot-recovery' \(@\('--import','tsx','--test'\) \+ \$Recovery\)/);
  assert.doesNotMatch(ps, /tests\/core\/recovery\.test\.ts/);
  assert.match(ps, /if \(\$env:OS -ne 'Windows_NT'\)/, 'Windows-only guard unchanged');
  for (const name of recoveryFiles) {
    assert.ok(fs.statSync(path.join(repo, name)).isFile(), name);
    assert.ok(requiredFiles.includes(name), `mandatory verifier input: ${name}`);
    assert.ok(allowedSource(name), `finite allowlist: ${name}`);
  }
  // Existing suite's local support references, not a replacement or dummy recovery test.
  const suite = fs.readFileSync(path.join(repo, recoveryFiles[0]), 'utf8');
  assert.match(suite, /from '\.\/helpers'/); assert.match(suite, /new URL\('\.\/snapshot-child\.ts'/);
});
for (const name of recoveryFiles) test(`packager refuses missing mandatory recovery input ${name}`, t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.root, name)); f.revision = f.commit();
  const output = path.join(f.base, 'rejected'); pack(f, ['--output', output], 1);
  assert.equal(fs.existsSync(output), false);
});
