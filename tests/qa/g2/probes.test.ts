/** Targeted Linux-local real REST/WS probes; NOT browser/native Windows/Gemini evidence. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer, id } from '../helpers';
import { fixture, Provider, deferred, edit, silent, seed, canaries, approved } from './fixture';

async function until(check: () => boolean, message: string) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) assert.fail(message); await delay(10); }
}
async function connected(t: TestContext, provider: Provider, consent = true) {
  const f = await fixture(provider, consent), peers = new Set<{ close(): void }>();
  const sessionId = f.app.session.getSession().sessionId, clientId = id();
  const peer = new Peer({ ...f, peers, sessionId, clientId } as any);
  t.after(async () => { peer.close(); await f.close(); });
  await peer.connect();
  async function request(method: string, target: string, body?: unknown) {
    const r = await fetch(f.baseURL + target, { method, headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: r.status, body: await r.json() };
  }
  const command = () => ({ requestId: id(), clientId, sessionId });
  assert.equal((await request('POST', '/api/session/start', { ...command(), limitMs: null, pauseOnHidden: true })).status, 200);
  const write = async (content: string) => {
    const doc = (await request('GET', '/api/file?path=main.py')).body;
    const ack = await peer.ack(peer.send('CODE_CHANGED', { path: 'main.py', content, baseVersion: doc.version,
      controlEpoch: f.app.session.getSession().controlEpoch, editKind: 'TYPING' }));
    assert.equal(ack.payload.status, 'OK'); assert.equal(f.disk(), content); return ack;
  };
  const chat = async (text: string) => {
    assert.equal((await peer.ack(peer.send('CHAT_MESSAGE', { text, path: null, documentVersion: null, selection: null }))).payload.status, 'OK');
  };
  return { ...f, peer, request, command, write, chat };
}

test('G2 probe TEST007: autonomous delayed analysis, actual autosave, stale plan denied and latest pending serialized', { timeout: 12000 }, async t => {
  const pending = deferred(); let old: any;
  const provider = new Provider(c => {
    if (c.documents.find(d => d.path === 'main.py')!.content.includes('g2_slow') && !old) { old = c; return pending.promise; }
    if (c.documents.find(d => d.path === 'main.py')!.content.includes('g2_fresh')) return edit(c);
    return silent;
  });
  const f = await connected(t, provider);
  await f.write(seed + '# g2_slow\n'); await until(() => !!old, 'autonomous edit must trigger actual provider');
  const oldCall = provider.calls.at(-1)!;
  await f.write(seed + '# g2_slow\n# independent_new_work\n');
  await delay(2100);
  assert(oldCall.signal.aborted); assert.equal(provider.inFlight, 1); assert.equal(provider.maxInFlight, 1);
  assert.equal(f.app.session.getSession().writeOwner, 'STUDENT');
  assert.equal(provider.calls.some(c => c.context.messages.length > 0), false, 'no CHAT trigger');
  pending.resolve(edit(old, '# STALE_MUST_NEVER_APPEAR\n'));
  await until(() => provider.inFlight === 0 && provider.calls.length >= 3, 'latest pending context must be analyzed after old actual call settles');
  assert.equal(f.disk(), seed + '# g2_slow\n# independent_new_work\n');
  assert.equal(provider.calls.at(-1)!.context.documents.find(d => d.path === 'main.py')!.content, f.disk());
  assert.equal(f.peer.frames.some(m => m.type === 'CONTROL_PREPARE' || m.type === 'COACH_STEP_EDIT'), false);
  // Positive control: the same real adapter/gate must accept a fresh plan, not reject all AI.
  const freshBase = f.disk() + '# g2_fresh\n'; await f.write(freshBase);
  const prepare = (await f.peer.take(m => m.type === 'CONTROL_PREPARE')).payload;
  await f.peer.ack(f.peer.send('CONTROL_READY', { requestId: prepare.requestId, workspaceVersion: prepare.basedOnWorkspaceVersion, ready: true }));
  const first = (await f.peer.take(m => m.type === 'COACH_STEP_EDIT')).payload;
  assert.equal(f.disk(), '# g2_coach_first\n' + freshBase);
  await f.peer.ack(f.peer.send('STEP_RENDERED', { stepId: first.stepId, interventionId: first.interventionId, documentVersion: first.version }));
  const second = (await f.peer.take(m => m.type === 'COACH_STEP_EDIT')).payload;
  assert.equal(f.disk(), '# g2_coach_second\n# g2_coach_first\n' + freshBase);
  await f.peer.ack(f.peer.send('STEP_RENDERED', { stepId: second.stepId, interventionId: second.interventionId, documentVersion: second.version }));
  await until(() => f.app.session.getSession().writeOwner === 'STUDENT', 'fresh plan must release control');
  f.peer.assertProtocol();
});

test('G2 probe TEST012: actual veto cooldown rejects wait/VIEW/whitespace; code+2s and chat resume analysis', { timeout: 16000 }, async t => {
  const provider = new Provider(() => silent), f = await connected(t, provider);
  await until(() => provider.inFlight === 0 && provider.calls.length === 1, 'initial START analysis');
  async function veto() {
    const state = f.app.session.getSession();
    assert.equal((await f.peer.ack(f.peer.send('VETO_ESCAPE', { controlEpoch: state.controlEpoch,
      activeInterventionId: state.interventionId, lastAppliedSeq: state.lastServerSeq }))).payload.status, 'OK');
    assert.equal(f.app.session.getSession().cooldownAfterVeto, true);
  }
  await veto(); const count = provider.calls.length;
  await f.peer.ack(f.peer.send('VIEW_CHANGED', { path: 'main.py', documentVersion: 1, cursor: { line: 2, column: 1 }, selection: null }));
  await delay(2200); assert.equal(provider.calls.length, count); assert(f.app.session.getSession().cooldownAfterVeto);
  await f.write(seed + '   \n'); await delay(2200);
  assert.equal(provider.calls.length, count); assert(f.app.session.getSession().cooldownAfterVeto);
  const ackAt = Date.now(); await f.write(seed + '   \n# new_fact\n');
  await delay(1500); assert.equal(provider.calls.length, count); assert(f.app.session.getSession().cooldownAfterVeto);
  await until(() => provider.calls.length === count + 1, 'confirmed substantive edit must resume automatically');
  assert(Date.now() - ackAt >= 2000); assert.equal(f.app.session.getSession().cooldownAfterVeto, false);
  await veto(); await f.chat('Explicit new fact');
  await until(() => provider.calls.length === count + 2, 'explicit CHAT must unlock cooldown');
  assert.equal(f.app.session.getSession().cooldownAfterVeto, false); assert.equal(f.app.session.getSession().writeOwner, 'STUDENT');
  f.peer.assertProtocol();
});

test('G2 probe TEST025/026: real consent boundary, exact token/file exclusion, Host/Origin/path attacks and positive control', { timeout: 12000 }, async t => {
  const provider = new Provider(() => silent), f = await connected(t, provider, false);
  await f.write(seed + '# manual_no_consent\n'); await f.chat('No consent'); await delay(450);
  assert.equal(provider.calls.length, 0);
  assert.equal((await f.request('PUT', '/api/project/settings', { ...f.command(), expectedWorkspaceVersion: f.app.workspace.workspaceVersion,
    settings: { ...approved, schemaVersion:2, aiConsent: true } })).status, 200);
  await f.chat(`Pasted synthetic session token ${f.token}`); await until(() => provider.calls.length === 1, 'consented provider call');
  const context = provider.calls[0].context, payload = JSON.stringify(context);
  assert(payload.includes('main.py')); assert(payload.includes('manual_no_consent'));
  assert(!payload.includes(f.token)); assert(payload.includes('[REDACTED]'));
  for (const [name, value] of Object.entries(canaries)) {
    assert(fs.existsSync(path.join(f.rootPath, name))); assert(!payload.includes(value));
    assert(!context.documents.some(d => d.path === name));
  }
  const address = f.app.server.address(); assert(address && typeof address !== 'string'); assert.equal(address.address, '127.0.0.1');
  for (const token of ['', 'invalid-token']) {
    const r = await fetch(f.baseURL + '/api/file?path=main.py', { headers: token ? { Authorization: `Bearer ${token}` } : {} }); assert.equal(r.status, 401);
  }
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }]) {
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.get(f.baseURL + '/api/project', { headers: { Authorization: `Bearer ${f.token}`, ...headers } }, res => {
        let body = ''; res.on('data', chunk => { body += chunk; }); res.once('end', () => resolve({ status: res.statusCode!, body }));
      }); req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    });
    assert.equal(result.status, 403); assert(!result.body.includes(f.token));
  }
  for (const bad of ['../outside.py', '/outside.py', 'CON', 'NUL.txt', 'main.py:stream', 'dir\\file.py']) {
    assert.equal((await f.request('GET', '/api/file?path=' + encodeURIComponent(bad))).status, 403, bad);
  }
  // Real external symlink, not a fake path validator. Windows junction is a distinct NOT_RUN surface.
  const outside = path.join(f.base, 'outside.py'); fs.writeFileSync(outside, 'G2_OUTSIDE_CANARY');
  fs.symlinkSync(outside, path.join(f.rootPath, 'escape.py'));
  assert.equal((await f.request('GET', '/api/file?path=escape.py')).status, 403);
  const good = await f.request('GET', '/api/file?path=main.py'); assert.equal(good.status, 200); assert.equal(good.body.content, f.disk());
  assert.equal(f.disk(), seed + '# manual_no_consent\n'); f.peer.assertProtocol();
});
