import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { WorkspaceService } from '../../src/server/WorkspaceService';
import { WriteGate } from '../../src/server/WriteGate';
import { fixture, open, code } from './helpers';

// No existing oracle is changed; these exercise the actual service and real disk.
test('snapshot persistence: stable project identity, frozen bytes and independent return values across restart', t => {
  const f = fixture(t), projectId = f.workspace.projectId;
  const snapshot = f.workspace.createSnapshot('Frozen');
  assert.equal(snapshot.workspaceVersion, 0);
  assert.deepEqual(snapshot.paths, ['a.ts', 'b.ts']);
  const frozen = f.workspace.readSnapshot(snapshot.snapshotId);
  frozen.files[0].rawBase64 = 'tampered caller'; frozen.snapshot.paths.push('not-a-file');
  snapshot.paths.length = 0;
  f.write('a.ts', 'NEW AFTER FREEZE');
  assert.equal(Buffer.from(f.workspace.readSnapshot(snapshot.snapshotId).files[0].rawBase64!, 'base64').toString(), 'SNAP A\n');
  f.close();
  const restarted = open(f.root, f.data);
  try {
    assert.equal(restarted.workspace.projectId, projectId);
    assert.equal(restarted.workspace.listSnapshots().length, 1);
    assert.deepEqual(restarted.workspace.listSnapshots()[0].paths, ['a.ts', 'b.ts']);
    assert.equal(Buffer.from(restarted.workspace.readSnapshot(snapshot.snapshotId).files[0].rawBase64!, 'base64').toString(), 'SNAP A\n');
  } finally { restarted.close(); }
});

test('snapshot identity is stable even before first persistence; opening does not create private data', t => {
  const f = fixture(t), id = f.workspace.projectId;
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['a.ts', 'b.ts']);
  assert.equal(fs.existsSync(f.data), false);
  f.close(); const again = open(f.root, f.data);
  try { assert.equal(again.workspace.projectId, id); } finally { again.close(); }
});

test('restore is gated, selective, creates durable before-image, advances versions and never resets timer', t => {
  const f = fixture(t);
  const source = f.workspace.createSnapshot('Original');
  f.session.start(60000, true); f.session.timerAction('PAUSE', null);
  f.write('a.ts', 'WORK A\n'); f.write('b.ts', 'WORK B\n');
  const beforeVersion = f.workspace.workspaceVersion, documentVersion = f.workspace.getDocument('a.ts').version;
  const timer = f.session.getSession().timer;
  assert.throws(() => f.workspace.restoreSnapshot(source.snapshotId, ['a.ts'], f.auth()), code('WRITE_GATE_REQUIRED'));
  const events: any[] = []; f.workspace.on('external', e => events.push(e));
  const backup = f.restore(source.snapshotId, ['a.ts']);
  assert.equal(backup.workspaceVersion, beforeVersion);
  assert.deepEqual(backup.paths, ['a.ts']);
  assert.equal(Buffer.from(f.workspace.readSnapshot(backup.snapshotId).files[0].rawBase64!, 'base64').toString(), 'WORK A\n');
  assert.equal(f.bytes('a.ts').toString(), 'SNAP A\n'); assert.equal(f.bytes('b.ts').toString(), 'WORK B\n');
  assert.ok(f.workspace.workspaceVersion > beforeVersion); assert.ok(f.workspace.getDocument('a.ts').version > documentVersion);
  assert.equal(f.workspace.listSnapshots().length, 2);
  assert.equal(events.length, 1); assert.equal(events[0].operation, 'UPDATED');
  const after = f.session.getSession().timer;
  assert.equal(after.elapsedMs, timer.elapsedMs); assert.equal(after.status, timer.status); assert.equal(after.limitMs, timer.limitMs);
  const settled = f.workspace.workspaceVersion; f.workspace.scanExternal(); assert.equal(f.workspace.workspaceVersion, settled, 'no own post-close ctime echo');
});

test('snapshot raw BOM/CRLF/binary and source mode are restored byte-for-byte, not re-encoded from live file', t => {
  const raw = Buffer.from('\ufeffconst text = "ź";\r\n');
  const f = fixture(t, { 'a.ts': raw, 'binary.bin': Buffer.from([0xff, 0, 0xfe]) });
  fs.chmodSync(f.file('a.ts'), 0o640); f.workspace.scanExternal();
  const snapshot = f.workspace.createSnapshot('Raw');
  f.write('a.ts', 'new content'); fs.chmodSync(f.file('a.ts'), 0o600); fs.writeFileSync(f.file('binary.bin'), Buffer.from([1, 2])); f.workspace.scanExternal();
  f.restore(snapshot.snapshotId, ['a.ts', 'binary.bin']);
  assert.deepEqual(f.bytes('a.ts'), raw); assert.deepEqual(f.bytes('binary.bin'), Buffer.from([0xff, 0, 0xfe]));
  assert.equal(fs.statSync(f.file('a.ts')).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o640);
  assert.equal(f.workspace.getDocument('a.ts').utf8Bom, true); assert.equal(f.workspace.getDocument('a.ts').eol, 'CRLF');
});

test('explicit tombstone deletion and backup restoration create nested parents without full-tree reset', t => {
  const f = fixture(t);
  const missing = f.workspace.createSnapshot('Absent', ['deep/file.ts']);
  assert.equal(f.workspace.readSnapshot(missing.snapshotId).files[0].rawBase64, null);
  fs.mkdirSync(f.file('deep')); fs.writeFileSync(f.file('deep/file.ts'), 'KEEP BEFORE DELETE'); fs.writeFileSync(f.file('new.ts'), 'UNSELECTED'); f.workspace.scanExternal();
  const backup = f.restore(missing.snapshotId, ['deep/file.ts']);
  assert.equal(fs.existsSync(f.file('deep/file.ts')), false); assert.equal(f.bytes('new.ts').toString(), 'UNSELECTED');
  fs.rmdirSync(f.file('deep')); f.workspace.scanExternal();
  f.restore(backup.snapshotId, ['deep/file.ts']);
  assert.equal(f.bytes('deep/file.ts').toString(), 'KEEP BEFORE DELETE'); assert.equal(f.bytes('new.ts').toString(), 'UNSELECTED');
});

test('empty project and explicit empty snapshot are supported but empty restore is rejected', t => {
  const f = fixture(t, {}), a = f.workspace.createSnapshot('Empty');
  assert.deepEqual(a.paths, []); assert.deepEqual(f.workspace.readSnapshot(a.snapshotId).files, []);
  assert.deepEqual(f.workspace.createSnapshot('Also empty', []).paths, []);
  assert.throws(() => f.restore(a.snapshotId, []), code('INVALID_SNAPSHOT_PATHS'));
});

test('snapshot hard excludes secrets/cache independent of AI consent; explicit secret paths fail without publication', t => {
  const f = fixture(t, { 'a.ts': 'code', '.env.local': 'secret', 'a.pem': 'private', '.aws/credentials': 'password',
    'credentials.json': 'secret', '.git/config': 'private', 'node_modules/pkg/a.ts': 'cache' });
  assert.deepEqual(f.workspace.createSnapshot('Safe').paths, ['a.ts']);
  for (const p of ['.env.local', 'a.pem', '.aws/credentials', 'credentials.json']) assert.throws(() => f.workspace.createSnapshot('Bad', [p]), code('SNAPSHOT_PATH_FORBIDDEN'));
  assert.equal(f.workspace.listSnapshots().length, 1); assert.equal(f.bytes('.env.local').toString(), 'secret');
});

test('snapshot path/label/subset/version validation fails closed without changing task bytes', t => {
  const f = fixture(t), s = f.workspace.createSnapshot('Valid', ['a.ts']);
  for (const label of ['', ' ', 'x'.repeat(201)]) assert.throws(() => f.workspace.createSnapshot(label));
  for (const paths of [['a.ts', 'a.ts'], ['a.ts', 'A.ts'], ['../outside'], ['CON'], ['/absolute'], ['a.ts/x'], ['dir', 'dir/file']]) assert.throws(() => f.workspace.createSnapshot('Bad', paths));
  assert.throws(() => f.restore(s.snapshotId, ['b.ts']), code('INVALID_SNAPSHOT_PATHS'));
  assert.throws(() => f.restore(s.snapshotId, ['a.ts'], -1), code('INVALID_VERSION'));
  assert.throws(() => f.workspace.readSnapshot('../no'), code('INVALID_SNAPSHOT_ID'));
  assert.throws(() => f.workspace.readSnapshot('00000000-0000-4000-8000-000000000001'), code('SNAPSHOT_NOT_FOUND'));
  assert.equal(f.bytes('a.ts').toString(), 'SNAP A\n'); assert.equal(f.workspace.workspaceVersion, 0);
});

test('oversize and hardlinked live files are never truncated/opened as snapshots', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file('large.bin'), Buffer.alloc(1048577, 65)); f.workspace.scanExternal();
  assert.throws(() => f.workspace.createSnapshot('Large', ['large.bin']), code('FILE_TOO_LARGE'));
  assert.equal(fs.statSync(f.file('large.bin')).size, 1048577);
  fs.linkSync(f.file('a.ts'), path.join(f.parent, 'alias'));
  assert.throws(() => f.workspace.createSnapshot('Linked', ['a.ts']), code('UNSAFE_PATH'));
});

test('symlinked live leaf/ancestor and private snapshot material are rejected without reading outside', t => {
  const f = fixture(t);
  const snapshot = f.workspace.createSnapshot('Safe');
  const outside = path.join(f.parent, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'a.ts'), 'OUTSIDE');
  fs.symlinkSync(outside, f.file('linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.workspace.createSnapshot('No', ['linked/a.ts']), code('UNSAFE_PATH'));
  const bin = path.join(f.data, 'snapshots-v1', snapshot.snapshotId, '0.bin'); fs.unlinkSync(bin);
  fs.symlinkSync(path.join(outside, 'a.ts'), bin);
  assert.throws(() => f.workspace.readSnapshot(snapshot.snapshotId), code('RECOVERY_REQUIRED'));
  assert.equal(fs.readFileSync(path.join(outside, 'a.ts'), 'utf8'), 'OUTSIDE');
});

test('frozen read is independent of current public bytes/types, including a later symlink replacement', t => {
  const f = fixture(t), snapshot = f.workspace.createSnapshot('Frozen');
  fs.unlinkSync(f.file('a.ts')); fs.symlinkSync(f.file('b.ts'), f.file('a.ts'));
  assert.equal(Buffer.from(f.workspace.readSnapshot(snapshot.snapshotId).files[0].rawBase64!, 'base64').toString(), 'SNAP A\n');
});

for (const target of ['manifest.json', '0.bin']) test(`snapshot checksum/authentication rejects tampered ${target}`, t => {
  const f = fixture(t), s = f.workspace.createSnapshot('Authenticated');
  const file = path.join(f.data, 'snapshots-v1', s.snapshotId, target);
  if (target === 'manifest.json') {
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8')); const value = JSON.parse(envelope.payload); value.snapshot.label = 'forged'; envelope.payload = JSON.stringify(value); fs.writeFileSync(file, JSON.stringify(envelope));
  } else fs.writeFileSync(file, 'tampered');
  assert.throws(() => f.workspace.readSnapshot(s.snapshotId), code('RECOVERY_REQUIRED'));
  assert.equal(f.bytes('a.ts').toString(), 'SNAP A\n');
});

test('snapshot store cannot be reused by another root/project; no public bytes are touched', t => {
  const f = fixture(t); f.workspace.createSnapshot('First root');
  const other = path.join(f.parent, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'a.ts'), 'OTHER');
  const w = new WorkspaceService(other, f.data);
  try { assert.throws(() => w.listSnapshots(), code('RECOVERY_REQUIRED')); assert.throws(() => w.createSnapshot('Wrong root'), code('RECOVERY_REQUIRED')); }
  finally { w.close(); }
  assert.equal(fs.readFileSync(path.join(other, 'a.ts'), 'utf8'), 'OTHER'); assert.equal(f.bytes('a.ts').toString(), 'SNAP A\n');
});

test('stale proposal, wrong lease/session/epoch and coach restore produce no backup or task effect', t => {
  const f = fixture(t), s = f.workspace.createSnapshot('Source');
  f.write('a.ts', 'WORK');
  assert.throws(() => f.restore(s.snapshotId, ['a.ts'], 0), code('WORKSPACE_VERSION_CONFLICT'));
  for (const [change, expected] of [[{ clientId: 'not-owner' }, 'LEASE_REQUIRED'], [{ sessionId: 'old' }, 'SESSION_MISMATCH'], [{ controlEpoch: -1 }, 'STALE_EPOCH'], [{ actor: 'COACH' }, 'WRITE_OWNER_CONFLICT']] as const) {
    assert.throws(() => f.gate.restoreSnapshot({ ...f.auth(), ...change, snapshotId: s.snapshotId, paths: ['a.ts'], expectedWorkspaceVersion: f.workspace.workspaceVersion }), code(expected));
  }
  assert.equal(f.workspace.listSnapshots().length, 1); assert.equal(f.bytes('a.ts').toString(), 'WORK');
});

test('late external change after earlier capture prevents publication with an old workspace version', t => {
  const f = fixture(t); let injected = false;
  f.workspace.on('snapshotCheckpoint', e => {
    if (e.phase === 'SNAPSHOT_FILE_CAPTURED' && e.index === 1) { injected = true; fs.writeFileSync(f.file('a.ts'), 'FOREIGN FIRST FILE'); }
  });
  assert.throws(() => f.workspace.createSnapshot('Must not publish'), code('DISK_CONFLICT'));
  assert.equal(injected, true); assert.equal(f.workspace.listSnapshots().length, 0);
  assert.ok(f.workspace.workspaceVersion > 0); assert.equal(f.bytes('a.ts').toString(), 'FOREIGN FIRST FILE');
});

test('capture revalidates whole workspace after private writes, including an unselected file', t => {
  const f = fixture(t); let captured = false, injected = false;
  f.workspace.on('snapshotCheckpoint', () => { captured = true; });
  const realSync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    realSync(fd);
    if (captured && !injected) { injected = true; fs.writeFileSync(f.file('b.ts'), 'FOREIGN UNSELECTED'); }
  }); syncBuiltinESMExports();
  assert.throws(() => f.workspace.createSnapshot('No stale tag', ['a.ts']), code('DISK_CONFLICT'));
  assert.equal(injected, true); assert.equal(f.workspace.listSnapshots().length, 0); assert.ok(f.workspace.workspaceVersion > 0);
});

test('real backup store failure blocks restore before any capture/publication', t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source'); f.write('a.ts', 'WORK');
  let injected = false;
  const base = path.join(f.data, 'snapshots-v1'), held = path.join(f.data, 'held');
  f.workspace.on('snapshotCheckpoint', e => {
    if (e.phase === 'SNAPSHOT_FILE_CAPTURED' && !injected) { injected = true; fs.renameSync(base, held); fs.writeFileSync(base, 'not a directory'); }
  });
  assert.throws(() => f.restore(source.snapshotId, ['a.ts']), code('SNAPSHOT_BACKUP_FAILED'));
  assert.equal(injected, true); assert.equal(f.bytes('a.ts').toString(), 'WORK'); assert.equal(f.bytes('b.ts').toString(), 'SNAP B\n');
  assert.equal(fs.existsSync(f.file('.paircoach/snapshot-journal-v1')), false);
  fs.unlinkSync(base); fs.renameSync(held, base);
});

test('lease revocation after backup capture is checked before publication and leaves task bytes intact', t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source'); f.write('a.ts', 'WORK');
  f.workspace.once('snapshotCheckpoint', () => f.session.releaseLease('tab'));
  assert.throws(() => f.restore(source.snapshotId, ['a.ts']), code('LEASE_REQUIRED'));
  assert.equal(f.bytes('a.ts').toString(), 'WORK'); assert.equal(f.workspace.listSnapshots().length, 1);
});

test('reentrant write/mutate/restore from changed/external listeners is blocked by shared workspace guard', t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source'); let blocked = 0;
  const reenter = () => {
    assert.throws(() => f.gate.write({ ...f.auth(), path: 'b.ts', content: 'REENTER', baseVersion: 1 }), code('WORKSPACE_BUSY')); blocked++;
    assert.throws(() => f.gate.mutate({ ...f.auth(), operation: 'CREATE', path: 'new.ts', content: 'REENTER', baseVersion: null, newPath: null }), code('WORKSPACE_BUSY')); blocked++;
    assert.throws(() => f.restore(source.snapshotId, ['b.ts']), code('WORKSPACE_BUSY')); blocked++;
  };
  f.workspace.once('changed', reenter); f.write('a.ts', 'WORK');
  f.workspace.once('external', reenter); f.restore(source.snapshotId, ['a.ts']);
  assert.equal(blocked, 6); assert.equal(f.bytes('b.ts').toString(), 'SNAP B\n'); assert.equal(fs.existsSync(f.file('new.ts')), false);
});

test('authority revoked after the first publication rolls back instead of continuing a stale restore', t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source'); f.write('a.ts', 'WORK A'); f.write('b.ts', 'WORK B');
  f.workspace.on('snapshotCheckpoint', e => { if (e.phase === 'PUBLISHED' && e.index === 0) f.session.releaseLease('tab'); });
  assert.throws(() => f.restore(source.snapshotId, ['a.ts', 'b.ts']), code('RESTORE_INCOMPLETE'));
  assert.equal(f.bytes('a.ts').toString(), 'WORK A'); assert.equal(f.bytes('b.ts').toString(), 'WORK B');
  assert.equal(f.workspace.listSnapshots().length, 2);
  f.session.claimLease('tab'); f.write('a.ts', 'AFTER ROLLBACK'); assert.equal(f.bytes('a.ts').toString(), 'AFTER ROLLBACK');
});

test('reentrant second Workspace/WriteGate instance for the same root cannot recover a live synchronous transaction', t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source'); f.write('a.ts', 'WORK'); let checked = false;
  f.workspace.on('snapshotCheckpoint', e => {
    if (e.phase !== 'PREPARED') return;
    const w = new WorkspaceService(f.root, f.data);
    try {
      // No session or mutation from another instance may bypass the root-scoped guard.
      assert.throws(() => w._recoverSnapshots(), code('WORKSPACE_BUSY'));
      assert.throws(() => w._withMutation(() => assert.fail('must not run')), code('WORKSPACE_BUSY'));
      checked = true;
    } finally { w.close(); }
  });
  f.restore(source.snapshotId, ['a.ts']); assert.equal(checked, true); assert.equal(f.bytes('a.ts').toString(), 'SNAP A\n');
});

for (const operation of ['capture', 'publish', 'cleanup']) test(`unknown ${operation} syscall outcome is observed before rollback, never replayed`, t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source'); f.write('a.ts', 'WORK A'); f.write('b.ts', 'WORK B');
  let count = 0;
  if (operation === 'capture') {
    const real = childProcess.spawnSync;
    t.mock.method(childProcess, 'spawnSync', (exe: any, args: any, options: any) => {
      const result = real(exe, args, options); // actual no-replace, child joined
      if (JSON.parse(options.input).from === f.file('a.ts')) { count++; return { ...result, stdout: 'unknown result' }; }
      return result;
    });
  } else if (operation === 'publish') {
    const real = fs.linkSync;
    t.mock.method(fs, 'linkSync', (from: fs.PathLike, to: fs.PathLike) => {
      real(from, to);
      if (String(from).endsWith('0.forward')) { count++; throw Object.assign(Error('unknown link result'), { code: 'EIO' }); }
    });
  } else {
    const real = fs.unlinkSync;
    t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
      real(file);
      if (String(file).endsWith('0.forward')) { count++; throw Object.assign(Error('unknown cleanup result'), { code: 'EIO' }); }
    });
  }
  syncBuiltinESMExports();
  assert.throws(() => f.restore(source.snapshotId, ['a.ts', 'b.ts']), code('RESTORE_INCOMPLETE'));
  assert.equal(count, 1); assert.equal(f.bytes('a.ts').toString(), 'WORK A'); assert.equal(f.bytes('b.ts').toString(), 'WORK B');
});

test('late foreign source replacement at actual capture syscall survives publicly and in retained material; no success', t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source'); f.write('a.ts', 'WORK A');
  let injected = false;
  const real = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', (exe: any, args: any, options: any) => {
    if (JSON.parse(options.input).from === f.file('a.ts') && !injected) { injected = true; fs.unlinkSync(f.file('a.ts')); fs.writeFileSync(f.file('a.ts'), 'FOREIGN LATEST'); }
    return real(exe, args, options);
  }); syncBuiltinESMExports();
  assert.throws(() => f.restore(source.snapshotId, ['a.ts']), code('RECOVERY_REQUIRED'));
  assert.equal(injected, true); assert.equal(f.bytes('a.ts').toString(), 'FOREIGN LATEST');
  const base = f.file('.paircoach/snapshot-journal-v1'), operation = fs.readdirSync(base).find(p => p.startsWith('transaction-'))!;
  assert.equal(fs.readFileSync(path.join(base, operation, '0.captured'), 'utf8'), 'FOREIGN LATEST');
  assert.throws(() => f.write('b.ts', 'MUST BLOCK'), code('RECOVERY_REQUIRED'));
});

test('no-clobber restore and rollback preserve an external destination created between capture and publication', t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source'); f.write('a.ts', 'WORK A');
  f.workspace.on('snapshotCheckpoint', e => { if (e.phase === 'BEFORE_PUBLICATION') fs.writeFileSync(f.file('a.ts'), 'FOREIGN NEW PUBLIC', { flag: 'wx' }); });
  assert.throws(() => f.restore(source.snapshotId, ['a.ts']), code('RECOVERY_REQUIRED'));
  assert.equal(f.bytes('a.ts').toString(), 'FOREIGN NEW PUBLIC');
  const backup = f.workspace.listSnapshots().find(s => s.snapshotId !== source.snapshotId)!;
  assert.equal(Buffer.from(f.workspace.readSnapshot(backup.snapshotId).files[0].rawBase64!, 'base64').toString(), 'WORK A');
});

test('even a currently authorized COACH owner cannot execute restore', t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source');
  f.workspace.updateSettings({ ...f.workspace.settings, aiConsent: true }); f.session.setAiStatus('READY'); f.session.start(null, true); f.session.acquireCoach('intervention');
  assert.throws(() => f.gate.restoreSnapshot({ ...f.auth(), actor: 'COACH', snapshotId: source.snapshotId, paths: ['a.ts'], expectedWorkspaceVersion: f.workspace.workspaceVersion }), code('COACH_RESTORE_FORBIDDEN'));
  assert.equal(f.workspace.listSnapshots().length, 1); assert.equal(f.bytes('a.ts').toString(), 'SNAP A\n');
});

test('restore backup revalidates earlier captured files after all files: foreign change leaves no task effect/journal', t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source'); f.write('a.ts', 'WORK A'); f.write('b.ts', 'WORK B');
  f.workspace.on('snapshotCheckpoint', e => { if (e.phase === 'SNAPSHOT_FILE_CAPTURED' && e.index === 1) fs.writeFileSync(f.file('a.ts'), 'LATEST FOREIGN'); });
  assert.throws(() => f.restore(source.snapshotId, ['a.ts', 'b.ts']), code('DISK_CONFLICT'));
  assert.equal(f.bytes('a.ts').toString(), 'LATEST FOREIGN'); assert.equal(f.bytes('b.ts').toString(), 'WORK B');
  assert.equal(f.workspace.listSnapshots().length, 1); assert.equal(fs.existsSync(f.file('.paircoach/snapshot-journal-v1')), false);
});

test('final verification checks ALL published paths before COMMITTED, never just the last file', t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source'); f.write('a.ts', 'WORK A'); f.write('b.ts', 'WORK B');
  f.workspace.on('snapshotCheckpoint', e => { if (e.phase === 'PUBLISHED' && e.index === 1) { fs.unlinkSync(f.file('a.ts')); fs.writeFileSync(f.file('a.ts'), 'LATEST FOREIGN'); } });
  assert.throws(() => f.restore(source.snapshotId, ['a.ts', 'b.ts']), code('RECOVERY_REQUIRED'));
  assert.equal(f.bytes('a.ts').toString(), 'LATEST FOREIGN');
  const base = f.file('.paircoach/snapshot-journal-v1'), operation = fs.readdirSync(base).find(n => n.startsWith('transaction-'))!;
  assert.equal(fs.existsSync(path.join(base, operation, 'COMMITTED')), false);
  assert.equal(f.workspace.listSnapshots().length, 2);
});

test('sequential replay using the original proposal version is rejected before a second backup; transport outcome dedupe remains K', t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source'); f.write('a.ts', 'WORK');
  const originalVersion = f.workspace.workspaceVersion;
  f.restore(source.snapshotId, ['a.ts'], originalVersion);
  assert.throws(() => f.restore(source.snapshotId, ['a.ts'], originalVersion), code('WORKSPACE_VERSION_CONFLICT'));
  assert.equal(f.workspace.listSnapshots().length, 2);
});

test('malformed snapshot manifest fails as RECOVERY_REQUIRED, never a raw JSON exception', t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source');
  fs.writeFileSync(path.join(f.data, 'snapshots-v1', source.snapshotId, 'manifest.json'), '{');
  assert.throws(() => f.workspace.readSnapshot(source.snapshotId), code('RECOVERY_REQUIRED'));
});
