import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createPairCoachServer } from '../../src/server/http';
import { LocalFallbackProvider } from '../../src/server/coach/provider';
import { workspaceFiles, Peer, id, settings } from '../qa/helpers';

for (const exitCode of [0, 1]) {
  test(`completed Run with exit ${exitCode} preserves wire ordering and subsequent settings access`, async t => {
    const dirs = await workspaceFiles(t, { 'main.py': 'value = 0\n' });
    const token = id();
    const app = createPairCoachServer({ ...dirs, port: 0, token,
      enableCoach: true, enableExecution: true, coachProvider: new LocalFallbackProvider() });
    const peers = new Set<{ close(): void }>();
    t.after(async () => {
      for (const peer of peers) peer.close();
      await app.close();
      await dirs.cleanup();
    });
    app.workspace.updateSettings({ ...settings, runProfiles: [{ kind: 'RUN_MAIN',
      executable: process.execPath, args: ['-e', `process.exit(${exitCode})`], cwd: '.',
      timeoutMs: 10000, testReportFormat: 'NONE', testReportGlob: null }] });
    const port = await app.listen();
    const baseURL = `http://127.0.0.1:${port}`;
    const clientId = id(), sessionId = app.session.getSession().sessionId;
    const peer = new Peer({ port, baseURL, token, clientId, sessionId, peers } as any);
    const sequences: number[] = [];
    peer.socket.on('message', data => sequences.push(JSON.parse(data.toString()).seq));
    await peer.connect();
    const command = () => ({ requestId: id(), clientId, sessionId });
    const request = (endpoint: string, method: string, body: unknown) => fetch(baseURL + endpoint, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    const start = await request('/api/session/start', 'POST', { ...command(), limitMs: null, pauseOnHidden: true });
    assert.equal(start.status, 200);
    const run = await request('/api/run', 'POST', { ...command(), mode: 'RUN_MAIN',
      expectedWorkspaceVersion: app.workspace.workspaceVersion });
    assert.equal(run.status, 202);
    const { runId } = await run.json();
    await peer.take(frame => frame.type === 'RUN_STATE' && frame.payload.runId === runId && frame.payload.finishedAt);
    await delay(10);
    peer.assertProtocol();
    for (let index = 1; index < sequences.length; index++) {
      assert.equal(sequences[index], sequences[index - 1] + 1);
    }
    assert.equal(app.session.leaseClientId, clientId);
    const update = await request('/api/project/settings', 'PUT', { ...command(),
      expectedWorkspaceVersion: app.workspace.workspaceVersion, settings: app.workspace.settings });
    assert.equal(update.status, 200);
  });
}
