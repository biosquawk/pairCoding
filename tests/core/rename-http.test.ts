import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { WebSocket } from 'ws';
import { createPairCoachServer } from '../../src/server/http';

const TOKEN = 'rename-test-only-0123456789abcdef0123456789';
test('RENAME real REST/WS: partial failure is 409 + external sync; replay repeats failure without deleting copies', async t => {
  const parent = fs.mkdtempSync(path.join(process.cwd(), '.paircoach-test-rename-http-'));
  const root = path.join(parent, 'project'); fs.mkdirSync(root);
  const source = path.join(root, 'main.ts'), target = path.join(root, 'target.ts');
  const bytes = Buffer.from('\ufeffconst n = 1;\r\n'); fs.writeFileSync(source, bytes);
  const app = createPairCoachServer({ rootPath: root, dataDir: path.join(parent, 'data'), port: 0, token: TOKEN });
  const port = await app.listen(), origin = `http://127.0.0.1:${port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/session`, { origin });
  const messages: any[] = [];
  ws.on('message', raw => messages.push(JSON.parse(String(raw))));
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports(); ws.terminate(); await app.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  async function wait(predicate: (m: any) => boolean) {
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      const match = messages.find(predicate); if (match) return match;
      await new Promise(r => setTimeout(r, 5));
    }
    assert.fail('Missing expected real WS event: ' + messages.map(m => m.type).join(','));
  }
  await once(ws, 'open');
  ws.send(JSON.stringify({ protocolVersion: '3.0', messageId: 'rename-hello', clientId: 'tab-1',
    sessionId: app.session.state.sessionId, type: 'HELLO', payload: { token: TOKEN, lastServerSeq: 0 } }));
  await wait(m => m.type === 'SESSION_SNAPSHOT');
  const request = { requestId: 'rename-partial', clientId: 'tab-1', sessionId: app.session.state.sessionId,
    controlEpoch: 0, operation: 'RENAME', path: 'main.ts', newPath: 'target.ts', baseVersion: 1, content: null };
  const realRename = fs.renameSync; let removeCalls = 0;
  t.mock.method(fs, 'renameSync', (file: fs.PathLike, to: fs.PathLike) => {
    if (String(file) === source) {
      removeCalls++; throw Object.assign(new Error('injected sharing violation'), { code: 'EACCES' });
    }
    return realRename(file, to);
  });
  syncBuiltinESMExports();
  async function post(body = request) {
    const response = await fetch(origin + '/api/file', { method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const first = await post();
  assert.equal(first.status, 409); assert.equal(first.body.code, 'RENAME_INCOMPLETE');
  assert.equal(first.body.retryable, false); assert.equal(first.body.requestId, request.requestId);
  const sync = await wait(m => m.type === 'EXTERNAL_FILE_SYNC' && m.payload.path === 'target.ts');
  assert.equal(sync.payload.operation, 'CREATED'); assert.equal(sync.payload.document.content, 'const n = 1;\n');
  assert.equal(sync.payload.workspaceVersion, 1);
  assert.deepEqual(fs.readFileSync(source), bytes); assert.deepEqual(fs.readFileSync(target), bytes);
  const repeat = await post(); assert.deepEqual(repeat, first); assert.equal(removeCalls, 1);
  assert.equal((await post({ ...request, newPath: 'changed.ts' })).body.code, 'IDEMPOTENCY_CONFLICT');
  const projectResponse = await fetch(origin + '/api/project', { headers: { Authorization: `Bearer ${TOKEN}` } });
  const project = await projectResponse.json();
  assert.equal(project.workspaceVersion, 1);
  assert.deepEqual(project.files.filter((f: any) => f.kind === 'FILE').map((f: any) => f.path).sort(), ['main.ts', 'target.ts']);
  const actual = { http: first.status, code: first.body.code, sourceRetained: true, targetRetained: true,
    externalSync: sync.payload.operation, workspaceVersion: project.workspaceVersion, sourceCaptureAttempts: removeCalls };
  console.log('RENAME_PARTIAL_OBSERVED ' + JSON.stringify(actual));
});
