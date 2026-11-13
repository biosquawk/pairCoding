// Real HTTP/WS/FS. Only delivery order is gated; no fabricated frames or ACKs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { LiveBackend } from '../../src/services/LiveBackend';
import { createPairCoachServer } from '../../src/server/http';
async function until(fn: () => boolean, label: string) {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw new Error('Timeout: ' + label); await new Promise(r => setTimeout(r, 10)); }
}
async function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-real-')), root = path.join(dir, 'root'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'challenge.md'), '# Task\n');
  const token=crypto.randomUUID();
  let app = createPairCoachServer({ token, rootPath: root, port: 0, devBootstrap: true, enableCoach: false });
  const port = await app.listen();
  let holdSnapshot = false, holding = false, readPath: string | null = null, releaseRead: (() => void) | null = null;
  let gateMutation = false, releaseMutation: (() => void) | null = null;
  const queued: (() => void)[] = [], sent: any[] = [], received: any[] = [];
  const client = new LiveBackend({ baseUrl: `http://127.0.0.1:${port}`, clientId: 'selection-client', socket: url => {
    const ws = new WebSocket(url);
    const relay: any = { get readyState() { return ws.readyState; }, send(raw: string) { sent.push(JSON.parse(raw)); ws.send(raw); }, close() { ws.close(); } };
    ws.on('open', () => relay.onopen?.({})); ws.on('close', () => relay.onclose?.({})); ws.on('error', e => relay.onerror?.(e));
    ws.on('message', raw => {
      const message = JSON.parse(String(raw));
      const deliver = () => { received.push(message); relay.onmessage?.({ data: String(raw) }); };
      if (holdSnapshot && message.type === 'SESSION_SNAPSHOT') holding = true;
      if (holding) queued.push(deliver); else deliver();
    });
    return relay;
  }, fetch: (async (url, options) => {
    const response = await fetch(url, options);
    if (readPath !== null && options?.method === 'GET' && new URL(String(url)).searchParams.get('path') === readPath) {
      readPath = null; await new Promise<void>(r => { releaseRead = r; });
    }
    if (gateMutation && options?.method === 'POST' && new URL(String(url)).pathname === '/api/file') {
      gateMutation = false; await new Promise<void>(r => { releaseMutation = r; });
    }
    return response;
  }) as typeof fetch });
  t.after(async () => { releaseRead?.(); releaseMutation?.(); client.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(); await until(() => !client.getState().isOffline, 'initial snapshot');
  assert.equal(client.getState().activePath, 'challenge.md');
  return { client, root, get app(){return app;}, port, sent, received,
    async restart(){await app.close();app=createPairCoachServer({token,rootPath:root,port,devBootstrap:true,enableCoach:false});await app.listen();client.reconnect();},
    gateMutation() { gateMutation = true; }, mutationHeld: () => releaseMutation !== null, releaseMutation() { releaseMutation?.(); releaseMutation = null; },
    gateSnapshot() { holdSnapshot = true; }, queued: () => queued.length,
    releaseSnapshot() { holdSnapshot = false; holding = false; queued.splice(0).forEach(deliver => deliver()); },
    gateRead(file: string) { readPath = file; }, readHeld: () => releaseRead !== null,
    releaseRead() { releaseRead?.(); releaseRead = null; },
  };
}

test('001 REAL create: late pre-selection snapshot cannot reset the created-file view; fresh save ACK and exact disk', async t => {
  const f = await fixture(t); f.gateSnapshot();
  await f.client.mutateFile('CREATE', 'solution.py', null, '');
  await until(() => f.queued() > 0, 'real CREATE snapshot buffered');
  assert.equal(f.client.getState().activePath, 'solution.py');
  const view = f.sent.find(m => m.type === 'VIEW_CHANGED' && m.payload.path === 'solution.py'); assert.ok(view);
  f.releaseSnapshot(); await until(() => !f.client.getState().isOffline, 'snapshot settled');
  assert.equal(f.client.getState().activePath, 'solution.py');
  assert.equal(f.client.getState().files.find(file => file.path === 'solution.py')?.loaded, true);
  assert.ok(f.received.some(m => m.type === 'ACK' && m.payload.replyTo === view.messageId && m.payload.status === 'OK'));
  f.client.saveFileContent('solution.py', 'answer = 42\n'); await f.client.flushAll();
  const change = f.sent.find(m => m.type === 'CODE_CHANGED' && m.payload.path === 'solution.py'); assert.ok(change);
  assert.ok(f.received.some(m => m.type === 'ACK' && m.payload.replyTo === change.messageId && m.payload.status === 'OK'));
  assert.equal(fs.readFileSync(path.join(f.root, 'solution.py'), 'utf8'), 'answer = 42\n');
  assert.equal(fs.readFileSync(path.join(f.root, 'challenge.md'), 'utf8'), '# Task\n');
  assert.equal(f.client.getState().connectionError, null, 'no active-document error');
  console.log('CREATE ordering', JSON.stringify(f.received.map(m => ({ type: m.type, seq: m.seq, active: m.payload.session?.activeFilePath ?? m.payload.activeFilePath, status: m.payload.status }))));
});

test('001 REAL create: snapshot during selected-file GET carries the current intent through generation replacement', async t => {
  const f = await fixture(t); f.gateSnapshot(); f.gateRead('solution.py');
  const create = f.client.mutateFile('CREATE', 'solution.py', null, '');
  await until(() => f.readHeld() && f.queued() > 0, 'CREATE read held before snapshot');
  f.releaseSnapshot(); await until(() => !f.client.getState().isOffline, 'new snapshot installed');
  f.releaseRead(); await create;
  await until(() => f.client.getState().activePath === 'solution.py', 'current selection carried forward');
  assert.equal(f.client.getState().files.find(file => file.path === 'solution.py')?.loaded, true);
  assert.equal(f.client.getState().connectionError, null);
});

test('001 REAL negative ordering: slower old tab cannot replace the latest user selection', async t => {
  const f = await fixture(t);
  await f.client.mutateFile('CREATE', 'first.py', null, 'first = 1\n');
  await until(() => !f.client.getState().isOffline, 'first sync');
  await f.client.mutateFile('CREATE', 'second.py', null, 'second = 2\n');
  await until(() => !f.client.getState().isOffline, 'second sync');
  // Resync discards non-active file caches without changing any source bytes.
  f.client.reconnect(); await until(() => f.received.filter(m => m.type === 'SESSION_SNAPSHOT').length >= 4 && !f.client.getState().isOffline, 'reconnect sync');
  f.gateRead('first.py'); const oldSelection = f.client.selectFile('first.py'); await until(f.readHeld, 'old selection read held');
  await f.client.selectFile('challenge.md'); f.releaseRead(); await oldSelection;
  assert.equal(f.client.getState().activePath, 'challenge.md');
  assert.equal(f.sent.filter(m => m.type === 'VIEW_CHANGED').at(-1)?.payload.path, 'challenge.md');
  assert.equal(fs.readFileSync(path.join(f.root, 'first.py'), 'utf8'), 'first = 1\n');
});

test('001 REAL negative scope: selected view is not inherited by a new project with the same file path', async t => {
  const f = await fixture(t); await f.client.mutateFile('CREATE', 'solution.py', null, 'old = 1\n');
  await until(() => !f.client.getState().isOffline, 'create settled'); await f.client.selectFile('solution.py');
  const next = path.join(f.root, '..', 'next'); fs.mkdirSync(next);
  fs.writeFileSync(path.join(next, 'challenge.md'), '# Next task\n'); fs.writeFileSync(path.join(next, 'solution.py'), 'next = 2\n');
  assert.equal(await f.client.openProject(next), true, f.client.getState().connectionError ?? undefined);
  await until(() => !f.client.getState().isOffline && f.client.getState().scenario.title === next, 'new project');
  assert.equal(f.client.getState().activePath, 'challenge.md');
  assert.equal(f.client.getState().connectionError, null);
});

test('001 REAL negative deletion: removed selection falls back without a fake active document', async t => {
  const f = await fixture(t); await f.client.mutateFile('CREATE', 'solution.py', null, '');
  await until(() => !f.client.getState().isOffline, 'create settled'); await f.client.selectFile('solution.py');
  f.gateSnapshot(); await f.client.mutateFile('DELETE', 'solution.py');
  await until(() => f.queued() > 0, 'delete snapshot'); f.releaseSnapshot();
  await until(() => !f.client.getState().isOffline, 'delete settled');
  assert.equal(f.client.getState().activePath, 'challenge.md');
  assert.equal(f.client.getState().files.some(file => file.path === 'solution.py'), false);
  assert.equal(f.client.getState().connectionError, null);
});


test('001 REAL negative session scope: same-root remote reopen invalidates old selected view and delayed GET', async t => {
  const f = await fixture(t);
  await f.client.mutateFile('CREATE', 'solution.py', null, 'old = 1\n');
  await until(() => !f.client.getState().isOffline, 'create settled'); await f.client.selectFile('solution.py');
  await f.client.mutateFile('CREATE', 'slow.py', null, 'slow = 2\n');
  await until(() => !f.client.getState().isOffline, 'slow create settled'); await f.client.selectFile('solution.py');
  f.client.reconnect();
  await until(() => f.received.filter(m => m.type === 'SESSION_SNAPSHOT').length >= 4 && !f.client.getState().isOffline, 'cache reset');
  f.gateRead('slow.py'); const oldSelection = f.client.selectFile('slow.py'); await until(f.readHeld, 'old-session GET held');
  const oldSession = f.app.session.state.sessionId, oldProject = f.app.workspace.projectId;
  // Same-root open is deliberately idempotent in V2. A real server restart
  // creates the different session required by this negative fixture.
  await f.restart();
  const response = await fetch(`http://localhost:${f.port}/api/project`,{headers:{Authorization:`Bearer ${f.client.getAuthToken()}`,Connection:'close'}});
  assert.equal(response.status,200); const project=await response.json();
  assert.notEqual(project.sessionId, oldSession);
  assert.equal(project.projectId, oldProject, 'same project identity, genuinely different session');
  await until(() => f.received.some(m => m.type === 'SESSION_SNAPSHOT' && m.sessionId === project.sessionId) && !f.client.getState().isOffline, 'replacement session');
  f.releaseRead(); await oldSelection;
  assert.equal(f.client.getState().activePath, 'challenge.md');
  assert.equal(f.client.getState().connectionError, null);
  assert.equal(fs.readFileSync(path.join(f.root, 'slow.py'), 'utf8'), 'slow = 2\n');
});


test('001 REAL negative navigation: late CREATE response cannot override a newer manual tab choice', async t => {
  const f = await fixture(t); f.gateMutation();
  const create = f.client.mutateFile('CREATE', 'solution.py', null, '');
  await until(() => f.mutationHeld() && f.received.filter(m => m.type === 'SESSION_SNAPSHOT').length >= 2 && !f.client.getState().isOffline, 'CREATE applied, HTTP response gated');
  await f.client.selectFile('challenge.md'); f.releaseMutation(); await create;
  assert.equal(f.client.getState().activePath, 'challenge.md');
  assert.equal(f.client.getState().connectionError, null);
  assert.equal(fs.readFileSync(path.join(f.root, 'solution.py'), 'utf8'), '');
});

test('001 REAL negative mutation scope: late CREATE response cannot install a previous project or choose its file', async t => {
  const f = await fixture(t); f.gateMutation();
  const create = f.client.mutateFile('CREATE', 'solution.py', null, 'old = 1\n');
  await until(() => f.mutationHeld() && f.received.filter(m => m.type === 'SESSION_SNAPSHOT').length >= 2 && !f.client.getState().isOffline, 'old CREATE response gated');
  const next = path.join(f.root, '..', 'new-root'); fs.mkdirSync(next); fs.writeFileSync(path.join(next, 'challenge.md'), '# New root\n');
  assert.equal(await f.client.openProject(next), true, f.client.getState().connectionError ?? undefined);
  await until(() => !f.client.getState().isOffline && f.client.getState().scenario.title === next, 'replacement root synced');
  f.releaseMutation(); await create;
  assert.equal(f.client.getState().scenario.title, next);
  assert.equal(f.client.getState().activePath, 'challenge.md');
  assert.equal(f.client.getState().files.some(file => file.path === 'solution.py'), false);
  assert.equal(f.client.getState().connectionError, null);
  assert.equal(fs.readFileSync(path.join(f.root, 'solution.py'), 'utf8'), 'old = 1\n', 'accepted old mutation is not replayed or undone');
  assert.equal(fs.existsSync(path.join(next, 'solution.py')), false);
});
