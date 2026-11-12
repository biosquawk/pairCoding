import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { assertDocument, coreFixture, id } from './helpers';

const student = (f: Awaited<ReturnType<typeof coreFixture>>) => ({ clientId: f.clientId,
  sessionId: f.sessionId, controlEpoch: f.session.getSession().controlEpoch, actor: 'STUDENT' as const });

test('AC-001 TEST-001: markdown-only folder is READY, create without Maven/tool profiles', async t => {
  const f = await coreFixture(t);
  assert.equal(f.session.getSession().lifecycle, 'READY');
  const task = f.workspace.getDocument('challenge.md'); assertDocument(task);
  f.gate.mutate({ ...student(f), operation: 'CREATE', path: 'src/main.py', newPath: null,
    content: 'print("created by student")\n', baseVersion: null });
  assert.equal(readFileSync(path.join(f.rootPath, 'src/main.py'), 'utf8'), 'print("created by student")\n');
  assert.equal(f.workspace.getProject(f.sessionId).capabilities.canRunTests, false);
});

test('AC-004 TEST-004: confirmed writes increment versions once; LF wire preserves CRLF+BOM disk', async t => {
  const f = await coreFixture(t, { 'main.py': Buffer.from('\ufeffa = 1\r\n') });
  const before = f.workspace.getDocument('main.py'); assertDocument(before);
  assert.equal(before.content, 'a = 1\n'); assert.equal(before.eol, 'CRLF'); assert.equal(before.utf8Bom, true);
  const wv = f.workspace.workspaceVersion;
  const after = f.gate.write({ ...student(f), path: 'main.py', baseVersion: before.version, content: 'a = 2\nnext = 3\n' });
  assertDocument(after);
  assert.equal(after.version, before.version + 1); assert.equal(f.workspace.workspaceVersion, wv + 1);
  assert.deepEqual(readFileSync(path.join(f.rootPath, 'main.py')), Buffer.from('\ufeffa = 2\r\nnext = 3\r\n'));
  const confirmed = readFileSync(path.join(f.rootPath, 'main.py'));
  assert.throws(() => f.gate.write({ ...student(f), path: 'main.py', baseVersion: before.version, content: 'STALE\n' }));
  assert.deepEqual(readFileSync(path.join(f.rootPath, 'main.py')), confirmed);
  assert.equal(f.workspace.workspaceVersion, wv + 1);
});

test('AC-005 TEST-005: on-disk race is checked before write, not just by watcher notification', async t => {
  const f = await coreFixture(t, { 'main.py': 'original\n' });
  const before = f.workspace.getDocument('main.py');
  // Same synchronous turn: the scheduled watcher cannot be the only write guard.
  writeFileSync(path.join(f.rootPath, 'main.py'), 'external IDE version\n');
  assert.throws(() => f.gate.write({ ...student(f), path: 'main.py', baseVersion: before.version, content: 'local draft\n' }));
  assert.equal(readFileSync(path.join(f.rootPath, 'main.py'), 'utf8'), 'external IDE version\n');
  f.workspace.scanExternal();
  const disk = f.workspace.getDocument('main.py'); assertDocument(disk);
  assert.equal(disk.content, 'external IDE version\n'); assert(disk.version > before.version);
});

test('AC-010 TEST-010: veto cutoff <50ms and no old coach epoch write after cutoff', async t => {
  const f = await coreFixture(t, { 'main.py': 'before\n' });
  f.workspace.updateSettings({ ...f.workspace.settings, aiConsent: true });
  f.session.start(null, true);
  f.session.setAiStatus('READY'); // explicit local fixture provider, not a Gemini availability claim
  const epoch = f.session.acquireCoach(id());
  const before = f.workspace.getDocument('main.py');
  const coach = { clientId: f.clientId, sessionId: f.sessionId, actor: 'COACH' as const, controlEpoch: epoch };
  const committed = f.gate.write({ ...coach, path: 'main.py', baseVersion: before.version, content: 'committed before cutoff\n' });
  const start = performance.now(); const vetoed = f.session.veto(); const elapsed = performance.now() - start;
  t.diagnostic(`single synchronous backend cutoff_ms=${elapsed.toFixed(3)}; NOT a 100-trial Windows metric`);
  assert(elapsed < 50, `backend veto took ${elapsed}ms (requirement <50ms)`);
  assert(vetoed.controlEpoch > epoch); assert.equal(vetoed.writeOwner, 'STUDENT');
  assert.equal(vetoed.cooldownAfterVeto, true);
  const wv = f.workspace.workspaceVersion;
  assert.throws(() => f.gate.write({ ...coach, path: 'main.py', baseVersion: committed.version, content: 'FORBIDDEN LATE STEP\n' }));
  assert.equal(readFileSync(path.join(f.rootPath, 'main.py'), 'utf8'), 'committed before cutoff\n');
  assert.equal(f.workspace.workspaceVersion, wv);
  // Control: current student epoch still authorizes a real write.
  f.gate.write({ ...student(f), path: 'main.py', baseVersion: committed.version, content: 'student after veto\n' });
  assert.equal(readFileSync(path.join(f.rootPath, 'main.py'), 'utf8'), 'student after veto\n');
});

test('AC-026 TEST-026: wrong lease/session/epoch are rejected without disk effects', async t => {
  const f = await coreFixture(t, { 'main.py': 'student work\n' });
  const doc = f.workspace.getDocument('main.py');
  assert.equal(f.session.claimLease(id()), false, 'second tab cannot silently steal lease');
  for (const wrong of [{ clientId: id() }, { sessionId: id() }, { controlEpoch: student(f).controlEpoch + 1 }]) {
    assert.throws(() => f.gate.write({ ...student(f), ...wrong, path: 'main.py', baseVersion: doc.version, content: 'unauthorized\n' }));
    assert.equal(readFileSync(path.join(f.rootPath, 'main.py'), 'utf8'), 'student work\n');
    assert.equal(f.workspace.getDocument('main.py').version, doc.version);
  }
});

test('AC-026 TEST-026: AI cannot mutate task/tests/config even with current coach epoch', async t => {
  const protectedFiles = { 'main.py': 'original\n', 'test_main.py': 'assert True\n', 'package.json': '{}\n' };
  const f = await coreFixture(t, protectedFiles);
  f.workspace.updateSettings({ ...f.workspace.settings, aiConsent: true }); f.session.start(null, true);
  f.session.setAiStatus('READY'); // explicit local fixture provider, not a Gemini availability claim
  const epoch = f.session.acquireCoach(id());
  for (const p of ['challenge.md', 'test_main.py', 'package.json']) {
    const doc = f.workspace.getDocument(p);
    assert.throws(() => f.gate.write({ clientId: f.clientId, sessionId: f.sessionId,
      actor: 'COACH', controlEpoch: epoch, path: p, baseVersion: doc.version, content: 'tampered\n' }));
    assert.equal(f.workspace.getDocument(p).content, doc.content);
  }
});

// Negative/control for the corrected readiness fixture: OFF is genuinely ineligible.
test('AC-010 TEST-010 control: unavailable provider cannot acquire, READY fixture can', async t => {
  const f = await coreFixture(t, { 'main.py': 'unchanged\n' });
  f.workspace.updateSettings({ ...f.workspace.settings, aiConsent: true }); f.session.start(null, true);
  assert.equal(f.session.getSession().aiStatus, 'OFF');
  assert.throws(() => f.session.acquireCoach(id()));
  assert.equal(readFileSync(path.join(f.rootPath, 'main.py'), 'utf8'), 'unchanged\n');
  f.session.setAiStatus('READY');
  f.session.acquireCoach(id()); assert.equal(f.session.getSession().writeOwner, 'COACH');
  f.session.releaseCoach(); assert.equal(f.session.getSession().writeOwner, 'STUDENT');
});
