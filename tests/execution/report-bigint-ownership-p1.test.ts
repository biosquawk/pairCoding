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


// Adjacent identities observed in ROOT's NTFS probe: equal Number, unequal bigint.
// Only stat identities are injected here; all wx/writes/replacements/cleanup use real files.
const originalId = 21955048184103830n, replacementId = originalId + 1n;

for (const field of ['ino', 'dev'] as const) {
  for (const target of ['facts', 'temporary', 'committed-temporary'] as const) {
    const other = field === 'ino' ? 'dev' : 'ino';
    test(`${target}: foreign same-bytes ${field} Number alias is retained`, t => {
      const f = fixture(t), injected = eio();
      const open = fs.openSync, fstat = fs.fstatSync, lstat = fs.lstatSync, rename = fs.renameSync;
      const targetFds = new Set<number>();
      let targetPath = '', bytes = '', replaced = false;
      assert.equal(Number(originalId), Number(replacementId), 'fixture must reproduce numeric alias');
      assert.notEqual(originalId, replacementId);
      t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        const fd = open(...args);
        if ((target === 'facts' && String(args[0]) === f.factsPath) ||
            (target !== 'facts' && String(args[0]).endsWith('.tmp'))) {
          targetPath = String(args[0]); targetFds.add(fd);
        } else targetFds.delete(fd); // Descriptor numbers may be reused for the next wx.
        return fd;
      });
      t.mock.method(fs, 'fstatSync', (fd: number, options?: { bigint?: boolean }) => {
        const stat = options?.bigint ? fstat(fd, { bigint: true }) : fstat(fd);
        return targetFds.has(fd) ? Object.assign(stat, { [field]: options?.bigint ? originalId : Number(originalId), [other]: options?.bigint ? 1111n : 1111 }) : stat;
      });
      t.mock.method(fs, 'lstatSync', (file: fs.PathLike, options?: { bigint?: boolean }) => {
        const stat = options?.bigint ? lstat(file, { bigint: true }) : lstat(file);
        return replaced && String(file) === targetPath
          ? Object.assign(stat, { [field]: options?.bigint ? replacementId : Number(replacementId), [other]: options?.bigint ? 1111n : 1111 }) : stat;
      });
      t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) !== f.reportPath) return rename(from, to);
        bytes = fs.readFileSync(targetPath, 'utf8');
        // Keep original alive, so this is an actual different file, not inode reuse.
        rename(targetPath, target === 'committed-temporary' ? to : targetPath + '.original');
        fs.writeFileSync(targetPath, bytes, { flag: 'wx' }); replaced = true;
        throw injected;
      });
      syncBuiltinESMExports();
      try { assert.throws(() => f.service.finish('COMPLETED', f.facts), error => error === injected); }
      finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
      assert.equal(replaced, true);
      assert.equal(fs.existsSync(targetPath), true, 'foreign file must not be deleted through rounded identity');
      assert.equal(fs.readFileSync(targetPath, 'utf8'), bytes);
      assert.equal(fs.existsSync(f.reportPath), target === 'committed-temporary');
      assert.equal(fs.existsSync(f.factsPath), target === 'facts' || target === 'committed-temporary');
      assert.deepEqual(f.events, [], 'no false persistence success');
    });
  }
}

test('equal exact identities above MAX_SAFE_INTEGER still allow owned temp and facts cleanup', t => {
  const f = fixture(t), injected = eio(), fstat = fs.fstatSync, lstat = fs.lstatSync;
  const exactIdentity = (stat: fs.Stats | fs.BigIntStats, bigint: boolean) =>
    Object.assign(stat, { ino: bigint ? originalId : Number(originalId), dev: bigint ? originalId : Number(originalId) });
  const fstatModes: boolean[] = [], cleanupModes: boolean[] = [];
  t.mock.method(fs, 'fstatSync', (fd: number, options?: { bigint?: boolean }) => {
    fstatModes.push(options?.bigint === true);
    return exactIdentity(options?.bigint ? fstat(fd, { bigint: true }) : fstat(fd), options?.bigint === true);
  });
  t.mock.method(fs, 'lstatSync', (file: fs.PathLike, options?: { bigint?: boolean }) => {
    const stat = options?.bigint ? lstat(file, { bigint: true }) : lstat(file);
    if (String(file) === f.factsPath || String(file).endsWith('.tmp')) {
      cleanupModes.push(options?.bigint === true);
      return exactIdentity(stat, options?.bigint === true);
    }
    return stat;
  });
  t.mock.method(fs, 'renameSync', () => { throw injected; });
  syncBuiltinESMExports();
  try { assert.throws(() => f.service.finish('COMPLETED', f.facts), error => error === injected); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(fs.readdirSync(f.dir), [], 'owned temp and facts can still be removed');
  assert.deepEqual(fstatModes, [true, true], 'capture must request exact identities');
  assert.deepEqual(cleanupModes, [true, true], 'comparison must request exact identities');
  assert.deepEqual(f.events, []);
});
