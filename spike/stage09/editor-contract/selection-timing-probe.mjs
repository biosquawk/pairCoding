/** Read-only diagnostic of actual LiveBackend scheduling, with injected transport (NOT real HTTP/WS). */
import assert from 'node:assert/strict';
import { LiveBackend } from '../../../src/services/LiveBackend.ts';
const project = { projectId: 'p1', sessionId: 's1', rootPath: '/synthetic-selection-probe', workspaceVersion: 1,
  settings: { taskFilePath: null, taskMode: 'IMPLEMENTATION', reviewNotesPath: 'review.md', runProfiles: [], aiConsent: false, contextPatterns: [] },
  capabilities: { canRunMain: false, canRunTests: false, docs: 'NOT_INSTALLED', autocomplete: 'NOT_INSTALLED' },
  files: ['challenge.md', 'solution.py'].map(path => ({ path, kind: 'FILE', version: 1 })) };
const doc = path => ({ path, version: 1, content: path === 'challenge.md' ? '# Task\n' : '', contentHash: 'fixture-hash',
  languageId: path.endsWith('.py') ? 'python' : 'markdown', eol: 'LF', utf8Bom: false, readOnly: false });
const session = { sessionId: 's1', projectId: 'p1', lifecycle: 'READY', workspaceVersion: 1, controlEpoch: 0,
  writeOwner: 'STUDENT', coachMode: 'UNAVAILABLE', cooldownAfterVeto: false, presence: 'FOCUSED', aiStatus: 'OFF',
  timer: { status: 'STOPPED', elapsedMs: 0, limitMs: null, pauseOnHidden: true, manualPaused: false, serverTime: '2026-11-11T00:00:00Z' },
  activeFilePath: 'challenge.md', interventionId: null, lastServerSeq: 0 };
const sent = [];
const socket = { readyState: 1, send: raw => sent.push(JSON.parse(raw)), close() {}, onopen: null, onmessage: null, onerror: null, onclose: null };
const client = new LiveBackend({ token: 'synthetic-token', clientId: 'timing-probe', socket: () => socket,
  fetch: async input => {
    const url = new URL(String(input));
    return Response.json(url.pathname === '/api/project' ? project : url.pathname === '/api/session' ? session
      : url.pathname === '/api/snapshots' ? [] : doc(url.searchParams.get('path')));
  } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let seq = 0;
const receive = (type, payload) => client.receive({ protocolVersion: '3.0', messageId: `msg-${++seq}`, seq, sessionId: 's1', type, payload });
try {
  await client.connect();
  receive('SESSION_SNAPSHOT', { project, session, activeDocument: doc('challenge.md'), proposals: [], lastRun: null, report: null, chat: [] });
  await pause(0);
  assert.equal(client.getState().isOffline, false);
  const started = performance.now();
  await client.selectFile('solution.py');
  assert.equal(client.getState().activePath, 'solution.py');
  console.log(JSON.stringify({ phase: 'immediately-after-await-selectFile', elapsedMs: performance.now() - started,
    activePath: client.getState().activePath, views: sent.filter(m => m.type === 'VIEW_CHANGED') }));
  assert.equal(sent.filter(m => m.type === 'VIEW_CHANGED').length, 0, 'current120ms throttle has not fired');
  // Existing production throttle120ms, not a raised product timeout. This diagnostic does not edit frozen tests.
  await pause(160);
  const view = sent.find(m => m.type === 'VIEW_CHANGED' && m.payload.path === 'solution.py');
  assert.ok(view); assert.equal(view.payload.documentVersion, 1);
  receive('ACK', { replyTo: view.messageId, status: 'OK', documentVersion: 1, workspaceVersion: 1, controlEpoch: 0, error: null });
  assert.equal(client.getState().activePath, 'solution.py');
  assert.equal(client.getState().connectionError, null);
  console.log(JSON.stringify({ phase: 'after-production-throttle-without-Monaco-observer', elapsedMs: performance.now() - started,
    activePath: client.getState().activePath, view: view.payload, syntheticAckReceived: true }));
  console.log('PASS timing diagnosis only; no real HTTP/WS/FS/Monaco integration claimed');
} finally { client.close(); }
