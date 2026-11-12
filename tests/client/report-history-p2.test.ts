import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveBackend } from '../../src/services/LiveBackend';
import { PairCoachClient } from '../../src/services/PairCoachClient';
import { ReportContent, ReportHistory } from '../../src/components/ReportHistory';
import type * as Wire from '../../src/shared/protocol';

const report = (sessionId = 'older/session?α'): Wire.Report => ({
  reportId: 'report-A', sessionId, status: 'READY', reason: 'COMPLETED', sourceWorkspaceVersion: 2,
  snapshotId: 'snapshot-A', generatedAt: '2026-11-11T12:00:00Z', markdown: '# Report A', error: null, evidenceIds: [],
});
const settings: Wire.Settings = { taskMode: 'IMPLEMENTATION', taskFilePath: null, reviewNotesPath: 'review.md', aiConsent: false, contextPatterns: [], runProfiles: [] };
const project = (id = 'project-B'): Wire.Project => ({ projectId: id, sessionId: 'session-B', rootPath: '/unit-fixture', workspaceVersion: 1, settings,
  capabilities: { canRunMain: false, canRunTests: false, docs: 'NOT_INSTALLED', autocomplete: 'NOT_INSTALLED' }, files: [] });
const session = (id = 'session-B'): Wire.Session => ({ sessionId: id, projectId: 'project-B', lifecycle: 'READY', workspaceVersion: 1, controlEpoch: 0,
  writeOwner: 'STUDENT', coachMode: 'UNAVAILABLE', cooldownAfterVeto: false, presence: 'FOCUSED', aiStatus: 'OFF',
  timer: { status: 'STOPPED', elapsedMs: 0, limitMs: null, pauseOnHidden: true, manualPaused: false, serverTime: '2026-11-11T12:00:00Z' }, activeFilePath: null, interventionId: null, lastServerSeq: 0 });
async function fixture() {
  const requests: { url: URL; init: RequestInit }[] = [];
  let respond: (url: URL) => Promise<Response> = async url => Response.json(url.pathname === '/api/session/reports' ? { reports: [report()] } : report(url.searchParams.get('sessionId')!));
  const socket = { readyState: 1 as const, send() {}, close() {}, onopen: null, onmessage: null, onerror: null, onclose: null };
  let remoteProject = project(), remoteSession = session();
  const client = new PairCoachClient({ token: 'unit-history-token', socket: () => socket,
    fetch: (async (input, init) => {
      const url = new URL(String(input)); requests.push({ url, init: init! });
      if (url.pathname === '/api/project') return Response.json(remoteProject);
      if (url.pathname === '/api/session') return Response.json(remoteSession);
      if (url.pathname === '/api/snapshots') return Response.json([]);
      return respond(url);
    }) as typeof fetch });
  await client.connect();
  // Use the actual public wire receiver to install project/session scope.
  const live = (client as unknown as { live: LiveBackend }).live;
  let seq = 0;
  async function snapshot(p = project(), s = session()) {
    if (s.sessionId !== remoteSession.sessionId) {
      remoteProject = p; remoteSession = s;
      await client.connect(); // real replacement-session admission precedes its envelope
    }
    live.receive({ protocolVersion: '3.0', messageId: `snapshot-${++seq}`, seq, sessionId: s.sessionId, type: 'SESSION_SNAPSHOT',
      payload: { project: p, session: s, activeDocument: null, proposals: [], lastRun: null, chat: [], report: report('session-B') } });
    await new Promise(resolve => setTimeout(resolve, 0)); // settle snapshot + async recovery list
  }
  await snapshot();
  return { client, live, requests, snapshot, setRespond: (fn: typeof respond) => { respond = fn; } };
}

test('history facade GETs authenticated encoded IDs and never publishes historical state or finish changes', async t => {
  const f = await fixture(); t.after(() => f.client.close());
  let changes = 0; const unsubscribe = f.client.onStateChanged(() => changes++); t.after(unsubscribe);
  const current = f.client.getState().report;
  const summaries = await f.client.listReports(); assert.equal(summaries[0].reportId, 'report-A');
  const historical = await f.client.readReport('older/session?α'); assert.equal(historical.markdown, '# Report A');
  assert.strictEqual(f.client.getState().report, current); assert.equal(changes, 0);
  const historyRequests = f.requests.filter(r => r.url.pathname.startsWith('/api/session/report'));
  assert.equal(historyRequests.length, 2);
  assert.ok(historyRequests.every(r => r.init.method === 'GET' && (r.init.headers as any).Authorization === 'Bearer unit-history-token'));
  assert.equal(historyRequests[1].url.searchParams.get('sessionId'), 'older/session?α');
  assert.equal(f.requests.filter(r => r.init.method === 'POST').length, 0);
});

test('late list/read replies are rejected across project switch, session switch, reconnect generation, and close', async t => {
  for (const kind of ['project', 'session', 'generation', 'close'] as const) {
    const f = await fixture(); t.after(() => f.client.close());
    const replies: ((r: Response) => void)[] = [];
    f.setRespond(() => new Promise(resolve => replies.push(resolve)));
    const list = f.client.listReports(), read = f.client.readReport('A');
    const errors = Promise.all([assert.rejects(list, /uległy zmianie/), assert.rejects(read, /uległy zmianie/)]);
    if (kind === 'project') await f.snapshot(project('other-project'));
    else if (kind === 'session') await f.snapshot(project(), session('session-C'));
    else if (kind === 'generation') await f.snapshot();
    else f.client.close();
    replies[0](Response.json({ reports: [report('A')] })); replies[1](Response.json(report('A')));
    await errors;
    assert.notEqual(f.client.getState().report?.markdown, '# stale result');
  }
});

test('history empty/auth/failure/wrong identity and unsynced states are explicit, without mutation', async t => {
  const f = await fixture(); t.after(() => f.client.close()); const current = f.client.getState().report;
  f.setRespond(async () => Response.json({ reports: [] })); assert.deepEqual(await f.client.listReports(), []);
  f.setRespond(async () => Response.json({ code: 'UNAUTHORIZED', message: 'Token wygasł' }, { status: 401 }));
  await assert.rejects(f.client.listReports(), /UNAUTHORIZED: Token wygasł/);
  f.setRespond(async () => Response.json(report('wrong-session')));
  await assert.rejects(f.client.readReport('A'), /innej sesji/);
  await assert.rejects(f.client.readReport(' '), /Wybierz sesję/);
  assert.strictEqual(f.client.getState().report, current);
  f.client.close(); await assert.rejects(f.client.listReports(), /Połącz z projektem/);
});

test('render distinguishes current/history affordance; failed history is read-only but current retains retry', () => {
  const failed = { status: 'FAILED' as const, error: 'REPORT_INTERRUPTED: restart' };
  const history = renderToStaticMarkup(React.createElement(ReportContent, { report: failed }));
  assert.match(history, /REPORT_INTERRUPTED/); assert.doesNotMatch(history, /<button/);
  const current = renderToStaticMarkup(React.createElement(ReportContent, { report: failed, onRetry() {} }));
  assert.match(current, /Ponów generowanie raportu/);
  const view = renderToStaticMarkup(React.createElement(ReportHistory, { scope: 'project-B/session-B', source: { listReports: async () => [], readReport: async () => failed }, currentReport: null, onRetryCurrent() {} }));
  assert.match(view, /label for="report-history-session"/); assert.match(view, /Poprzednie raporty/); assert.match(view, /Bieżący raport/); assert.match(view, /Odśwież listę/);
  const offline = renderToStaticMarkup(React.createElement(ReportHistory, { scope: null, source: { listReports: async () => [], readReport: async () => failed }, currentReport: null, onRetryCurrent() {} }));
  assert.match(offline, /Połącz z projektem/); assert.match(offline, /disabled/);
});
