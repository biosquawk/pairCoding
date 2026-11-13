/** Own-attempt rollback, separate from P3 public finish/Runner oracle. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { ReportService, type FrozenFacts } from '../../src/server/ReportService';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-attempt-p1-'));
  const events: unknown[] = [];
  const service = new ReportService({ dataDir: root, emit: (type, payload) => events.push({ type, payload }) });
  const facts: FrozenFacts = {
    aiConsent: false,
    session: { sessionId: 'attempt-session', projectId: 'project1', lifecycle: 'FINISHED', workspaceVersion: 7,
      controlEpoch: 5, writeOwner: 'STUDENT', coachMode: 'UNAVAILABLE', cooldownAfterVeto: false,
      presence: 'FOCUSED', aiStatus: 'OFF', activeFilePath: 'main.py', interventionId: null, lastServerSeq: 30,
      timer: { status: 'STOPPED', elapsedMs: 5000, limitMs: null, manualPaused: false,
        pauseOnHidden: false, serverTime: '2026-11-11T00:00:00Z' } },
    snapshot: { snapshotId: 'snapshot1', projectId: 'project1', createdAt: '2026-11-11T00:00:00Z',
      label: 'final', workspaceVersion: 7, paths: ['main.py'] },
    runs: [], chat: [], events: [],
  };
  const dir = path.join(root, 'reports', createHash('sha256').update(facts.session.sessionId).digest('hex'));
  const factsPath = path.join(dir, 'facts.json'), reportPath = path.join(dir, 'report.json');
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dir, factsPath, reportPath, facts, events, service };
}
const eio = () => Object.assign(new Error('injected exact report-commit EIO'), { code: 'EIO' });

for (const fault of ['rename-EIO', 'directory-obstruction'] as const) {
  test(`own facts rollback after ${fault} permits fresh current facts without publication`, async t => {
    const f = fixture(t);
    const originalRename = fs.renameSync;
    let durableFactsSeen = false;
    const injected = eio();
    const mocked = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === f.reportPath) {
        const stored = JSON.parse(fs.readFileSync(f.factsPath, 'utf8'));
        durableFactsSeen = JSON.parse(stored.serialized).snapshot.snapshotId === 'snapshot1';
        if (fault === 'directory-obstruction') { fs.mkdirSync(f.reportPath); return originalRename(from, to); }
        throw injected;
      }
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => f.service.finish('COMPLETED', f.facts), error => fault === 'rename-EIO'
        ? error === injected : (error as NodeJS.ErrnoException).code === (process.platform === 'win32' ? 'EPERM' : 'EISDIR'));
      // Same real rename-to-directory failure: Windows reports EPERM, POSIX EISDIR.
      // Rollback and foreign-obstruction assertions below are platform-independent.
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(durableFactsSeen, true, 'fault is after real durable facts, not before creation');
    assert.deepEqual(f.events, [], 'no PENDING/publication before report commit');
    assert.equal(fs.existsSync(f.factsPath), false, 'only own unpublished facts are rolled back');
    if (fault === 'directory-obstruction') {
      assert.equal(fs.lstatSync(f.reportPath).isDirectory(), true, 'obstruction is not ours to delete');
      fs.rmdirSync(f.reportPath); // repair fixture-owned fault, never product cleanup
    }
    const current = structuredClone(f.facts);
    current.snapshot.snapshotId = 'snapshot-after-repair';
    current.chat.push({ messageId: 'new-chat', author: 'STUDENT', text: 'work after failure', createdAt: '2026-11-11T00:01:00Z' });
    assert.equal(f.service.finish('COMPLETED', current).status, 'PENDING');
    const retained = JSON.parse(JSON.parse(fs.readFileSync(f.factsPath, 'utf8')).serialized) as FrozenFacts;
    assert.equal(retained.snapshot.snapshotId, 'snapshot-after-repair');
    assert.equal(retained.chat[0].text, 'work after failure');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service.get(current.session.sessionId).status, 'READY');
  });
}

test('pre-existing orphan EEXIST is retained byte-for-byte, never adopted or removed', t => {
  const f = fixture(t); fs.mkdirSync(f.dir, { recursive: true });
  const bytes = 'pre-existing forensic orphan bytes'; fs.writeFileSync(f.factsPath, bytes);
  assert.throws(() => f.service.finish('COMPLETED', f.facts), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
  assert.equal(fs.readFileSync(f.factsPath, 'utf8'), bytes);
  assert.equal(fs.existsSync(f.reportPath), false); assert.deepEqual(f.events, []);
});

test('committed facts preserve idempotency and conflict checks', async t => {
  const f = fixture(t);
  const first = f.service.finish('COMPLETED', f.facts);
  const bytes = fs.readFileSync(f.factsPath, 'utf8');
  assert.equal(f.service.finish('COMPLETED', f.facts).reportId, first.reportId);
  const changed = structuredClone(f.facts); changed.events.push({ type: 'changed' });
  assert.throws(() => f.service.finish('COMPLETED', changed), (error: any) => error.code === 'REPORT_FACTS_CONFLICT');
  assert.throws(() => f.service.finish('ABANDONED', f.facts), (error: any) => error.code === 'REPORT_FACTS_CONFLICT');
  assert.equal(fs.readFileSync(f.factsPath, 'utf8'), bytes);
  await new Promise(resolve => setImmediate(resolve));
});

test('cleanup failure keeps own evidence and original persistence error, not false success', t => {
  const f = fixture(t), injected = eio();
  const rename = fs.renameSync, unlink = fs.unlinkSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === f.reportPath) throw injected;
    return rename(from, to);
  });
  let cleanupAttempts = 0;
  t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    if (String(file) === f.factsPath) { cleanupAttempts++; throw Object.assign(new Error('cleanup EACCES'), { code: 'EACCES' }); }
    return unlink(file);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => f.service.finish('COMPLETED', f.facts), error => error === injected); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(cleanupAttempts, 1);
  const bytes = fs.readFileSync(f.factsPath, 'utf8');
  assert.equal(fs.existsSync(f.reportPath), false); assert.deepEqual(f.events, []);
  assert.throws(() => f.service.finish('COMPLETED', f.facts), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
  assert.equal(fs.readFileSync(f.factsPath, 'utf8'), bytes);
});

test('replaced same-bytes facts are not owned by failed attempt and must survive', t => {
  const f = fixture(t), injected = eio(), rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === f.reportPath) {
      const bytes = fs.readFileSync(f.factsPath);
      rename(f.factsPath, f.factsPath + '.original');
      fs.writeFileSync(f.factsPath, bytes, { flag: 'wx' }); // same bytes, different file identity
      throw injected;
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => f.service.finish('COMPLETED', f.facts), error => error === injected); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(f.factsPath, 'utf8'), fs.readFileSync(f.factsPath + '.original', 'utf8'));
  assert.notEqual(fs.statSync(f.factsPath).ino, fs.statSync(f.factsPath + '.original').ino);
  assert.deepEqual(f.events, []);
});

test('late ambiguous error after actual report rename retains committed report and facts', t => {
  const f = fixture(t), injected = eio(), rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    const result = rename(from, to);
    if (String(to) === f.reportPath) throw injected;
    return result;
  });
  syncBuiltinESMExports();
  try { assert.throws(() => f.service.finish('COMPLETED', f.facts), error => error === injected); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(fs.existsSync(f.factsPath), true); assert.equal(fs.existsSync(f.reportPath), true);
  assert.equal(JSON.parse(fs.readFileSync(f.reportPath, 'utf8')).status, 'PENDING');
  assert.deepEqual(f.events, [], 'an uncertain failed caller does not announce success');
});

for (const fault of ['partial-write', 'fsync'] as const) {
  test(`own wx-created facts ${fault} failure cleans only that attempt and permits fresh retry`, async t => {
    const f = fixture(t), injected = eio();
    const open = fs.openSync, write = fs.writeFileSync, fsync = fs.fsyncSync;
    let factsFd: number | undefined;
    let observedPartial = false;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args);
      if (String(args[0]) === f.factsPath) factsFd = fd;
      return fd;
    });
    if (fault === 'partial-write') t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      if (args[0] === factsFd) {
        write(args[0], String(args[1]).slice(0, 25));
        observedPartial = fs.statSync(f.factsPath).size === 25;
        throw injected;
      }
      return write(...args);
    });
    else t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if (fd === factsFd) { observedPartial = fs.statSync(f.factsPath).size > 25; throw injected; }
      return fsync(fd);
    });
    syncBuiltinESMExports();
    try { assert.throws(() => f.service.finish('COMPLETED', f.facts), error => error === injected); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(observedPartial, true, 'wx succeeded and actual bytes preceded the injected write/fsync failure');
    assert.equal(fs.existsSync(f.factsPath), false);
    assert.equal(fs.existsSync(f.reportPath), false); assert.deepEqual(f.events, []);
    const current = structuredClone(f.facts); current.snapshot.snapshotId = 'new-material';
    assert.equal(f.service.finish('COMPLETED', current).status, 'PENDING');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service.get(current.session.sessionId).status, 'READY');
    const stored = JSON.parse(JSON.parse(fs.readFileSync(f.factsPath, 'utf8')).serialized) as FrozenFacts;
    assert.equal(stored.snapshot.snapshotId, 'new-material');
  });
}
