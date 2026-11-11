import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBackend } from '../../src/services/LiveBackend';
import { PairCoachClient } from '../../src/services/PairCoachClient';
import { EditorViewThrottleP2, observeMonacoViewP2, type EditorViewObservationP2 } from '../../src/services/editorViewP2';
import type * as Wire from '../../src/shared/protocol';

const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const doc = (content = 'A😀B\nsecond', version = 7, path = 'solution.ts'): Wire.Document => ({ path, version, content, contentHash: 'fixture-hash', languageId: 'typescript', eol: 'LF', utf8Bom: false, readOnly: false });
const bundle = (): Wire.SessionBundle => ({
  project: { projectId: 'project', sessionId: 'session', rootPath: '/unit-editor-view', workspaceVersion: 1,
    settings: { taskMode: 'IMPLEMENTATION', taskFilePath: null, reviewNotesPath: 'review.md', aiConsent: false, contextPatterns: ['**/*.ts'], runProfiles: [] },
    capabilities: { canRunMain: false, canRunTests: false, docs: 'NOT_INSTALLED', autocomplete: 'NOT_INSTALLED' },
    files: [{ path: 'solution.ts', kind: 'FILE', version: 7 }, { path: 'other.ts', kind: 'FILE', version: 7 }] },
  session: { sessionId: 'session', projectId: 'project', lifecycle: 'READY', workspaceVersion: 1, controlEpoch: 0, writeOwner: 'STUDENT', coachMode: 'UNAVAILABLE', cooldownAfterVeto: false, presence: 'FOCUSED', aiStatus: 'OFF', timer: { status: 'STOPPED', elapsedMs: 0, limitMs: null, pauseOnHidden: true, manualPaused: false, serverTime: '2026-11-11T00:00:00Z' }, activeFilePath: 'solution.ts', interventionId: null, lastServerSeq: 0 },
  activeDocument: doc(), proposals: [], lastRun: null, chat: [], report: null,
});
class TestSocket {
  readyState: 0 | 1 | 2 | 3 = 1;
  sent: any[] = [];
  onopen: any = null; onmessage: any = null; onerror: any = null; onclose: any = null;
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.onclose?.({}); }
}
async function fixture() {
  const b = bundle(), sockets: TestSocket[] = [], stored = new Map<string, string>();
  const client = new PairCoachClient({ token: 'unit-view-token', clientId: 'unit-tab', socket: () => { const socket = new TestSocket(); sockets.push(socket); return socket; },
    storage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); }, removeItem: key => { stored.delete(key); } },
    fetch: (async input => {
      const url = new URL(String(input));
      return Response.json(url.pathname === '/api/project' ? b.project : url.pathname === '/api/session' ? b.session
        : url.pathname === '/api/snapshots' ? [] : doc(undefined, undefined, url.searchParams.get('path')!));
    }) as typeof fetch });
  await client.connect();
  const live = (client as unknown as { live: LiveBackend }).live;
  let seq = 0;
  const receive = (type: string, payload: any) => live.receive({ protocolVersion: '3.0', messageId: `server-${++seq}`, seq, sessionId: b.session.sessionId, type, payload } as any);
  async function snapshot() { receive('SESSION_SNAPSHOT', b); await pause(); }
  await snapshot(); assert.equal(client.getState().isOffline, false);
  const sent = (type: string) => sockets.flatMap(ws => ws.sent).filter(message => message.type === type);
  const ack = (message: any, version = message.payload.documentVersion, status = 'OK') => receive('ACK', { replyTo: message.messageId, status, documentVersion: version, workspaceVersion: version ?? 1, controlEpoch: 0, error: status === 'REJECTED' ? { code: 'INVALID_VIEW', message: 'fixture rejection', currentVersion: null } : null });
  const observe = (column = 2, content = doc().content, overrides: Partial<EditorViewObservationP2> = {}) => client.updateEditorView({ projectId: 'project', path: 'solution.ts', content,
    cursor: { line: 1, column }, selection: { startLine: 1, startColumn: 2, endLine: 1, endColumn: column }, ...overrides });
  return { client, live, b, sockets, sent, ack, observe, receive, snapshot, stored };
}

test('bounded trailing-latest throttle does not debounce continuous motion and cancels on dispose', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  f.observe(2); await pause(45); f.observe(3); await pause(45); f.observe(4); await pause(50);
  assert.equal(f.sent('VIEW_CHANGED').length, 1);
  const first = f.sent('VIEW_CHANGED')[0];
  assert.deepEqual(first.payload, { path: 'solution.ts', documentVersion: 7, cursor: { line: 1, column: 4 }, selection: { startLine: 1, startColumn: 2, endLine: 1, endColumn: 4 } });
  assert.equal('content' in first.payload, false); assert.equal('projectId' in first.payload, false);
  f.observe(5); await pause(140); assert.equal(f.sent('VIEW_CHANGED').length, 1, 'bounded to one unacknowledged view');
  f.ack(first); await pause(140); assert.equal(f.sent('VIEW_CHANGED').length, 2); assert.equal(f.sent('VIEW_CHANGED')[1].payload.cursor.column, 5);
  f.ack(f.sent('VIEW_CHANGED')[1]); f.observe(6); f.client.close(); await pause(140);
  assert.equal(f.sent('VIEW_CHANGED').length, 2); assert.equal(f.sent('CHAT_MESSAGE').length, 0);
  assert.equal(f.sent('CODE_CHANGED').length, 0); assert.equal(f.client.getState().controlEpoch, 0);
});

test('draft coordinates wait for latest content ACK; never use Monaco version or older flight version', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  f.client.saveFileContent('solution.ts', 'one'); f.observe(3, 'one'); await pause(175);
  assert.equal(f.sent('CODE_CHANGED').length, 1); assert.equal(f.sent('VIEW_CHANGED').length, 0);
  f.client.saveFileContent('solution.ts', 'two'); f.observe(4, 'two'); f.ack(f.sent('CODE_CHANGED')[0], 41); await pause(175);
  assert.equal(f.sent('VIEW_CHANGED').length, 0, 'old content ACK must not label new coordinates');
  assert.equal(f.sent('CODE_CHANGED')[1].payload.baseVersion, 41); f.ack(f.sent('CODE_CHANGED')[1], 93); await pause(140);
  assert.equal(f.sent('VIEW_CHANGED').length, 1); assert.equal(f.sent('VIEW_CHANGED')[0].payload.documentVersion, 93);
  assert.equal(f.sent('VIEW_CHANGED')[0].payload.cursor.column, 4);
});

test('CHAT flushes save then matching view ACK then question, immediate latest not old throttle; duplicate submits blocked', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  f.client.saveFileContent('solution.ts', 'new draft'); f.observe(4, 'new draft');
  const question = f.client.sendChatMessage('explain selection');
  assert.equal(await f.client.sendChatMessage('duplicate'), false);
  assert.equal(f.sent('CODE_CHANGED').length, 1); assert.equal(f.sent('CHAT_MESSAGE').length, 0); assert.equal(f.sent('VIEW_CHANGED').length, 0);
  f.ack(f.sent('CODE_CHANGED')[0], 11); await pause(30);
  assert.equal(f.sent('VIEW_CHANGED').length, 1, 'chat bypassed 120ms throttle'); assert.equal(f.sent('CHAT_MESSAGE').length, 0);
  f.observe(5, 'new draft'); f.ack(f.sent('VIEW_CHANGED')[0]); await pause();
  assert.equal(f.sent('VIEW_CHANGED').length, 2, 'motion during await must flush latest'); assert.equal(f.sent('CHAT_MESSAGE').length, 0);
  f.ack(f.sent('VIEW_CHANGED')[1]); assert.equal(await question, true);
  const relevant = f.sockets[0].sent.filter(m => ['CODE_CHANGED', 'VIEW_CHANGED', 'CHAT_MESSAGE'].includes(m.type));
  assert.deepEqual(relevant.map(m => m.type), ['CODE_CHANGED', 'VIEW_CHANGED', 'VIEW_CHANGED', 'CHAT_MESSAGE']);
  assert.equal(relevant.at(-1).payload.documentVersion, 11); assert.deepEqual(relevant.at(-1).payload.selection, relevant.at(-2).payload.selection);
  assert.equal(f.client.getState().chatEntries.filter(m => m.sender === 'STUDENT').length, 1);
});

test('content mismatch, offline, conflict and rejected/wrong-version view ACK visibly prevent false-context chat', async t => {
  for (const kind of ['mismatch', 'offline', 'conflict', 'rejected', 'wrong-version'] as const) {
    const f = await fixture(); t.after(() => f.client.close());
    f.observe(4, kind === 'mismatch' ? 'unacknowledged Monaco content' : doc().content);
    if (kind === 'offline') f.sockets[0].close();
    if (kind === 'conflict') {
      f.client.saveFileContent('solution.ts', 'protected draft');
      f.receive('EXTERNAL_FILE_SYNC', { path: 'solution.ts', operation: 'UPDATED', document: doc('external', 8), version: 8, workspaceVersion: 2 });
    }
    const question = f.client.sendChatMessage('must not send'); await pause();
    if (kind === 'rejected' || kind === 'wrong-version') {
      assert.equal(f.sent('VIEW_CHANGED').length, 1); f.ack(f.sent('VIEW_CHANGED')[0], kind === 'wrong-version' ? 8 : 7, kind === 'rejected' ? 'REJECTED' : 'OK');
    }
    assert.equal(await question, false, kind); assert.equal(f.sent('CHAT_MESSAGE').length, 0, kind);
    assert.ok(f.client.getState().connectionError, kind); assert.equal(f.client.getState().chatEntries.length, 0, kind);
    if (kind === 'conflict') assert.ok([...f.stored.values()].some(value => value.includes('protected draft')));
    f.client.close();
  }
});

test('identity checked after autosave await across project, session, generation, tab and close', async t => {
  for (const kind of ['project', 'session', 'generation', 'tab', 'close'] as const) {
    const f = await fixture(); t.after(() => f.client.close());
    f.client.saveFileContent('solution.ts', 'draft'); f.observe(2, 'draft');
    const question = f.client.sendChatMessage('old identity');
    const save = f.sent('CODE_CHANGED')[0];
    if (kind === 'project') { f.b.project.projectId = 'other-project'; f.b.session.projectId = 'other-project'; await f.snapshot(); }
    else if (kind === 'session') {
      f.sockets[0].close(); f.b.session.sessionId = 'new-session'; f.b.project.sessionId = 'new-session'; await f.client.connect(); await f.snapshot();
    } else if (kind === 'generation') await f.snapshot();
    else if (kind === 'tab') await f.client.selectFile('other.ts');
    else f.client.close();
    // Snapshot can mark a draft conflicting. It is never permission to send the old question.
    if (kind === 'tab' || kind === 'close') f.ack(save, 8);
    assert.equal(await question, false, kind); assert.equal(f.sent('CHAT_MESSAGE').length, 0, kind);
    f.client.close();
  }
});

test('identity checked after view ACK; unmount clears remote view and old coordinates never survive external update', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  f.observe(4); const scope = f.client.getEditorViewScope();
  const question = f.client.sendChatMessage('old tab'); await pause(); const old = f.sent('VIEW_CHANGED')[0];
  await f.client.selectFile('other.ts'); f.ack(old); assert.equal(await question, false); assert.equal(f.sent('CHAT_MESSAGE').length, 0);
  f.client.clearEditorView(scope); assert.equal(f.sent('VIEW_CHANGED').length, 1, 'old cleanup cannot clear new scope');
  const scope2 = f.client.getEditorViewScope(); f.client.clearEditorView(scope2);
  assert.deepEqual(f.sent('VIEW_CHANGED').at(-1).payload, { path: null, documentVersion: null, cursor: null, selection: null });
  await f.client.selectFile('solution.ts'); f.observe(4); await pause(140); f.ack(f.sent('VIEW_CHANGED').at(-1));
  f.receive('EXTERNAL_FILE_SYNC', { path: 'solution.ts', operation: 'UPDATED', document: doc('fresh', 9), version: 9, workspaceVersion: 3 });
  const freshQuestion = f.client.sendChatMessage('fresh context'); await pause();
  const fresh = f.sent('VIEW_CHANGED').at(-1);
  assert.equal(fresh.payload.documentVersion, 9); assert.equal(fresh.payload.selection, null); assert.equal(fresh.payload.cursor, null);
  f.ack(fresh); assert.equal(await freshQuestion, true);
});

test('no-path chat explicitly clears view; project/path mismatch observation is ignored', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  f.observe(4, doc().content, { projectId: 'alien' }); f.observe(4, doc().content, { path: 'other.ts' }); await pause(140);
  assert.equal(f.sent('VIEW_CHANGED').length, 0);
  f.b.project.files = []; f.b.activeDocument = null; f.b.session.activeFilePath = null; await f.snapshot();
  assert.equal(await f.client.sendChatMessage('general question'), true);
  const messages = f.sockets[0].sent.slice(-2);
  assert.deepEqual(messages.map(m => m.type), ['VIEW_CHANGED', 'CHAT_MESSAGE']); assert.equal(messages[0].payload.path, null); assert.equal(messages[1].payload.documentVersion, null);
});

test('Monaco structural adapter reads actual position/normalized selection/content; stale/disposed/model callbacks do nothing', () => {
  const callbacks: (() => void)[] = []; let disposals = 0, valid = true;
  let model = { uri: { scheme: 'paircoach', authority: 'project', path: '/solution.ts' }, getValue: () => 'A😀B', isDisposed: () => false };
  const views: EditorViewObservationP2[] = [];
  const register = (cb: () => void) => { callbacks.push(cb); return { dispose() { disposals++; } }; };
  const editor = { getModel: () => model, getPosition: () => ({ lineNumber: 1, column: 4 }),
    getSelection: () => ({ startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 4 }),
    onDidChangeCursorPosition: register, onDidChangeCursorSelection: register, onDidChangeModelContent: register };
  const dispose = observeMonacoViewP2(editor, 'project', 'solution.ts', () => valid, view => views.push(view));
  assert.equal(views.length, 1); assert.equal(views[0].cursor?.column, 4); assert.equal(views[0].content, 'A😀B'); assert.deepEqual(views[0].selection, { startLine: 1, startColumn: 2, endLine: 1, endColumn: 4 });
  callbacks[0](); assert.equal(views.length, 2);
  valid = false; callbacks[1](); assert.equal(views.length, 2); valid = true;
  model = { ...model }; callbacks[2](); assert.equal(views.length, 2);
  dispose(); callbacks.forEach(cb => cb()); assert.equal(views.length, 2); assert.equal(disposals, 3);
});

test('throttle cancel disposes pending callback without mutation', async () => {
  let sends = 0; const throttle = new EditorViewThrottleP2(() => sends++, 10);
  throttle.schedule(); throttle.schedule(); throttle.cancel(); await pause(20); assert.equal(sends, 0);
});

test('missing view ACK times out visibly and never submits a question', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.observe(4); const question = f.client.sendChatMessage('do not send without ACK');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.sent('VIEW_CHANGED').length, 1);
  t.mock.timers.tick(5000);
  assert.equal(await question, false); assert.equal(f.sent('CHAT_MESSAGE').length, 0);
  assert.match(f.client.getState().connectionError!, /Nie potwierdzono|Brak ACK/);
});

test('reconnect discards pending old-scope observation until a fresh Monaco sample', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  const oldScope = f.client.getEditorViewScope(); f.observe(4); f.sockets[0].close();
  await f.client.connect(); await f.snapshot();
  assert.notEqual(f.client.getEditorViewScope(), oldScope);
  await pause(140); assert.equal(f.sent('VIEW_CHANGED').length, 0);
  f.observe(3); await pause(140); assert.equal(f.sent('VIEW_CHANGED').length, 1);
  assert.equal(f.sent('VIEW_CHANGED')[0].payload.cursor.column, 3);
});
