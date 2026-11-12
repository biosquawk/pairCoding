/** Independent AC016/017 + AC012 regressions: actual LiveBackend, HTTP, WS and disk.
 * Contract: latest observed presence survives unsynced state, never means RESUME.
 * No fabricated snapshot/ACK, product internals mutated, or manual resume fallback.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { LiveBackend } from '../../src/services/LiveBackend';
import type { Session } from '../../src/shared/protocol';
import { connected, DEADLINE, id, serverFixture } from './helpers';

type Fixture = Awaited<ReturnType<typeof serverFixture>>;
type Presence = Session['presence'];
type Trace = { connection: number; direction: 'in' | 'out'; type: string; presence?: Presence; action?: string };
const brief = (s: Session) => ({ lifecycle: s.lifecycle, presence: s.presence,
  timer: { status: s.timer.status, manualPaused: s.timer.manualPaused, pauseOnHidden: s.timer.pauseOnHidden },
  cooldownAfterVeto: s.cooldownAfterVeto, writeOwner: s.writeOwner, coachMode: s.coachMode });

async function until(predicate: () => boolean, label: string) {
  const end = Date.now() + DEADLINE;
  while (!predicate()) {
    assert(Date.now() < end, label);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function current(f: Fixture): Promise<Session> {
  const reply = await f.http('GET', '/api/session');
  assert.equal(reply.status, 200); return reply.body;
}
async function stateIs(f: Fixture, predicate: (s: Session) => boolean, label: string) {
  const end = Date.now() + DEADLINE;
  for (;;) {
    const s = await current(f);
    if (predicate(s)) return s;
    assert(Date.now() < end, `${label}; actual=${JSON.stringify(brief(s))}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function previousPage(t: TestContext, initial: Presence, options: { manualPause?: boolean; veto?: boolean; pauseOnHidden?: boolean } = {}) {
  const f = await serverFixture(t, { 'main.py': 'value = 0\n' });
  const old = await connected(t, f);
  const started = await f.http('POST', '/api/session/start', {
    requestId: id(), clientId: f.clientId, sessionId: f.sessionId,
    limitMs: null, pauseOnHidden: options.pauseOnHidden ?? true,
  });
  assert.equal(started.status, 200); assert.equal(started.body.timer.status, 'RUNNING');
  if (options.manualPause) {
    const ack = await old.ack(old.send('TIMER_ACTION', { action: 'PAUSE', pauseOnHidden: null }));
    assert.equal(ack.payload.status, 'OK');
  }
  if (options.veto) {
    const s = await current(f);
    const ack = await old.ack(old.send('VETO_ESCAPE', { controlEpoch: s.controlEpoch,
      activeInterventionId: s.interventionId, lastAppliedSeq: s.lastServerSeq }));
    assert.equal(ack.payload.status, 'OK');
  }
  assert.equal((await old.ack(old.send('WINDOW_STATE', { presence: initial }))).payload.status, 'OK');
  assert.equal((await current(f)).presence, initial);
  const closed = new Promise<void>(resolve => old.socket.once('close', () => resolve()));
  old.close(); await closed;
  // Fixture barrier only; all expected state is read via authenticated real HTTP.
  await until(() => f.app.session.leaseClientId === null, 'previous page must release its real lease');
  old.assertProtocol(); return f;
}
function pageClient(t: TestContext, f: Fixture) {
  const trace: Trace[] = [];
  let connection = 0;
  const stored = new Map<string, string>();
  const client = new LiveBackend({ baseUrl: f.baseURL, token: f.token,
    storage: { getItem: k => stored.get(k) ?? null, setItem: (k, v) => { stored.set(k, v); }, removeItem: k => { stored.delete(k); } },
    socket: url => {
      // Native Node WebSocket, observing ONLY metadata while forwarding unchanged bytes.
      const ws = new WebSocket(url), n = ++connection;
      const send = ws.send.bind(ws);
      ws.send = data => {
        const frame = JSON.parse(String(data));
        trace.push({ connection: n, direction: 'out', type: frame.type,
          ...(frame.type === 'WINDOW_STATE' ? { presence: frame.payload.presence } : {}),
          ...(frame.type === 'TIMER_ACTION' ? { action: frame.payload.action } : {}) });
        send(data);
      };
      ws.addEventListener('message', event => {
        const frame = JSON.parse(String(event.data));
        trace.push({ connection: n, direction: 'in', type: frame.type });
      });
      return ws;
    },
  });
  // This hook is registered after the server's: close client before the server closes.
  f.peers.add({ close: () => client.close() });
  t.after(() => t.diagnostic(`sanitized real wire: ${JSON.stringify(trace)}`));
  return { client, trace };
}
async function sync(client: LiveBackend) {
  await client.connect(); await until(() => !client.getState().isOffline, 'real snapshot sync');
}
function assertReplay(trace: Trace[], connection: number, presence: Presence) {
  const frames = trace.filter(f => f.connection === connection);
  const snapshot = frames.findIndex(f => f.direction === 'in' && f.type === 'SESSION_SNAPSHOT');
  const window = frames.findIndex(f => f.direction === 'out' && f.type === 'WINDOW_STATE');
  assert(snapshot >= 0 && window > snapshot, 'presence is sent after a real authoritative snapshot, not before HELLO');
  assert.deepEqual(frames.filter(f => f.direction === 'out' && f.type === 'WINDOW_STATE').map(f => f.presence), [presence],
    'only the latest pre-sync presence is replayed, not a stale queue');
  assert(!trace.some(f => f.direction === 'out' && f.type === 'TIMER_ACTION'), 'presence must not manually PAUSE/RESUME');
}

test('AC016: new page FOCUSED before connect replaces previous HIDDEN and automatically runs timer', async t => {
  const f = await previousPage(t, 'HIDDEN'); const { client, trace } = pageClient(t, f);
  client.sendWindowState('FOCUSED'); await sync(client);
  const s = await stateIs(f, s => s.presence === 'FOCUSED' && s.timer.status === 'RUNNING', 'FOCUSED initial presence must reach server');
  assert.equal(s.timer.manualPaused, false); assert.equal(s.cooldownAfterVeto, false);
  assert.equal(s.writeOwner, 'STUDENT'); assertReplay(trace, 1, 'FOCUSED');
});

test('AC016 negative: truly HIDDEN initial page must not be coerced to FOCUSED', async t => {
  const f = await previousPage(t, 'FOCUSED'); const { client, trace } = pageClient(t, f);
  client.sendWindowState('HIDDEN'); await sync(client);
  const s = await stateIs(f, s => s.presence === 'HIDDEN', 'HIDDEN initial presence must reach server');
  assert.equal(s.timer.status, 'PAUSED'); assert.equal(s.timer.manualPaused, false);
  assert.equal(s.coachMode, 'MUTED_WINDOW_HIDDEN'); assertReplay(trace, 1, 'HIDDEN');
});

test('AC016: latest value during async connect wins, including BLURRED (no hardcoded focus)', async t => {
  const f = await previousPage(t, 'HIDDEN'); const { client, trace } = pageClient(t, f);
  client.sendWindowState('FOCUSED'); client.sendWindowState('HIDDEN');
  const connecting = client.connect();
  assert.equal(client.getState().isOffline, true); client.sendWindowState('BLURRED');
  await connecting; await until(() => !client.getState().isOffline, 'real async snapshot sync');
  const s = await stateIs(f, s => s.presence === 'BLURRED', 'latest unsynced BLURRED must replace older observations');
  assert.equal(s.timer.status, 'RUNNING'); assertReplay(trace, 1, 'BLURRED');
});

test('AC016 negative: restored FOCUSED must preserve prior manual pause', async t => {
  const f = await previousPage(t, 'HIDDEN', { manualPause: true }); const { client, trace } = pageClient(t, f);
  client.sendWindowState('FOCUSED'); await sync(client);
  const s = await stateIs(f, s => s.presence === 'FOCUSED', 'focused observation must be restored even with manual pause');
  assert.equal(s.timer.status, 'PAUSED'); assert.equal(s.timer.manualPaused, true);
  assert.equal(s.writeOwner, 'STUDENT'); assertReplay(trace, 1, 'FOCUSED');
});

test('AC012/016 negative: restored FOCUSED must preserve veto cooldown without new user fact', async t => {
  const f = await previousPage(t, 'HIDDEN', { veto: true }); const { client, trace } = pageClient(t, f);
  client.sendWindowState('FOCUSED'); await sync(client);
  const s = await stateIs(f, s => s.presence === 'FOCUSED', 'focused observation must be restored in cooldown');
  assert.equal(s.timer.status, 'RUNNING'); assert.equal(s.cooldownAfterVeto, true);
  assert.equal(s.coachMode, 'COOLDOWN_AFTER_VETO'); assert.equal(s.writeOwner, 'STUDENT'); assertReplay(trace, 1, 'FOCUSED');
});

test('AC016: new FOCUSED observation while reconnecting replaces last connected HIDDEN', async t => {
  const f = await previousPage(t, 'FOCUSED'); const { client, trace } = pageClient(t, f);
  await sync(client); client.sendWindowState('HIDDEN');
  await stateIs(f, s => s.presence === 'HIDDEN' && s.timer.status === 'PAUSED', 'setup: real connected HIDDEN');
  client.reconnect(); assert.equal(client.getState().isOffline, true); client.sendWindowState('FOCUSED');
  await until(() => trace.some(f => f.connection === 2 && f.type === 'SESSION_SNAPSHOT') && !client.getState().isOffline, 'real reconnect snapshot');
  const s = await stateIs(f, s => s.presence === 'FOCUSED', 'latest reconnect FOCUSED must reach server');
  assert.equal(s.timer.status, 'RUNNING'); assertReplay(trace, 2, 'FOCUSED');
});

test('AC016: unchanged latest observation is replayed on real reconnect, without needing another browser event', async t => {
  const f = await previousPage(t, 'FOCUSED'); const { client, trace } = pageClient(t, f);
  await sync(client); client.sendWindowState('FOCUSED');
  await until(() => trace.some(f => f.type === 'WINDOW_STATE'), 'setup: connected observation sent');
  client.reconnect();
  await until(() => trace.some(f => f.connection === 2 && f.type === 'SESSION_SNAPSHOT') && !client.getState().isOffline, 'real reconnect snapshot');
  await until(() => trace.some(f => f.connection === 2 && f.type === 'WINDOW_STATE'), 'reconnect must replay retained observation');
  assertReplay(trace, 2, 'FOCUSED'); assert.equal((await current(f)).timer.status, 'RUNNING');
});

test('AC016 control: ordinary post-sync presence works and cannot cancel manual pause or veto', async t => {
  const f = await previousPage(t, 'HIDDEN', { manualPause: true, veto: true }); const { client, trace } = pageClient(t, f);
  await sync(client); client.sendWindowState('FOCUSED');
  const s = await stateIs(f, s => s.presence === 'FOCUSED', 'post-sync focus control');
  assert.equal(s.timer.status, 'PAUSED'); assert.equal(s.timer.manualPaused, true);
  assert.equal(s.cooldownAfterVeto, true); assert.equal(s.writeOwner, 'STUDENT'); assertReplay(trace, 1, 'FOCUSED');
});

test('AC017 control: pauseOnHidden=false keeps timer running while actual HIDDEN still suppresses coach', async t => {
  const f = await previousPage(t, 'FOCUSED', { pauseOnHidden: false }); const { client, trace } = pageClient(t, f);
  await sync(client); client.sendWindowState('HIDDEN');
  const s = await stateIs(f, s => s.presence === 'HIDDEN', 'post-sync hidden control');
  assert.equal(s.timer.status, 'RUNNING'); assert.equal(s.timer.pauseOnHidden, false);
  assert.equal(s.coachMode, 'MUTED_WINDOW_HIDDEN'); assert.equal(s.writeOwner, 'STUDENT'); assertReplay(trace, 1, 'HIDDEN');
});
