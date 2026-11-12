/** Real loopback HTTP/WS + filesystem. Faults only hold/drop actual fetched responses. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { LiveBackend } from '../../src/services/LiveBackend';
import { createPairCoachServer } from '../../src/server/http';
import type * as Wire from '../../src/shared/protocol';

async function until(read: () => boolean, label: string) {
  const end = Date.now() + 3000;
  while (!read()) { assert.ok(Date.now() < end, label); await delay(10); }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
type Gate = { path: string; drop: boolean; arrived: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
async function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finish-cache-'));
  const root = path.join(base, 'first'), other = path.join(base, 'second');
  for (const dir of [root, other]) {
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'challenge.md'), '# Exercise\n');
    fs.writeFileSync(path.join(dir, 'main.py'), `print(${JSON.stringify(path.basename(dir))})\n`);
  }
  const token = 'fixture-' + crypto.randomUUID();
  const app = createPairCoachServer({ rootPath: root, dataDir: path.join(base, 'data'), token,
    port: 0, enableCoach: false, enableExecution: true });
  const port = await app.listen(), baseUrl = `http://127.0.0.1:${port}`;
  const gates: Gate[] = [], allGates: Gate[] = [], requests: { path: string; method: string; body: any; status?: number; value?: any; done?: boolean }[] = [];
  const frames: { direction: string; type: string; payload: any }[] = [];
  const client = new LiveBackend({ baseUrl, token, clientId: 'cache-tab',
    fetch: async (url, options) => {
      assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${token}`);
      const pathname = new URL(String(url)).pathname;
      const request: (typeof requests)[number] = { path: pathname, method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) : null };
      requests.push(request);
      const index = gates.findIndex(g => g.path === pathname), gate = index < 0 ? null : gates.splice(index, 1)[0];
      const response = await fetch(url, options);
      request.status = response.status; request.value = await response.clone().json();
      if (gate) {
        gate.arrived.resolve();
        await new Promise<void>((resolve, reject) => {
          const signal = options!.signal!;
          const abort = () => reject(new DOMException('Controlled response delay aborted', 'AbortError'));
          if (signal.aborted) { abort(); return; }
          signal.addEventListener('abort', abort, { once: true });
          gate.release.promise.then(() => { signal.removeEventListener('abort', abort); resolve(); });
        });
        if (gate.drop) throw new TypeError('Controlled loss of actual HTTP response');
      }
      request.done = true;
      return response;
    },
    socket: url => {
      const ws = new WebSocket(url), proxy: any = { get readyState() { return ws.readyState; },
        send: (raw: string) => { const m = JSON.parse(raw); frames.push({ direction: 'out', type: m.type, payload: m.payload }); ws.send(raw); }, close: () => ws.close() };
      ws.addEventListener('open', e => proxy.onopen?.(e));
      ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); frames.push({ direction: 'in', type: m.type, payload: m.payload }); proxy.onmessage?.(e); });
      ws.addEventListener('error', e => proxy.onerror?.(e)); ws.addEventListener('close', e => proxy.onclose?.(e)); return proxy;
    },
  });
  t.after(async () => { client.close(); allGates.forEach(g => g.release.resolve()); await app.close(); fs.rmSync(base, { recursive: true, force: true }); });
  function hold(pathname = '/api/snapshots', drop = false) {
    const gate: Gate = { path: pathname, drop, arrived: deferred(), release: deferred() }; gates.push(gate); allGates.push(gate); return gate;
  }
  const posts = () => requests.filter(r => r.method === 'POST');
  const lists = () => requests.filter(r => r.path === '/api/snapshots');
  const ids = () => client.getState().snapshots.map(s => s.id);
  const actual = async () => {
    const r = await fetch(baseUrl + '/api/snapshots', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200); return await r.json() as Wire.Snapshot[];
  };
  async function finished() {
    await until(() => client.getState().report?.status === 'READY' && client.getState().connectionError === null, 'READY and settled finish');
    assert.equal(app.session.state.lifecycle, 'FINISHED');
    const report = requests.find(r => r.path === '/api/session/finish')!.value as Wire.Report;
    const durable = await actual();
    assert.equal(durable.length, 1); assert.equal(durable[0].snapshotId, report.snapshotId);
    assert.equal(fs.readFileSync(path.join(root, 'main.py'), 'utf8'), 'print("first")\n');
    return durable[0].snapshotId;
  }
  async function cached() { const id = await finished(); await until(() => ids().includes(id), 'same-session durable final snapshot visible without reconnect/restart'); return id; }
  async function finish() { await client.finishSession('COMPLETED'); return cached(); }
  await client.connect();
  await until(() => !client.getState().isOffline && lists().some(r => r.done), 'real HELLO snapshot and initial empty list');
  assert.deepEqual(ids(), []);
  assert.ok(frames.some(f => f.direction === 'out' && f.type === 'HELLO'));
  return { app, client, root, other, requests, frames, hold, posts, lists, ids, actual, finished, cached, finish };
}

for (const mode of ['normal', 'loss', 'timeout'] as const) {
  test(`REAL finish ${mode}: durable list refresh in same session, original request, no extra mutation`, { timeout: 15000 }, async t => {
    const f = await fixture(t), before = f.lists().length;
    const gate = mode === 'normal' ? null : f.hold('/api/session/finish', true);
    // Retain an independent list-read error while finish starts; finish must not clear it.
    const bad = f.hold('/api/snapshots', true), badRead = f.client.refreshSnapshots();
    await bad.arrived.promise; bad.release.resolve(); await badRead;
    const listError = f.client.getState().snapshotsError; assert.match(listError!, /Controlled loss/);
    const wait = f.client.finishSession('COMPLETED');
    if (gate) {
      await gate.arrived.promise;
      if (mode === 'loss') gate.release.resolve();
    }
    const start = performance.now(); await wait;
    if (gate) {
      const notice = f.client.getState().connectionError;
      assert.match(notice!, /Wynik zakończenia jest nieznany/);
      assert.ok(notice!.includes(f.posts()[0].body.requestId));
      if (mode === 'timeout') { assert.match(notice!, /5 s/); assert.ok(performance.now() - start >= 4500); gate.release.resolve(); }
      await f.client.finishSession('ABANDONED');
    }
    const id = await f.cached();
    assert.equal(f.client.getState().snapshotsError, null, 'successful fresh list clears only list error');
    await f.client.finishSession('COMPLETED');
    assert.equal(f.posts().length, 1, 'GET refresh/reconciliation never adds a mutation or re-POSTs finish');
    assert.ok(f.lists().length > before + 1, 'finish issued another real snapshots GET');
    assert.equal(f.frames.filter(m => m.direction === 'out' && m.type === 'HELLO').length, 1, 'no reconnect workaround');
    t.diagnostic(JSON.stringify({ mode, finishRequestId: f.posts()[0].body.requestId, posts: f.posts().length,
      listGets: f.lists().length, durableId: id, cached: f.ids(), status: f.client.getState().report?.status }));
  });
}

for (const dropOld of [false, true]) {
  test(`REAL latest GET guard: stale ${dropOld ? 'error' : 'empty success'} cannot overwrite newer final list/error`, async t => {
    const f = await fixture(t);
    const old = f.hold('/api/snapshots', dropOld), oldRead = f.client.refreshSnapshots(); await old.arrived.promise;
    assert.deepEqual(f.lists().at(-1)!.value, [], 'older GET actually read pre-finish empty durable list');
    await f.client.finishSession('COMPLETED'); const durableId = (await f.actual())[0].snapshotId;
    // Wait for the automatic read, but before-baseline is allowed to have none: the
    // explicit newer GET also independently exercises latest-request protection.
    await f.client.refreshSnapshots(); assert.deepEqual(f.ids(), [durableId]);
    const newer = f.hold('/api/snapshots', true), newerRead = f.client.refreshSnapshots();
    await newer.arrived.promise; newer.release.resolve(); await newerRead;
    const error = f.client.getState().snapshotsError; assert.match(error!, /Controlled loss/);
    let stalePublishes = 0; const unsubscribe = f.client.subscribe('state', () => { stalePublishes++; });
    old.release.resolve(); await oldRead; unsubscribe();
    assert.equal(stalePublishes, 0, 'superseded response must not publish, even if its error text/list is unchanged');
    assert.deepEqual(f.ids(), [durableId]); assert.equal(f.client.getState().snapshotsError, error, 'old success/error cannot replace current error');
    await f.client.refreshSnapshots(); assert.equal(f.client.getState().snapshotsError, null);
    assert.equal(f.posts().length, 1);
  });
}

for (const dropOld of [false, true]) {
  test(`REAL generation guard: stale ${dropOld ? 'error' : 'empty success'} after same-project snapshot is ignored`, async t => {
    const f = await fixture(t), old = f.hold('/api/snapshots', dropOld), oldRead = f.client.refreshSnapshots();
    await old.arrived.promise;
    // Public service creates real durable fixture material (not a fabricated GET).
    const durable = await f.app.workspace.createSnapshotAsync('generation fixture');
    const fresh = f.hold('/api/snapshots');
    assert.equal(await f.client.updateProjectSettings({ ...f.client.getState().projectSettings, aiConsent: false }), true);
    await fresh.arrived.promise; // New generation's GET still in flight, not yet installed.
    const before = { ids: f.ids(), error: f.client.getState().snapshotsError };
    let stalePublishes = 0; const unsubscribe = f.client.subscribe('state', () => { stalePublishes++; });
    old.release.resolve(); await oldRead; unsubscribe();
    assert.equal(stalePublishes, 0, 'prior generation response must not publish even unchanged empty data');
    assert.deepEqual({ ids: f.ids(), error: f.client.getState().snapshotsError }, before);
    fresh.release.resolve(); await until(() => f.ids().includes(durable.snapshotId), 'current generation durable snapshot');
    assert.equal(f.client.getState().snapshotsError, null);
  });
}

for (const dropOld of [false, true]) {
  test(`REAL project switch: clear old copies/errors immediately; delayed ${dropOld ? 'error' : 'success'} cannot leak them`, async t => {
    const f = await fixture(t);
    const durable = await f.app.workspace.createSnapshotAsync('first-project fixture'); await f.client.refreshSnapshots(); assert.deepEqual(f.ids(), [durable.snapshotId]);
    const bad = f.hold('/api/snapshots', true), badRead = f.client.refreshSnapshots(); await bad.arrived.promise; bad.release.resolve(); await badRead;
    assert.ok(f.client.getState().snapshotsError);
    const old = f.hold('/api/snapshots', dropOld), oldRead = f.client.refreshSnapshots(); await old.arrived.promise;
    const fresh = f.hold('/api/snapshots');
    const leaked: string[] = [];
    f.client.subscribe('state', state => { if (state.scenario.title === f.other && (state.snapshots.length || state.snapshotsError)) leaked.push(JSON.stringify({ ids: state.snapshots.map((s: any) => s.id), error: state.snapshotsError })); });
    assert.equal(await f.client.openProject(f.other), true);
    await fresh.arrived.promise;
    assert.deepEqual(f.ids(), [], 'old project copies hidden before new list resolves');
    assert.equal(f.client.getState().snapshotsError, null);
    old.release.resolve(); await oldRead;
    assert.deepEqual(f.ids(), []); assert.equal(f.client.getState().snapshotsError, null);
    fresh.release.resolve(); await until(() => f.lists().at(-1)?.done === true, 'new project empty list'); await delay(10);
    assert.deepEqual(await f.actual(), []); assert.deepEqual(leaked, [], 'no published new-project state exposes old copies/errors');
  });
}

for (const dropOld of [false, true]) {
  test(`REAL close guard: delayed ${dropOld ? 'error' : 'success'} publishes nothing after disposal`, async t => {
    const f = await fixture(t), old = f.hold('/api/snapshots', dropOld), oldRead = f.client.refreshSnapshots(); await old.arrived.promise;
    f.client.close(); const before = structuredClone(f.client.getState()); let publishes = 0;
    f.client.subscribe('state', () => { publishes++; });
    old.release.resolve(); await oldRead;
    assert.deepEqual(f.client.getState(), before); assert.equal(publishes, 0);
  });
}

test('REAL current list error stays separate from file/connection failure; newer success beats delayed error', async t => {
  const f = await fixture(t);
  await f.client.selectFile('missing.py');
  const independent = f.client.getState().connectionError; assert.match(independent!, /FILE_NOT_FOUND/);
  const old = f.hold('/api/snapshots', true), oldRead = f.client.refreshSnapshots(); await old.arrived.promise;
  await f.client.refreshSnapshots();
  old.release.resolve(); await oldRead;
  assert.equal(f.client.getState().snapshotsError, null, 'stale error must not replace newer success');
  assert.equal(f.client.getState().connectionError, independent);
  const current = f.hold('/api/snapshots', true), currentRead = f.client.refreshSnapshots(); await current.arrived.promise;
  current.release.resolve(); await currentRead;
  assert.match(f.client.getState().snapshotsError!, /Controlled loss/);
  assert.equal(f.client.getState().connectionError, independent, 'current list failure does not overwrite independent error');
  await f.client.refreshSnapshots(); assert.equal(f.client.getState().snapshotsError, null);
  assert.equal(f.client.getState().connectionError, independent, 'list success does not clear independent error');
});
