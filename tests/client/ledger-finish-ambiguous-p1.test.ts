/** Transport edge regressions; mock HTTP/WS are unit evidence, not real integration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBackend } from '../../src/services/LiveBackend';
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

// Frozen client regression. Deliberate HTTP/WS doubles isolate the catch and readonly reconciliation;
// public real-listener projection is separately covered by ledger-public-failures-p1.test.ts.
test('P1 ledger503 finish retains UNKNOWN/original ID; repeated clicks and reconnect cannot POST; durable evidence settles',async t=>{
  for(const code of ['COMMAND_RESULT_UNAVAILABLE','COMMAND_STORAGE_UNAVAILABLE']) {
    const f=await fixture(async()=>new Response(JSON.stringify({code,message:'Operacja mogła zostać wykonana. Zsynchronizuj stan; nie ponawiaj z nowym ID.',retryable:false}),{status:503}));
    t.after(()=>f.client.close());await f.client.finishSession('COMPLETED');await turn();
    const notice=f.client.getState().connectionError!;
    assert.match(notice,/Wynik zakończenia jest nieznany/);assert.match(notice,new RegExp(code));
    assert.match(notice,/nie ponawiaj z nowym ID/);assert(notice.includes(f.posts()[0].body.requestId));
    assert.equal(f.requests.filter(r=>r.path==='/api/session/report').length,1,'UNKNOWN initiates readonly reconciliation');
    for(let i=0;i<3;i++)await f.client.finishSession(i%2?'COMPLETED':'ABANDONED');
    f.sockets.at(-1).close();await f.connect();await turn();
    assert.equal(f.posts().length,1,'UNKNOWN cannot be released by503 or reconnect');
    assert.match(f.client.getState().connectionError!,/nieznany/);
    f.bundle.session.lifecycle='FINISHED';f.report(readyReport());await turn();await turn();
    assert.equal(f.client.getState().connectionError,null);assert.equal(f.client.getState().report?.status,'READY');
    await f.client.finishSession('COMPLETED');assert.equal(f.posts().length,1);
    t.diagnostic(JSON.stringify({code,notice,posts:f.posts(),readonlyGets:f.requests.filter(r=>r.path==='/api/session/report').length}));
  }
});

test('P1 ambiguous classification is status+code, never message text; ordinary rejection still releases attempt',async t=>{
  for(const [status,code] of [[409,'COMMAND_RESULT_UNAVAILABLE'],[503,'GENERIC_UNAVAILABLE']] as const) {
    const f=await fixture(async()=>new Response(JSON.stringify({code,message:'COMMAND_STORAGE_UNAVAILABLE: wynik nieznany'}),{status}));
    t.after(()=>f.client.close());await f.client.finishSession('COMPLETED');
    assert.equal(f.requests.filter(r=>r.path==='/api/session/report').length,0);
    await f.client.finishSession('COMPLETED');assert.equal(f.posts().length,2);
    assert.notEqual(f.posts()[0].body.requestId,f.posts()[1].body.requestId);
  }
});
