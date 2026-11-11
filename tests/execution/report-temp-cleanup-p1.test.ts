/** Temp ownership and primary error preservation; syscall faults, not OS double-fault claims. */
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


test('rename EIO plus own temporary cleanup EACCES preserves original error and permits fresh retry', async t => {
  const f = fixture(t), injected = eio(), rename = fs.renameSync, unlink = fs.unlinkSync;
  let temporary = '', cleanupAttempts = 0;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === f.reportPath) { temporary = String(from); throw injected; }
    return rename(from, to);
  });
  t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    if (String(file) === temporary) { cleanupAttempts++; throw Object.assign(new Error('temp cleanup EACCES'), { code: 'EACCES' }); }
    return unlink(file);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => f.service.finish('COMPLETED', f.facts), error => error === injected); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(cleanupAttempts, 1);
  const retainedTemporary = fs.readFileSync(temporary, 'utf8');
  assert.equal(JSON.parse(retainedTemporary).status, 'PENDING');
  assert.equal(fs.existsSync(f.reportPath), false); assert.equal(fs.existsSync(f.factsPath), false);
  assert.deepEqual(f.events, [], 'no false persistence success or generation');
  const current = structuredClone(f.facts); current.snapshot.snapshotId = 'after-temp-fault-repair';
  assert.equal(f.service.finish('COMPLETED', current).status, 'PENDING');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.get(current.session.sessionId).status, 'READY');
  const stored = JSON.parse(JSON.parse(fs.readFileSync(f.factsPath, 'utf8')).serialized) as FrozenFacts;
  assert.equal(stored.snapshot.snapshotId, 'after-temp-fault-repair');
  assert.equal(fs.readFileSync(temporary, 'utf8'), retainedTemporary, 'old cleanup evidence is not adopted/deleted');
});

test('temporary wx EEXIST must not delete a foreign collision', t => {
  const f = fixture(t), open = fs.openSync;
  let temporary = '';
  const foreign = 'foreign pre-existing temp';
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).endsWith('.tmp')) {
      temporary = String(args[0]);
      const foreignFd = open(temporary, 'wx', 0o600);
      try { fs.writeFileSync(foreignFd, foreign); } finally { fs.closeSync(foreignFd); }
    }
    return open(...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => f.service.finish('COMPLETED', f.facts), (error: NodeJS.ErrnoException) => error.code === 'EEXIST'); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(temporary, 'utf8'), foreign);
  assert.equal(fs.existsSync(f.factsPath), false); assert.equal(fs.existsSync(f.reportPath), false);
  assert.deepEqual(f.events, []);
});

for (const committed of [false, true]) {
  test(`same-bytes replaced temporary survives rename error (committed=${committed})`, t => {
    const f = fixture(t), injected = eio(), rename = fs.renameSync;
    let temporary = '', identity = 0, replacement = 0, bytes = '';
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === f.reportPath) {
        temporary = String(from); bytes = fs.readFileSync(temporary, 'utf8'); identity = fs.statSync(temporary).ino;
        rename(from, committed ? to : temporary + '.original');
        fs.writeFileSync(temporary, bytes, { flag: 'wx' }); replacement = fs.statSync(temporary).ino;
        throw injected;
      }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try { assert.throws(() => f.service.finish('COMPLETED', f.facts), error => error === injected); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.notEqual(identity, replacement, 'same content is not file ownership');
    assert.equal(fs.readFileSync(temporary, 'utf8'), bytes);
    assert.equal(fs.existsSync(f.reportPath), committed); assert.equal(fs.existsSync(f.factsPath), committed);
    assert.equal(fs.readFileSync(committed ? f.reportPath : temporary + '.original', 'utf8'), bytes);
    assert.deepEqual(f.events, [], 'ambiguous commit is not reported as success');
  });
}

test('partial temporary write plus own cleanup EACCES preserves write error without unowned retry cleanup', t => {
  const f = fixture(t), injected = eio(), open = fs.openSync, write = fs.writeFileSync, unlink = fs.unlinkSync;
  let temporary = '', temporaryFd: number | undefined, cleanupAttempts = 0;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (String(args[0]).endsWith('.tmp')) { temporary = String(args[0]); temporaryFd = fd; }
    return fd;
  });
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (args[0] === temporaryFd) { write(args[0], String(args[1]).slice(0, 25)); throw injected; }
    return write(...args);
  });
  t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    if (String(file) === temporary) { cleanupAttempts++; throw Object.assign(new Error('temp cleanup EACCES'), { code: 'EACCES' }); }
    return unlink(file);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => f.service.finish('COMPLETED', f.facts), error => error === injected); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(cleanupAttempts, 1, 'writeExclusive alone owns cleanup after its partial write failure');
  assert.equal(fs.statSync(temporary).size, 25, 'actual partial bytes retained on failed cleanup');
  assert.equal(fs.existsSync(f.reportPath), false); assert.equal(fs.existsSync(f.factsPath), false);
  assert.deepEqual(f.events, []);
});
