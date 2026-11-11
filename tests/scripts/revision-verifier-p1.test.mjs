import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { requiredFiles, allowedSource, verifyAndCopy, verifyCopiedInputs } from '../../scripts/verify-source-revision.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = path.join(repo, 'scripts/verify-source-revision.mjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
function write(root, name, data) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
function fixture(t) {
  const base = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'p1-revision-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'); fs.mkdirSync(source);
  for (const name of requiredFiles) write(source, name, fs.existsSync(path.join(repo, name)) && !name.startsWith('src/') ? fs.readFileSync(path.join(repo, name)) : '// synthetic\n');
  write(source, 'tests/execution/synthetic.test.ts', 'throw new Error("NOT_EXECUTED_BY_PREFLIGHT");\n');
  write(source, 'src/extra.ts', 'const example = 1;\n');
  write(source, '.gitignore', 'node_modules/\n');
  git(source, 'init', '--quiet');
  git(source, 'config', 'core.autocrlf', 'false');
  const commit = () => { git(source, 'add', '-A'); git(source, '-c', 'user.name=P1-test', '-c', 'user.email=p1-test@invalid.local', 'commit', '--quiet', '--allow-empty', '-m', 'synthetic revision fixture'); return git(source, 'rev-parse', 'HEAD'); };
  const revision = commit();
  return { base, source, revision, commit };
}
function filesOf(f) {
  const names = git(f.source, 'ls-tree', '-r', '--name-only', f.revision).split('\n').filter(allowedSource);
  return names.map(name => { const bytes = fs.readFileSync(path.join(f.source, name)); return { path: name, bytes: bytes.length, sha256: hash(bytes) }; });
}
function archiveMode(f, edit = m => m) {
  const manifest = edit({ sourceCommit: f.revision, files: filesOf(f) });
  const file = path.join(f.base, 'trusted-manifest.json'), raw = JSON.stringify(manifest);
  fs.writeFileSync(file, raw);
  fs.rmSync(path.join(f.source, '.git'), { recursive: true, force: true });
  return { file, digest: hash(raw), manifest };
}
function run(f, { revision = f.revision, source = f.source, trust, expected = 0 } = {}) {
  const id = fs.readdirSync(f.base).length;
  const dest = path.join(f.base, 'copy-' + id), evidence = path.join(f.base, 'evidence-' + id + '.json');
  const args = [helper, '--source', source, '--revision', revision, '--destination', dest, '--evidence', evidence];
  if (trust) args.push('--trusted-manifest', trust.file, '--manifest-sha256', trust.digest);
  const r = spawnSync(process.execPath, args, { cwd: f.base, encoding: 'utf8' });
  assert.equal(r.status, expected, r.stderr);
  const report = JSON.parse(fs.readFileSync(evidence));
  if (expected !== 0) { assert.equal(report.byteVerification, 'FAIL'); assert.equal(fs.existsSync(dest), false, 'failure before any copy/install/test'); assert.doesNotMatch(r.stdout, /Windows.*PASS/); }
  return { ...r, report, dest };
}

test('actual Git root/HEAD -> verified exact disposable bytes and retained identity', t => {
  const f = fixture(t), r = run(f);
  assert.equal(r.report.actualRevision, f.revision); assert.equal(r.report.requestedRevision, f.revision);
  assert.equal(r.report.trustMode, 'GIT_HEAD'); assert.equal(r.report.byteVerification, 'PASS');
  verifyCopiedInputs(r.dest, r.report.files);
  assert.equal(fs.existsSync(path.join(r.dest, '.git')), false);
  assert.equal(fs.existsSync(path.join(r.dest, 'node_modules')), false);
});

test('wrong SHA rejected before copy/install/test, actual HEAD retained, lifecycle not run', t => {
  const f = fixture(t), sentinel = path.join(f.base, 'INSTALL_OR_TEST_RAN');
  const pkg = JSON.parse(fs.readFileSync(path.join(f.source, 'package.json')));
  pkg.scripts.preinstall = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`)}`;
  write(f.source, 'package.json', JSON.stringify(pkg)); f.revision = f.commit();
  const r = run(f, { revision: '0'.repeat(40), expected: 1 });
  assert.match(r.stderr, /GIT_REVISION_MISMATCH/); assert.equal(r.report.actualRevision, f.revision);
  assert.equal(fs.existsSync(sentinel), false);
});
for (const [name, mutate] of [
  ['dirty tracked', f => write(f.source, 'src/extra.ts', 'tamper\n')],
  ['missing tracked', f => fs.unlinkSync(path.join(f.source, 'README.md'))],
  ['staged-only change with restored worktree', f => { write(f.source, 'src/extra.ts', 'staged\n'); git(f.source, 'add', 'src/extra.ts'); write(f.source, 'src/extra.ts', 'const example = 1;\n'); }],
  ['untracked source', f => write(f.source, 'src/untracked.ts', '// extra\n')],
  ['ignored untracked source', f => { write(f.source, '.git/info/exclude', 'src/ignored.ts\n'); write(f.source, 'src/ignored.ts', '// extra\n'); }],
]) test(`Git rejects ${name}`, t => { const f = fixture(t); mutate(f); run(f, { expected: 1 }); });

test('checkout CRLF supported only as clean Git UTF-8 text; copy preserves exact checkout bytes', t => {
  const f = fixture(t);
  const checkout = path.join(f.base, 'crlf-checkout');
  git(f.base, 'clone', '--quiet', '--no-hardlinks', '-c', 'core.autocrlf=true', f.source, checkout);
  f.source = checkout;
  assert.equal(fs.readFileSync(path.join(f.source, 'src/extra.ts'), 'utf8'), 'const example = 1;\r\n');
  assert.equal(git(f.source, 'status', '--porcelain'), '', 'real clean autocrlf checkout fixture');
  const r = run(f);
  assert.equal(fs.readFileSync(path.join(r.dest, 'src/extra.ts'), 'utf8'), 'const example = 1;\r\n');
});
test('binary changes and lone CR cannot use text EOL exception', t => {
  const f = fixture(t); write(f.source, 'src/extra.ts', 'const example = 1;\r'); run(f, { expected: 1 });
});

test('Git-less source cannot borrow parent Git identity or self-attest with colocated JSON', t => {
  const f = fixture(t), nested = path.join(f.source, 'archive'); fs.mkdirSync(nested);
  write(nested, 'manifest.json', JSON.stringify({ sourceCommit: f.revision }));
  const r = run(f, { source: nested, expected: 1 }); assert.match(r.stderr, /SOURCE_IS_NOT_GIT_ROOT/);
});
test('no Git and no external trust fails closed', t => { const f = fixture(t); fs.rmSync(path.join(f.source, '.git'), { recursive: true }); run(f, { expected: 1 }); });

test('trusted external manifest digest verifies full source set and exact copy', t => {
  const f = fixture(t), trust = archiveMode(f), r = run(f, { trust });
  assert.equal(r.report.trustMode, 'EXTERNAL_MANIFEST_SHA256'); assert.equal(r.report.manifestDigest, trust.digest);
  verifyCopiedInputs(r.dest, r.report.files);
});
for (const [name, edit] of [
  ['wrong sourceCommit', m => ({ ...m, sourceCommit: '0'.repeat(40) })],
  ['omitted required docs', m => ({ ...m, files: m.files.filter(f => f.path !== 'docs/windows-start.md') })],
  ['duplicate', m => ({ ...m, files: [...m.files, m.files[0]] })],
  ['case alias', m => ({ ...m, files: [...m.files, { ...m.files[0], path: m.files[0].path.toUpperCase() }] })],
  ['traversal', m => ({ ...m, files: [...m.files, { ...m.files[0], path: '../outside.txt' }] })],
  ['absolute', m => ({ ...m, files: [...m.files, { ...m.files[0], path: '/outside.txt' }] })],
  ['drive', m => ({ ...m, files: [...m.files, { ...m.files[0], path: 'C:/outside.txt' }] })],
  ['backslash', m => ({ ...m, files: [...m.files, { ...m.files[0], path: 'src\\outside.ts' }] })],
  ['empty path component', m => ({ ...m, files: [...m.files, { ...m.files[0], path: 'src//outside.ts' }] })],
  ['Windows device path', m => ({ ...m, files: [...m.files, { ...m.files[0], path: 'src/CON.ts' }] })],
  ['wrong length', m => ({ ...m, files: m.files.map((f, i) => i === 0 ? { ...f, bytes: f.bytes + 1 } : f) })],
  ['disallowed secret', m => ({ ...m, files: [...m.files, { ...m.files[0], path: 'src/secret.key' }] })],
]) test(`archive rejects ${name} even with digest supplied for malformed manifest`, t => { const f = fixture(t), trust = archiveMode(f, edit); run(f, { trust, expected: 1 }); });

test('wrong externally expected digest rejects manifest before copy', t => { const f = fixture(t), trust = archiveMode(f); trust.digest = '0'.repeat(64); const r = run(f, { trust, expected: 1 }); assert.match(r.stderr, /UNTRUSTED_MANIFEST_DIGEST/); });
test('changed manifest cannot self-refresh trust via SHA256SUMS', t => {
  const f = fixture(t), trust = archiveMode(f); fs.appendFileSync(trust.file, ' '); write(f.source, 'SHA256SUMS', hash(fs.readFileSync(trust.file))); run(f, { trust, expected: 1 });
});
test('colocated manifest explicitly rejected even with correct digest', t => {
  const f = fixture(t), trust = archiveMode(f); const inside = path.join(f.source, 'manifest.json'); fs.copyFileSync(trust.file, inside); trust.file = inside; const r = run(f, { trust, expected: 1 }); assert.match(r.stderr, /MANIFEST_MUST_BE_EXTERNAL/);
});
for (const [name, mutate] of [
  ['tampered', f => write(f.source, 'src/extra.ts', 'tampered\n')],
  ['missing', f => fs.unlinkSync(path.join(f.source, 'src/extra.ts'))],
  ['extra required-scope file', f => write(f.source, 'src/extra-unlisted.ts', 'extra\n')],
  ['same-length tamper', f => write(f.source, 'src/extra.ts', 'const example = 2;\n')],
  ['archive CRLF not exact', f => write(f.source, 'src/extra.ts', 'const example = 1;\r\n')],
  ['file symlink', f => { const target = path.join(f.base, 'outside.ts'); fs.copyFileSync(path.join(f.source, 'src/extra.ts'), target); fs.unlinkSync(path.join(f.source, 'src/extra.ts')); fs.symlinkSync(target, path.join(f.source, 'src/extra.ts')); }],
  ['directory symlink', f => { const target = path.join(f.base, 'outside'); fs.renameSync(path.join(f.source, 'src'), target); fs.symlinkSync(target, path.join(f.source, 'src'), 'junction'); }],
]) test(`trusted archive rejects ${name} input`, t => { const f = fixture(t), trust = archiveMode(f); mutate(f); run(f, { trust, expected: 1 }); });

test('post-copy byte recheck actually rejects tampered/missing/extra copied inputs', t => {
  const f = fixture(t), r = run(f);
  write(r.dest, 'src/extra.ts', 'const example = 2;\n');
  assert.throws(() => verifyCopiedInputs(r.dest, r.report.files), /COPIED_BYTES_MISMATCH/);
  fs.copyFileSync(path.join(f.source, 'src/extra.ts'), path.join(r.dest, 'src/extra.ts'));
  fs.unlinkSync(path.join(r.dest, 'README.md')); assert.throws(() => verifyCopiedInputs(r.dest, r.report.files), /SOURCE_SET_MISMATCH/);
  fs.copyFileSync(path.join(f.source, 'README.md'), path.join(r.dest, 'README.md'));
  write(r.dest, 'src/unexpected.ts', 'extra'); assert.throws(() => verifyCopiedInputs(r.dest, r.report.files), /SOURCE_SET_MISMATCH/);
});

test('PowerShell wiring guard is before npm; static only, NOT native execution', () => {
  const ps = fs.readFileSync(path.join(repo, 'scripts/windows-verify.ps1'), 'utf8');
  assert.match(ps, /\$env:OS -ne 'Windows_NT'/);
  const fail = ps.indexOf('if ($LASTEXITCODE -ne 0) { throw "Source revision/byte verification FAIL;');
  assert.ok(fail > ps.indexOf('& $Node @Preflight'));
  assert.ok(fail < ps.indexOf("Invoke-NodeCheck 'npm-ci'"));
  assert.match(ps, /\$Identity.actualRevision -ne \$Revision/);
  assert.match(ps, /Set-Location \$PreviousCwd/);
  assert.doesNotMatch(ps, /Stop-Process|taskkill.*\/IM/i);
});

for (const kind of ['source changes before copy-read', 'destination corrupted during write']) {
  test(`actual copy flow rejects ${kind} (deterministic filesystem fault, no mock verifier)`, t => {
    const f = fixture(t), destination = path.join(f.base, 'fault-copy');
    const original = fs.writeFileSync;
    let injected = false;
    fs.writeFileSync = function (target, bytes, options) {
      original.call(fs, target, bytes, options);
      if (!injected && String(target).startsWith(destination + path.sep)) {
        injected = true;
        if (kind === 'source changes before copy-read') original.call(fs, path.join(f.source, 'src/extra.ts'), 'const example = 2;\n');
        else original.call(fs, target, 'corrupted copied bytes\n');
      }
    };
    try {
      assert.throws(() => verifyAndCopy({ source: f.source, revision: f.revision, destination }),
        kind === 'source changes before copy-read' ? /SOURCE_CHANGED_DURING_COPY/ : /COPIED_BYTES_MISMATCH/);
      assert.equal(injected, true);
    } finally { fs.writeFileSync = original; }
  });
}

test('Git clean-status alone is not byte attestation (assume-unchanged binary corruption)', t => {
  const f = fixture(t);
  git(f.source, 'update-index', '--assume-unchanged', 'src/extra.ts');
  write(f.source, 'src/extra.ts', Buffer.from([0, 255, 13, 10]));
  assert.equal(git(f.source, 'status', '--porcelain'), '');
  const r = run(f, { expected: 1 }); assert.match(r.stderr, /GIT_SOURCE_BYTES_MISMATCH/);
});
