/** Real FE service -> HTTP/WS handler -> CoachAdapter boundary. NOT real Monaco/AI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import { createPairCoachServer } from '../../src/server/http';
import { PairCoachClient } from '../../src/services/PairCoachClient';

const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < end, 'real transport condition timed out'); await pause(5); }
}

test('real VIEW ACK owns documentVersion; motion alone no provider; next CHAT gets selection; rejected VIEW blocks question', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-view-p2-real-'));
  const root = path.join(base, 'project'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'solution.ts'), 'A😀B\nsecond');
  const contexts: any[] = [], sent: any[] = [], received: any[] = [];
  const app = createPairCoachServer({ rootPath: root, dataDir: path.join(base, 'data'), port: 0, token: 'unit-editor-view-p2-token', enableCoach: true,
    coachProvider: { name: 'editor-view-service-capture', decide: async context => { contexts.push(structuredClone(context)); return { kind: 'REPLY', text: 'deterministic provider boundary' }; } } });
  t.after(async () => { await app.close(); fs.rmSync(base, { recursive: true, force: true }); });
  app.workspace.updateSettings({ ...app.workspace.settings, aiConsent: true, taskFilePath: null, contextPatterns: ['**/*.ts'] });
  const port = await app.listen(); assert.ok(![8080, 8081, 8765, 8766, 8767, 8768].includes(port));
  const client = new PairCoachClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'unit-editor-view-p2-token', clientId: 'editor-view-integration',
    socket: url => {
      const ws = new WebSocket(url), send = ws.send.bind(ws);
      ws.send = ((raw: string) => { sent.push(JSON.parse(raw)); send(raw); }) as typeof ws.send;
      ws.on('message', raw => received.push(JSON.parse(String(raw))));
      return ws as unknown as WebSocket & Pick<globalThis.WebSocket, 'onopen' | 'onmessage' | 'onerror' | 'onclose'>;
    } });
  t.after(() => client.close());
  await client.connect(); await until(() => !client.getState().isOffline);
  await client.startTimer(); await until(() => contexts.length > 0);
  const before = contexts.length;
  client.updateEditorView({ projectId: app.workspace.projectId, path: 'solution.ts', content: 'A😀B\nsecond',
    cursor: { line: 1, column: 4 }, selection: { startLine: 1, startColumn: 2, endLine: 1, endColumn: 4 } });
  await until(() => sent.some(frame => frame.type === 'VIEW_CHANGED'));
  const view = sent.find(frame => frame.type === 'VIEW_CHANGED');
  await until(() => received.some(frame => frame.type === 'ACK' && frame.payload.replyTo === view.messageId));
  const ack = received.find(frame => frame.type === 'ACK' && frame.payload.replyTo === view.messageId).payload;
  assert.equal(ack.status, 'OK'); assert.equal(ack.documentVersion, app.workspace.getDocument('solution.ts').version);
  await pause(400); assert.equal(contexts.length, before, 'view alone never triggers provider');
  assert.equal(await client.sendChatMessage('explain the emoji selection'), true);
  await until(() => contexts.some(context => context.trigger?.reason === 'CHAT'));
  const captured = contexts.find(context => context.trigger?.reason === 'CHAT');
  assert.deepEqual(captured.view, { projectId: app.workspace.projectId, path: 'solution.ts', documentVersion: ack.documentVersion,
    cursor: view.payload.cursor, selection: view.payload.selection, selectedText: '😀', selectionTruncated: false });
  const chatCount = sent.filter(frame => frame.type === 'CHAT_MESSAGE').length;
  client.updateEditorView({ projectId: app.workspace.projectId, path: 'solution.ts', content: 'A😀B\nsecond',
    cursor: { line: 99, column: 1 }, selection: null });
  assert.equal(await client.sendChatMessage('must not be sent with invalid context'), false);
  assert.equal(sent.filter(frame => frame.type === 'CHAT_MESSAGE').length, chatCount);
  const bad = sent.filter(frame => frame.type === 'VIEW_CHANGED').at(-1);
  assert.equal(received.find(frame => frame.type === 'ACK' && frame.payload.replyTo === bad.messageId).payload.status, 'REJECTED');
  assert.ok(client.getState().connectionError);
});
