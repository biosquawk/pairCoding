import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LiveBackend } from '../../src/services/LiveBackend';
import { observeWindowPresence } from '../../src/services/windowPresence';
import { createPairCoachServer } from '../../src/server/http';
import type { WindowPresence } from '../../src/types/paircoach';

async function until(condition: () => boolean, label: string) {
  const end = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() >= end) throw new Error(`Timeout: ${label}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

// Host-object unit tests, not rendered DOM/browser evidence.
class Page extends EventTarget {
  hidden = false;
  focused = true;
  hasFocus() { return this.focused; }
}
for (const presence of ['FOCUSED', 'HIDDEN', 'BLURRED'] as const) {
  test(`App presence observer reads real host properties on mount: ${presence}`, () => {
    const doc = new Page(), win = new EventTarget(), sent: WindowPresence[] = [];
    doc.hidden = presence === 'HIDDEN'; doc.focused = presence !== 'BLURRED';
    const cleanup = observeWindowPresence(doc, win, p => sent.push(p));
    try { assert.deepEqual(sent, [presence], 'mount needs no subsequent focus/visibility event'); }
    finally { cleanup(); }
  });
}
test('App observer handles visibility/focus/blur and removes all listeners on cleanup', () => {
  const doc = new Page(), win = new EventTarget(), sent: WindowPresence[] = [];
  const cleanup = observeWindowPresence(doc, win, p => sent.push(p));
  sent.length = 0;
  doc.focused = false; win.dispatchEvent(new Event('blur'));
  doc.hidden = true; doc.focused = true; doc.dispatchEvent(new Event('visibilitychange'));
  doc.hidden = false; win.dispatchEvent(new Event('focus'));
  assert.deepEqual(sent, ['BLURRED', 'HIDDEN', 'FOCUSED']);
  cleanup(); doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange')); win.dispatchEvent(new Event('focus')); win.dispatchEvent(new Event('blur'));
  assert.deepEqual(sent, ['BLURRED', 'HIDDEN', 'FOCUSED']);
});

type Frame = { direction: 'sent' | 'received'; type: string; sessionId: string; presence?: WindowPresence };
async function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-presence-'));
  const root = path.join(dir, 'root'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'challenge.md'), '# Presence\n');
  fs.writeFileSync(path.join(root, 'solution.ts'), 'const value = 0;\n');
  const app = createPairCoachServer({ rootPath: root, port: 0, devBootstrap: true });
  const port = await app.listen();
  const clients: LiveBackend[] = [];
  const create = (gate?: { entered: boolean; wait: Promise<void> }, badHello = false) => {
    const connections: Frame[][] = [];
    let closed = 0;
    const client = new LiveBackend({ baseUrl: `http://127.0.0.1:${port}`,
      fetch: (async (url: string, options: any) => {
        if (gate && new URL(url).pathname === '/api/file' && new URL(url).searchParams.get('path') === 'hydration.md') {
          gate.entered = true; await gate.wait;
        }
        return fetch(url, options);
      }) as typeof fetch,
      socket: url => {
      const frames: Frame[] = []; connections.push(frames);
      const ws = new WebSocket(url);
      // Native WebSocket and real backend; retain only sanitized type/presence metadata.
      const record = (direction: Frame['direction'], raw: string) => {
        const m = JSON.parse(raw); frames.push({ direction, type: m.type, sessionId: m.sessionId, ...(m.type === 'WINDOW_STATE' ? { presence: m.payload.presence } : {}) });
      };
      const proxy = { get readyState() { return ws.readyState; }, send: (raw: string) => {
        // Negative auth test: real HTTP bootstrap is valid, only HELLO is corrupted.
        if (badHello) { const m = JSON.parse(raw); if (m.type === 'HELLO') { m.payload.token = 'invalid-test-token'; raw = JSON.stringify(m); } }
        record('sent', raw); ws.send(raw);
      }, close: () => ws.close(), onopen: null as any, onmessage: null as any, onclose: null as any, onerror: null as any };
      ws.addEventListener('open', e => proxy.onopen?.(e));
      ws.addEventListener('message', e => { record('received', String(e.data)); proxy.onmessage?.(e); });
      ws.addEventListener('close', e => { closed++; proxy.onclose?.(e); });
      ws.addEventListener('error', e => proxy.onerror?.(e));
      return proxy;
    } });
    clients.push(client); return { client, connections, get closed() { return closed; } };
  };
  t.after(async () => { clients.forEach(c => c.close()); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const old = create(); await old.client.connect(); await until(() => !old.client.getState().isOffline, 'old sync');
  await old.client.startTimer(); old.client.sendWindowState('HIDDEN');
  await until(() => app.session.getSession().presence === 'HIDDEN', 'old hidden');
  return { app, dir, create, old };
}
function assertReplay(frames: Frame[], presence: WindowPresence) {
  const windows = frames.filter(m => m.direction === 'sent' && m.type === 'WINDOW_STATE');
  assert.deepEqual(windows.map(m => m.presence), [presence], 'one latest presence per synchronized snapshot');
  assert.equal(frames[0]?.type, 'HELLO');
  assert.ok(frames.findIndex(m => m.type === 'SESSION_SNAPSHOT' && m.direction === 'received') < frames.indexOf(windows[0]), 'presence only after authenticated snapshot');
  assert.equal(windows[0].sessionId, frames[0].sessionId);
}
for (const presence of ['FOCUSED', 'HIDDEN', 'BLURRED'] as const) {
  test(`REAL HTTP/WS old Hidden page closes; new ${presence} page replays pre-connect latest after HELLO snapshot`, async t => {
    const f = await fixture(t);
    f.old.client.close(); await until(() => f.app.session.leaseClientId === null, 'old lease release');
    const next = f.create();
    next.client.sendWindowState('BLURRED'); next.client.sendWindowState(presence);
    await next.client.connect(); await until(() => !next.client.getState().isOffline, 'new sync');
    await until(() => next.connections[0].some(m => m.type === 'WINDOW_STATE'), 'initial presence replay');
    await until(() => f.app.session.getSession().presence === presence && next.client.getState().windowPresence === presence, 'authoritative presence');
    assertReplay(next.connections[0], presence);
    const s = f.app.session.getSession();
    assert.equal(s.timer.status, presence === 'HIDDEN' ? 'PAUSED' : 'RUNNING');
    assert.equal(s.timer.pauseOnHidden, true); assert.equal(s.timer.manualPaused, false);
    assert.equal(s.cooldownAfterVeto, false); assert.equal(s.writeOwner, 'STUDENT');
    t.diagnostic(JSON.stringify({ frames: next.connections[0], presence: s.presence, timer: s.timer.status, manualPaused: s.timer.manualPaused, cooldownAfterVeto: s.cooldownAfterVeto }));
  });
}
test('REAL HTTP/WS initial focus replay cannot erase manual pause or veto cooldown', async t => {
  const f = await fixture(t);
  f.old.client.pauseTimer(); f.old.client.triggerVeto();
  await until(() => f.app.session.getSession().timer.manualPaused && f.app.session.getSession().cooldownAfterVeto, 'manual pause + veto');
  f.old.client.close(); await until(() => f.app.session.leaseClientId === null, 'old lease release');
  const next = f.create(); next.client.sendWindowState('FOCUSED');
  await next.client.connect(); await until(() => !next.client.getState().isOffline, 'new sync');
  await until(() => f.app.session.getSession().presence === 'FOCUSED', 'focus replay');
  assertReplay(next.connections[0], 'FOCUSED');
  const s = f.app.session.getSession();
  assert.equal(s.timer.manualPaused, true); assert.equal(s.timer.status, 'PAUSED');
  assert.equal(s.cooldownAfterVeto, true); assert.equal(s.writeOwner, 'STUDENT'); assert.equal(s.interventionId, null);
});
test('REAL HTTP/WS latest update during reconnect is retained and replays again for a new session', async t => {
  const f = await fixture(t);
  const current = f.old;
  current.client.reconnect();
  current.client.sendWindowState('FOCUSED'); current.client.sendWindowState('BLURRED');
  await until(() => current.connections.length === 2 && !current.client.getState().isOffline, 'reconnect sync');
  await until(() => current.connections[1].some(m => m.type === 'WINDOW_STATE'), 'reconnect presence replay');
  await until(() => f.app.session.getSession().presence === 'BLURRED', 'latest reconnect presence');
  assertReplay(current.connections[1], 'BLURRED');
  const previousSession = f.app.session.getSession().sessionId;
  const root2 = path.join(f.dir, 'root2'); fs.mkdirSync(root2); fs.writeFileSync(path.join(root2, 'challenge.md'), '# New session\n');
  assert.equal(await current.client.openProject(root2), true, current.client.getState().connectionError ?? undefined);
  await until(() => current.connections.length === 3 && !current.client.getState().isOffline, 'new session sync');
  await until(() => current.connections[2].some(m => m.type === 'WINDOW_STATE'), 'new session presence replay');
  await until(() => f.app.session.getSession().presence === 'BLURRED', 'new session authoritative presence');
  assertReplay(current.connections[2], 'BLURRED');
  assert.notEqual(f.app.session.getSession().sessionId, previousSession);
  assert.equal(f.app.session.getSession().lifecycle, 'READY', 'presence is not session start/resume');
});

test('REAL HTTP/WS latest change while snapshot file hydration is unsynced is not lost', async t => {
  const f = await fixture(t);
  await f.old.client.selectFile('solution.ts');
  let release!: () => void;
  const gate = { entered: false, wait: new Promise<void>(resolve => { release = resolve; }) };
  // The authoritative bundle now includes its active document. Select a task
  // distinct from that active document so this test really exercises hydration.
  fs.writeFileSync(path.join(f.app.workspace.rootPath,'hydration.md'),'# Hydrated task\n');
  f.app.workspace.scanExternal();
  await until(()=>f.old.client.getState().workspaceVersion===f.app.workspace.workspaceVersion,'external task version observed');
  assert.equal(await f.old.client.updateProjectSettings({...f.old.client.getState().projectSettings,taskFilePath:'hydration.md'}),true);
  f.old.client.close(); await until(() => f.app.session.leaseClientId === null, 'old lease release');
  const next = f.create(gate); next.client.sendWindowState('FOCUSED');
  t.after(() => release());
  await next.client.connect(); await until(() => gate.entered, 'snapshot task hydration');
  assert.equal(next.client.getState().isOffline, true);
  assert.ok(next.connections[0].some(m => m.type === 'SESSION_SNAPSHOT'));
  assert.equal(next.connections[0].filter(m => m.type === 'WINDOW_STATE').length, 0);
  next.client.sendWindowState('BLURRED'); next.client.sendWindowState('HIDDEN');
  assert.equal(next.connections[0].filter(m => m.type === 'WINDOW_STATE').length, 0, 'no presence while unsynced');
  release();
  await until(() => !next.client.getState().isOffline, 'hydration completed');
  await until(() => next.connections[0].some(m => m.type === 'WINDOW_STATE'), 'latest hydration presence replay');
  assertReplay(next.connections[0], 'HIDDEN');
  await until(() => f.app.session.getSession().presence === 'HIDDEN', 'hydration authoritative presence');
  assert.equal(f.app.session.getSession().timer.status, 'PAUSED');
});
test('REAL HTTP/WS rejected HELLO never sends retained presence without an authorized snapshot', async t => {
  const f = await fixture(t);
  f.old.client.close(); await until(() => f.app.session.leaseClientId === null, 'old lease release');
  const next = f.create(undefined, true); next.client.sendWindowState('FOCUSED');
  await next.client.connect();
  await until(() => next.connections[0]?.some(m => m.type === 'HELLO') === true, 'unauthorized HELLO sent');
  await until(() => next.client.getState().writeOwner === 'SYNCING', 'remains unsynced');
  // Wait for the server close, not an arbitrary sleep or a manually fabricated snapshot.
  await until(() => next.closed > 0, 'unauthorized disconnect');
  next.client.close();
  assert.deepEqual(next.connections[0].map(m => m.type), ['HELLO']);
  assert.equal(f.app.session.getSession().presence, 'HIDDEN');
});
