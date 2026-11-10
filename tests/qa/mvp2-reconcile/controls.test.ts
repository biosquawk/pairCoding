/** Harness self-tests: NOT substitute evidence for the three React/Monaco cases. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Backend, Wire, seed } from './harness';
import { filesBelow } from '../g3/fixture';
import { require as tsRequire } from 'tsx/cjs/api';
const config = tsRequire('../mvp2-reconcile.config.ts', import.meta.url).default;

test('configuration discovers only the three owned GUI cases, no inherited server/retries/skips', () => {
  assert.equal(config.testDir, './mvp2-reconcile'); assert.equal(config.testMatch, 'reconcile.spec.ts');
  assert.equal(config.workers, 1); assert.equal(config.retries, 0); assert.equal(config.webServer, undefined);
  const spec = fs.readFileSync(new URL('./reconcile.spec.ts', import.meta.url), 'utf8');
  assert.equal((spec.match(/^test\('MVP2-/gm) ?? []).length, 3);
  assert.doesNotMatch(spec, /test\.(skip|fixme)|model\.setValue|dispatchEvent|mock\.timers/);
});

test('wire observation only matches the exact decision ACK, redacts HELLO and preserves rejected/unrelated controls', () => {
  const w = new Wire(), decision = { type: 'PROPOSAL_RESPONSE', messageId: 'decision' };
  w.sent.push(decision, { type: 'HELLO', payload: { token: 'ephemeral-secret' } });
  w.received.push({ type: 'ACK', payload: { replyTo: 'other', status: 'OK', error: null } });
  assert.equal(w.ack(decision), undefined);
  w.received.push({ type: 'ACK', payload: { replyTo: 'decision', status: 'REJECTED', error: { code: 'STALE_PROPOSAL' } } });
  assert.equal(w.ack(decision).payload.status, 'REJECTED'); assert.equal(w.decisions().length, 1);
  assert.equal(w.dump().sent[1].payload.token, '[EPHEMERAL_QA_REDACTED]');
});

test('real separate process harness: authenticated GUI bootstrap endpoints, normal file bytes, kill/rebind has new session without mutation', async t => {
  const f = await new Backend().start(); t.after(() => f.close());
  const headers = { Authorization: `Bearer ${f.token}` };
  const session = await fetch(f.baseURL + '/api/session', { headers }).then(r => r.json());
  assert.equal(session.sessionId, f.ready.sessionId); assert.equal(f.read(), seed);
  const snapshots = await fetch(f.baseURL + '/api/snapshots', { headers }).then(r => r.json());
  assert.equal(snapshots.length, 1); assert.equal(snapshots[0].snapshotId, f.ready.snapshotId);
  assert.equal((await fetch(f.baseURL + '/api/session', { headers: { Authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await fetch(f.baseURL + '/')).status, 200);
  const port = f.ready.port, previous = f.ready.sessionId, before = filesBelow(f.rootPath);
  await f.arm('restore'); assert.equal(f.checkpoints().length, 0, 'arming does not mutate or restore');
  await f.kill(); await f.start(port);
  assert.notEqual(f.ready.sessionId, previous); assert.deepEqual(filesBelow(f.rootPath), before);
  assert.equal(f.checkpoints().length, 0);
  assert.ok(fs.existsSync(path.join(f.dataDir, 'fixture-meta.json')));
});
