// Unit counter-controls of the QA relay ONLY. Scripted Playwright routes are NOT browser/REST/WS E2E.
// The real TEST014 before/after evidence is separately supplied by ROOT diagnostic-014.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { Wire } from './helpers';

class ScriptedSide {
  sent: (string | Buffer)[] = [];
  closes: unknown[] = [];
  message?: (raw: string | Buffer) => void;
  closed?: (code?: number, reason?: string) => void;
  onMessage(cb: typeof this.message) { this.message = cb; }
  onClose(cb: typeof this.closed) { this.closed = cb; }
  send(raw: string | Buffer) { this.sent.push(raw); }
  async close(options: unknown) { this.closes.push(options); }
  receive(frame: unknown) { this.message!(JSON.stringify(frame)); }
}
async function setup() {
  let connect!: (route: any) => void;
  const page = { routeWebSocket: async (_: string, cb: typeof connect) => { connect = cb; } } as unknown as Page;
  const wire = new Wire(); await wire.install(page);
  return { wire, connection() {
    const browser = new ScriptedSide(), server = new ScriptedSide();
    connect(Object.assign(browser, { connectToServer: () => server }));
    return { browser, server };
  } };
}
function hello(id: string, clientId: string, sessionId: string) {
  return { type: 'HELLO', messageId: id, clientId, sessionId, payload: { token: 'SYNTHETIC_UNIT_ONLY' } };
}
function authenticate(c: ReturnType<Awaited<ReturnType<typeof setup>>['connection']>, h: ReturnType<typeof hello>) {
  c.browser.receive(h);
  c.server.receive({ type: 'SESSION_SNAPSHOT', sessionId: h.sessionId, payload: { session: { sessionId: h.sessionId } } });
}

test('QA wire refuses command before current HELLO is authenticated; mismatched snapshots do not grant readiness', async () => {
  const { wire, connection } = await setup(), c = connection();
  assert.throws(() => wire.command('PROPOSAL_RESPONSE', {}));
  c.browser.receive(hello('h1', 'client1', 'session1'));
  assert.throws(() => wire.command('PROPOSAL_RESPONSE', {}));
  c.server.receive({ type: 'SESSION_SNAPSHOT', sessionId: 'other', payload: { session: { sessionId: 'other' } } });
  assert.throws(() => wire.command('PROPOSAL_RESPONSE', {}));
  c.server.receive({ type: 'SESSION_SNAPSHOT', sessionId: 'session1', payload: { session: { sessionId: 'session1' } } });
  const frame = wire.command('PROPOSAL_RESPONSE', { proposalId: 'proposal1' });
  assert.equal(JSON.parse(String(c.server.sent.at(-1))).messageId, frame.messageId);
  assert.deepEqual(wire.identity(), { clientId: 'client1', sessionId: 'session1' });
});

test('QA wire uses current connection identity, not first HELLO; old close cannot invalidate a new ready route', async () => {
  const { wire, connection } = await setup(), old = connection();
  authenticate(old, hello('h1', 'client1', 'session1'));
  const current = connection();
  old.server.receive({ type: 'SESSION_SNAPSHOT', sessionId: 'session1', payload: { session: { sessionId: 'session1' } } });
  assert.throws(() => wire.command('PROPOSAL_RESPONSE', {}));
  authenticate(current, hello('h2', 'client2', 'session2'));
  assert.deepEqual(wire.identity(), { clientId: 'client2', sessionId: 'session2' });
  old.browser.closed!(1000, 'old resync');
  const frame = wire.command('PROPOSAL_RESPONSE', { proposalId: 'proposal2' });
  assert.equal(frame.sessionId, 'session2'); assert.equal(frame.clientId, 'client2');
  assert.equal(JSON.parse(String(current.server.sent.at(-1))).messageId, frame.messageId);
  assert.equal(old.server.sent.length, 1); // only its own original HELLO, no test injection
  assert.deepEqual(wire.currentConnection(), { generation: 2, closed: false, authenticated: true, helloId: 'h2' });
});

test('QA wire closes transparently in either direction and refuses a closed-current or not-yet-authenticated replacement', async () => {
  for (const direction of ['browser', 'server'] as const) {
    const { wire, connection } = await setup(), c = connection(); authenticate(c, hello('h1', 'client1', 'session1'));
    c[direction].closed!(1001, 'fixture close');
    assert.deepEqual(c[direction === 'browser' ? 'server' : 'browser'].closes, [{ code: 1001, reason: 'fixture close' }]);
    assert.throws(() => wire.command('PROPOSAL_RESPONSE', {}));
    connection(); // no HELLO on the replacement, must not borrow previous identity/authentication
    assert.throws(() => wire.identity()); assert.throws(() => wire.command('PROPOSAL_RESPONSE', {}));
  }
});

test('QA wire forwards real frame bytes unchanged and preserves all observations; no synthetic server ACK', async () => {
  const { wire, connection } = await setup(), c = connection();
  const raw = ' { "type": "HELLO", "messageId":"raw", "clientId":"c", "sessionId":"s", "payload": {"token":"UNIT_ONLY"} } ';
  c.browser.message!(raw); assert.equal(c.server.sent[0], raw);
  const response = '{"type":"ACK","payload":{"replyTo":"missing","status":"REJECTED"}}';
  c.server.message!(response); assert.equal(c.browser.sent[0], response);
  assert.deepEqual(wire.sent, [JSON.parse(raw)]); assert.deepEqual(wire.received, [JSON.parse(response)]);
  assert.throws(() => wire.command('PROPOSAL_RESPONSE', {}));
});
