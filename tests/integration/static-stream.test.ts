import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const DEADLINE = 5000; // Hang guard, never a substitute for an event handshake.
const childFile = fileURLToPath(new URL('./static-stream-server.ts', import.meta.url));
const asset = Buffer.from('// actual static file bytes, not JSON\n' + 'const value = 42;\n'.repeat(16384));

/** Retains events arriving before their waiter; no polling/sleeps. */
class Events {
  values: any[] = [];
  failure: Error | undefined;
  private waiters = new Set<() => void>();
  add(value: any) { this.values.push(value); for (const wake of this.waiters) wake(); }
  fail(error: Error) { this.failure = error; for (const wake of this.waiters) wake(); }
  take(match: (value: any) => boolean, label: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: any) => {
        clearTimeout(timer); this.waiters.delete(check);
        if (error) reject(error); else resolve(value);
      };
      const check = () => {
        const index = this.values.findIndex(match);
        if (index >= 0) finish(undefined, this.values.splice(index, 1)[0]);
        else if (this.failure) finish(this.failure);
      };
      const timer = setTimeout(() => finish(new Error(`Timed out: ${label}`)), DEADLINE);
      this.waiters.add(check); check();
    });
  }
}

async function fixture(t: TestContext) {
  const base = fs.mkdtempSync(fileURLToPath(new URL('./.static-stream-', import.meta.url)));
  for (const name of ['workspace', 'data', 'static']) fs.mkdirSync(path.join(base, name));
  fs.writeFileSync(path.join(base, 'workspace', 'challenge.md'), '# Stage 1 static I/O QA\n');
  for (const name of ['index.html', 'ordinary.js', 'head.js', 'open-fail.js', 'mid-fail.js', 'disconnect.js']) {
    fs.writeFileSync(path.join(base, 'static', name), asset);
  }
  fs.writeFileSync(path.join(base, 'private.js'), 'OUTSIDE_STATIC_ROOT');
  fs.symlinkSync(path.join(base, 'private.js'), path.join(base, 'static', 'outward.js'));
  const token = `ephemeral-stage01-${randomUUID()}`;
  const events = new Events();
  let stdout = '', stderr = '';
  const child = fork(childFile, [base, token], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.on('data', b => { stdout += b; });
  child.stderr!.on('data', b => { stderr += b; });
  child.on('message', event => events.add(event));
  child.on('error', error => events.fail(error));
  const exit = new Promise<void>(resolve => child.once('exit', (code, signal) => {
    events.fail(new Error(`Product child exited ${code}/${signal}: ${stderr}`)); resolve();
  }));
  let ws: WebSocket | undefined;
  t.after(async () => {
    ws?.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      // A bounded kill is cleanup only; its result is not a product PASS.
      const guard = setTimeout(() => child.kill('SIGKILL'), DEADLINE);
      if (child.connected) child.send({ command: 'close' }); else child.kill('SIGKILL');
      await exit; clearTimeout(guard);
    }
    t.diagnostic(JSON.stringify({ childExit: child.exitCode, childSignal: child.signalCode, stdout, stderr }));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const { port } = await events.take(e => e.event === 'ready', 'real listener ready');
  assert(![8080, 8081, 8765, 8766, 8767, 8768].includes(port), `unexpected ephemeral port ${port}`);

  type Reply = { status?: number; body: Buffer; complete: boolean; error?: string; headers?: http.IncomingHttpHeaders };
  function request(target: string, method = 'GET', headers: Record<string, string> = {}, firstData?: (res: http.IncomingMessage) => void) {
    return new Promise<Reply>(resolve => {
      let response: http.IncomingMessage | undefined, error: string | undefined;
      const chunks: Buffer[] = [];
      const req = http.request({ hostname: '127.0.0.1', port, path: target, method, agent: false,
        headers: { Authorization: `Bearer ${token}`, ...headers } }, res => {
        response = res;
        res.on('data', data => { chunks.push(Buffer.from(data)); if (chunks.length === 1) firstData?.(res); });
        res.on('error', err => { error = err.message; });
        res.once('close', finish);
      });
      const timer = setTimeout(() => req.destroy(new Error('HTTP hang guard')), DEADLINE);
      function finish() {
        clearTimeout(timer);
        resolve({ status: response?.statusCode, body: Buffer.concat(chunks), complete: response?.complete ?? false,
          error, headers: response?.headers });
      }
      req.once('error', err => { error = err.message; if (!response) finish(); });
      req.end();
    });
  }
  async function json(target: string) {
    const reply = await request(target);
    assert.equal(reply.status, 200, `API survives: ${JSON.stringify(reply)}; child stderr: ${stderr}`);
    assert.equal(reply.complete, true); return JSON.parse(reply.body.toString());
  }
  const initial = await json('/api/session');
  const clientId = randomUUID(), frames = new Events();
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws/session`, { origin: `http://127.0.0.1:${port}` });
  let lastAppliedSeq = 0;
  ws.on('message', data => {
    const frame = JSON.parse(data.toString()); lastAppliedSeq = frame.seq; frames.add(frame);
  });
  let closeCount = 0;
  ws.on('close', (code, reason) => { closeCount++; frames.fail(new Error(`Authenticated WS closed ${code}: ${reason}`)); });
  ws.on('error', error => frames.fail(error));
  await new Promise<void>((resolve, reject) => { ws!.once('open', resolve); ws!.once('error', reject); });
  function send(type: string, payload: unknown) {
    const messageId = randomUUID();
    ws!.send(JSON.stringify({ protocolVersion: '3.0', messageId, sessionId: initial.sessionId, clientId, type, payload }));
    return messageId;
  }
  send('HELLO', { token, lastServerSeq: 0 });
  const snapshot = await frames.take(e => e.type === 'SESSION_SNAPSHOT', 'authenticated session snapshot');
  assert.equal(snapshot.sessionId, initial.sessionId);
  const authenticated = await json('/api/session');
  async function healthy() {
    const current = await json('/api/session');
    for (const key of ['sessionId', 'projectId', 'controlEpoch', 'writeOwner', 'lifecycle', 'workspaceVersion']) {
      assert.notEqual(authenticated[key], undefined, `fixture needs actual Session.${key}`);
      assert.equal(current[key], authenticated[key], `static request must preserve session.${key}`);
    }
    assert.equal(closeCount, 0, 'same WS connection, no reconnect masking a backend crash');
    assert.equal(ws!.readyState, WebSocket.OPEN);
    const messageId = send('PING', { lastAppliedSeq });
    const ack = await frames.take(e => e.type === 'ACK' && e.payload.replyTo === messageId, 'same authenticated WS PING ACK');
    assert.equal(ack.sessionId, initial.sessionId);
    assert.equal(ack.payload.status, 'OK'); assert.equal(ack.payload.error, null);
    assert.equal(ack.payload.controlEpoch, authenticated.controlEpoch);
  }
  async function inspect() {
    const id = randomUUID(); child.send({ command: 'inspect', id });
    return events.take(e => e.event === 'inspection' && e.id === id, 'stream inspection');
  }
  const release = (name: string) => child.send({ command: 'release-read', name });
  await healthy();
  return { request, json, healthy, inspect, events, release };
}

test('static stream: ordinary GET/HEAD and root index use real bytes; HEAD opens no stream', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const before = await f.inspect();
  const head = await f.request('/head.js', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.complete, true); assert.equal(head.body.length, 0);
  assert.match(head.headers!['content-type']!, /javascript/);
  assert.deepEqual((await f.inspect()).created, before.created, 'HEAD must not create a source stream');
  for (const target of ['/ordinary.js', '/']) {
    const reply = await f.request(target);
    assert.equal(reply.status, 200); assert.equal(reply.complete, true); assert.deepEqual(reply.body, asset);
    assert.equal(reply.headers!['x-content-type-options'], 'nosniff');
  }
  await f.healthy();
});

test('static stream: traversal/realpath, missing, method, Host/Origin and API token guards remain enforced', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  for (const target of ['/%2e%2e%2fprivate.js', '/bad%5cpath.js', '/bad%00.js', '/outward.js']) {
    const reply = await f.request(target);
    assert.equal(reply.status, 403, target); assert(!reply.body.includes(Buffer.from('OUTSIDE_STATIC_ROOT')));
  }
  assert.equal((await f.request('/bad%zz')).status, 400);
  assert.equal((await f.request('/missing.js')).status, 404);
  assert.equal((await f.request('/ordinary.js', 'POST')).status, 404);
  assert.equal((await f.request('/ordinary.js', 'GET', { Host: 'attacker.invalid' })).status, 403);
  assert.equal((await f.request('/ordinary.js', 'GET', { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await f.request('/api/session', 'GET', { Authorization: '' })).status, 401);
  assert.equal((await f.request('/api/session', 'GET', { Authorization: 'Bearer incorrect' })).status, 401);
  assert.deepEqual((await f.inspect()).created, [], 'guarded requests cannot open a source stream');
  await f.healthy();
});

test('static stream: asynchronous open EIO returns controlled 5xx; same API/session/authenticated WS survive', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const reply = await f.request('/open-fail.js');
  await f.events.take(e => e.event === 'injected-open-error', 'open EIO actually injected');
  // Run health before status assertions: a socket reset must never conceal process death.
  await f.healthy();
  assert(reply.status! >= 500 && reply.status! <= 599, `expected controlled 5xx, actual ${JSON.stringify(reply)}`);
  assert.equal(reply.complete, true, 'open failure is a complete error response, not a reset');
  assert(!reply.body.includes(asset.subarray(0, 64)), 'no resource bytes before failed open');
  await f.events.take(e => e.event === 'stream-close' && e.name === 'open-fail.js', 'failed stream closed');
});

test('static stream: mid-read EIO after real bytes aborts only the response, without appending JSON', { timeout: 20000 }, async t => {
  const f = await fixture(t), first = new Events();
  const result = f.request('/mid-fail.js', 'GET', {}, () => first.add('data'));
  await first.take(e => e === 'data', 'client received actual file bytes');
  const read = await f.events.take(e => e.event === 'real-read' && e.name === 'mid-fail.js', 'actual fs.read');
  assert.equal(read.error, null); assert(read.count > 0);
  await f.events.take(e => e.event === 'read-blocked' && e.name === 'mid-fail.js', 'second read handshake');
  f.release('mid-fail.js');
  const reply = await result;
  await f.events.take(e => e.event === 'injected-read-error', 'mid-read EIO actually injected');
  await f.healthy();
  assert.equal(reply.status, 200); assert.equal(reply.complete, false, 'partial asset must be marked aborted, not a successful truncation');
  assert(reply.body.length > 0 && reply.body.length < asset.length);
  assert.deepEqual(reply.body, asset.subarray(0, reply.body.length), 'only genuine resource prefix; never a JSON error suffix');
  await f.events.take(e => e.event === 'stream-close' && e.name === 'mid-fail.js', 'failed source closed');
});

test('static stream: client disconnect destroys the source and closes its real descriptor; API/WS survive', { timeout: 20000 }, async t => {
  const f = await fixture(t), first = new Events();
  let response: http.IncomingMessage | undefined;
  const result = f.request('/disconnect.js', 'GET', {}, res => { response = res; first.add('data'); });
  await first.take(e => e === 'data', 'download started');
  await f.events.take(e => e.event === 'read-blocked' && e.name === 'disconnect.js', 'real source deliberately pending before client disconnect');
  response!.destroy(); await result;
  const closed = await f.events.take(e => e.event === 'response-close' && e.name === 'disconnect.js', 'server observed receiver close');
  const state = (await f.inspect()).streams.find((s: any) => s.name === 'disconnect.js');
  assert.equal(closed.destroyed, true, 'source.destroy() must follow receiver close even while read is outstanding');
  assert.equal(state.destroyed, true);
  f.release('disconnect.js');
  const stream = await f.events.take(e => e.event === 'stream-close' && e.name === 'disconnect.js', 'real descriptor closed after outstanding read completes');
  assert.equal(stream.closed, true); assert.equal(stream.destroyed, true);
  await f.healthy();
});
