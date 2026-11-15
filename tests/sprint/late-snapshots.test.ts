/** Real HTTP/WS/FS + LiveBackend. Only actual snapshot responses are delayed/lost.
 * No Run, Docker, coach, injected client state, or modified learning material. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createPairCoachServer } from '../../src/server/http';
import { DEFAULT_PACK_PATH } from '../../src/server/sprint/LearningPack';
import { LiveBackend } from '../../src/services/LiveBackend';
import { currentAttempt } from '../../src/shared/sprint';
import type * as Wire from '../../src/shared/protocol';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type Request = { route: string; method: string; body: any; status?: number; value?: any };
type Gate = { drop: boolean; arrived: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; request?: Request };

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-late-snapshots-'));
  const directory = path.join(root, 'Training'), pack = path.join(root, 'pack');
  fs.mkdirSync(directory);
  fs.cpSync(DEFAULT_PACK_PATH, pack, { recursive: true }); // private, byte-identical material
  const token = 'late-snapshots-' + randomUUID(), clientId = 'late-snapshots-tab';
  const app = createPairCoachServer({ port: 0, token, learningPackPath: pack,
    enableCoach: false, enableExecution: false, runtimeEnvironment: {} });
  const gates: Gate[] = [], allGates: Gate[] = [], requests: Request[] = [];
  const frames: { direction: string; message: any }[] = [];
  const port = await app.listen(), baseUrl = `http://127.0.0.1:${port}`;
  const client = new LiveBackend({ baseUrl, token, clientId,
    fetch: async (url, options) => {
      assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${token}`);
      const request: Request = { route: new URL(String(url)).pathname, method: options?.method ?? 'GET',
        body: options?.body ? JSON.parse(String(options.body)) : null };
      requests.push(request);
      const gate = request.route === '/api/snapshots' && request.method === 'GET' ? gates.shift() : undefined;
      const response = await fetch(url, options);
      request.status = response.status; request.value = await response.clone().json();
      if (gate) {
        gate.request = request; gate.arrived.resolve();
        await new Promise<void>((resolve, reject) => {
          const signal = options?.signal;
          const abort = () => reject(new DOMException('Held snapshot response aborted', 'AbortError'));
          if (signal?.aborted) { abort(); return; }
          signal?.addEventListener('abort', abort, { once: true });
          gate.release.promise.then(() => { signal?.removeEventListener('abort', abort); resolve(); });
        });
        if (gate.drop) throw new TypeError('Controlled loss of actual snapshot HTTP response');
      }
      return response;
    },
    socket: url => {
      const ws = new WebSocket(url), send = ws.send.bind(ws);
      ws.send = ((raw: string) => { frames.push({ direction: 'out', message: JSON.parse(String(raw)) }); send(raw); }) as typeof ws.send;
      ws.on('message', raw => frames.push({ direction: 'in', message: JSON.parse(String(raw)) }));
      return ws as any;
    },
  });
  t.after(async () => {
    client.close(); allGates.forEach(g => g.release.resolve());
    await app.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  function hold(drop = false) {
    const gate: Gate = { drop, arrived: deferred(), release: deferred() };
    gates.push(gate); allGates.push(gate); return gate;
  }
  // Event-driven prerequisites: no sleep/polling or private state installation.
  async function stateWhen(predicate: () => boolean) {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const stop = client.subscribe('state', () => { if (predicate()) { cleanup(); resolve(); } });
      const abort = () => { cleanup(); reject(t.signal.reason); };
      function cleanup() { stop(); t.signal.removeEventListener('abort', abort); }
      t.signal.addEventListener('abort', abort, { once: true });
      if (t.signal.aborted) abort();
    });
  }
  const ids = () => client.getState().snapshots.map(s => s.id);
  const snapshotState = () => ({ ids: ids(), error: client.getState().snapshotsError });
  const actual = async () => {
    const response = await fetch(baseUrl + '/api/snapshots', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); return await response.json() as Wire.Snapshot[];
  };
  await client.connect();
  assert.equal(await client.createDurableProject(directory, 'Late snapshots'), true, client.getState().projectError ?? undefined);
  const started = await client.sprintAction('start', { topics: ['http'], level: 1, budgetMinutes: 60 });
  assert.equal(currentAttempt(started.sprint!).taskId, 'get-item');
  await stateWhen(() => !client.getState().isOffline && client.getState().writeOwner === 'STUDENT');
  await client.refreshSnapshots();
  assert.deepEqual(ids(), []);
  assert.ok(frames.some(f => f.direction === 'out' && f.message.type === 'HELLO'));
  return { app, client, directory, requests, frames, hold, stateWhen, ids, snapshotState, actual, started };
}

for (const dropOld of [false, true]) {
  test(`REAL sprintAction(harder): delayed A snapshot ${dropOld ? 'error' : 'success'} cannot publish into B`, { timeout: 15000 }, async t => {
    const f = await fixture(t), a = currentAttempt(f.started.sprint!);
    const durableId = f.client.getState().durableProject!.id;
    const pathA = f.app.workspace.rootPath, projectA = f.app.workspace.projectId;
    assert.equal(a.sessionId, f.app.session.state.sessionId);
    assert.equal(f.client.getState().durableProject!.exercisePath, pathA);
    // Public workspace snapshot API writes real durable fixture material. No cache injection.
    const snapshotA = await f.app.workspace.createSnapshotAsync('Attempt A recovery copy');
    await f.client.refreshSnapshots();
    assert.deepEqual(f.ids(), [snapshotA.snapshotId]);
    assert.equal(snapshotA.projectId, projectA);
    const bad = f.hold(true), badRead = f.client.refreshSnapshots();
    await bad.arrived.promise; assert.equal(bad.request!.status, 200);
    bad.release.resolve(); await badRead;
    const errorA = f.client.getState().snapshotsError;
    assert.match(errorA!, /Controlled loss/);
    assert.deepEqual(f.ids(), [snapshotA.snapshotId], 'real A cache retained with real read error');

    const old = f.hold(dropOld), oldRead = f.client.refreshSnapshots();
    await old.arrived.promise;
    assert.equal(old.request!.status, 200);
    assert.deepEqual(old.request!.value.map((s: Wire.Snapshot) => [s.snapshotId, s.projectId]), [[snapshotA.snapshotId, projectA]]);
    const fresh = f.hold(), leaked: unknown[] = [];
    const stopLeaks = f.client.subscribe('state', state => {
      if (state.durableProject?.exercisePath && state.durableProject.exercisePath !== pathA &&
        (state.snapshots.some((s: { id: string }) => s.id === snapshotA.snapshotId) || state.snapshotsError === errorA)) {
        leaked.push({ path: state.durableProject.exercisePath, ...f.snapshotState() });
      }
    });
    t.after(stopLeaks);
    const moved = await f.client.sprintAction('harder'); // the actual changed boundary, not openProject
    await fresh.arrived.promise;
    await f.stateWhen(() => !f.client.getState().isOffline && f.client.getState().writeOwner === 'STUDENT');
    const b = currentAttempt(moved.sprint!), pathB = f.app.workspace.rootPath, projectB = f.app.workspace.projectId;
    assert.equal(b.taskId, 'create-item');
    assert.equal(moved.sprint!.sprintId, f.started.sprint!.sprintId, 'same sprint');
    assert.notEqual(b.attemptId, a.attemptId); assert.notEqual(b.sessionId, a.sessionId);
    assert.equal(b.sessionId, f.app.session.state.sessionId);
    assert.equal(moved.sprint!.attempts.length, 2);
    assert.equal(moved.sprint!.attempts[0].outcome, 'DECLARED_SKIP');
    assert.notEqual(pathB, pathA); assert.notEqual(projectB, projectA);
    assert.equal(f.client.getState().durableProject!.id, durableId, 'same durable project, different exercise workspace');
    assert.equal(f.client.getState().durableProject!.exercisePath, pathB);
    assert.equal(f.client.getState().durableProject!.sprint!.activeAttemptId, b.attemptId);
    assert.ok(f.frames.some(f => f.direction === 'in' && f.message.type === 'SESSION_SNAPSHOT' &&
      f.message.sessionId === b.sessionId && f.message.payload.project.projectId === projectB), 'actual B HELLO snapshot');
    assert.equal(fresh.request!.status, 200); assert.deepEqual(fresh.request!.value, [], 'actual B GET is held before installation');
    assert.deepEqual(f.snapshotState(), { ids: [], error: null }, 'A cache AND error cleared before B GET resolves');
    const before = f.snapshotState();
    let stalePublishes = 0;
    const stop = f.client.subscribe('state', () => { stalePublishes++; });
    old.release.resolve(); await oldRead; stop();
    assert.equal(stalePublishes, 0, 'old A success/error must not publish, even unchanged empty data');
    assert.deepEqual(f.snapshotState(), before, 'old A cannot refill B cache or replace its error');
    assert.deepEqual(leaked, [], 'no B publication exposes A recovery copies or A error');
    stopLeaks(); // Later B errors belong to B; identical wording is not an A leak.

    // Avoid waiting for a value change: a current empty success must still publish.
    const currentPublished = new Promise<void>(resolve => {
      const unsubscribe = f.client.subscribe('state', () => { unsubscribe(); resolve(); });
    });
    fresh.release.resolve(); await currentPublished;
    assert.deepEqual(f.snapshotState(), { ids: [], error: null });
    assert.deepEqual(await f.actual(), []);
    // Positive control: B's own current error and durable copy still work after rejecting A.
    const badB = f.hold(true), badBRead = f.client.refreshSnapshots();
    await badB.arrived.promise; badB.release.resolve(); await badBRead;
    assert.match(f.client.getState().snapshotsError!, /Controlled loss/);
    const snapshotB = await f.app.workspace.createSnapshotAsync('Attempt B recovery copy');
    assert.equal(snapshotB.projectId, projectB);
    await f.client.refreshSnapshots();
    assert.deepEqual(f.snapshotState(), { ids: [snapshotB.snapshotId], error: null });
    assert.deepEqual((await f.actual()).map(s => s.snapshotId), [snapshotB.snapshotId]);
    assert.deepEqual(leaked, []);
    const posts = f.requests.filter(r => r.method === 'POST');
    assert.deepEqual(posts.map(r => r.route), ['/api/durable-project/create', '/api/durable-project/sprint', '/api/durable-project/sprint']);
    assert.deepEqual(posts.slice(1).map(r => r.body.action), ['start', 'harder'], 'no repeated mutations or Run/finish workaround');
    assert.equal(posts[2].body.projectId, durableId);
    assert.equal(posts[2].body.sessionId, a.sessionId);
    assert.equal(posts[2].body.expectedSprintId, moved.sprint!.sprintId);
    assert.equal(posts[2].body.expectedAttemptId, a.attemptId);
    assert.equal(posts[2].status, 200);
    assert.equal(fs.existsSync(path.join(pathA, 'challenge.md')), true, 'old attempt files retained');
    t.diagnostic(JSON.stringify({ variant: dropOld ? 'delayed-error' : 'delayed-success', durableId,
      sprintId: moved.sprint!.sprintId, a: { ...a, projectId: projectA, snapshotId: snapshotA.snapshotId },
      b: { ...b, projectId: projectB, snapshotId: snapshotB.snapshotId }, stalePublishes, leaks: leaked.length,
      snapshotGets: f.requests.filter(r => r.route === '/api/snapshots').length, posts: posts.map(r => r.body.action ?? 'create') }));
  });
}
