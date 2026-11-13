import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HeaderBar } from '../../src/components/HeaderBar';
import { LiveBackend } from '../../src/services/LiveBackend';
import { createPairCoachServer } from '../../src/server/http';

function findButton(node: any, title: string): any {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'button' && node.props?.title === title) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    const found = findButton(child, title); if (found) return found;
  }
  return null;
}
async function until(condition: () => boolean) {
  const end = Date.now() + 5000;
  while (!condition()) { if (Date.now() > end) throw new Error('Timer state timeout'); await new Promise(r => setTimeout(r, 20)); }
}

test('HeaderBar actual Start handler -> real POST200/lifecycle RUNNING; Pause and Resume use WS actions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-header-'));
  const root = path.join(dir, 'root'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'challenge.md'), '# Task\n');
  const app = createPairCoachServer({ rootPath: root, dataDir: path.join(root, '.paircoach'), port: 0, devBootstrap: true });
  const port = await app.listen();
  const requests: { path: string; method: string; status: number }[] = [];
  const client = new LiveBackend({ baseUrl: `http://127.0.0.1:${port}`, fetch: (async (url: string, options: any) => {
    const response = await fetch(url, options); requests.push({ path: new URL(url).pathname, method: options.method, status: response.status }); return response;
  }) as typeof fetch });
  t.after(async () => { client.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(); await until(() => !client.getState().isOffline);
  const render = () => HeaderBar({ ...client.getState(), taskMode: 'IMPLEMENTATION', isDevSimulatorOpen: false, executionStatus: 'IDLE', onStartTimer: () => client.startTimer(), onPauseTimer: () => client.pauseTimer(), onResumeTimer: () => client.resumeTimer(), onEmergencyVeto() {}, onTogglePauseOnHidden() {}, onRunMain() {}, onRunTests() {}, onStopExecution() {}, onOpenFinishModal() {}, onToggleDevSimulator() {} });
  const start = findButton(render(), 'Start sesji'); assert.ok(start);
  await start.props.onClick();
  assert.equal(app.session.getSession().lifecycle, 'RUNNING');
  assert.ok(requests.some(r => r.path === '/api/session/start' && r.method === 'POST' && r.status === 200));
  await until(() => client.getState().sessionStatus === 'RUNNING');
  findButton(render(), 'Pauza czasu').props.onClick(); await until(() => client.getState().sessionStatus === 'PAUSED');
  findButton(render(), 'Wznów czas').props.onClick(); await until(() => client.getState().sessionStatus === 'RUNNING');
  assert.equal(requests.filter(r => r.path === '/api/session/start').length, 1, 'resume is not a new session start');
});
