/** Transport edge regressions; mock HTTP/WS are unit evidence, not real integration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { LiveBackend } from '../../src/services/LiveBackend';
import { createPairCoachServer } from '../../src/server/http';
import type * as Wire from '../../src/shared/protocol';
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const initial = (): Wire.SessionBundle => ({
  project: { projectId: 'project', sessionId: 'session', rootPath: 'unit', workspaceVersion: 1, files: [],
    capabilities: { canRunMain: false, canRunTests: false, docs: 'NOT_INSTALLED', autocomplete: 'NOT_INSTALLED' },
    settings: { taskMode: 'IMPLEMENTATION', taskFilePath: null, reviewNotesPath: 'review.md', aiConsent: false, runProfiles: [], contextPatterns: [] } },
  session: { sessionId: 'session', projectId: 'project', lifecycle: 'READY', workspaceVersion: 1, controlEpoch: 1,
    writeOwner: 'STUDENT', coachMode: 'UNAVAILABLE', cooldownAfterVeto: false, presence: 'FOCUSED', aiStatus: 'OFF',
    timer: { status: 'STOPPED', elapsedMs: 0, limitMs: null, pauseOnHidden: true, manualPaused: false, serverTime: new Date().toISOString() },
    activeFilePath: null, interventionId: null, lastServerSeq: 0 },
  activeDocument: null, proposals: [], lastRun: null, report: null, chat: [],
});
const readyReport = (): Wire.Report => ({ reportId: 'report', sessionId: 'session', status: 'READY', reason: 'COMPLETED',
  sourceWorkspaceVersion: 1, snapshotId: 'final', generatedAt: new Date().toISOString(), markdown: 'frozen', evidenceIds: [], error: null });
async function fixture(post: () => Promise<Response>) {
  const bundle = initial(), requests: { method: string; path: string; body: any }[] = [], sockets: any[] = [];
  let durable: Wire.Report | null = null, seq = 0;
  const client = new LiveBackend({ token: 'unit-token', clientId: 'tab',
    socket: () => { const s: any = { readyState: 1, send() {}, close() { s.readyState = 3; s.onclose?.({}); } }; sockets.push(s); return s; },
    fetch: (async (url, options) => {
      const u = new URL(String(url)), method = options?.method ?? 'GET';
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer unit-token');
      requests.push({ method, path: u.pathname, body: options?.body ? JSON.parse(String(options.body)) : null });
      if (u.pathname === '/api/session/finish') return post();
      if (u.pathname === '/api/session/report') return new Response(JSON.stringify(durable ?? { code: 'REPORT_NOT_FOUND' }), { status: durable ? 200 : 404 });
      return new Response(JSON.stringify(u.pathname === '/api/project' ? bundle.project : u.pathname === '/api/session' ? bundle.session : []));
    }) as typeof fetch,
  });
  const receive = (type: string, payload: any) => sockets.at(-1).onmessage?.({ data: JSON.stringify({
    protocolVersion: '3.0', messageId: 'frame-' + (++seq), sessionId: bundle.session.sessionId, seq, type, payload,
  }) });
  async function connect() { await client.connect(); sockets.at(-1).onopen?.({}); receive('SESSION_SNAPSHOT', structuredClone(bundle)); await turn(); }
  await connect();
  return { client, bundle, requests, receive, connect, sockets, posts: () => requests.filter(r => r.method === 'POST'),
    report: (value: Wire.Report) => { durable = value; receive('SESSION_REPORT', value); } };
}

test('fetch rejection and unreadable successful body retain original UNKNOWN; only matching durable state settles and FINISHED blocks new POST', async t => {
  for (const post of [async () => { throw new TypeError('fetch failed'); }, async () => new Response('{truncated', { status: 202 })]) {
    const f = await fixture(post); t.after(() => f.client.close());
    await f.client.finishSession('COMPLETED');
    const body = f.posts()[0].body;
    assert.match(f.client.getState().connectionError!, /Wynik zakończenia jest nieznany/);
    assert.ok(f.client.getState().connectionError!.includes(body.requestId));
    await f.client.finishSession('ABANDONED'); assert.equal(f.posts().length, 1);
    f.bundle.session.lifecycle = 'FINISHED'; f.report(readyReport()); await turn(); await turn();
    assert.equal(f.client.getState().connectionError, null);
    assert.equal(f.client.getState().report?.status, 'READY');
    await f.client.finishSession('COMPLETED'); assert.equal(f.posts().length, 1, 'settled FINISHED is not fresh permission');
  }
});

test('explicit 409/400/401 rejection, including unreadable rejection body, is not retained UNKNOWN', async t => {
  for (const response of [() => new Response(JSON.stringify({ code: 'VERSION_CONFLICT', message: 'stale' }), { status: 409 }),
    () => new Response(JSON.stringify({ code: 'VALIDATION_ERROR', message: 'invalid' }), { status: 400 }),
    () => new Response('unreadable body', { status: 401 })]) {
    const f = await fixture(async () => response()); t.after(() => f.client.close());
    await f.client.finishSession('COMPLETED');
    assert.doesNotMatch(f.client.getState().connectionError!, /nieznany/);
    assert.match(f.client.getState().connectionError!, /VERSION_CONFLICT|VALIDATION_ERROR|401/);
    assert.equal(f.requests.filter(r => r.path === '/api/session/report').length, 0);
    await f.client.finishSession('COMPLETED'); assert.equal(f.posts().length, 2, 'a rejected attempt is released for an explicit corrected command');
    assert.notEqual(f.posts()[0].body.requestId, f.posts()[1].body.requestId);
  }
});

test('network UNKNOWN never clears independent error or foreign-session history; no replay after reconnect', async t => {
  const post = async () => { throw new TypeError('socket lost'); };
  const f = await fixture(post); t.after(() => f.client.close()); await f.client.finishSession('COMPLETED');
  f.receive('ERROR', { code: 'INDEPENDENT', message: 'keep this error' });
  f.bundle.session.lifecycle = 'FINISHED'; f.report(readyReport()); await turn(); await turn();
  assert.match(f.client.getState().connectionError!, /INDEPENDENT/); assert.equal(f.posts().length, 1);
  const g = await fixture(post); t.after(() => g.client.close()); await g.client.finishSession('COMPLETED');
  g.report({ ...readyReport(), sessionId: 'foreign' }); await turn();
  assert.equal(g.client.getState().report, null); assert.match(g.client.getState().connectionError!, /nieznany/);
  g.sockets.at(-1).close(); g.bundle.session.sessionId = g.bundle.project.sessionId = 'replacement'; await g.connect();
  assert.match(g.client.getState().connectionError!, /SESSION_REPLACED/);
  await g.client.finishSession('COMPLETED'); assert.equal(g.posts().length, 1);
});

test('REAL socket loss after capture admission: valid task file, asynchronous authenticated reconciliation, one POST/snapshot', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finish-socket-edge-')), root = path.join(base, 'project'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'challenge.md'), '# Real fixture task\n');
  fs.writeFileSync(path.join(root, 'main.py'), 'PRESERVED\n');
  const token = 'ephemeral-unit-integration', app = createPairCoachServer({ rootPath: root, dataDir: path.join(root, '.paircoach'),
    token, port: 0, enableCoach: false, enableExecution: true });
  const port = await app.listen(), posts: any[] = [], requests: string[] = [];
  let response: any, cut = false, client: LiveBackend | undefined;
  app.server.on('request', (req, res) => { if (req.method === 'POST' && req.url === '/api/session/finish') response = res; });
  app.workspace.on('snapshotCheckpoint', e => {
    if (e.phase === 'SNAPSHOT_FILE_CAPTURED' && !cut) { cut = true; assert.ok(response); response.destroy(); }
  });
  t.after(async () => { client?.close(); await app.close(); fs.rmSync(base, { recursive: true, force: true }); });
  client = new LiveBackend({ baseUrl: `http://127.0.0.1:${port}`, token, clientId: 'real-tab',
    fetch: async (url, options) => {
      const pathname = new URL(String(url)).pathname; requests.push(pathname);
      if (options?.method === 'POST') posts.push(JSON.parse(String(options.body)));
      assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${token}`);
      return fetch(url, options);
    },
    socket: url => {
      const ws = new WebSocket(url), proxy: any = { get readyState() { return ws.readyState; }, send: (raw: string) => ws.send(raw), close: () => ws.close() };
      ws.addEventListener('open', e => proxy.onopen?.(e)); ws.addEventListener('message', e => proxy.onmessage?.(e));
      ws.addEventListener('error', e => proxy.onerror?.(e)); ws.addEventListener('close', e => proxy.onclose?.(e)); return proxy;
    },
  });
  async function until(read: () => boolean, label: string) {
    const end = Date.now() + 10000; while (!read()) { assert.ok(Date.now() < end, label); await delay(10); }
  }
  await client.connect(); await until(() => !client!.getState().isOffline, 'sync');
  await client.finishSession('COMPLETED'); assert.ok(cut);
  assert.match(client.getState().connectionError!, /Wynik zakończenia jest nieznany/);
  assert.ok(client.getState().connectionError!.includes(posts[0].requestId));
  await client.finishSession('ABANDONED'); assert.equal(posts.length, 1);
  // READY alone is not proof that the asynchronous GET/report/session checks finished.
  await until(() => client!.getState().report?.status === 'READY' && client!.getState().connectionError === null, 'read-only reconciliation settled');
  assert.equal(app.session.state.lifecycle, 'FINISHED'); assert.equal(app.workspace.listSnapshots().length, 1);
  await client.finishSession('COMPLETED'); assert.equal(posts.length, 1);
  assert.ok(requests.includes('/api/session/report')); assert.equal(fs.readFileSync(path.join(root, 'main.py'), 'utf8'), 'PRESERVED\n');
  t.diagnostic(JSON.stringify({ cut, posts: posts.length, snapshots: app.workspace.listSnapshots().length,
    lifecycle: app.session.state.lifecycle, report: client.getState().report?.status, connectionError: client.getState().connectionError }));
});
