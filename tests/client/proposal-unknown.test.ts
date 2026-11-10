import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LiveBackend } from '../../src/services/LiveBackend';
import type * as Wire from '../../src/shared/protocol';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const doc = (content = 'original\n'): Wire.Document => ({ path: 'main.py', content, version: 1, contentHash: createHash('sha256').update(content).digest('hex'), languageId: 'python', eol: 'LF', utf8Bom: false, readOnly: false });
const proposal = (): Wire.Proposal => ({ proposalId: 'decision-1', kind: 'RESTORE_SNAPSHOT', basedOnWorkspaceVersion: 1, questionText: 'Przywrócić?', yesLabel: 'Tak', noLabel: 'Nie', expiresAt: new Date(Date.now() + 60000).toISOString(), paths: ['main.py'], snapshotId: 'snapshot-1', resetTimer: false });
function bundle(): Wire.SessionBundle {
  return {
    project: { projectId: 'project-1', sessionId: 'session-1', rootPath: 'unit-workspace', workspaceVersion: 1, files: [{ path: 'main.py', kind: 'FILE', version: 1 }], capabilities: { canRunMain: false, canRunTests: false, docs: 'NOT_INSTALLED', autocomplete: 'NOT_INSTALLED' }, settings: { taskMode: 'IMPLEMENTATION', taskFilePath: null, reviewNotesPath: 'review.md', aiConsent: false, runProfiles: [], contextPatterns: ['**/*.py'] } },
    session: { sessionId: 'session-1', projectId: 'project-1', lifecycle: 'READY', workspaceVersion: 1, controlEpoch: 1, writeOwner: 'STUDENT', coachMode: 'UNAVAILABLE', cooldownAfterVeto: false, presence: 'FOCUSED', aiStatus: 'OFF', timer: { status: 'STOPPED', elapsedMs: 0, limitMs: null, pauseOnHidden: true, manualPaused: false, serverTime: new Date().toISOString() }, activeFilePath: 'main.py', interventionId: null, lastServerSeq: 0 },
    activeDocument: doc(), proposals: [proposal()], chat: [], lastRun: null, report: null,
  };
}
class UnitSocket {
  readyState: 0 | 1 | 2 | 3 = 1;
  sent: string[] = [];
  onopen: any; onmessage: any; onerror: any; onclose: any;
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; this.onclose?.({}); }
}
async function unit() {
  const b = bundle(), sockets: UnitSocket[] = [], stored = new Map<string, string>();
  let seq = 0;
  const client = new LiveBackend({ token: 'unit-token', clientId: 'unit-tab', baseUrl: 'http://127.0.0.1:51234',
    storage: { getItem: k => stored.get(k) ?? null, setItem: (k, v) => { stored.set(k, v); }, removeItem: k => { stored.delete(k); } },
    socket: () => { const ws = new UnitSocket(); sockets.push(ws); return ws; },
    fetch: (async (url: string) => {
      const route = new URL(url).pathname;
      return route === '/api/file' ? new Response(JSON.stringify({ code: 'FILE_NOT_FOUND', message: 'Brak pliku zadania.' }), { status: 404 })
        : new Response(JSON.stringify(route === '/api/project' ? b.project : route === '/api/session' ? b.session : []), { status: 200 });
    }) as typeof fetch,
  });
  const receive = (type: string, payload: any) => sockets.at(-1)!.onmessage?.({ data: JSON.stringify({ protocolVersion: '3.0', messageId: `frame-${++seq}`, sessionId: b.session.sessionId, seq, type, payload }) });
  async function hello() {
    await client.connect(); sockets.at(-1)!.onopen?.({}); receive('SESSION_SNAPSHOT', structuredClone(b)); await turn();
    assert.equal(client.getState().isOffline, false);
  }
  const responses = () => sockets.flatMap(ws => ws.sent).filter(raw => JSON.parse(raw).type === 'PROPOSAL_RESPONSE');
  const ack = (status: 'OK' | 'DUPLICATE' | 'REJECTED', error: any = null) => receive('ACK', { replyTo: JSON.parse(responses()[0]).messageId, status, documentVersion: null, workspaceVersion: 1, controlEpoch: 1, error });
  await hello();
  return { client, b, sockets, stored, receive, hello, responses, ack };
}

test('UNKNOWN: real 5s deadline retains correlation; late success is not inferred from missing proposal', async t => {
  const f = await unit(); t.after(() => f.client.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = f.client.respondToProposal('decision-1', true); await turn();
  assert.equal(f.responses().length, 1);
  t.mock.timers.tick(5000); await waiting;
  assert.match(f.client.getState().connectionError!, /wynik nieznany/i);
  f.b.proposals = []; f.receive('SESSION_SNAPSHOT', structuredClone(f.b)); await turn();
  assert.equal(f.responses().length, 1, 'broadcast snapshot is NOT a new HELLO authorization');
  assert.match(f.client.getState().connectionError!, /wynik nieznany/i, 'absence cannot clear UNKNOWN');
  f.ack('OK'); await turn();
  assert.equal(f.client.getState().connectionError, null, 'only matching late ACK resolves UNKNOWN');
  assert.equal(f.client.getState().activeProposal, null);
});

test('UNKNOWN: late REJECTED is visible and unrelated errors are never cleared by successful decision', async t => {
  const f = await unit(); t.after(() => f.client.close()); t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = f.client.respondToProposal('decision-1', true); await turn(); t.mock.timers.tick(5000); await waiting;
  f.ack('REJECTED', { code: 'RECOVERY_REQUIRED', message: 'Zachowano materiały.', retryable: false, requestId: null, currentVersion: null }); await turn();
  assert.match(f.client.getState().connectionError!, /RECOVERY_REQUIRED/);
  f.b.proposals = []; f.receive('SESSION_SNAPSHOT', structuredClone(f.b)); await turn();
  assert.match(f.client.getState().connectionError!, /RECOVERY_REQUIRED/, 'terminal rejection survives ordinary snapshot');
  assert.equal(f.client.getState().activeProposal, null);
  f.receive('ACTION_PROPOSAL', { ...proposal(), proposalId: 'decision-2' });
  const next = f.client.respondToProposal('decision-2', true); await turn();
  const second = JSON.parse(f.responses()[1]);
  f.receive('ERROR', { code: 'OTHER_FAILURE', message: 'Inny błąd.', retryable: false, requestId: null, currentVersion: null });
  f.receive('ACK', { replyTo: second.messageId, status: 'OK', documentVersion: null, workspaceVersion: 1, controlEpoch: 1, error: null }); await next;
  await f.hello();
  assert.match(f.client.getState().connectionError!, /OTHER_FAILURE/, 'successful decision/resync cannot clear an unrelated error');
});

test('lost ACK: authenticated same-session HELLO + absence permits ONE byte-identical ledger replay, cached REJECTED resolves', async t => {
  const f = await unit(); t.after(() => f.client.close()); t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = f.client.respondToProposal('decision-1', true); await turn(); const original = f.responses()[0];
  f.sockets[0].close(); await waiting;
  f.b.proposals = []; await f.hello();
  assert.deepEqual(f.responses(), [original, original], 'message/session/client/payload all retained');
  f.sockets.at(-1)!.close(); await f.hello();
  assert.equal(f.responses().length, 2, 'no replay loop on another reconnect');
  f.ack('REJECTED', { code: 'STALE_PROPOSAL', message: 'Odrzucono wcześniej.', retryable: false, requestId: null, currentVersion: null }); await turn();
  assert.match(f.client.getState().connectionError!, /STALE_PROPOSAL/);
});

test('proposal present, new session/restart and close never manufacture a new decision or discard local work', async t => {
  const f = await unit(); t.after(() => f.client.close()); t.mock.timers.enable({ apis: ['setTimeout'] });
  f.client.saveFileContent('main.py', 'protected draft\n');
  const waiting = f.client.respondToProposal('decision-1', true); await turn(); f.sockets[0].close(); await waiting;
  await f.hello();
  assert.equal(f.responses().length, 1, 'still-present proposal is not safe to replay');
  void f.client.respondToProposal('decision-1', false); await turn();
  assert.equal(f.responses().length, 1, 'opposite click cannot replace unresolved original approval');
  f.sockets.at(-1)!.close();
  f.b.session.sessionId = f.b.project.sessionId = 'session-after-restart'; f.b.proposals = []; await f.hello();
  assert.equal(f.responses().length, 1, 'no old-session replay');
  assert.match(f.client.getState().connectionError!, /SESSION_REPLACED.*wynik nieznany/i);
  assert.equal(f.client.getState().files.find(file => file.path === 'main.py')?.content, 'protected draft\n');
  assert.ok([...f.stored.values()].some(value => value.includes('protected draft')));
  f.client.close(); t.mock.timers.tick(30000); await turn(); assert.equal(f.responses().length, 1);
});

test('UNKNOWN remains explicit despite a missing task; late success preserves that independent read error', async t => {
  const f = await unit(); t.after(() => f.client.close()); t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = f.client.respondToProposal('decision-1', true); await turn(); t.mock.timers.tick(5000); await waiting;
  f.b.proposals = []; f.b.project.settings.taskFilePath = 'missing.md';
  f.receive('SESSION_SNAPSHOT', structuredClone(f.b)); await turn();
  assert.match(f.client.getState().connectionError!, /wynik nieznany/i, 'background file-read failure cannot hide UNKNOWN');
  f.ack('OK'); await turn(); await f.hello();
  assert.match(f.client.getState().connectionError!, /FILE_NOT_FOUND/);
  assert.doesNotMatch(f.client.getState().connectionError!, /wynik nieznany/i);
});

test('close releases an unresolved decision wait/timer and never replays it', async t => {
  const f = await unit(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = f.client.respondToProposal('decision-1', true); await turn();
  f.client.close(); await waiting; t.mock.timers.tick(30000); await turn();
  await f.client.connect(); assert.equal(f.sockets.length, 1); assert.equal(f.responses().length, 1);
});

async function until<T>(read: () => T, valid: (value: T) => boolean, label: string, ms = 12000) {
  const end = Date.now() + ms;
  do { const value = read(); if (valid(value)) return value; await delay(10); } while (Date.now() < end);
  assert.fail('Timeout: ' + label);
}
// Integration may point at the separately-owned, explicit G3 dependency before K
// cherry-picks this client commit. Default is this repo once G3 is integrated.
const serverRoot = process.env.PAIRCOACH_PROPOSAL_SERVER_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
for (const mode of ['success', 'recovery'] as const) for (const lost of [false, true]) {
  test(`REAL separate-process >5s restore: ${mode}, ${lost ? 'lost ACK + client ledger reconnect' : 'late ACK'}`, { timeout: 25000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-proposal-unknown-'));
    const root = path.join(dir, 'workspace'), data = path.join(dir, 'data'); fs.mkdirSync(root); fs.mkdirSync(data);
    fs.writeFileSync(path.join(root, 'main.py'), 'ORIGINAL\n');
    fs.writeFileSync(path.join(root, 'challenge.md'), '# Real proposal exercise\n');
    const token = 'fixture-' + crypto.randomUUID(), sent: string[] = [], frames: any[] = [], errors: string[] = [];
    const script = `
      import fs from 'node:fs'; import path from 'node:path';
      import { createPairCoachServer } from ${JSON.stringify(pathToFileURL(path.join(serverRoot, 'src/server/http.ts')).href)};
      const app = createPairCoachServer({ rootPath: ${JSON.stringify(root)}, dataDir: ${JSON.stringify(data)}, token: ${JSON.stringify(token)}, port: 0, enableCoach: false });
      const source = app.workspace.createSnapshot('Original', ['main.py']);
      app.workspace.on('snapshotCheckpoint', e => {
        if (e.phase !== 'BEFORE_PUBLICATION') return;
        fs.appendFileSync(${JSON.stringify(path.join(data, 'checkpoints.txt'))}, '1\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
        if (${JSON.stringify(mode)} === 'recovery') fs.writeFileSync(path.join(${JSON.stringify(root)}, 'main.py'), 'FOREIGN', { flag: 'wx' });
      });
      const port = await app.listen(); process.send({ port, snapshotId: source.snapshotId });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { cwd: serverRoot, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
    let client: LiveBackend | undefined;
    t.after(async () => {
      client?.close();
      if (process.env.PAIRCOACH_PROPOSAL_EVIDENCE_DIR) {
        const output = path.join(process.env.PAIRCOACH_PROPOSAL_EVIDENCE_DIR, `${mode}-${lost ? 'lost' : 'late'}`);
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, 'transport.json'), JSON.stringify({ mode, lost, serverRoot,
          sent: sent.map(raw => { const message = JSON.parse(raw); if (message.type === 'HELLO') message.payload.token = '[REDACTED]'; return message; }),
          frames, errors, finalState: { connectionError: client?.getState().connectionError, pendingPaths: client?.getState().pendingPaths }, stderr,
        }, null, 2));
      }
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const ready = await new Promise<{ port: number; snapshotId: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server start timeout: ' + stderr)), 8000);
      child.once('message', message => { clearTimeout(timer); resolve(message as any); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exit ' + code + ': ' + stderr)); });
    });
    assert(![8765, 8766, 8767, 8768].includes(ready.port));
    const baseUrl = `http://127.0.0.1:${ready.port}`, stored = new Map<string, string>();
    let dropped: any = null;
    client = new LiveBackend({ baseUrl, token, clientId: crypto.randomUUID(), storage: { getItem: k => stored.get(k) ?? null, setItem: (k, v) => { stored.set(k, v); }, removeItem: k => { stored.delete(k); } }, socket: url => {
      const ws = new WebSocket(url); let blocked = false;
      const proxy = { get readyState() { return ws.readyState; }, send: (raw: string) => { sent.push(raw); ws.send(raw); }, close: () => ws.close(), onopen: null as any, onmessage: null as any, onclose: null as any, onerror: null as any };
      ws.addEventListener('open', event => proxy.onopen?.(event));
      ws.addEventListener('message', event => {
        const frame = JSON.parse(String(event.data)); frames.push(frame);
        const decision = sent.map(raw => JSON.parse(raw)).find(message => message.type === 'PROPOSAL_RESPONSE');
        if (lost && !dropped && frame.type === 'ACK' && frame.payload.replyTo === decision?.messageId) { dropped = frame; blocked = true; }
        if (!blocked) proxy.onmessage?.(event);
      });
      ws.addEventListener('error', event => proxy.onerror?.(event)); ws.addEventListener('close', event => proxy.onclose?.(event)); return proxy;
    } });
    client.subscribe('state', state => { if (state.connectionError) errors.push(state.connectionError); });
    await client.connect(); await until(() => client!.getState().isOffline, value => !value, 'authorized snapshot');
    await client.selectFile('main.py'); client.saveFileContent('main.py', 'USER WORK\n'); await client.flushAll();
    client.restoreSnapshotById(ready.snapshotId); await until(() => client!.getState().activeProposal, Boolean, 'public proposal');
    const proposalId = client.getState().activeProposal!.id, started = performance.now();
    await client.respondToProposal(proposalId, true);
    const deadlineMs = performance.now() - started;
    assert(errors.some(error => /wynik nieznany/i.test(error)), '5s is UNKNOWN, not failure/success');
    assert(deadlineMs >= 4900 && deadlineMs < 6300, 'unchanged real 5s deadline in independent client process');
    const original = sent.find(raw => JSON.parse(raw).type === 'PROPOSAL_RESPONSE')!; assert(original);
    const matching = (frame: any) => frame.type === 'ACK' && frame.payload.replyTo === JSON.parse(original).messageId;
    await until(() => frames.find(matching), Boolean, 'real terminal outcome');
    if (lost) {
      assert(dropped); assert.match(client.getState().connectionError!, /wynik nieznany/i, 'missing proposal snapshot does NOT imply success');
      client.reconnect();
      await until(() => sent.filter(raw => JSON.parse(raw).type === 'PROPOSAL_RESPONSE').length, count => count === 2, 'client original-envelope replay');
      assert.deepEqual(sent.filter(raw => JSON.parse(raw).type === 'PROPOSAL_RESPONSE'), [original, original]);
      await until(() => frames.filter(matching).length, count => count === 2, 'cached ledger outcome');
    }
    await until(() => client!.getState().connectionError, value => mode === 'recovery' ? /RECOVERY_REQUIRED/.test(value ?? '') : value === null, 'client reconciles actual outcome');
    const outcomes = frames.filter(matching).map(frame => frame.payload);
    assert.equal(outcomes[0].status, mode === 'success' ? 'OK' : 'REJECTED');
    if (lost) { assert.equal(outcomes[1].status, mode === 'success' ? 'DUPLICATE' : 'REJECTED'); assert.deepEqual(outcomes[1].error, outcomes[0].error); }
    assert.equal(fs.readFileSync(path.join(root, 'main.py'), 'utf8'), mode === 'success' ? 'ORIGINAL\n' : 'FOREIGN');
    assert.equal(fs.readFileSync(path.join(data, 'checkpoints.txt'), 'utf8'), '1\n', 'exactly one restore gate effect');
    const snapshots = await fetch(baseUrl + '/api/snapshots', { headers: { Authorization: `Bearer ${token}` } }).then(response => response.json());
    assert.equal(snapshots.length, 2, 'source + one real pre-restore backup');
    const privateFiles = fs.readdirSync(data, { recursive: true }).filter((file): file is string => typeof file === 'string');
    const backupBytesRetained = privateFiles.some(file => file.endsWith('.bin') && fs.readFileSync(path.join(data, file), 'utf8') === 'USER WORK\n');
    assert(backupBytesRetained, 'actual pre-restore backup retains confirmed USER WORK bytes');
    assert.equal(client.getState().activeProposal, null);
    assert(!errors.some(error => error.includes(token)), 'no token in UI errors');
    t.diagnostic(JSON.stringify({ mode, lost, serverRoot, delayMs: 6500, deadlineMs: Math.round(deadlineMs), decision: JSON.parse(original), statuses: outcomes.map(outcome => outcome.status), displayedRecovery: errors.some(error => /RECOVERY_REQUIRED/.test(error)), backupCount: snapshots.length - 1, publicationCheckpoints: 1 }));
  });
}
