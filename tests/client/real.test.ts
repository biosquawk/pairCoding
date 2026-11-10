import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LiveBackend } from '../../src/services/LiveBackend';
import { createPairCoachServer } from '../../src/server/http';

async function until(condition: () => boolean, label: string) {
  const end = Date.now() + 6000;
  while (!condition()) { if (Date.now() >= end) throw new Error(`Timeout: ${label}`); await new Promise(r => setTimeout(r, 20)); }
}
test('REAL HTTP/WS GATE001 client bootstrap, HELLO, CODE_CHANGED, disk/ACK, external conflict, veto and reconnect', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-client-real-'));
  const root = path.join(dir, 'workspace'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'challenge.md'), '# Real client exercise\n');
  fs.writeFileSync(path.join(root, 'solution.ts'), 'const value = 0;\n');
  const app = createPairCoachServer({ rootPath: root, dataDir: path.join(dir, 'data'), port: 0, devBootstrap: true });
  const port = await app.listen();
  const stored = new Map<string, string>();
  const client = new LiveBackend({ baseUrl: `http://127.0.0.1:${port}`, storage: { getItem: k => stored.get(k) ?? null, setItem: (k,v) => { stored.set(k,v); }, removeItem: k => { stored.delete(k); } } });
  t.after(async () => { client.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(); await until(() => !client.getState().isOffline, 'snapshot sync');
  assert.equal(client.getState().transportMode, 'LIVE_BACKEND');
  assert.ok(client.getState().files.find(f => f.path === 'challenge.md')?.content.includes('Real client exercise'));
  await client.selectFile('solution.ts');
  client.saveFileContent('solution.ts', 'const value = 1;\n');
  client.saveFileContent('solution.ts', 'const value = 2;\n');
  await until(() => client.getState().pendingPaths.length === 0, 'CODE_CHANGED ACK');
  assert.equal(fs.readFileSync(path.join(root, 'solution.ts'), 'utf8'), 'const value = 2;\n');
  assert.equal(client.getState().files.find(f => f.path === 'solution.ts')?.version, app.workspace.getDocument('solution.ts').version);
  const approved = { kind: 'RUN_MAIN' as const, executable: 'node', args: ['main.js'], cwd: '.', timeoutMs: 1000, testReportFormat: 'NONE' as const, testReportGlob: null };
  assert.equal(await client.updateProjectSettings({ ...client.getState().projectSettings, wireRunProfiles: [approved], contextPatterns: ['**/*.ts', '**/*.md'] }), true);
  assert.deepEqual(app.workspace.settings.runProfiles, [approved]);
  assert.deepEqual(app.workspace.settings.contextPatterns, ['**/*.ts', '**/*.md']);
  const epoch = client.getState().controlEpoch;
  client.triggerVeto(); client.saveFileContent('solution.ts', 'const value = 3;\n');
  await until(() => client.getState().controlEpoch > epoch && client.getState().pendingPaths.length === 0, 'veto cutoff ACK and draft save');
  assert.equal(fs.readFileSync(path.join(root, 'solution.ts'), 'utf8'), 'const value = 3;\n');
  client.saveFileContent('solution.ts', 'const local = 4;\n');
  fs.writeFileSync(path.join(root, 'solution.ts'), 'const disk = 5;\n'); app.workspace.scanExternal();
  await until(() => !!client.getState().fileConflict, 'external conflict');
  assert.equal(client.getState().fileConflict?.localDraftContent, 'const local = 4;\n');
  assert.equal(client.getState().fileConflict?.diskContent, 'const disk = 5;\n');
  assert.equal(client.getState().files.find(f => f.path === 'solution.ts')?.content, 'const local = 4;\n');
  client.reconnect(); await until(() => !client.getState().isOffline, 'real WS reconnect and resnapshot');
  assert.equal(client.getState().files.find(f => f.path === 'solution.ts')?.content, 'const local = 4;\n');
  assert.equal(fs.readFileSync(path.join(root, 'solution.ts'), 'utf8'), 'const disk = 5;\n');
  await client.resolveConflict('LOAD_DISK');
  assert.equal(client.getState().files.find(f => f.path === 'solution.ts')?.content, 'const disk = 5;\n');
  assert.equal(client.getState().fileConflict, null);
  const secondRoot = path.join(dir, 'second-workspace'); fs.mkdirSync(secondRoot);
  fs.writeFileSync(path.join(secondRoot, 'challenge.md'), '# Second root');
  fs.writeFileSync(path.join(secondRoot, 'solution.ts'), 'const other = 9;\n');
  await client.openProject(secondRoot);
  await until(() => !client.getState().isOffline && client.getState().scenario.title === secondRoot, 'open new project and handshake');
  await client.selectFile('solution.ts');
  assert.equal(client.getState().files.find(f => f.path === 'solution.ts')?.content, 'const other = 9;\n');
  assert.equal(client.getState().projectSettings.aiConsent, false);
  assert.deepEqual(client.getState().projectSettings.runProfiles, []);
});

test('REGRESSION: lost veto ACK then real reconnect snapshot proves cutoff and unlocks preserved draft', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-veto-reconnect-'));
  const root = path.join(dir, 'workspace'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'challenge.md'), '# Task\n');
  fs.writeFileSync(path.join(root, 'solution.ts'), 'const value = 0;\n');
  const app = createPairCoachServer({ rootPath: root, dataDir: path.join(dir, 'data'), port: 0, devBootstrap: true });
  const port = await app.listen();
  const sockets: { block: boolean }[] = [];
  const client = new LiveBackend({ baseUrl: `http://127.0.0.1:${port}`, socket: url => {
    const ws = new WebSocket(url);
    const control = { block: false }; sockets.push(control);
    const proxy = { get readyState() { return ws.readyState; }, send: (value: string) => ws.send(value), close: () => ws.close(), onopen: null as any, onmessage: null as any, onerror: null as any, onclose: null as any };
    ws.addEventListener('open', event => proxy.onopen?.(event));
    ws.addEventListener('message', event => { if (!control.block) proxy.onmessage?.(event); });
    ws.addEventListener('error', event => proxy.onerror?.(event)); ws.addEventListener('close', event => proxy.onclose?.(event));
    return proxy;
  } });
  t.after(async () => { client.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(); await until(() => !client.getState().isOffline, 'initial snapshot'); await client.selectFile('solution.ts');
  const epoch = app.session.getSession().controlEpoch;
  sockets[0].block = true;
  client.triggerVeto(); client.saveFileContent('solution.ts', 'const preserved = 42;\n');
  await until(() => app.session.getSession().controlEpoch > epoch, 'actual backend veto cutoff');
  client.reconnect(); await until(() => !client.getState().isOffline && sockets.length === 2, 'reconnected authoritative snapshot');
  // No ACK was delivered. Only the new authoritative STUDENT/epoch snapshot may discharge the veto barrier.
  await until(() => client.getState().pendingPaths.length === 0, 'draft save after cutoff proof');
  assert.equal(fs.readFileSync(path.join(root, 'solution.ts'), 'utf8'), 'const preserved = 42;\n');
  assert.equal(client.getState().fileConflict, null);
});
