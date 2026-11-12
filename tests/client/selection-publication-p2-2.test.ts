// Focused transport/lifecycle controls. Synthetic socket/HTTP, not browser/AI proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { createPairCoachServer } from '../../src/server/http';
import { LiveBackend } from '../../src/services/LiveBackend';
import type * as Wire from '../../src/shared/protocol';

const document = (path = 'a.ts', version = 7, content = 'A😀B'): Wire.Document => ({
  path, version, content, contentHash: 'fixture', languageId: 'typescript', eol: 'LF', utf8Bom: false, readOnly: false,
});
function bundle(): Wire.SessionBundle {
  return {
    project: { projectId: 'project', sessionId: 'session', rootPath: '/unit-publication', workspaceVersion: 1,
      settings: { taskMode: 'IMPLEMENTATION', taskFilePath: null, reviewNotesPath: 'review.md', aiConsent: false, contextPatterns: ['**/*.ts'], runProfiles: [] },
      capabilities: { canRunMain: false, canRunTests: false, docs: 'NOT_INSTALLED', autocomplete: 'NOT_INSTALLED' },
      files: ['a.ts', 'b.ts'].map(path => ({ path, kind: 'FILE', version: 7 })) },
    session: { sessionId: 'session', projectId: 'project', lifecycle: 'READY', workspaceVersion: 1, controlEpoch: 0,
      writeOwner: 'STUDENT', coachMode: 'UNAVAILABLE', cooldownAfterVeto: false, presence: 'FOCUSED', aiStatus: 'OFF',
      timer: { status: 'STOPPED', elapsedMs: 0, limitMs: null, pauseOnHidden: true, manualPaused: false, serverTime: '2026-11-11T00:00:00Z' },
      activeFilePath: 'a.ts', interventionId: null, lastServerSeq: 0 },
    activeDocument: document(), proposals: [], lastRun: null, chat: [], report: null,
  };
}
async function fixture(t: any) {
  const b = bundle(), sent: any[] = [], reads: string[] = [];
  const socket = () => ({ readyState: 1 as 0 | 1 | 2 | 3, onopen: null, onmessage: null, onclose: null, onerror: null,
    send(raw: string) { sent.push(JSON.parse(raw)); }, close() { this.readyState = 3; } });
  const live = new LiveBackend({ token: 'unit', clientId: 'unit', socket,
    fetch: (async input => {
      const url = new URL(String(input));
      if (url.pathname === '/api/file') reads.push(url.searchParams.get('path')!);
      return Response.json(url.pathname === '/api/project' ? b.project : url.pathname === '/api/session' ? b.session
        : url.pathname === '/api/snapshots' ? [] : document(url.searchParams.get('path')!));
    }) as typeof fetch });
  t.after(() => live.close());
  let seq = 0;
  const receive = (type: string, payload: any) => live.receive({ protocolVersion: '3.0', messageId: `s-${++seq}`,
    seq, sessionId: b.session.sessionId, type, payload } as any);
  const snapshot = async () => { receive('SESSION_SNAPSHOT', b); await setImmediate(); assert.equal(live.getState().isOffline, false); };
  await live.connect(); await snapshot();
  const views = () => sent.filter(m => m.type === 'VIEW_CHANGED');
  const ack = (message: any, version = message.payload.documentVersion) => receive('ACK', { replyTo: message.messageId,
    status: 'OK', documentVersion: version, workspaceVersion: 1, controlEpoch: 0, error: null });
  const observe = (path = 'a.ts', column = 4, content = 'A😀B') => live.updateEditorView({ projectId: b.project.projectId, path, content,
    cursor: { line: 1, column }, selection: { startLine: 1, startColumn: 2, endLine: 1, endColumn: column } });
  return { live, b, sent, reads, views, ack, observe, receive, snapshot };
}

test('await selection publishes fresh path-only, cancels old coordinates; real motion keeps 120ms throttle and singleflight', async t => {
  const f = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  f.observe();
  await f.live.selectFile('b.ts');
  assert.deepEqual(f.views().map(m => m.payload), [{ path: 'b.ts', documentVersion: 7, cursor: null, selection: null }]);
  f.ack(f.views()[0]); f.observe('b.ts');
  t.mock.timers.tick(119); assert.equal(f.views().length, 1);
  t.mock.timers.tick(1); assert.equal(f.views().length, 2);
  assert.equal(f.views()[1].payload.cursor.column, 4);
  assert.deepEqual(f.views()[1].payload.selection, { startLine: 1, startColumn: 2, endLine: 1, endColumn: 4 });
  f.observe('b.ts', 3); t.mock.timers.tick(120); assert.equal(f.views().length, 2);
  f.ack(f.views()[1]); t.mock.timers.tick(120); assert.equal(f.views().length, 3);
  assert.equal(f.views()[2].payload.cursor.column, 3);
  assert.equal(f.sent.some(m => ['CHAT_MESSAGE', 'CODE_CHANGED'].includes(m.type)), false);
});

test('same-session snapshot settles selected path before synchronized state publication, never stale coordinates', async t => {
  const f = await fixture(t);
  await f.live.selectFile('b.ts'); f.ack(f.views().at(-1));
  f.observe('b.ts');
  let atSettlement: any[] = [];
  f.live.subscribe('state', state => { if (!state.isOffline) atSettlement = [...f.views()]; });
  await f.snapshot();
  assert.equal(f.live.getState().activePath, 'b.ts');
  assert.equal(atSettlement.length, 2);
  assert.deepEqual(atSettlement.at(-1).payload, { path: 'b.ts', documentVersion: 7, cursor: null, selection: null });
  assert.equal(f.sent.some(m => ['CHAT_MESSAGE', 'CODE_CHANGED'].includes(m.type)), false);
});

test('pending draft/conflict block selection publication; external version replaces old coordinates, never labels old content', async t => {
  const f = await fixture(t);
  f.live.saveFileContent('a.ts', 'draft');
  await f.live.selectFile('a.ts'); assert.equal(f.views().length, 0);
  f.receive('EXTERNAL_FILE_SYNC', { path: 'a.ts', operation: 'UPDATED', document: document('a.ts', 8, 'external'), version: 8, workspaceVersion: 2 });
  await f.live.selectFile('a.ts'); assert.equal(f.views().length, 0);
  assert.equal(f.live.getState().fileConflict?.localDraftContent, 'draft');
  // Independent document can still be selected without leaking the conflicted draft.
  await f.live.selectFile('b.ts');
  assert.deepEqual(f.views().at(-1).payload, { path: 'b.ts', documentVersion: 7, cursor: null, selection: null });
  f.ack(f.views().at(-1));
  f.observe('b.ts');
  f.receive('EXTERNAL_FILE_SYNC', { path: 'b.ts', operation: 'UPDATED', document: document('b.ts', 9, 'new bytes'), version: 9, workspaceVersion: 3 });
  await f.live.selectFile('b.ts');
  assert.deepEqual(f.views().at(-1).payload, { path: 'b.ts', documentVersion: 9, cursor: null, selection: null });
  assert.equal(f.sent.some(m => m.type === 'CHAT_MESSAGE'), false);
});

test('old-scope unACK flight uses bounded queue, old ACK never acknowledges new view or old chat', async t => {
  const f = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  f.observe();
  const oldQuestion = f.live.sendChatMessage('old tab');
  await Promise.resolve(); await Promise.resolve();
  const oldView = f.views()[0]; assert.ok(oldView);
  await f.live.selectFile('b.ts');
  assert.equal(await oldQuestion, false);
  assert.equal(f.views().length, 1, 'no second immediate frame when selection entered with an old flight');
  f.ack(oldView);
  assert.equal(f.views().length, 1, 'old ACK is not reentrant new-scope publication');
  t.mock.timers.tick(0); assert.equal(f.views().length, 2, 'queued path-only publishes next tick, not cursor throttle');
  const newView = f.views()[1];
  assert.deepEqual(newView.payload, { path: 'b.ts', documentVersion: 7, cursor: null, selection: null });
  const question = f.live.sendChatMessage('new tab');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.sent.some(m => m.type === 'CHAT_MESSAGE'), false);
  f.ack(oldView); await Promise.resolve();
  assert.equal(f.sent.some(m => m.type === 'CHAT_MESSAGE'), false, 'late duplicate old ACK cannot authorize new chat');
  f.ack(newView); assert.equal(await question, true);
  assert.equal(f.sent.filter(m => m.type === 'CHAT_MESSAGE').length, 1);
  assert.equal(f.sent.at(-1).payload.path, 'b.ts');
});

test('reconnect settles latest selection over old server document; old flight ACK cannot authorize fresh scope', async t => {
  const f = await fixture(t);
  f.observe();
  const oldQuestion = f.live.sendChatMessage('before selection');
  await Promise.resolve(); await Promise.resolve();
  const oldView = f.views()[0];
  await f.live.selectFile('b.ts'); assert.equal(await oldQuestion, false);
  assert.equal(f.views().length, 1);
  // Authoritative snapshot still describes old server a.ts; latest local intent is b.ts.
  f.live.reconnect(); await f.live.connect(); await f.snapshot();
  assert.equal(f.live.getState().activePath, 'b.ts');
  const settled = f.views().at(-1);
  assert.notEqual(settled.messageId, oldView.messageId);
  assert.deepEqual(settled.payload, { path: 'b.ts', documentVersion: 7, cursor: null, selection: null });
  const question = f.live.sendChatMessage('after reconnect');
  await Promise.resolve(); await Promise.resolve();
  f.ack(oldView); await Promise.resolve();
  assert.equal(f.sent.some(m => m.type === 'CHAT_MESSAGE'), false);
  f.ack(settled); assert.equal(await question, true);
  assert.equal(f.sent.at(-1).payload.path, 'b.ts');
  // Cache generation contains settled selection, not an unrelated old server-view document.
  assert.equal(f.live.getState().files.find(file => file.path === 'a.ts')?.loaded, false);
  await f.live.selectFile('a.ts'); assert.deepEqual(f.reads, ['b.ts', 'b.ts', 'a.ts']);
  assert.equal(f.live.getState().activePath, 'a.ts');
  assert.deepEqual(f.views().at(-1).payload, { path: 'a.ts', documentVersion: 7, cursor: null, selection: null });
  console.log('reconnect trace', JSON.stringify(f.sent.map(m => ({ type: m.type, messageId: m.messageId, path: m.payload.path, version: m.payload.documentVersion }))));
});

test('queued path-only tick rechecks latest observation and pending write; no stale coordinates or content', async t => {
  for (const mode of ['motion', 'draft'] as const) {
    const f = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
    f.observe(); t.mock.timers.tick(120); const old = f.views()[0];
    await f.live.selectFile('b.ts'); f.ack(old);
    if (mode === 'motion') f.observe('b.ts', 3);
    else f.live.saveFileContent('b.ts', 'unacknowledged');
    t.mock.timers.tick(0); assert.equal(f.views().length, 1, mode);
    t.mock.timers.tick(120);
    if (mode === 'motion') {
      assert.equal(f.views().length, 2);
      assert.equal(f.views()[1].payload.path, 'b.ts'); assert.equal(f.views()[1].payload.cursor.column, 3);
    } else assert.equal(f.views().length, 1, 'draft blocks old-content publication');
    assert.equal(f.sent.some(m => m.type === 'CHAT_MESSAGE'), false);
    f.live.close(); t.mock.timers.reset();
  }
});

test('REAL selection/reconnect ordering: old server path never supplants settled selection or caches its document', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-publication-'));
  const root = path.join(dir, 'root'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'challenge.md'), '# Task\n');
  const app = createPairCoachServer({ rootPath: root, dataDir: path.join(dir, 'data'), port: 0, devBootstrap: true, enableCoach: false });
  const port = await app.listen(), trace: any[] = [], sent: any[] = [], received: any[] = [];
  const client = new LiveBackend({ baseUrl: `http://127.0.0.1:${port}`, clientId: 'publication-real',
    socket: url => {
      const ws = new WebSocket(url);
      const relay: any = { get readyState() { return ws.readyState; }, send(raw: string) {
        const m = JSON.parse(raw); sent.push(m); trace.push({ direction: 'send', type: m.type, id: m.messageId, path: m.payload.path, cursor: m.payload.cursor }); ws.send(raw);
      }, close() { ws.close(); } };
      ws.on('open', () => relay.onopen?.({})); ws.on('close', () => relay.onclose?.({})); ws.on('error', e => relay.onerror?.(e));
      ws.on('message', raw => {
        const m = JSON.parse(String(raw)); received.push(m);
        trace.push({ direction: 'receive', type: m.type, seq: m.seq, active: m.payload.session?.activeFilePath ?? m.payload.activeFilePath,
          replyTo: m.payload.replyTo, status: m.payload.status }); relay.onmessage?.({ data: String(raw) });
      });
      return relay;
    }, fetch: (async (url, options) => {
      if (new URL(String(url)).pathname === '/api/file' && options?.method === 'GET') trace.push({ direction: 'read', path: new URL(String(url)).searchParams.get('path') });
      return fetch(url, options);
    }) as typeof fetch });
  t.after(async () => { client.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition()) { assert.ok(Date.now() < deadline, 'real transport settlement'); await new Promise(r => setTimeout(r, 5)); }
  };
  await client.connect(); await until(() => !client.getState().isOffline);
  await client.mutateFile('CREATE', 'slow.py', null, 'value = 1\n');
  await until(() => !client.getState().isOffline);
  await client.selectFile('slow.py');
  await client.selectFile('challenge.md');
  const snapshots = received.filter(m => m.type === 'SESSION_SNAPSHOT').length;
  client.reconnect();
  await until(() => received.filter(m => m.type === 'SESSION_SNAPSHOT').length > snapshots && !client.getState().isOffline);
  assert.equal(client.getState().activePath, 'challenge.md');
  const afterReconnect = sent.filter(m => m.type === 'VIEW_CHANGED').at(-1);
  assert.equal(afterReconnect.payload.path, 'challenge.md');
  assert.equal(afterReconnect.payload.cursor, null); assert.equal(afterReconnect.payload.selection, null);
  assert.equal(client.getState().files.find(f => f.path === 'slow.py')?.loaded, false);
  await client.selectFile('slow.py');
  assert.equal(client.getState().activePath, 'slow.py');
  await until(() => received.some(m => m.type === 'ACK' && m.payload.replyTo === sent.filter(m => m.type === 'VIEW_CHANGED').at(-1)?.messageId));
  assert.equal(fs.readFileSync(path.join(root, 'slow.py'), 'utf8'), 'value = 1\n');
  assert.equal(fs.readFileSync(path.join(root, 'challenge.md'), 'utf8'), '# Task\n');
  assert.equal(client.getState().connectionError, null);
  console.log('REAL publication trace', JSON.stringify(trace));
});
