import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LiveBackend, applyWireEdit } from '../../src/services/LiveBackend';
import { PairCoachClient } from '../../src/services/PairCoachClient';
import { mapProposal, mapRun, mapReport } from '../../src/services/liveMapper';
import type * as Wire from '../../src/shared/protocol';

const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const document = (content = 'hello', version = 1): Wire.Document => ({ path: 'solution.ts', version, content, contentHash: createHash('sha256').update(content).digest('hex'), languageId: 'typescript', eol: 'LF', utf8Bom: false, readOnly: false });
const settings: Wire.Settings = { taskMode: 'IMPLEMENTATION', taskFilePath: 'challenge.md', reviewNotesPath: 'review.md', aiConsent: false, contextPatterns: ['**/*.ts'], runProfiles: [] };
const bundle = (): Wire.SessionBundle => ({
  project: { projectId: 'project-1', sessionId: 'session-1', rootPath: 'fixture-root', workspaceVersion: 1, settings: structuredClone(settings), capabilities: { canRunMain: false, canRunTests: false, docs: 'NOT_INSTALLED', autocomplete: 'NOT_INSTALLED' }, files: [{ path: 'solution.ts', kind: 'FILE', version: 1 }, { path: 'challenge.md', kind: 'FILE', version: 1 }] },
  session: { sessionId: 'session-1', projectId: 'project-1', lifecycle: 'READY', workspaceVersion: 1, controlEpoch: 1, writeOwner: 'STUDENT', coachMode: 'UNAVAILABLE', cooldownAfterVeto: false, presence: 'FOCUSED', aiStatus: 'OFF', timer: { status: 'STOPPED', elapsedMs: 0, limitMs: null, pauseOnHidden: true, manualPaused: false, serverTime: new Date().toISOString() }, activeFilePath: 'solution.ts', interventionId: null, lastServerSeq: 0 },
  activeDocument: document(), proposals: [], lastRun: null, report: null, chat: [{ messageId: 'chat-1', author: 'SYSTEM', text: 'Real shape', createdAt: '2026-11-10T12:00:00Z' }]
});
class TestSocket {
  readyState: 0 | 1 | 2 | 3 = 1;
  sent: any[] = [];
  onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.onclose?.({}); }
}
async function fixture(options: { storage?: any } = {}) {
  const b = bundle(), ws = new TestSocket(), requests: any[] = [], stored = new Map<string, string>();
  let remote = document();
  const storage = options.storage ?? { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); }, removeItem: (k: string) => { stored.delete(k); } };
  const client = new LiveBackend({ token: 'test-only-unit-token', clientId: 'unit-tab', baseUrl: 'http://127.0.0.1:54321', storage, socket: () => ws,
    fetch: (async (url: string, init: any) => {
      requests.push({ url, ...init });
      const path = new URL(url).pathname;
      const value = path === '/api/project' ? b.project : path === '/api/session' ? b.session : path === '/api/snapshots' ? [] : path === '/api/file' ? new URL(url).searchParams.get('path') === 'challenge.md' ? { ...document('# Task'), path: 'challenge.md', languageId: 'markdown' } : remote : null;
      return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch
  });
  await client.connect(); ws.onopen?.({});
  let seq = 0;
  const receive = (type: string, payload: any) => client.receive({ protocolVersion: '3.0', sessionId: 'session-1', messageId: `server-${++seq}`, seq, type, payload } as any);
  receive('SESSION_SNAPSHOT', b); await pause(10);
  assert.equal(client.getState().isOffline, false);
  const changes = () => ws.sent.filter(m => m.type === 'CODE_CHANGED');
  const ack = (m: any, version: number, overrides = {}) => receive('ACK', { replyTo: m.messageId, status: 'OK', documentVersion: version, workspaceVersion: version, controlEpoch: 1, error: null, ...overrides });
  return { client, ws, requests, stored, receive, changes, ack, b, setRemote: (d: Wire.Document) => { remote = d; }, nextSeq: () => ++seq };
}

test('LIVE default is not a simulator fallback; empty state has no mock files', () => {
  const client = new PairCoachClient();
  assert.equal(client.transportMode, 'LIVE_BACKEND'); assert.deepEqual(client.getState().files, []); assert.equal(client.getState().writeOwner, 'SYNCING'); client.close();
  const mock = new PairCoachClient({ mode: 'MOCK_SIMULATOR' }); assert.ok(mock.getState().files.length); mock.close();
});
test('REST auth, HELLO auth and mapper/task cache follow wire contract', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  assert.ok(f.requests.every(r => r.headers.Authorization === 'Bearer test-only-unit-token'));
  assert.equal(f.ws.sent[0].type, 'HELLO'); assert.equal(f.ws.sent[0].payload.token, 'test-only-unit-token');
  assert.ok(f.client.getState().files.find(x => x.path === 'challenge.md')?.content.includes('Task'));
  assert.equal(f.client.getState().chatEntries[0].message, 'Real shape');
  assert.equal(f.client.getState().projectSettings.aiConsent, false);
});
test('TEST004 throttle sends within 150ms during continuous typing; one flight until ACK then current base', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  f.client.saveFileContent('solution.ts', 'a'); await pause(60);
  f.client.saveFileContent('solution.ts', 'ab'); await pause(60);
  f.client.saveFileContent('solution.ts', 'abc'); await pause(65);
  assert.equal(f.changes().length, 1); assert.equal(f.changes()[0].payload.content, 'abc');
  f.client.saveFileContent('solution.ts', 'abcd'); await pause(180); assert.equal(f.changes().length, 1);
  f.ack(f.changes()[0], 2); await pause(170);
  assert.equal(f.changes().length, 2); assert.equal(f.changes()[1].payload.baseVersion, 2); assert.equal(f.changes()[1].payload.content, 'abcd');
  f.ack(f.changes()[1], 3); assert.deepEqual(f.client.getState().pendingPaths, []); assert.equal(f.stored.size, 0);
});
test('CONTROL_READY waits for all flushed ACKs and blocks new local mutation', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  f.client.saveFileContent('solution.ts', 'draft');
  f.receive('CONTROL_PREPARE', { requestId: 'prepare-1', purpose: 'demo', path: 'solution.ts', basedOnWorkspaceVersion: 1 });
  assert.equal(f.changes().length, 1); assert.equal(f.ws.sent.filter(m => m.type === 'CONTROL_READY').length, 0);
  assert.equal(f.client.getState().writeOwner, 'SYNCING');
  f.ack(f.changes()[0], 2);
  const ready = f.ws.sent.filter(m => m.type === 'CONTROL_READY'); assert.equal(ready.length, 1); assert.equal(ready[0].payload.workspaceVersion, 2); assert.equal(ready[0].payload.ready, true);
});
test('TEST005 external sync and a delayed older ACK preserve both versions', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  f.client.saveFileContent('solution.ts', 'mine'); await pause(170);
  f.setRemote(document('disk external', 3));
  f.receive('EXTERNAL_FILE_SYNC', { operation: 'UPDATED', path: 'solution.ts', version: 3, workspaceVersion: 3, document: document('disk external', 3) });
  f.ack(f.changes()[0], 2);
  assert.equal(f.client.getState().fileConflict?.localDraftContent, 'mine'); assert.equal(f.client.getState().fileConflict?.diskContent, 'disk external');
  assert.equal(f.client.getState().files.find(x => x.path === 'solution.ts')?.content, 'mine'); assert.ok(f.stored.size);
  await f.client.resolveConflict('LOAD_DISK'); assert.equal(f.client.getState().files.find(x => x.path === 'solution.ts')?.content, 'disk external'); assert.equal(f.client.getState().fileConflict, null);
  assert.ok([...f.stored.keys()].some(k => k.includes(':conflict:')), 'explicit resolution retains recovery copy');
});
test('TEST010/011 veto stops old steps synchronously, permits protected local draft before ACK', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  f.receive('CONTROL_STATE', { writeOwner: 'COACH', controlEpoch: 2, coachMode: 'INTERVENING', cooldownAfterVeto: false, interventionId: 'old-intervention', purpose: 'demo' });
  let rendered = 0; f.client.subscribe('step', () => rendered++);
  f.client.triggerVeto(); assert.equal(f.client.getState().writeOwner, 'STUDENT');
  f.client.saveFileContent('solution.ts', 'student protected');
  const late = { stepId: 'old-step', interventionId: 'old-intervention', controlEpoch: 2, path: 'solution.ts', baseVersion: 1, version: 2, workspaceVersion: 2, range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 }, textBlock: 'coach', contentHash: document('coach').contentHash };
  f.setRemote(document('coach', 2)); f.receive('COACH_STEP_EDIT', late); await pause(10);
  assert.equal(rendered, 0); assert.equal(f.client.getState().files.find(x => x.path === 'solution.ts')?.content, 'student protected');
  assert.equal(f.client.getState().fileConflict?.diskContent, 'coach');
  const veto = f.ws.sent.find(m => m.type === 'VETO_ESCAPE'); f.ack(veto, 2, { controlEpoch: 3, documentVersion: null });
  assert.equal(f.client.getState().controlEpoch, 3); assert.equal(f.changes().length, 0, 'conflict must not autosave over disk');
});
test('STEP_RENDERED only after renderer callback; coach content never echoes CODE_CHANGED', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  f.receive('CONTROL_STATE', { writeOwner: 'COACH', controlEpoch: 2, coachMode: 'INTERVENING', cooldownAfterVeto: false, interventionId: 'intervention', purpose: 'demo' });
  let step: any; f.client.subscribe('step', payload => { step = payload; });
  f.receive('COACH_STEP_EDIT', { stepId: 'step', interventionId: 'intervention', controlEpoch: 2, path: 'solution.ts', baseVersion: 1, version: 2, workspaceVersion: 2, range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 }, textBlock: 'coach', contentHash: document('coach').contentHash });
  await pause(15); assert.ok(step); assert.equal(f.ws.sent.filter(m => m.type === 'STEP_RENDERED').length, 0);
  f.client.stepRendered(step, 'coach');
  assert.equal(f.ws.sent.filter(m => m.type === 'STEP_RENDERED').length, 1); assert.equal(f.changes().length, 0); assert.equal(f.client.getState().files.find(x => x.path === 'solution.ts')?.version, 2);
});
test('seq gap halts steps, disconnects and retains draft; duplicate seq does not apply', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  f.receive('CHAT_REPLY', { replyTo: null, text: 'first' });
  f.client.receive({ protocolVersion: '3.0', sessionId: 'session-1', messageId: 'duplicate', seq: 2, type: 'CHAT_REPLY', payload: { replyTo: null, text: 'must not apply twice' } });
  assert.equal(f.client.getState().chatEntries.length, 2);
  f.client.saveFileContent('solution.ts', 'offline draft');
  f.client.receive({ protocolVersion: '3.0', sessionId: 'session-1', messageId: 'gap', seq: 99, type: 'CHAT_REPLY', payload: { replyTo: null, text: 'should not show' } });
  assert.equal(f.client.getState().writeOwner, 'SYNCING'); assert.equal(f.client.getState().isOffline, true); assert.equal(f.ws.readyState, 3);
  assert.equal(f.client.getState().chatEntries.length, 2); assert.ok([...f.stored.values()].some(v => v.includes('offline draft')));
});
test('storage failure is visible and does not discard the in-memory draft', async t => {
  const f = await fixture({ storage: { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} } }); t.after(() => f.client.close());
  f.client.saveFileContent('solution.ts', 'recover me'); assert.match(f.client.getState().storageError!, /localStorage/); assert.equal(f.client.getState().files.find(x => x.path === 'solution.ts')?.content, 'recover me');
});
test('wire mappers preserve NO_TESTS/UNKNOWN and report failure/proposal identifiers', () => {
  const r: Wire.Run = { runId: 'run', mode: 'RUN_TESTS', status: 'SUCCEEDED', exitCode: 0, workspaceVersionAtStart: 1, workspaceChangedDuringRun: true, testOutcome: 'UNKNOWN', testCount: null, outputTail: 'ok', outputTruncated: false, startedAt: null, finishedAt: null };
  assert.equal(mapRun(r, null).testOutcome, 'UNKNOWN'); assert.equal(mapRun({ ...r, testOutcome: 'NO_TESTS', testCount: 0 }, null).testOutcome, 'NO_TESTS');
  assert.match(mapReport({ status: 'FAILED', error: { code: 'FAIL', message: 'failure' } } as any).error!, /FAIL/);
  assert.equal(mapProposal({ proposalId: 'p', kind: 'RESTORE_SNAPSHOT', expiresAt: '2026-11-10T12:00:00Z' } as any).id, 'p');
});
test('UTF16 wire ranges match Monaco; invalid range is rejected instead of clamping', () => {
  assert.equal(applyWireEdit('A😀B\nsecond', { startLine: 1, startColumn: 2, endLine: 1, endColumn: 4 }, 'x'), 'AxB\nsecond');
  assert.throws(() => applyWireEdit('a', { startLine: 2, startColumn: 1, endLine: 2, endColumn: 1 }, 'x'));
});

test('REGRESSION: disconnect during COACH preserves local typing as offline draft, never a red saved state', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  f.receive('CONTROL_STATE', { writeOwner: 'COACH', controlEpoch: 2, coachMode: 'INTERVENING', cooldownAfterVeto: false, interventionId: 'coach-offline', purpose: 'demo' });
  f.ws.close();
  assert.equal(f.client.getState().writeOwner, 'SYNCING');
  f.client.saveFileContent('solution.ts', 'offline human text');
  assert.equal(f.client.getState().files.find(file => file.path === 'solution.ts')?.content, 'offline human text');
  assert.ok([...f.stored.values()].some(value => value.includes('offline human text')));
  assert.equal(f.changes().length, 0);
});

test('reconnect snapshot retains a draft whose disk file was deleted instead of looping on GET404', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  f.client.saveFileContent('solution.ts', 'recover deleted'); f.ws.close();
  f.b.project.files = f.b.project.files.filter(file => file.path !== 'solution.ts');
  f.b.activeDocument = { ...document('# Task'), path: 'challenge.md', languageId: 'markdown' };
  f.b.session.activeFilePath = 'challenge.md';
  f.receive('SESSION_SNAPSHOT', f.b); await pause(15);
  assert.equal(f.client.getState().isOffline, false);
  assert.equal(f.client.getState().fileConflict?.diskDeleted, true);
  await f.client.selectFile('solution.ts');
  assert.equal(f.client.getState().files.find(file => file.path === 'solution.ts')?.content, 'recover deleted');
  assert.equal(f.client.getState().activePath, 'solution.ts');
  f.client.saveFileContent('solution.ts', 'recover deleted plus more typing');
  assert.equal(f.client.getState().files.find(file => file.path === 'solution.ts')?.content, 'recover deleted plus more typing');
  assert.equal(f.client.getState().fileConflict?.localDraftContent, 'recover deleted plus more typing');
  assert.ok([...f.stored.values()].some(value => value.includes('recover deleted plus more typing')));
  assert.equal(f.changes().length, 0, 'deleted draft waits for explicit conflict decision');
});
