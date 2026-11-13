import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { LiveBackend, applyWireEdit } from '../../src/services/LiveBackend';
import { createPairCoachServer, type ServiceContext } from '../../src/server/http';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, label: string) {
  const end = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= end) throw new Error(`Timeout: ${label}`);
    await pause(10);
  }
}

/** Real HTTP/WS/gate/disk. The relay delays genuine frames only, in their original seq order.
 * The deterministic coordinator is NOT Gemini; the renderer callback is NOT Monaco/browser proof.
 */
async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paircoach-ac011-'));
  const root = path.join(dir, 'project'); fs.mkdirSync(root);
  const seed = 'value = 0\n';
  fs.writeFileSync(path.join(root, 'main.py'), seed);
  fs.writeFileSync(path.join(root, 'challenge.md'), '# AC011\n');
  fs.mkdirSync(path.join(root, '.paircoach'), {mode:0o700});
  fs.writeFileSync(path.join(root, '.paircoach', 'settings.json'), JSON.stringify({
    schemaVersion: 2, taskFilePath: 'challenge.md', taskMode: 'IMPLEMENTATION', reviewNotesPath: 'review.md',
    runProfiles: [], aiConsent: true, contextPatterns: ['**/*.java', '**/*.py', '**/*.js', '**/*.ts', '**/*.md'],
  }));
  let context!: ServiceContext;
  const app = createPairCoachServer({ rootPath: root, dataDir: path.join(root, '.paircoach'), port: 0,
    devBootstrap: true, enableCoach: true,
    coachFactory: ctx => {
      context = ctx;
      ctx.session.setAiStatus('READY');
      return { trigger() {}, controlReady() {}, stepRendered() {}, abort() {}, close() {} };
    },
  });
  const sent: any[] = [], received: any[] = [], held: { frame: any; event: any }[] = [];
  const stored = new Map<string, string>();
  let holding = false;
  let proxy: any;
  const port = await app.listen();
  const client = new LiveBackend({ baseUrl: `http://127.0.0.1:${port}`, clientId: 'ac011-tab',
    storage: { getItem: k => stored.get(k) ?? null, setItem: (k,v) => { stored.set(k,v); }, removeItem: k => { stored.delete(k); } },
    socket: url => {
      const ws = new WebSocket(url);
      proxy = { get readyState() { return ws.readyState; }, send(raw: string) { sent.push(JSON.parse(raw)); ws.send(raw); },
        close: () => ws.close(), onopen: null, onmessage: null, onerror: null, onclose: null };
      ws.addEventListener('open', event => proxy.onopen?.(event));
      ws.addEventListener('message', event => {
        const frame = JSON.parse(String(event.data)); received.push(frame);
        if (holding) held.push({ frame, event }); else proxy.onmessage?.(event);
      });
      ws.addEventListener('error', event => proxy.onerror?.(event));
      ws.addEventListener('close', event => proxy.onclose?.(event));
      return proxy;
    },
  });
  t.after(async () => { client.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(); await until(() => !client.getState().isOffline, 'initial real snapshot');
  await client.selectFile('main.py'); await client.startTimer();
  const disk = () => fs.readFileSync(path.join(root, 'main.py'), 'utf8');
  const changes = () => sent.filter(f => f.type === 'CODE_CHANGED');
  const matchedACK = (write: any) => received.find(f => f.type === 'ACK' && f.payload.replyTo === write.messageId
    && f.payload.status === 'OK' && f.payload.error === null && f.payload.documentVersion > write.payload.baseVersion
    && f.payload.controlEpoch === write.payload.controlEpoch)?.payload;
  // Public renderer callback: no private client state changes and no fabricated messages/ACKs.
  let rendered = 0;
  client.subscribe('step', step => {
    rendered++;
    const content = client.getState().files.find(f => f.path === step.path)!.content;
    client.stepRendered(step, applyWireEdit(content, step.range, step.text));
  });
  const interventionId = randomUUID();
  const epoch = context.session.acquireCoach(interventionId);
  await until(() => client.getState().writeOwner === 'COACH', 'actual coach ownership');
  function commitStep(textBlock: string) {
    const before = context.workspace.getDocument('main.py');
    const after = context.gate.write({ clientId: 'ac011-tab', sessionId: context.session.state.sessionId,
      actor: 'COACH', controlEpoch: epoch, path: 'main.py', baseVersion: before.version, content: before.content + textBlock });
    context.emit('COACH_STEP_EDIT', { stepId: randomUUID(), interventionId, controlEpoch: epoch, path: 'main.py',
      baseVersion: before.version, version: after.version, workspaceVersion: context.workspace.workspaceVersion,
      range: { startLine: before.content.split('\n').length, startColumn: 1,
        endLine: before.content.split('\n').length, endColumn: 1 }, textBlock, contentHash: after.contentHash });
  }
  commitStep('# coach_step_1\n'); await until(() => rendered === 1, 'first actually committed step rendered');
  holding = true;
  commitStep('# coach_step_2\n');
  await until(() => held.some(h => h.frame.type === 'COACH_STEP_EDIT'), 'pre-cutoff second commit held in real WS');
  const diskAtCutoff = disk();
  function release() { holding = false; for (const h of held.splice(0)) proxy.onmessage?.(h.event); }
  function recovery(local: string) {
    return [...stored].some(([key, value]) => {
      if (!key.includes(':conflict:main.py:')) return false;
      const c = JSON.parse(value); return c.localDraftContent === local && c.diskContent === diskAtCutoff;
    });
  }
  async function vetoAndType(multipleEdits: boolean) {
    client.triggerVeto();
    const first = seed + '# coach_step_1\n# qa_keep_local';
    client.saveFileContent('main.py', first);
    const local = multipleEdits ? first + '\n' : first;
    if (multipleEdits) client.saveFileContent('main.py', local);
    const veto = sent.find(f => f.type === 'VETO_ESCAPE');
    await until(() => held.some(h => h.frame.type === 'ACK' && h.frame.payload.replyTo === veto.messageId), 'real veto ACK withheld');
    assert.equal(disk(), diskAtCutoff);
    assert.throws(() => context.gate.write({ clientId: 'ac011-tab', sessionId: context.session.state.sessionId,
      actor: 'COACH', controlEpoch: epoch, path: 'main.py', baseVersion: context.workspace.getDocument('main.py').version,
      content: 'STALE SHOULD NEVER WRITE' }), (e: any) => e.code === 'STALE_EPOCH');
    release();
    await until(() => !!client.getState().fileConflict, 'late committed step produces protected conflict');
    await until(() => client.getState().controlEpoch > epoch, 'actual veto ACK delivered');
    // Let the original autosave expire WHILE conflicted; no silent overwrite is permitted.
    await pause(200);
    assert.equal(changes().length, 0);
    assert.equal(disk(), diskAtCutoff);
    assert.equal(rendered, 1, 'late invalid intervention is never rendered');
    assert.equal(client.getState().fileConflict?.localDraftContent, local);
    assert.equal(client.getState().fileConflict?.diskContent, diskAtCutoff);
    assert.ok([...stored.values()].some(v => v.includes('qa_keep_local')), 'pending local draft persisted');
    return local;
  }
  return { client, app, sent, received, changes, matchedACK, disk, diskAtCutoff, recovery, vetoAndType, stored };
}

for (const multipleEdits of [true, false]) {
  test(`AC011 KEEP_LOCAL after expired conflict timer, ${multipleEdits ? 'multiple edits' : 'one edit'}: real CODE_CHANGED + matched ACK + exact disk`, async t => {
    const f = await fixture(t);
    const local = await f.vetoAndType(multipleEdits);
    const decisionAfter = f.sent.length;
    await f.client.resolveConflict('KEEP_LOCAL');
    await until(() => f.changes().some(w => f.matchedACK(w)) && f.client.getState().pendingPaths.length === 0,
      'explicit KEEP_LOCAL real CODE_CHANGED and matched successful ACK');
    const writes = f.changes(); assert.equal(writes.length, 1, 'single-flight, no duplicate commit');
    assert.ok(f.sent.indexOf(writes[0]) >= decisionAfter);
    assert.equal(writes[0].payload.content, local);
    assert.equal(writes[0].payload.baseVersion, 3, 'uses latest committed coach/disk version');
    assert.equal(writes[0].payload.controlEpoch, f.client.getState().controlEpoch);
    assert.equal(f.disk(), local); assert.equal(f.client.getState().fileConflict, null);
    assert.ok(f.recovery(local), 'both exact conflict versions archived before explicit overwrite');
    t.diagnostic(JSON.stringify({ multipleEdits, write: writes[0], ack: f.matchedACK(writes[0]), recovery: true }));
  });
}

test('AC011 no decision then LOAD_DISK: no CODE_CHANGED, no silent commit, both versions archived', async t => {
  const f = await fixture(t); const local = await f.vetoAndType(true);
  await pause(200);
  assert.equal(f.changes().length, 0); assert.equal(f.disk(), f.diskAtCutoff);
  assert.equal(f.client.getState().fileConflict?.localDraftContent, local);
  await f.client.resolveConflict('LOAD_DISK'); await pause(200);
  assert.equal(f.changes().length, 0); assert.equal(f.disk(), f.diskAtCutoff);
  assert.equal(f.client.getState().files.find(file => file.path === 'main.py')?.content, f.diskAtCutoff);
  assert.equal(f.client.getState().fileConflict, null); assert.deepEqual(f.client.getState().pendingPaths, []);
  assert.ok(f.recovery(local));
});
